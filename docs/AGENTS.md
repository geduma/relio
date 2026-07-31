# AGENTS.md — Relio

Instructions for AI assistants working on this codebase.

## Stack

- **Runtime:** Node.js 18+ (ESM — `"type": "module"`)
- **Backend:** Express.js 4.x
- **DB:** better-sqlite3 (synchronous, no ORM)
- **Frontend:** React 18 + Vite 5 (no TypeScript)
- **HTTP:** Native `fetch` (no axios)
- **Auth:** Pluggable auth providers (default: none/anonymous) + local API Keys
- **Testing:** Vitest
- **Docker:** multi-stage in `docker/`

## Code Conventions

- **No comments** in source code (JSDoc allowed where needed)
- **ESM** — use `import`/`export`, never `require`
- **Filenames:** kebab-case (`auth.routes.js`, `cacheManager.js`)
- **React component names:** PascalCase (`Login.jsx`, `ProvidersList.jsx`)
- **Variables and functions:** camelCase
- **Constants:** UPPER_CASE only for exported magic values
- **No TypeScript** — plain JS with optional JSDoc for complex types

## Database

Uses `better-sqlite3` with helper functions in `src/db.js`:

```js
import { dbAll, dbGet, dbRun, getDb } from '../db.js'

// Queries
const rows = dbAll('SELECT * FROM providers WHERE capability = ?', ['chat'])
const row  = dbGet('SELECT * FROM providers WHERE id = ?', [id])
const result = dbRun('UPDATE providers SET name = ? WHERE id = ?', [name, id])

// Transactions
const db = getDb()
const tx = db.transaction(() => { dbRun(...); dbRun(...) })
tx()
```

- **Never** use `db.prepare().all()` directly — always use helpers
- **Transactions** via `getDb().transaction(fn)`
- **WAL mode** enabled by default
- **`:memory:`** for tests (via `setDbPath(':memory:')`)

## Architecture

```
src/
├── index.js              # Express setup, routes, static, error handler
├── config.js             # Reads config.json
├── db.js                 # SQLite helpers + migrations
├── services/             # Pure logic (no Express)
│   ├── authService.js    # Geduma login, sessions, API keys
│   ├── failoverEngine.js # Provider selection, rate/daily limits
│   ├── circuitBreaker.js # healthy/cooldown/paused states
│   ├── cacheManager.js   # Hash + TTL cache
│   └── metricsLogger.js  # Logging + daily metrics
├── middleware/
│   └── authMiddleware.js # Cookie session + API Key validation
├── routes/               # Express routers
│   ├── auth.routes.js    # /admin/api/auth/*
│   ├── providers.routes.js
│   ├── metrics.routes.js
│   ├── keys.routes.js
│   ├── chat.routes.js    # /admin/api/chat/* (dashboard chat test)
│   └── proxy.routes.js   # /v1/*
├── handlers/
│   ├── requestHandler.js # Cache → failover → response
│   └── dashboardHandler.js
├── auth/                 # Pluggable auth providers
│   ├── base.js           # AuthProvider abstract class
│   ├── geduma.js         # Geduma OAuth provider
│   ├── none.js           # Anonymous session provider
│   └── index.js          # Factory (loads provider from AUTH_PROVIDER env)
├── adapters/             # Pluggable LLM provider adapters
│   ├── base.js           # ProviderAdapter abstract class
│   ├── index.js          # Factory + registry (singleton cache)
│   ├── openai-compatible.js
│   ├── anthropic.js
│   ├── gemini-native.js
│   └── azure-openai.js
└── utils/
    └── logger.js         # File app logger
```

### Chat Flow (Dashboard)

1. `Chat.jsx` loads providers from `GET /admin/api/chat/providers` (only `capability = 'chat'`)
2. User selects a provider, types a message, and optionally enables the Relio proxy toggle (when ON, the provider selector switches to "Auto (failover)" and is disabled)
3. `POST /admin/api/chat/send` with `{ provider_id, messages, use_proxy }`:
   - **Proxy disabled (default):** Calls `callProvider()` directly — bypasses failover, cache, metrics, and rate limiting
   - **Proxy enabled:** Calls `processRequest()` — goes through the full pipeline (failover, caching, circuit breaker, metrics); `provider_id` is ignored and the best available provider is selected
4. Response is rendered as a chat bubble

### Provider Connection Test

`testProviderConnection()` in `providers.routes.js` now validates both URL reachability and API key correctness by checking `res.ok` after calling `{api_url}/v1/models` with the API key. A 401 status returns `{ valid: false, error: '...invalid API key' }`.

### Proxy Request Flow

1. `proxy.routes.js` receives POST → `authMiddleware.requireApiKey`
2. `requestHandler.processRequest()`:
   - Computes `queryHash` → checks cache
   - Cache hit → returns immediately
   - Cache miss → `selectProviders(capability)` ordered by `order_position`
   - For each provider: checks `isProviderAvailable()`, `isRateLimitExceeded()` (in-memory), `isDailyLimitExceeded()` (via `metrics` table)
   - `callProvider()` → `getAdapter(provider.provider_type)` resolves adapter from registry (singleton cache) → `adapter.chat()` with 30s timeout
   - Success → `recordSuccess()`, `setCache()`, `enqueueLog()`, `enqueueMetric()`
   - Retryable failure (network/5xx/408/429) → `recordFailure()`, next provider; non-retryable (4xx) → thrown immediately, no failover
3. All failed → 503

### Streaming Flow

1. `proxy.routes.js` detects `stream: true` in request body → `handleStreamingRequest()`
2. Resolves provider (by provider name/ID, or first available for `chat` capability skipping paused/cooldown/rate-limited/daily-limited providers)
3. `streamProvider()` → `getAdapter(provider.provider_type)` → `adapter.stream()` returns a Node.js `Readable`
4. Enforces an idle timeout (`relay.streamIdleTimeoutMs`) and a max duration (`relay.streamTimeoutSeconds`) via `AbortController`; client disconnect aborts the upstream fetch
5. `pipeline(stream, res)` from `stream/promises` handles backpressure, completion, and errors
6. On success: `recordSuccess()`, `enqueueLog()`, `enqueueMetric()`
7. On pre-headers failure: `enqueueLog()`/`enqueueMetric()` and `recordFailure()` for retryable errors; no action once headers were sent

### Login Flow

Depends on the active auth provider (set via `auth.provider` in `config.json`):

**none** (default):
1. `GET /admin/api/auth/providers` → `{ autoLogin: true }`
2. Frontend auto-redirects to dashboard (no login page shown)
3. Backend creates anonymous session automatically

**geduma** (opt-in OAuth):
1. `GET /admin/api/auth/providers` → returns OAuth provider buttons
2. User clicks a provider → `POST /admin/api/auth/login { provider }` → returns `{ redirect: oauth_url }`
3. Browser redirects to OAuth provider (Google, GitHub, etc.)
4. User authenticates → OAuth callback goes to Geduma API (`/auth?code=xxx&state=yyy`)
5. Geduma returns HTML that redirects to Relio with `#session_token=xxx` in the URL hash
6. Frontend detects the hash → `POST /admin/api/auth/callback { sessionToken }` → backend exchanges token via Geduma `GET /auth/session/:sessionToken` → creates local session → sets cookie

## Configuration

All settings live in `config.json` at the project root. `src/config.js` reads this file at startup and exposes the parsed object as `config`.

To add a new key, add it to `config.json`, `config.example.json`, and update the README table.

`process.env` overrides are supported: `PORT`, `HOST`, `NODE_ENV`, `DB_PATH`, and `CONFIG_PATH`.

### Env vars

| Env | Type | Default | Effect |
|---|---|---|---|
| `CONFIG_PATH` | string | `./config.json` | Path to the JSON config file |
| `PORT` | number | from `config.json` | HTTP listen port |
| `HOST` | string | from `config.json` | Listen address (`0.0.0.0` in prod) |
| `NODE_ENV` | string | from `config.json` | `development` / `production` |
| `DB_PATH` | string | from `config.json` | SQLite file path (e.g. `:memory:`) |

### Security / relay settings

- `auth.trustedProxy` (default `false`): set to `true` only when Relio sits behind a trusted reverse proxy — enables `trust proxy` and honors `X-Forwarded-For`.
- `relay.exposeProvider` (default `false`): when `true`, responses include the resolved `_provider` metadata.
- `relay.streamTimeoutSeconds` (default `300`): max duration for streaming requests.
- `relay.streamIdleTimeoutMs` (default `30000`): abort a stream if no data arrives for this long.
- `rateLimit.loginPer15Minutes` (default `20`): login attempts per 15 min.
- `rateLimit.dashboardPerMinute` (default `120`): dashboard API requests per min.
- `rateLimit.proxyPerMinute` (default `60`): `/v1` requests per min, keyed by API key + IP.

## Tests

```bash
npm test                  # Run once
npm run test:watch        # Watch mode
```

- Tests in `tests/` with Vitest
- Set `process.env.DB_PATH = ':memory:'` in `beforeAll` for in-memory DB
- Use `process.env.CONFIG_PATH` to point to a test config file if needed
- Use dynamic `await import(...)` in tests so env vars are set before import
- Mock external APIs with `vi.mock` or by intercepting fetch

Test pattern:

```js
import { beforeAll, afterAll, describe, it, expect } from 'vitest'

beforeAll(async () => {
  process.env.DB_PATH = ':memory:'
  // ... dynamic imports
})
```

## Frontend

- React 18 with React Router v6
- Vite with proxy to Express in dev (`vite.config.js`)
- Build output in `frontend/dist/` — served as static by Express
- No TypeScript, no CSS framework, no external libs (only react + react-router-dom)
- Styles in `frontend/src/style.css` (plain CSS, no modules)

### Theme

- **Dark mode by default** using CSS custom properties on `:root`
- `.light-mode` class on `body` overrides variables for light theme
- Toggle in sidebar (Dashboard) and top-right (Login) persists to `localStorage('relio-theme')`
- Login page uses `--login-bg` for background contrast

### Provider Connection Test

`testProviderConnection()` in `providers.routes.js` validates both URL reachability and API key correctness:

1. **Primary:** `GET /v1/models` with `Authorization: Bearer <apiKey>`
   - `200` → also verifies with `POST /v1/chat/completions` (catches providers that don't auth on `/models`, and 404 from chat → "endpoint not found")
   - `401`/`403` → API key invalid
   - `404` → falls back to `POST /v1/chat/completions`
2. **Fallback:** `POST /v1/chat/completions` with fake model
   - `401`/`403` → API key invalid
   - `404` → endpoint not found
   - Checks response body for auth-related error messages
3. **Timeout:** 5 seconds per request via `AbortController`

**Security:** When editing a provider, the API key is masked as `'***'` in the GET response. On save, `'***'` is ignored (key unchanged). On test, the frontend sends `provider_id` so the backend resolves the real key from DB.

### Chat Flow (Dashboard)

1. `Chat.jsx` loads providers from `GET /admin/api/chat/providers` (only `capability = 'chat'`)
2. User selects a provider, types a message, and optionally enables the Relio proxy toggle (when ON, the selector shows "Auto (failover)" and is disabled)
3. `POST /admin/api/chat/send` with `{ provider_id, messages, use_proxy }`:
   - **Proxy disabled (default):** Calls `callProvider()` directly — bypasses failover, cache, metrics, and rate limiting
   - **Proxy enabled:** Calls `processRequest()` — goes through the full pipeline (failover, caching, circuit breaker, metrics); `provider_id` is ignored
4. Response includes `response_time_ms` displayed next to the provider name in each message bubble

### Components

| Component | Route | Purpose |
|---|---|---|
| `Login.jsx` | `/admin/login` | Captures session_token hash, initiates OAuth login, theme toggle |
| `Dashboard.jsx` | `/admin/dashboard/*` | Layout + internal routing + theme toggle |
| `ProvidersList.jsx` | `/admin/dashboard/providers` | List with reorder |
| `ProviderForm.jsx` | Modal | Create/edit provider |
| `Metrics.jsx` | `/admin/dashboard/metrics` | Stats + table |
| `ApiKeys.jsx` | `/admin/dashboard/keys` | CRUD API keys |
| `Logs.jsx` | `/admin/dashboard/logs` | Requests table |
| `Chat.jsx` | `/admin/chat` | Chat interface to test providers |

## Docker

```bash
# Build and run (config.json must exist in project root)
docker compose -f docker/docker-compose.yml up --build

# Structure
docker/
├── Dockerfile            # Multi-stage build, copies config.example.json as default
├── docker-compose.yml    # Port 3000, volumes for db/logs/config.json
└── .dockerignore
```

Before Docker deployment, ensure you have `config.json` with your settings (mounts override the default `config.example.json`).

## Common Tasks

### Add an endpoint

1. Create/edit route in `src/routes/`
2. Add auth middleware if needed
3. If new logic required, create service in `src/services/`
4. Register in `src/index.js`
5. Add test in `tests/`

### Add a table

1. Add `CREATE TABLE IF NOT EXISTS` in `src/db.js > initDb()`
2. Add indexes in `createIndexes()`
3. Update DB tests

### Add an LLM provider (Dashboard)

1. Dashboard → Add Provider
2. Fill in: name, API URL, API Key, model, provider type (openai-compatible, anthropic, gemini-native, azure-openai), capability (chat, embeddings), costs
3. Auto-ordered as the next fallback

### Add a provider adapter (backend)

The adapter system follows the same pluggable pattern as auth providers. Use `src/adapters/` to add new provider types:

1. Create `src/adapters/yourprovider.js` extending `ProviderAdapter` (from `src/adapters/base.js`):

```js
import ProviderAdapter from './base.js'
import { Readable } from 'stream'

export default class YourProviderAdapter extends ProviderAdapter {
  static get type() { return 'yourprovider' }

  buildUrl(baseUrl) { /* return the API endpoint URL */ }
  buildHeaders(apiKey) { /* return headers object */ }

  async chat(provider, requestBody, signal) {
    // Transform request to provider format, call fetch, transform response
  }

  async stream(provider, requestBody, signal) {
    // Return a Node.js Readable streaming SSE-formatted chunks
  }

  async testConnection(apiUrl, apiKey) {
    // Return { valid: true } or { valid: false, error: '...' }
  }
}
```

2. Register in `src/adapters/index.js`:
```js
import YourProviderAdapter from './yourprovider.js'
registerAdapter('yourprovider', YourProviderAdapter)
```

3. The factory auto-caches singleton instances — no additional wiring needed.

### Create a custom AuthProvider

The auth system is pluggable. To add your own authentication:

1. Create `src/auth/yourprovider.js` that extends `AuthProvider` (from `src/auth/base.js`):

```js
import AuthProvider from './base.js'

export default class MyProvider extends AuthProvider {
  static get type() { return 'myprovider' }

  get loginView() { return 'oauth' }   // 'oauth' | 'none'

  async getLoginConfig() {
    // Return data for the login UI
    // For 'oauth': { providers: [{ id, name, providerId }] }
    return { providers: [...] }
  }

  async initiateLogin({ provider }) {
    // Called when user clicks a provider button
    // Return { redirect: url } to send the browser there
    return { redirect: 'https://...' }
  }

  async login(credentials) {
    // Called with the result of the OAuth flow
    // Authenticate and return { sessionId, user }
    return { sessionId, user: { email, name, avatar } }
  }

  async logout(sessionId) {
    // Destroy session (delete from DB, log history)
  }

  async getSession(sessionId) {
    // Return session object or null
  }
}
```

2. Set `auth.provider` in `config.json` to the provider type name

## Provider-agnostic rule

Relio must **always be provider-agnostic**. Every adapter or utility must apply to ALL provider types uniformly:

- ❌ No code that detects a specific provider name, URL pattern, or model list
- ❌ No special-casing for `google`, `openai`, `anthropic`, `azure`, or any particular vendor
- ✅ Always use patterns in `src/adapters/base.js` for shared behavior (e.g. `ProviderAdapter.extractErrorMsg()`)
- ✅ Error handling, response parsing, timeouts, and retries must follow the same logic for every `provider_type`
- ✅ When a provider returns non-standard formats (e.g. array `[{error}]` instead of object `{error}`), handle it generically in `base.js` so all adapters benefit

If a fix would require detecting a specific provider, rethink the approach. The adapter architecture is designed so that `provider_type` is the only dimension of variation.

Interface reference: `src/auth/base.js` has full JSDoc documentation.

## Commands

```bash
npm run dev        # Backend with watch + frontend auto-build
npm start          # Production
npm test           # Tests
npm run build      # Build frontend only
```

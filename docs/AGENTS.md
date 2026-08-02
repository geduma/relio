# AGENTS.md — Relio

Instructions for AI assistants working on this codebase.

## Stack

- **Runtime:** Node.js 20+ (ESM — `"type": "module"`)
- **Backend:** Express.js 4.x
- **DB:** better-sqlite3 (synchronous, no ORM)
- **Frontend:** React 18 + Vite 7 (no TypeScript)
- **HTTP:** Native `fetch` (no axios)
- **Auth:** Local API Keys (bearer token on `/v1/*`). No login — dashboard is open
- **Testing:** Vitest
- **Lint:** ESLint 9 (flat config, `eslint.config.mjs`)
- **Docker:** multi-stage in `docker/` (non-root, HEALTHCHECK)

## Code Conventions

- **No comments** in source code (JSDoc allowed where needed)
- **ESM** — use `import`/`export`, never `require`
- **Filenames:** kebab-case (`auth.routes.js`, `cacheManager.js`)
- **React component names:** PascalCase (`ProvidersList.jsx`, `Metrics.jsx`)
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
├── config.js             # Reads config.json + env overrides
├── db.js                 # SQLite helpers + migrations
├── services/             # Pure logic (no Express)
│   ├── authService.js    # API key management + validation
│   ├── failoverEngine.js # Provider selection, rate/daily limits
│   ├── circuitBreaker.js # healthy/cooldown/paused states
│   ├── cacheManager.js   # Hash + TTL cache
│   └── metricsLogger.js  # Logging + daily metrics
├── middleware/
│   └── authMiddleware.js # API Key validation (/v1/*)
├── routes/               # Express routers
│   ├── providers.routes.js
│   ├── metrics.routes.js
│   ├── keys.routes.js    # /admin/api/keys
│   ├── chat.routes.js    # /admin/api/chat/* (dashboard chat test)
│   └── proxy.routes.js   # /v1/*
├── handlers/
│   ├── requestHandler.js # Cache → failover → response
│   └── dashboardHandler.js
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

## Configuration

All settings live in `config.json` at the project root. `src/config.js` reads this file at startup and exposes the parsed object as `config`.

To add a new key, add it to `config.json`, `config.example.json`, and update the README table.

`process.env` overrides are supported: `PORT`, `HOST`, `NODE_ENV`, `DB_PATH`, `CONFIG_PATH`, and `ENCRYPTION_KEY`.

### Env vars

| Env | Type | Default | Effect |
|---|---|---|---|
| `CONFIG_PATH` | string | `./config.json` | Path to the JSON config file |
| `PORT` | number | from `config.json` | HTTP listen port |
| `HOST` | string | from `config.json` | Listen address (`0.0.0.0` in prod) |
| `NODE_ENV` | string | from `config.json` | `development` / `production` |
| `DB_PATH` | string | from `config.json` | SQLite file path (e.g. `:memory:`) |
| `ENCRYPTION_KEY` | string | from `config.json` | Overrides `security.encryptionKey` |

### Security / relay settings

- `security.encryptionKey` (**required**, ≥ 32 chars): AES-256-GCM key for provider API keys at rest + used to hash client API keys. Overridable via `ENCRYPTION_KEY` env. The server refuses the example placeholder.
- `server.trustedProxy` (default `false`): set to `true` only when Relio sits behind a trusted reverse proxy — enables `trust proxy` and honors `X-Forwarded-For`.
- `relay.exposeProvider` (default `false`): when `true`, responses include the resolved `_provider` metadata.
- `relay.streamTimeoutSeconds` (default `300`): max duration for streaming requests.
- `relay.streamIdleTimeoutMs` (default `30000`): abort a stream if no data arrives for this long.
- `rateLimit.dashboardPerMinute` (default `120`): dashboard API requests per min.
- `rateLimit.proxyPerMinute` (default `120`): `/v1` requests per min, keyed by API key + IP.

### API key storage (S1)

- Client API keys (`llm_pk_*`) are stored **hashed** (SHA-256) in `api_keys.key_hash`, plus a 10-char `key_prefix` for display. The raw key is shown once at creation.
- `src/db.js` exports `hashApiKey(key)`. Use it — never store raw keys.
- `authService.createApiKey()` returns the raw key to the caller (shown once); `validateApiKey()` looks up by `key_hash`.

### SSRF guard (S3)

- `src/utils/ssrf.js` exports `assertPublicUrl(url)` — rejects localhost/loopback, private/link-local addresses (IPv4 + IPv6) and non-http(s) protocols via DNS resolution.
- Used in `providers.routes.js` on create/update/test-connection.

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

- React 18 with React Router v7
- Vite 7 with proxy to Express in dev (`vite.config.js`)
- Build output in `frontend/dist/` — served as static by Express
- No TypeScript, no CSS framework, no external libs (only react + react-router-dom)
- Styles in `frontend/src/style.css` (plain CSS, no modules)

### Theme

- **Dark mode by default** using CSS custom properties on `:root`
- `.light-mode` class on `body` overrides variables for light theme
- Toggle in sidebar (Dashboard) persists to `localStorage('relio-theme')`

### Components

| Component | Route | Purpose |
|---|---|---|
| `Dashboard.jsx` | `/admin/*` | Layout + internal routing + theme toggle |
| `ProvidersList.jsx` | `/admin/dashboard/providers` | List with reorder |
| `ProviderForm.jsx` | Modal | Create/edit provider |
| `Metrics.jsx` | `/admin/dashboard/metrics` | Stats + table |
| `ApiKeys.jsx` | `/admin/dashboard/keys` | CRUD API keys |
| `Logs.jsx` | `/admin/dashboard/logs` | Requests table |
| `Chat.jsx` | `/admin/chat` | Chat interface to test providers |
| `Pagination.jsx` | — | Shared paginator + `usePagination` hook (tables) |

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

Use `src/adapters/` to add new provider types:

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

## Provider-agnostic rule

Relio must **always be provider-agnostic**. Every adapter or utility must apply to ALL provider types uniformly:

- ❌ No code that detects a specific provider name, URL pattern, or model list
- ❌ No special-casing for `google`, `openai`, `anthropic`, `azure`, or any particular vendor
- ✅ Always use patterns in `src/adapters/base.js` for shared behavior (e.g. `ProviderAdapter.extractErrorMsg()`)
- ✅ Error handling, response parsing, timeouts, and retries must follow the same logic for every `provider_type`
- ✅ When a provider returns non-standard formats (e.g. array `[{error}]` instead of object `{error}`), handle it generically in `base.js` so all adapters benefit

If a fix would require detecting a specific provider, rethink the approach. The adapter architecture is designed so that `provider_type` is the only dimension of variation.

## Commands

```bash
npm run dev          # Backend with watch + frontend auto-build
npm start            # Production (prestart builds frontend/dist if missing)
npm test             # Tests
npm run test:coverage# Coverage report
npm run lint         # ESLint (src, tests, scripts, frontend/src)
npm run build        # Build frontend only
```

## Notes

- `npm start` runs `prestart` (`scripts/prestart.js`) which builds `frontend/dist` if `index.html` is missing.
- `config.js` falls back to `config.example.json` if `config.json` is absent (so CI works with `ENCRYPTION_KEY` set).
- `isDailyLimitExceeded()` caches the used-token sum for 10s per provider/day (`clearDailyLimitCache()` exported for tests).
- `recordSuccess()` is a no-op when the provider is already healthy (one read instead of a write transaction).

# AGENTS.md — Relio

Instructions for AI assistants working on this codebase.

## Stack

- **Runtime:** Node.js 18+ (ESM — `"type": "module"`)
- **Backend:** Express.js 4.x
- **DB:** better-sqlite3 (synchronous, no ORM)
- **Frontend:** React 18 + Vite 5 (no TypeScript)
- **HTTP:** Native `fetch` (no axios)
- **Auth:** Geduma API (OAuth) + local API Keys
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
import { dbAll, dbGet, dbRun, dbExec, dbTransaction } from '../db.js'

// Queries
const rows = dbAll('SELECT * FROM providers WHERE type = ?', ['chat'])
const row  = dbGet('SELECT * FROM providers WHERE id = ?', [id])
const result = dbRun('UPDATE providers SET name = ? WHERE id = ?', [name, id])
```

- **Never** use `db.prepare().all()` directly — always use helpers
- **Transactions** via `dbTransaction(fn)`
- **WAL mode** enabled by default
- **`:memory:`** for tests

## Architecture

```
src/
├── index.js              # Express setup, routes, static, error handler
├── config.js             # Lazy env var getters
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
│   └── proxy.routes.js   # /v1/*
├── handlers/
│   ├── requestHandler.js # Cache → failover → response
│   └── dashboardHandler.js
├── external/
│   └── gedumaClient.js   # Native fetch to Geduma API
└── utils/
    ├── logger.js         # File app logger
    └── validators.js     # URL, type, sanitize
```

### Proxy Request Flow

1. `proxy.routes.js` receives POST → `authMiddleware.requireApiKey`
2. `requestHandler.processRequest()`:
   - Computes `queryHash` → checks cache
   - Cache hit → returns immediately
   - Cache miss → `selectProviders(modelType)` ordered by `order_position`
   - For each provider: checks `isProviderAvailable()`, `isRateLimitExceeded()`, `isDailyLimitExceeded()`
   - `callProvider()` with 30s timeout
   - Success → `recordSuccess()`, `setCache()`, `logRequest()`, `updateMetrics()`
   - Failure → `recordFailure()`, next provider
3. All failed → 503

### Login Flow

1. `GET /admin/api/auth/providers` → Geduma API → OAuth buttons
2. User clicks → redirect to OAuth provider → callback to `/admin/api/auth/callback`
3. `POST /admin/api/auth/login` (or callback) → Geduma API → `loginWithGeduma()`
4. Creates local session, sets `relio_session` cookie, redirects to dashboard

## Environment Variables

All read lazily via getters in `src/config.js`. Add new variables like this:

```js
export const config = {
  newModule: {
    get newVar() { return env('NEW_VAR', 'default') },
  },
}
```

Always add to `.env.example` and the README table.

## Tests

```bash
npm test                  # Run once
npm run test:watch        # Watch mode
```

- Tests in `tests/` with Vitest
- Use `:memory:` for DB in tests (set in `beforeAll` via `process.env.DB_PATH`)
- Use dynamic `await import(...)` in tests so env vars are set before import
- Mock Geduma API with `vi.mock` or by intercepting fetch

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

### Components

| Component | Route | Purpose |
|---|---|---|
| `Login.jsx` | `/admin/login` | OAuth login buttons |
| `Dashboard.jsx` | `/admin/dashboard/*` | Layout + internal routing |
| `ProvidersList.jsx` | `/admin/dashboard/providers` | List with reorder |
| `ProviderForm.jsx` | Modal | Create/edit provider |
| `Metrics.jsx` | `/admin/dashboard/metrics` | Stats + table |
| `ApiKeys.jsx` | `/admin/dashboard/keys` | CRUD API keys |
| `Logs.jsx` | `/admin/dashboard/logs` | Requests table |

## Docker

```bash
# Build and run
docker compose -f docker/docker-compose.yml up --build

# Structure
docker/
├── Dockerfile            # Multi-stage build
├── docker-compose.yml    # Port 3000, volumes for db/logs
└── .dockerignore
```

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

### Add an LLM provider

1. Dashboard → Add Provider
2. Fill in: name, API URL, API Key, model, type, costs
3. Auto-ordered as the next fallback

## Commands

```bash
npm run dev        # Backend with watch + frontend auto-build
npm start          # Production
npm test           # Tests
npm run build      # Build frontend only
```

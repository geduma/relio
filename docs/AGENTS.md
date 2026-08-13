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

Key tables:

- `providers` — provider definitions; `health_failures` column tracks consecutive failed probes (reset to 0 on success/activation)
- `provider_health_checks` — one row per provider (PK = `provider_id`), representing the **latest** probe result. Truncated on every full `runHealthCheck()` (no history); manual per-provider checks upsert a single row
- `circuit_breaker_state` — healthy/cooldown/paused state shared by failover and health checks

### Health check job

`src/services/healthCheck.js`:

- `startHealthCheckScheduler()` / `stopHealthCheckScheduler()` — self-re-arming `setTimeout`; the next delay is recomputed from `config.healthCheck.intervalMinutes` on every cycle, so config edits apply live. `settings.routes.js` restarts it when a `healthCheck.*` key is saved.
- `runHealthCheck()` — no-op when `enabled` is false; truncates `provider_health_checks`, probes every `active` provider in order, applies results.
- `checkAndApply(provider)` — probe → classify → `paused` (permanent errors, or after `pauseAfterConsecutiveFailures`) or `cooldown` (transient) → upsert health record. A successful probe reactivates a paused/cooldown provider.
- `probeProvider()` — minimal chat (`max_tokens: 1`) or embeddings (`input: 'ping'`) request with an abort timeout.
- Cooldown/pause reuse the same statuses as failover (`providers.status`, `circuit_breaker_state`), so the daily `recoverCooldowns` maintenance re-activates expired cooldowns.

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
│   ├── healthCheck.js    # Periodic provider probes (scheduler + classification)
│   ├── cacheManager.js   # Hash + TTL cache
│   └── metricsLogger.js  # Logging + daily metrics
├── middleware/
│   └── authMiddleware.js # API Key validation (/v1/*)
├── routes/               # Express routers
│   ├── providers.routes.js
│   ├── metrics.routes.js
│   ├── health.routes.js  # /admin/api/health (+ POST /check)
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

`testProviderConnection()` in `providers.routes.js` delegates to the adapter's `testConnection(apiUrl, apiKey, { model })`. For `openai-compatible`, validation first calls `GET {baseUrl}/models`; on `200` the connection is valid (no chat probe is sent). Only when `/models` is `404` (some providers don't expose it) does it fall back to a minimal chat-completions probe that reuses the configured `model` when available. In the probe, only `401`/`403` mean an invalid key; a `4xx` with an OpenAI-style JSON error body (e.g. "Invalid model") proves the endpoint and key are valid, so it passes. A `404` with a non-JSON body means the endpoint path is wrong.

### Proxy Request Flow

1. `proxy.routes.js` receives POST → `authMiddleware.requireApiKey`
2. `requestHandler.processRequest()`:
   - If a specific `providerId` is selected and it is **not** in the key's `allowedProviderIds`, throws a `provider_access_denied` error (403) **before** any cache lookup or provider call
   - Computes `queryHash` → checks cache
   - Cache hit → returns immediately
   - Cache miss → `selectProviders(capability, allowedProviderIds)` ordered by `order_position`, already filtered to the key's allowed providers
   - For each provider: checks `isProviderAvailable()`, `isRateLimitExceeded()` (in-memory), `isDailyLimitExceeded()` (via `metrics` table)
   - `callProvider()` → `getAdapter(provider.provider_type)` resolves adapter from registry (singleton cache) → `adapter.chat()` with 30s timeout
   - Success → `recordSuccess()`, `setCache()`, `enqueueLog()`, `enqueueMetric()`
   - Retryable failure (network/5xx/408/429) → `recordFailure()`, next provider; non-retryable (4xx) → thrown immediately, no failover
3. All failed (or zero providers allowed) → 503

### Streaming Flow

1. `proxy.routes.js` detects `stream: true` in request body → `handleStreamingRequest()` (dashboard `chat.routes.js` mirrors this via `handleStreamingSend`; both use the shared `createStreamSession()` from `src/services/streamSession.js` and message helpers from `src/utils/streamErrors.js`)
2. `createStreamSession(res, { idleMs, maxDurationMs, keepAliveMs, startTime, sseHeaders })` owns the `AbortController`, the abort-reason taxonomy (`client_disconnect` | `idle_timeout` | `max_duration` | `upstream_error`), the idle/max-duration timers, the keep-alive timer, and TTFT tracking. It attaches `res.on('close')` from the start so a client abort aborts the upstream fetch even before the stream starts. `start()` writes the SSE headers and arms the timers; `run(stream)` pipes the adapter stream to `res` (backpressure + byte-for-byte passthrough through the `StreamUsageTracker`) and returns `{ ttftMs, usage }`; `dispose()` clears timers and the `close` listener
3. Resolves provider: for a specific provider name/ID, it must be in the key's `allowedProviderIds` (otherwise immediate `403 provider_access_denied`); in failover mode it uses `selectProviders('chat', allowedProviderIds)` skipping paused/cooldown/rate-limited/daily-limited providers
4. `streamProvider()` → `getAdapter(provider.provider_type)` → `adapter.stream()` returns a Node.js `Readable`; the fetch is called with `session.signal`
5. Selection failure handling (pre-headers):
   - If `session.isAborted()` (client disconnected / max duration while still waiting for the upstream), the retry loop **stops immediately and records no circuit failure** — a client disconnect or hard duration cap is not a provider fault, so it must not push a healthy provider into cooldown (this was the root cause of the "No available provider for streaming" 404 cascade)
   - Genuine upstream errors keep the previous behavior: `recordProviderFailure()` for rate/quota kinds, `recordFailure()` (circuit) for retryable kinds, then the loop moves to the next provider
6. Timeout semantics (all read from `config.relay` at request time):
   - `streamTimeoutSeconds` → hard total ceiling from request start (`max_duration`)
   - `streamIdleTimeoutMs` → aborts if no **real upstream data** arrives (`idle_timeout`). Only upstream data resets it — SSE keep-alive comments do **not**
   - `streamKeepAliveMs` → writes `: keep-alive\n\n` to the client when no upstream data has arrived for that long. It never resets the idle timer (which is what actually detects a dead upstream). Keep it below `streamIdleTimeoutMs` or it is useless
7. On success: `recordSuccess()`, `enqueueLog()`, `enqueueMetric()` — the log records `ttft_ms` (time to first chunk, `null` when no content ever arrived) and, when the upstream includes a `usage` field in a final SSE chunk, `input_tokens`/`output_tokens` (captured by a pass-through `StreamUsageTracker` transform inserted between the adapter stream and `res`; chunks are forwarded byte-for-byte unchanged). The relay never buffers or rewrites the stream.
   - Token capture works for every provider type: the `openai-compatible` adapter auto-requests `stream_options.include_usage: true` (OpenAI/Ollama), the `azure-openai` adapter does the same but only when the effective `api-version` supports it (`>= 2024-10-21`, else graceful degradation), and the `anthropic`/`gemini-native` adapters already map their native usage (`message_delta` / `usageMetadata`) into the OpenAI-style SSE chunks the tracker reads.
8. On mid-stream interruption (after headers were sent): the interruption is **logged** with `statusCode: 503` and a descriptive `error_message` (`Stream aborted: client disconnected` / `idle timeout (no data received)` / `max duration exceeded` / the upstream error). No SSE error frame is sent to the client — the stream closes as before (transparent passthrough). Failover is never attempted once headers are sent. Circuit penalties:
   - `idle_timeout` → exactly **one** `recordFailure()` (a real dead upstream is a health signal)
   - `client_disconnect` and `max_duration` → no penalty (not provider faults)
   - genuine upstream error → no penalty mid-stream (matches prior behavior)
9. When no provider resolves (all paused/cooldown/limited, or the only attempt aborted), the response is a **503** `No available provider for streaming (all providers paused, in cooldown, or rate/daily limited)` — never a 404 — so clients can retry. Non-streaming request timeouts (`relay.requestTimeoutMs`) are reported as `Request timed out after ${requestTimeoutMs}ms` instead of leaking the raw `This operation was aborted`

### Models Endpoint

`GET /v1/models` (in `proxy.routes.js`) does **not** call upstream providers. It reads the `providers` table via `selectProviders('chat', allowed)` + `selectProviders('embeddings', allowed)` where `allowed` is the requesting key's `allowedProviderIds`, excludes providers named `auto` (`FAILOVER_MODEL`), dedupes by name, and maps each available provider to an OpenAI-compatible entry `{ id: name, object: 'model', created, owned_by: 'relio' }` where `id` is the provider name (the model selector clients send back to `/v1/*`). The reserved `auto` entry (`{ id: 'auto', object: 'model', created: 0, owned_by: 'relio' }`) is returned first whenever the key has at least one provider assigned and enables failover/proxy mode. Paused and in-cooldown providers are excluded. The response is cached for 60s **per API key** (a `Map` keyed by `req.apiKey.id`; `invalidateModelsCache()` clears it entirely).

### Reserved provider name

`auto` (`FAILOVER_MODEL`) is the failover/proxy selector. `providers.routes.js` rejects creating or renaming a provider to `auto` (case-insensitive, trimmed) with a 400, and `ProviderForm.jsx` blocks it client-side.

## Configuration

All settings live in a single `config/` folder at the repo root, shared by npm, pm2 and Docker:

```
config/
├── config.example.json    # template (versioned)
└── config.json            # real config (gitignored)
```

`src/config.js` reads `config/config.json` at startup (override with `CONFIG_PATH`) and exposes the parsed object as `config`. In Docker, `../config` is mounted at `/app/config` and `CONFIG_PATH=/app/config/config.json` points at the same file.

To add a new key, add it to `config/config.json`, `config/config.example.json`, and update the README table.

`process.env` overrides are supported: `PORT`, `HOST`, `NODE_ENV`, `DB_PATH`, `CONFIG_PATH`, and `ENCRYPTION_KEY`.

### Env vars

| Env | Type | Default | Effect |
|---|---|---|---|
| `CONFIG_PATH` | string | `./config/config.json` | Path to the JSON config file |
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
- `relay.streamKeepAliveMs` (default `15000`): send an SSE keep-alive comment to the client when no upstream data has arrived for this long (`0` disables). Does **not** reset the idle timeout.
- `relay.routingStrategy` (default `order`): how the proxy picks the starting provider in `auto` mode. `order` or `least-used` (provider with fewest tokens used today). Editable from the dashboard (Settings → Load balancer) and persisted to `config.json`; takes effect on restart.
- `rateLimit.dashboardPerMinute` (default `120`): dashboard API requests per min.
- `rateLimit.proxyPerMinute` (default `120`): `/v1` requests per min, keyed by API key + IP.
- `relay.tokenOptimization.enabled` (default `false`): when `true`, request bodies are normalized/minified before cache hashing and before being sent to the provider. Only applies to proxy-managed requests (all `/v1/*` paths, dashboard chat via proxy, and dashboard chat direct calls).
- `relay.tokenOptimization.logSavings` (default `true`): records the estimated tokens saved per request in `requests_log.tokens_saved_estimate`. `false` keeps optimizing but stores `0`.
- `relay.tokenOptimization.aggressiveNormalization` (default `false`): also maps typographic characters (curly quotes, em/en dashes, ellipsis) to ASCII in message content.
- `healthCheck.enabled` (default `true`): runs the periodic provider health-check job.
- `healthCheck.intervalMinutes` (default `1440`): how often all active providers are probed (every 24h). Editable from **Settings → Health Check**; `settings.routes.js` restarts the scheduler on save so it applies without a restart.
- `healthCheck.timeoutMs` (default `10000`): per-probe timeout; a timeout is classified as transient (cooldown).
- `healthCheck.pauseAfterConsecutiveFailures` (default `2`): consecutive failures after which a transiently-failing provider is paused. Permanent errors (auth, quota/billing, model/endpoint not found) pause on the first failure.

### API key storage and provider scoping (S1)

- Client API keys (`relio_sk_*`) are stored **hashed** (SHA-256) in `api_keys.key_hash`, plus a 10-char `key_prefix` for display. The raw key is shown once at creation. The format is `relio_sk_` + 64 lowercase hex chars (32 random bytes); `authService.isValidApiKeyFormat(key)` matches `/^relio_sk_[0-9a-f]{64}$/`, and `authMiddleware.requireApiKey` fast-fails malformed tokens with `403` before any DB lookup.
- `src/db.js` exports `hashApiKey(key)`. Use it — never store raw keys.
- The N:N table `api_key_providers` (`api_key_id`, `provider_id`, both `TEXT` with `ON DELETE CASCADE`) defines which providers each key can access. A key must have **at least one** provider; validated on create and on edit (400 if empty or if any provider ID doesn't exist).
- `authService.createApiKey({ name, providerIds })` inserts the key + its provider rows inside a transaction and returns the raw key (shown once). `authService.updateApiKeyProviders(keyId, providerIds)` replaces the assignment and invalidates the in-memory key cache so the change applies immediately. `validateApiKey()` returns the key row plus `allowedProviderIds` (loaded with a single JOIN, cached for 5 min; invalidated on PATCH/revoke).
- In `authMiddleware.requireApiKey`, `req.apiKey.allowedProviderIds` is available to downstream code. `processRequest()` and `handleStreamingRequest()` take it as `allowedProviderIds`; the dashboard chat routes don't pass it, so they are unaffected.
- Unauthorized specific-provider requests return `403` with `{ error: { message: "API key does not have access to this provider", type: "invalid_request_error", code: "provider_access_denied" } }` — sent directly, **not** through `normalizeError()`. A nonexistent provider still returns the existing `400 unknown_provider`.

### SSRF guard (S3)

- `src/utils/ssrf.js` exports `assertPublicUrl(url)` — rejects localhost/loopback, private/link-local addresses (IPv4 + IPv6) and non-http(s) protocols via DNS resolution.
- Used in `providers.routes.js` on create/update/test-connection.
- `config.security.allowedPrivateHosts` (array of hostnames/IPs, default `[]`, editable from Settings → Security) exempts matching hosts from the check — the normalized hostname and each resolved IP are compared against it. Non-allowlisted private URLs keep being rejected.

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
| `ApiKeys.jsx` | `/admin/dashboard/keys` | CRUD API keys + provider scoping (multi-select, edit) |
| `Logs.jsx` | `/admin/dashboard/logs` | Requests table |
| `Chat.jsx` | `/admin/chat` | Chat interface to test providers |
| `Pagination.jsx` | — | Shared paginator + `usePagination` hook (tables) |

## Docker

```bash
# Build and run (config/config.json is bootstrapped by the entrypoint if missing)
mkdir -p config
cp config/config.example.json config/config.json  # edit as needed
docker compose -f docker/docker-compose.yml up --build

# Structure
docker/
├── Dockerfile            # Multi-stage build, copies config/config.example.json for bootstrap
├── docker-compose.yml    # Port 3000, volumes for db/logs + ../config (CONFIG_PATH=/app/config/config.json)
└── .dockerignore
```

The config file is mounted as a **directory** (`../config` → `/app/config`) rather than a single file, because the app writes `config.json` atomically (`rename` over a temp file) and Docker returns `EBUSY` on single-file bind mounts. The entrypoint `setup-config-perm.sh` runs as root, ensures `/app/config/config.json` exists (copies from the baked `config.example.json` if missing), chowns it to `node:node` with `664`, then drops to the `node` user to start the app. This is the same `config/config.json` that npm and pm2 use — all three runtimes share one file.

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

## Adapter invariants

- **Never send `headers: { Connection: 'close' }`** in adapter `fetch()` calls. Node 20 (undici) reuses keep-alive connections by default; an explicit `Connection: close` disables that and adds a new TLS/TCP handshake per request. The only allowed `Connection: keep-alive` headers are the SSE responses to the client in `proxy.routes.js`/`chat.routes.js` (outbound to the client, not the upstream provider).

## Write buffering (logQueue)

`src/services/logQueue.js` is the single write path for `requests_log`, `metrics`, API-key touches, and circuit-breaker counters. `enqueueLog`/`enqueueMetric`/`enqueueApiKeyTouch`/`enqueueCircuitCounter` are fire-and-forget (in-memory push); a flush (`flushAll()` or the `setInterval` timer) applies everything in one `better-sqlite3` transaction. Parameters come from `relay.writeBuffer.{flushIntervalMs,maxBufferSize}` (default `500`/`50`) and are read at flush time (hot-reload via the settings API works).

- **Risk (by design):** rows buffered for up to `flushIntervalMs` are lost if the process crashes hard (`SIGKILL`, power loss). The shutdown handler (`src/index.js`) calls `flushAll()` on `SIGTERM`/`SIGINT` to drain the buffers before closing the DB. This trade-off is explicit.
- Circuit-breaker **state transitions** (healthy → cooldown, immediate cooldown, success reset) are always synchronous — they affect failover decisions on the next request. Only intermediate `failure_count` increments are buffered; the running count is tracked in memory (`circuitBreaker.js`) so the cooldown threshold still fires correctly between flushes.

## Token optimization

`src/services/tokenOptimizer.js` exports pure, deterministic functions (`optimizeRequestBody`, `estimateTokens`) that reduce the input-token footprint of request bodies. It is **lossless** for JSON content (minifies whitespace while preserving number/string literals byte-for-byte) and **never touches code blocks** inside markdown fences. The requestHandler wrapper `optimizeRelayBody()` gates on `config.relay.tokenOptimization.*` and is used by every request path (non-streaming and streaming `/v1/*`, plus all four dashboard chat paths).

- Optimizations applied: strip invisible/control characters, collapse blank lines and trim non-fenced whitespace, minify embedded JSON (including `tool_calls[].function.arguments` and tool/function descriptions), dedupe identical system messages, and dedupe consecutive identical messages.
- `aggressiveNormalization: true` additionally maps typographic chars (curly quotes, em/en dashes, ellipsis) to ASCII in message content.
- The optimizer runs **before** `generateHash`, so the cache key and the stored `request_body` reflect the optimized body. This keeps cache hits consistent between streaming and non-streaming paths (dashboard streaming hashes `optimizeRelayBody({ messages }).body` to match `processRequest`).
- The estimated tokens saved (`estimateTokens(originalJson) - estimateTokens(optimizedJson)`, ~4 chars/token) is stored in `requests_log.tokens_saved_estimate` (migrated with `ALTER TABLE ... ADD COLUMN` in `db.js`), surfaced in `metricsLogger.getMetrics().totals.tokens_saved_estimate` and `getSummary().today_tokens_saved`.
- **Provider-agnostic invariant:** normalization applies uniformly to all providers; never special-case a vendor here.

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
- `config.js` falls back to `config/config.example.json` if `config/config.json` is absent (so CI works with `ENCRYPTION_KEY` set).
- `isDailyLimitExceeded()` caches the used-token sum for 10s per provider/day (`clearDailyLimitCache()` exported for tests).
- `recordSuccess()` is a no-op when the provider is already healthy (one read instead of a write transaction).

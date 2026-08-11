# Relio — LLM Relay

> **Personal-use, self-hosted LLM proxy.** Relio centralizes multiple LLM providers behind a single OpenAI-compatible API, with automatic failover, caching, audit logging, and a management dashboard.

## Philosophy

Relio does not attempt to evaluate the quality, cost, or capabilities of models. It treats every provider as a black box. Model selection, and the order or weighting of providers, are decisions left entirely to the user.

## Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express.js |
| Database | SQLite (better-sqlite3) |
| Frontend | React + Vite (self-served by Express) |
| HTTP Client | Native fetch (Node 20+) |
| Auth | Local API Keys (`/v1/*`) |
| Testing | Vitest |
| Infra | Docker multi-stage (`docker/`) |

## Features

- **OpenAI-compatible proxy** — `/v1/chat/completions`, `/v1/embeddings`, `/v1/models`
- **Automatic failover** — tries providers in order (Main → Fallback 1 → N)
- **Circuit breaker** — auto-cooldown after N consecutive failures
- **Quota/rate-aware failover** — `402`/`413`/`429` (and Anthropic `529`) trigger immediate provider cooldown and continue with the next provider, including for streaming requests
- **Persistent cache** — identical responses never reach the provider
- **Rate limiting** — per-provider controls (req/min, tokens/day)
- **Estimated costs** — per-provider input/output token pricing
- **Full audit trail** — every request logged to SQLite
- **Local API Keys** — for AI agents, with per-key provider scoping and revocation
- **Dashboard** — visual provider management, metrics, logs, API keys
- **Settings** — edit all `config.json` options (server, cache, relay, rate limits) from the dashboard, persisted back to the file
- **Daily metrics** — requests, tokens, costs, errors, cache hits
- **Provider health checks** — periodic minimal probes of active providers that automatically pause or cool down failing ones, visible under **Metrics → Provider Health**
- **Chat dashboard** — test LLM providers directly from the UI with response time display
- **Dark mode** — toggleable theme (dark by default) with localStorage persistence
- **Auto-maintenance** — daily backups, data retention cleanup
- **Provider Type Abstraction** — pluggable adapters for OpenAI-compatible, Anthropic, Gemini, and Azure OpenAI with canonical response normalization
- **Normalized errors** — all errors follow `{error: {message, type, code}}` OpenAI format
- **Structured output** — JSON mode via `response_format`
- **Tool choice** — native adapters respect `tool_choice` parameter

## Requirements

- Node.js 20+
- npm

## Quick Start

```bash
git clone <repo> relio
cd relio

mkdir -p config
cp config/config.example.json config/config.json
# Edit config/config.json — set security.encryptionKey (openssl rand -hex 32) and your provider settings

npm run install:all  # installs backend (root) + frontend dependencies

npm run dev
```

Alternatively, install each one manually:

```bash
npm install
cd frontend && npm install && cd ..
```

Open `http://localhost:3000/admin` — the dashboard requires no login.

## Configuration

All settings are in `config/config.json` (a single folder shared by npm, pm2 and Docker). Copy the template and edit:

```json
{
  "security": { "encryptionKey": "replace-with-a-random-64-char-hex-string" },
  "db": { "path": "./db/db.sqlite" },
  "cache": { "ttlSeconds": 2592000 },
  "server": {
    "port": 3000,
    "host": "0.0.0.0",
    "nodeEnv": "development",
    "trustedProxy": false
  }
}
```

| Key | Description |
|---|---|
| `security.encryptionKey` | **Required.** AES-256-GCM key used to encrypt provider API keys at rest and to hash API keys. Generate with `openssl rand -hex 32`. Overridable via `ENCRYPTION_KEY` env. The server refuses to start with the example placeholder or a key shorter than 32 chars |
| `db.path` | SQLite database file path (overridable via `DB_PATH` env) |
| `cache.ttlSeconds` | Cache TTL in seconds (default 30 days) |
| `server.port` | Server port (overridable via `PORT` env) |
| `server.host` | Server host (overridable via `HOST` env) |
| `server.nodeEnv` | `development` or `production` (overridable via `NODE_ENV` env) |
| `server.trustedProxy` | `false` (default). Set to `true` only behind a trusted reverse proxy so `X-Forwarded-For` is honored |
| `relay.exposeProvider` | `false` (default) — includes `_provider` in proxy responses. Set to `true` to expose resolved provider metadata |
| `relay.debugProviderRequests` | `false` (default) — when `true`, logs every outgoing provider request (method, URL, redacted headers, payload, response status/body) to `logs/app.log`. Useful to debug OpenAI-compatible providers |
| `relay.streamTimeoutSeconds` | Max duration for streaming requests (default `300`) |
| `relay.streamIdleTimeoutMs` | Abort a stream if no data arrives for this long (default `30000`) |
| `relay.requestTimeoutMs` | Max duration for non-streaming requests (default `30000`) |
| `relay.routingStrategy` | How the proxy picks the starting provider in failover (`auto`) mode. `order` (default, by provider order) or `least-used` (provider with the fewest tokens used today, balancing free-tier usage). Editable from the dashboard (Settings → Load balancer) |
| `relay.failoverOnQuota` | `true` (default) — when a provider answers `402` (billing), `413` (request too large) or `429` (rate limit/quota), the proxy applies an immediate cooldown and continues with the next provider (non-streaming **and** streaming). When `false`, `402`/`413` abort the request immediately and `429` is only handled by the circuit breaker as before. Editable from the dashboard |
| `relay.quotaCooldownSeconds` | Cooldown applied after a billing/quota error (`402`, `429` with a quota marker like `insufficient_quota`, `credit_balance_exhausted`, `quota_exceeded`, `spend_limit`). Default `3600` (1 hour). Editable from the dashboard |
| `relay.rateLimitCooldownSeconds` | Cooldown applied after a plain rate-limit `429`. Default `60`. Editable from the dashboard |
| `relay.retryAfterMaxSeconds` | When the provider sends `Retry-After` / `retry_after_seconds` / "retry in Ns", that value is used as the cooldown instead of the defaults, capped at this maximum. Default `900` (15 minutes). Editable from the dashboard |
| `relay.writeBuffer.flushIntervalMs` | How often buffered DB writes (requests_log, metrics, circuit-breaker counters) are flushed to SQLite in a single transaction. Default `500`. Lower = less data loss on crash, more write pressure |
| `relay.writeBuffer.maxBufferSize` | Maximum buffered rows before an immediate flush is forced. Default `50` |
| `relay.tokenOptimization.enabled` | `false` (default) — when `true`, the proxy normalizes and minifies request bodies (message whitespace, invisible characters, embedded JSON, duplicate system messages, tool-call arguments) before hashing for the cache and forwarding to the provider. The provider receives a semantically identical, compact request, so you pay for fewer input tokens |
| `relay.tokenOptimization.logSavings` | `true` (default) — records the estimated tokens saved per request in `requests_log.tokens_saved_estimate` (visible in Metrics). Set to `false` to keep optimizing without logging the estimate |
| `relay.tokenOptimization.aggressiveNormalization` | `false` (default) — additionally normalizes typographic characters (curly quotes, em/en dashes, ellipsis) to their ASCII equivalents in message content |
| `healthCheck.enabled` | `true` (default) — runs the periodic provider health-check job. When `false`, no automatic or manual checks run. Editable from the dashboard |
| `healthCheck.intervalMinutes` | How often all active providers are probed. Default `1440` (every 24 hours). Scheduler re-reads this live, so changing it via **Settings → Health Check** applies without a restart |
| `healthCheck.timeoutMs` | Time limit for a single probe before it is treated as a timeout failure (→ cooldown). Default `10000` |
| `healthCheck.pauseAfterConsecutiveFailures` | Consecutive failures after which a provider is paused instead of cooled down. Default `2`. Permanent errors (auth, quota/billing, model/endpoint not found) pause on the first failure regardless |
| `rateLimit.dashboardPerMinute` | Dashboard API requests per minute (default `120`) |
| `rateLimit.proxyPerMinute` | `/v1` requests per minute, keyed by API key + IP (default `120`) |

### Editing settings from the dashboard

The hot-applicable options (server nodeEnv, cache, relay) can be edited at **Settings** in the dashboard. Changes are written back to the physical `config.json` file (atomically) **and** applied to the running process immediately — **no restart needed**. Options that are only read at startup (`server.port`, `server.host`, `server.trustedProxy`, rate limits, `security.encryptionKey`, `db.path`) are shown as read-only in the UI with a note to edit `config.json` and restart the server. Fields overridden by an environment variable are shown with an `override:` badge and disabled. Rotate the encryption key via `config.json`/`ENCRYPTION_KEY` and re-enter provider keys, and change the database path via `config.json`/`DB_PATH`.

### Provider health checks

Relio can periodically probe every `active` provider with a minimal request (`{role: "user", content: "ping"}`, `max_tokens: 1` — a handful of tokens per provider) to catch dead or misconfigured providers before they break failover.

How it works:

- A scheduler runs the job every `healthCheck.intervalMinutes` (default every 24 hours). It skips the run entirely when `healthCheck.enabled` is `false`.
- Each probe has its own timeout (`healthCheck.timeoutMs`, default 10s). Timeouts are classified as transient.
- Results are classified and applied automatically:
  - **Transient failures** (rate limit `429`, `408`/`5xx`, timeout, network) move the provider to **cooldown** for the configured cooldown duration; it resumes automatically once the cooldown expires.
  - **Permanent failures** (auth `401/403`, quota/billing `402`/`429`-with-quota-marker, model/endpoint not found `404`/`400`) **pause** the provider immediately.
  - A provider that keeps failing with transient errors is paused once it reaches `healthCheck.pauseAfterConsecutiveFailures` (default 2).
- A provider that recovers (probe succeeds while paused/cooldown) is reactivated automatically.
- The dashboard exposes the results under **Metrics → Provider Health**, with a "Check all now" button (`POST /admin/api/health/check`), per-provider "Check", and "Reactivate" for paused/cooldown providers.

Because each probe is a single tiny request, health checks are cheap even on free-tier accounts — the default daily interval costs roughly tens of tokens per provider per month.

## Development

`npm run dev` compiles the frontend (`npm run build`) and starts the backend with file-watching. The backend serves the built frontend on `http://localhost:3000` — one command is enough:

```bash
npm run dev
```

Open `http://localhost:3000/admin`.

When you are iterating on frontend code, you can instead run the Vite dev server with hot reload; it proxies API requests to the backend:

```bash
# Terminal 1: Backend
npm run dev

# Terminal 2: Frontend (hot reload)
cd frontend && npm run dev
```

In that case the frontend runs on `http://localhost:5173` and proxies API requests to the backend.

## Authentication

The dashboard requires no login and is intended for **trusted networks only**. Only the proxy API (`/v1/*`) is protected by **local API Keys** (`relio_sk_xxx`), managed in the dashboard under *Keys*. Each key is scoped to a subset of providers (see [Provider scoping per API key](#provider-scoping-per-api-key)).

## Security

- **API keys at rest** — provider API keys are encrypted with AES-256-GCM using `security.encryptionKey`. Rotate the key by updating the config and re-entering provider keys.
- **Client API keys hashed** — your `relio_sk_*` keys are stored as SHA-256 hashes; only a 10-char prefix is displayed in the dashboard. The raw key is shown once at creation. Each key only has access to the providers explicitly assigned to it.
- **SSRF guard** — provider URLs are validated on create, on update (when the URL or API key changes), and on connection test to reject localhost, loopback, private and link-local addresses, and non-http(s) protocols.
- **Dashboard exposure** — the dashboard has no login; put it behind a trusted reverse proxy with authentication if exposed beyond your local network.
- **Encryption key** — `security.encryptionKey` is required (min 32 chars); the server refuses the example placeholder. Set it via `ENCRYPTION_KEY` in production.

## LLM Provider Adapters

Relio normalizes all LLM providers to an OpenAI-compatible format using a pluggable adapter system at `src/adapters/`. Each adapter handles request transformation, response normalization, streaming, and connection testing.

### Built-in adapters

| Provider Type | Auth | Endpoint | Notes |
|---|---|---|---|
| `openai-compatible` | Bearer token | `/v1/chat/completions` | Passthrough — works with any provider implementing the OpenAI Chat Completions API. Only `baseUrl` + `apiKey` + `model` are needed; connection validation tolerates providers that don't expose `GET /models` or reject probe models |
| `anthropic` | x-api-key | `/v1/messages` | Transforms request/response, includes tool calls and streaming |
| `gemini-native` | Bearer token | `/v1/models/{model}:generateContent` | Uses the native API (not the hosted platform), supports streaming |
| `azure-openai` | api-key header | `/chat/completions` | Appends `api-version` parameter automatically |

### Adding a custom adapter

Create `src/adapters/yourprovider.js` extending `ProviderAdapter` and register it in `src/adapters/index.js`. See `docs/AGENTS.md` for the full guide.

## `config.json` permissions setup

The configuration lives in a **single `config/` folder** at the repo root, shared by all runtimes (npm, pm2 and Docker):

```
config/
├── config.example.json    # template (versioned)
└── config.json            # real config (gitignored)
```

- **npm / pm2**: read `config/config.json` (the default path in `src/config.js`).
- **Docker**: mounts `../config` → `/app/config` and points `CONFIG_PATH=/app/config/config.json` — the same file.

The **directory** mount (not a single-file mount) is essential because the app writes `config.json` atomically (`rename` over a temporary file), and Docker **does not allow `rename` over a single-file bind mount** (`EBUSY` error).

The `setup-config-perm.sh` entrypoint runs as `root`, ensures `/app/config/config.json` exists (copying it from `config.example.json` if missing), sets permissions to `rw-rw-r--` and owner `node:node`, then launches the app as the `node` user. Thanks to the directory mount, the atomic `rename()` happens inside the same folder and the `EBUSY` error disappears.

With this, the dashboard can persist changes and you can edit `config/config.json` from the host with no manual steps.

### Deployment steps

```bash
# Restart the stack (tears down the existing container)
docker compose -f docker/docker-compose.yml down

# Rebuild the image and start the service
docker compose -f docker/docker-compose.yml up --build -d
```

Once run, verify:

- On the host: `ls -l config/config.json` – should show permissions `-rw-rw-r--`.
- Inside the container: `docker compose -f docker/docker-compose.yml exec relio ls -l /app/config/config.json` – same result.

## Docker

### Build and run

```bash
# Prepare the config (once)
mkdir -p config
cp config/config.example.json config/config.json
# Edit config/config.json — set security.encryptionKey (openssl rand -hex 32) and your providers

docker compose -f docker/docker-compose.yml up --build -d
```

On a clean install these steps are optional: the entrypoint creates `config.json` from the template on first start. You only need to set your `encryptionKey` (in `config/config.json` or via `ENCRYPTION_KEY`) for the app to start.

### Volumes

The compose file mounts persistent host directories (relative to `docker/`):

```
- ./db:/app/db
- ./logs:/app/logs
- ../config:/app/config:rw
```

The config file Docker uses is `config/config.json` at the repo root (edited from the host or the dashboard; both share the same file). `CONFIG_PATH` points to `/app/config/config.json`. You can override the key via an environment variable:

```bash
ENCRYPTION_KEY=... docker compose -f docker/docker-compose.yml up -d
```

The image runs the app as a non-root user (`node`), includes a healthcheck at `/admin/api/metrics/health`, and the entrypoint automatically prepares the `config.json` permissions on every start.

## Usage

### Dashboard

Open `http://localhost:3000/admin`. The sidebar includes a **theme toggle** (dark/light mode, persisted in localStorage).

1. Add providers — select **provider type** (openai-compatible, anthropic, gemini-native, azure-openai) and **capability** (chat, embeddings)
2. Order them: Main, Fallback 1, Fallback 2...
3. Generate API Keys for your AI agents — each key must be assigned at least one provider
4. Use the **Chat** tab to test providers interactively with response time display (toggle **Proxy** to route through the full failover/cache pipeline)

### Proxy API

The `model` field is a **provider selector**: use a provider name or ID to route directly to it, or `"auto"` to enable failover across providers. The model sent to each provider is always the one configured for that provider. The name `auto` is reserved for failover/proxy mode and cannot be used as a provider name.

```bash
# Route to a specific provider (uses its configured model)
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer relio_sk_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "MyProviderName",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# Failover mode (Main -> Fallback 1 -> ...)
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer relio_sk_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

An unknown provider returns `400` with `code: "unknown_provider"`.

#### Failover on provider errors

When a provider request fails, Relio classifies the error and decides whether to continue with the next provider:

| Status | Meaning | Behaviour in failover mode |
|---|---|---|
| `402` | Billing / out of credits (OpenRouter, Cohere, HuggingFace, etc.) | **Retryable** — provider goes into an immediate **quota cooldown** (`quotaCooldownSeconds`, 1h default) and the request continues with the next provider. Exception: an Anthropic `402` (Max-plan rate limit) is treated as a rate limit |
| `429` | Rate limit **or** quota/billing (OpenAI `insufficient_quota`, `credit_balance_exhausted`, `*_spend_limit_exceeded`; Anthropic `quota_exceeded` with `x-should-retry:false`; Gemini quota) | **Retryable** — the error body is inspected: quota markers trigger a long **quota cooldown**, plain rate limits trigger a short **rate cooldown** (`rateLimitCooldownSeconds`, 60s default). If the provider sends `Retry-After`, `retry_after_seconds` or "retry in Ns", that exact value is used (capped at `retryAfterMaxSeconds`) |
| `413` | Request too large (Groq context/TPM, Anthropic, Cohere) | **Retryable, no cooldown** — depends on the payload size, not provider health, so the next provider is tried immediately |
| `400` | Provider-side rendering/template error (e.g. Groq's `Tools should have a name!` Harmony error) | **Retryable, no cooldown** — matched by message pattern, next provider is tried |
| `529` | Anthropic "overloaded" | Retryable via the circuit breaker (counts toward the N-failure cooldown) |
| `5xx`, `408`, timeout, network | Transient failures | Retryable via the circuit breaker (existing behaviour) |
| `401`, `403`, `404`, `410`, `422`, other `400` | Client/provider configuration problems | **Not retryable** — the request fails fast |

All cooldowns are **persistent** (stored in SQLite, shown in the dashboard and reflected in `/v1/models`). Immediate quota/rate cooldowns apply to both non-streaming and streaming requests (`auto` mode will retry with the next provider before opening the SSE stream). A direct provider route (`model: "ProviderName"`) never fails over, but the classified cooldown is still applied. `429` cooldown recovery happens automatically on expiry (via maintenance), and any successful request clears the cooldown.

#### Provider scoping per API key

Every API key defines which providers it can use (assigned at creation and editable later from the dashboard under *Keys*). The proxy enforces that scope on `/v1/*` in both routing modes:

- **`"auto"` (failover)** — failover only ever considers the providers assigned to the key. If the key has no allowed provider available for the requested capability, the request ends with `503` (same as "all providers failed").
- **Specific provider** (`model: "ProviderName"`) — the key must include that provider, otherwise the request is rejected **before any provider call or cache lookup** with:

```json
{
  "error": {
    "message": "API key does not have access to this provider",
    "type": "invalid_request_error",
    "code": "provider_access_denied"
  }
}
```

- `GET /v1/models` only lists the providers allowed for the key used (the `auto` entry stays present whenever the key has at least one provider assigned). The response is cached for 60 seconds **per key**.

The dashboard Chat tab (session-based) is not affected by API key scoping.

## API Endpoints

### Dashboard

| Method | Route | Description |
|---|---|---|
| GET | `/admin/api/summary` | Dashboard summary |
| GET/POST | `/admin/api/providers` | List/create providers |
| PATCH | `/admin/api/providers/:id` | Edit provider |
| PATCH | `/admin/api/providers/reorder` | Reorder providers |
| DELETE | `/admin/api/providers/:id` | Delete provider |
| POST | `/admin/api/providers/test-connection` | Test provider URL + API key validation |
| GET | `/admin/api/metrics` | Metrics by date range |
| GET | `/admin/api/metrics/logs` | Recent requests |
| GET | `/admin/api/metrics/health` | Health check |
| GET | `/admin/api/health` | Provider health checks (summary + per-provider state) |
| POST | `/admin/api/health/check` | Run a health check now (all providers, or `{ "provider_id": id }` for one) |
| GET | `/admin/api/chat/providers` | List chat-capable providers |
| POST | `/admin/api/chat/send` | Send a message to a provider via Chat UI |
| POST | `/admin/api/keys` | Create API Key (requires `providerIds`) |
| GET | `/admin/api/keys` | List API Keys (includes assigned providers) |
| PATCH | `/admin/api/keys/:id` | Update a key's provider access |
| DELETE | `/admin/api/keys/:id` | Revoke API Key |

### Proxy (public)

| Method | Route | Auth | Description |
|---|---|---|---|
| GET | `/v1/models` | API Key | List available providers (OpenAI-compatible, `id` = provider name) |
| POST | `/v1/chat/completions` | API Key | Chat/vision (multimodal) |
| POST | `/v1/embeddings` | API Key | Embeddings |

`GET /v1/models` lists the configured Relio providers that are currently available **and assigned to the API key used** (active, both `chat` and `embeddings` capabilities), using an OpenAI-compatible shape:

```json
{
  "object": "list",
  "data": [
    { "id": "auto", "object": "model", "created": 0, "owned_by": "relio" },
    { "id": "AlphaChat", "object": "model", "created": 1735765445, "owned_by": "relio" }
  ]
}
```

`auto` is always present (as long as the key has at least one provider assigned) and enables failover/proxy mode; the other `id`s are provider names, which are also the model selectors to send in `POST /v1/chat/completions` / `POST /v1/embeddings`. Paused and in-cooldown providers are excluded. The response is cached for 60 seconds per API key.

## Tests

```bash
npm test          # run the suite
npm run test:coverage  # coverage report
npm run lint      # ESLint (src, tests, scripts, frontend)
```

CI (GitHub Actions) runs lint + tests + frontend build on every push/PR.

## Project Structure

```
relio/
├── src/                    # Backend (Express)
│   ├── index.js            # Entry point
│   ├── config.js           # Config loader (reads config.json)
│   ├── db.js               # SQLite setup + queries
│   ├── adapters/           # Pluggable LLM provider adapters
│   │   ├── base.js         # ProviderAdapter interface
│   │   ├── index.js        # Factory + registry (singleton cache)
│   │   ├── openai-compatible.js
│   │   ├── anthropic.js
│   │   ├── gemini-native.js
│   │   └── azure-openai.js
│   ├── services/           # Business logic
│   ├── middleware/          # API Key auth middleware
│   ├── routes/             # API routes
│   │   └── chat.routes.js  # Dashboard chat API
│   ├── handlers/           # Request processing
│   └── utils/              # Logger, validators
├── frontend/               # Frontend (React + Vite)
│   ├── src/components/     # React components
│   │   └── Chat.jsx        # Chat testing interface
│   ├── index.html
│   └── vite.config.js
├── docker/                 # Docker multi-stage
│   ├── Dockerfile
│   └── docker-compose.yml
├── config/                 # Config shared by npm/pm2/docker
│   ├── .gitkeep            # Keeps the dir in clean clones (tracked)
│   ├── config.example.json # Template (tracked)
│   └── config.json         # Real config (gitignored)
├── db/                     # Database (gitignored)
├── tests/                  # Vitest tests
└── docs/                   # Documentation
```

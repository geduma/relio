# Relio — LLM Relay

> **Personal-use, self-hosted LLM proxy.** Relio centralizes multiple LLM providers behind a single OpenAI-compatible API, with automatic failover, caching, audit logging, and a management dashboard.

## Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express.js |
| Database | SQLite (better-sqlite3) |
| Frontend | React + Vite (self-served by Express) |
| HTTP Client | Native fetch (Node 18+) |
| Auth | Local API Keys (`/v1/*`) |
| Testing | Vitest |
| Infra | Docker multi-stage (`docker/`) |

## Features

- **OpenAI-compatible proxy** — `/v1/chat/completions`, `/v1/embeddings`, `/v1/models`
- **Automatic failover** — tries providers in order (Main → Fallback 1 → N)
- **Circuit breaker** — auto-cooldown after N consecutive failures
- **Persistent cache** — identical responses never reach the provider
- **Rate limiting** — per-provider controls (req/min, tokens/day)
- **Estimated costs** — per-provider input/output token pricing
- **Full audit trail** — every request logged to SQLite
- **Local API Keys** — for AI agents, with revocation
- **Dashboard** — visual provider management, metrics, logs, API keys
- **Daily metrics** — requests, tokens, costs, errors, cache hits
- **Chat dashboard** — test LLM providers directly from the UI with response time display
- **Dark mode** — toggleable theme (dark by default) with localStorage persistence
- **Auto-maintenance** — daily backups, data retention cleanup
- **Provider Type Abstraction** — pluggable adapters for OpenAI-compatible, Anthropic, Gemini, and Azure OpenAI with canonical response normalization
- **Normalized errors** — all errors follow `{error: {message, type, code}}` OpenAI format
- **Structured output** — Gemini JSON mode via `response_format`
- **Tool choice** — Anthropic and Gemini respect `tool_choice` parameter

## Requirements

- Node.js 18+
- npm

## Quick Start

```bash
git clone <repo> relio
cd relio

cp config.example.json config.json
# Edit config.json — set your provider settings

npm install
cd frontend && npm install && cd ..

npm run dev
```

Open `http://localhost:3000/admin` — the dashboard requires no login.

## Configuration

All settings are in `config.json` at the project root. Copy `config.example.json` and edit:

```json
{
  "db": { "path": "./db/db.sqlite" },
  "cache": { "ttlSeconds": 2592000 },
  "server": {
    "port": 3000,
    "host": "0.0.0.0",
    "baseUrl": "http://localhost:3000",
    "nodeEnv": "development",
    "trustedProxy": false
  }
}
```

| Key | Description |
|---|---|
| `security.encryptionKey` | AES-256-GCM key for API key encryption at rest (auto-derived if omitted) |
| `db.path` | SQLite database file path (overridable via `DB_PATH` env) |
| `cache.ttlSeconds` | Cache TTL in seconds (default 30 days) |
| `server.port` | Server port (overridable via `PORT` env) |
| `server.host` | Server host (overridable via `HOST` env) |
| `server.baseUrl` | Public URL |
| `server.nodeEnv` | `development` or `production` (overridable via `NODE_ENV` env) |
| `server.trustedProxy` | `false` (default). Set to `true` only behind a trusted reverse proxy so `X-Forwarded-For` is honored |
| `relay.exposeProvider` | `false` (default) — includes `_provider` in proxy responses. Set to `true` to expose resolved provider metadata |
| `relay.streamTimeoutSeconds` | Max duration for streaming requests (default `300`) |
| `relay.streamIdleTimeoutMs` | Abort a stream if no data arrives for this long (default `30000`) |
| `relay.requestTimeoutMs` | Max duration for non-streaming requests (default `30000`) |
| `rateLimit.dashboardPerMinute` | Dashboard API requests per minute (default `120`) |
| `rateLimit.proxyPerMinute` | `/v1` requests per minute, keyed by API key + IP (default `60`) |

## Development

The frontend is self-served by Express (production) or via Vite dev server with hot reload:

```bash
# Terminal 1: Backend (with auto-build + watch)
npm run dev

# Terminal 2: Frontend (hot reload)
cd frontend && npm run dev
```

In dev mode, the frontend runs on `http://localhost:5173` and proxies API requests to the backend.

## Authentication

The dashboard requires no login. Only the proxy API (`/v1/*`) is protected by **local API Keys** (`llm_pk_xxx`), managed in the dashboard under *Keys*.

## LLM Provider Adapters

Relio normalizes all LLM providers to an OpenAI-compatible format using a pluggable adapter system at `src/adapters/`. Each adapter handles request transformation, response normalization, streaming, and connection testing.

### Built-in adapters

| Provider Type | Auth | Endpoint | Notes |
|---|---|---|---|
| `openai-compatible` | Bearer token | `/v1/chat/completions` | Passthrough — works with OpenAI, Groq, Together, etc. |
| `anthropic` | x-api-key | `/v1/messages` | Transforms request/response, includes tool calls and streaming |
| `gemini-native` | Bearer token | `/v1/models/{model}:generateContent` | Uses native Gemini API (not Vertex), supports streaming |
| `azure-openai` | api-key header | `/chat/completions` | Appends `api-version` parameter automatically |

### Adding a custom adapter

Create `src/adapters/yourprovider.js` extending `ProviderAdapter` and register it in `src/adapters/index.js`. See `docs/AGENTS.md` for the full guide.

## Docker

```bash
cp config.example.json config.json
# Edit config.json — set your provider settings

docker compose -f docker/docker-compose.yml up -d
```

The compose file mounts `config.json`, `db/`, and `logs/` from the host so data persists across restarts.

## Usage

### Dashboard

Open `http://localhost:3000/admin`. The sidebar includes a **theme toggle** (dark/light mode, persisted in localStorage).

1. Add providers — select **provider type** (openai-compatible, anthropic, gemini-native, azure-openai) and **capability** (chat, embeddings)
2. Order them: Main, Fallback 1, Fallback 2...
3. Generate API Keys for your AI agents
4. Use the **Chat** tab to test providers interactively with response time display (toggle **Proxy** to route through the full failover/cache pipeline)

### Proxy API

The `model` field is a **provider selector**: use a provider name or ID to route directly to it, or `"auto"` to enable failover across providers. The model sent to each provider is always the one configured for that provider.

```bash
# Route to a specific provider (uses its configured model)
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer llm_pk_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "MyProviderName",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# Failover mode (Main -> Fallback 1 -> ...)
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer llm_pk_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

An unknown provider returns `400` with `code: "unknown_provider"`.

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
| GET | `/admin/api/chat/providers` | List chat-capable providers |
| POST | `/admin/api/chat/send` | Send a message to a provider via Chat UI |
| POST | `/admin/api/keys` | Create API Key |
| GET | `/admin/api/keys` | List API Keys |
| DELETE | `/admin/api/keys/:keyPreview` | Revoke API Key |

### Proxy (public)

| Method | Route | Auth | Description |
|---|---|---|---|
| GET | `/v1/models` | API Key | List available models |
| POST | `/v1/chat/completions` | API Key | Chat/vision (multimodal) |
| POST | `/v1/embeddings` | API Key | Embeddings |

## Tests

```bash
npm test
```

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
├── config.json             # Configuration (gitignored)
├── config.example.json     # Configuration template
├── db/                     # Database (gitignored)
├── tests/                  # Vitest tests
└── docs/                   # Documentation
```

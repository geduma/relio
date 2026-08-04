# Relio — LLM Relay

> **Personal-use, self-hosted LLM proxy.** Relio centralizes multiple LLM providers behind a single OpenAI-compatible API, with automatic failover, caching, audit logging, and a management dashboard.

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
- **Persistent cache** — identical responses never reach the provider
- **Rate limiting** — per-provider controls (req/min, tokens/day)
- **Estimated costs** — per-provider input/output token pricing
- **Full audit trail** — every request logged to SQLite
- **Local API Keys** — for AI agents, with revocation
- **Dashboard** — visual provider management, metrics, logs, API keys
- **Settings** — edit all `config.json` options (server, cache, relay, rate limits) from the dashboard, persisted back to the file
- **Daily metrics** — requests, tokens, costs, errors, cache hits
- **Chat dashboard** — test LLM providers directly from the UI with response time display
- **Dark mode** — toggleable theme (dark by default) with localStorage persistence
- **Auto-maintenance** — daily backups, data retention cleanup
- **Provider Type Abstraction** — pluggable adapters for OpenAI-compatible, Anthropic, Gemini, and Azure OpenAI with canonical response normalization
- **Normalized errors** — all errors follow `{error: {message, type, code}}` OpenAI format
- **Structured output** — Gemini JSON mode via `response_format`
- **Tool choice** — Anthropic and Gemini respect `tool_choice` parameter

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
| `relay.streamTimeoutSeconds` | Max duration for streaming requests (default `300`) |
| `relay.streamIdleTimeoutMs` | Abort a stream if no data arrives for this long (default `30000`) |
| `relay.requestTimeoutMs` | Max duration for non-streaming requests (default `30000`) |
| `relay.routingStrategy` | How the proxy picks the starting provider in failover (`auto`) mode. `order` (default, by provider order) or `least-used` (provider with the fewest tokens used today, balancing free-tier usage). Editable from the dashboard (Settings → Load balancer) |
| `rateLimit.dashboardPerMinute` | Dashboard API requests per minute (default `120`) |
| `rateLimit.proxyPerMinute` | `/v1` requests per minute, keyed by API key + IP (default `120`) |

### Editing settings from the dashboard

The hot-applicable options (server nodeEnv, cache, relay) can be edited at **Settings** in the dashboard. Changes are written back to the physical `config.json` file (atomically) **and** applied to the running process immediately — **no restart needed**. Options that are only read at startup (`server.port`, `server.host`, `server.trustedProxy`, rate limits, `security.encryptionKey`, `db.path`) are shown as read-only in the UI with a note to edit `config.json` and restart the server. Fields overridden by an environment variable are shown with an `override:` badge and disabled. Rotate the encryption key via `config.json`/`ENCRYPTION_KEY` and re-enter provider keys, and change the database path via `config.json`/`DB_PATH`.

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

The dashboard requires no login and is intended for **trusted networks only**. Only the proxy API (`/v1/*`) is protected by **local API Keys** (`llm_pk_xxx`), managed in the dashboard under *Keys*.

## Security

- **API keys at rest** — provider API keys are encrypted with AES-256-GCM using `security.encryptionKey`. Rotate the key by updating the config and re-entering provider keys.
- **Client API keys hashed** — your `llm_pk_*` keys are stored as SHA-256 hashes; only a 10-char prefix is displayed in the dashboard. The raw key is shown once at creation.
- **SSRF guard** — provider URLs are validated on create/update/test to reject localhost, loopback, private and link-local addresses, and non-http(s) protocols.
- **Dashboard exposure** — the dashboard has no login; put it behind a trusted reverse proxy with authentication if exposed beyond your local network.
- **Encryption key** — `security.encryptionKey` is required (min 32 chars); the server refuses the example placeholder. Set it via `ENCRYPTION_KEY` in production.

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

## Configuración de permisos de `config.json`

La configuración vive en una **carpeta única `config/`** en la raíz del repo, compartida por todos los runtimes (npm, pm2 y Docker):

```
config/
├── config.example.json    # plantilla (versionada)
└── config.json            # config real (gitignored)
```

- **npm / pm2**: leen `config/config.json` (ruta por defecto de `src/config.js`).
- **Docker**: monta `../config` → `/app/config` y apunta `CONFIG_PATH=/app/config/config.json` — el mismo archivo.

El montaje de **directorio** (no de archivo único) es imprescindible porque la app escribe `config.json` de forma atómica (`rename` sobre un archivo temporal) y Docker **no permite `rename` sobre un bind‑mount de un solo archivo** (error `EBUSY`).

El entrypoint `setup-config-perm.sh` se ejecuta como `root`, garantiza que `/app/config/config.json` exista (copiándolo de `config.example.json` si falta), ajusta los permisos a `rw-rw-r--` y propietario `node:node`, y luego lanza la app como usuario `node`. Gracias al montaje de directorio, el `rename()` atómico ocurre dentro de la misma carpeta y el error `EBUSY` desaparece.

Con esto el dashboard puede persistir los cambios y tú puedes editar `config/config.json` desde el host sin pasos manuales.

### Pasos de despliegue

```bash
# Reinicia el stack (desmonta el contenedor existente)
docker compose -f docker/docker-compose.yml down

# Reconstruye la imagen y levanta el servicio
docker compose -f docker/docker-compose.yml up --build -d
```

Una vez ejecutado, verifica:

- En el host: `ls -l config/config.json` – debe mostrar permisos `-rw-rw-r--`.
- Dentro del contenedor: `docker compose -f docker/docker-compose.yml exec relio ls -l /app/config/config.json` – el mismo resultado.

## Docker

### Build and run

```bash
# Prepara la config (una sola vez)
mkdir -p config
cp config/config.example.json config/config.json
# Edita config/config.json — pon security.encryptionKey (openssl rand -hex 32) y tus providers

docker compose -f docker/docker-compose.yml up --build -d
```

En una instalación limpia estos pasos son opcionales: el entrypoint crea `config.json` desde la plantilla en el primer arranque. Solo necesitas poner tu `encryptionKey` (en `config/config.json` o vía `ENCRYPTION_KEY`) para que la app arranque.

### Volúmenes

El compose monta directorios persistentes del host (relativos a `docker/`):

```
- ./db:/app/db
- ./logs:/app/logs
- ../config:/app/config:rw
```

El archivo de configuración que usa Docker es `config/config.json` de la raíz (se edita desde el host o desde el dashboard; ambos comparten el mismo archivo). `CONFIG_PATH` apunta a `/app/config/config.json`. Puedes sobrescribir la clave por entorno:

```bash
ENCRYPTION_KEY=... docker compose -f docker/docker-compose.yml up -d
```

La imagen corre la app como usuario no root (`node`), incluye un healthcheck en `/admin/api/metrics/health`, y el entrypoint prepara automáticamente los permisos de `config.json` en cada arranque.

## Usage

### Dashboard

Open `http://localhost:3000/admin`. The sidebar includes a **theme toggle** (dark/light mode, persisted in localStorage).

1. Add providers — select **provider type** (openai-compatible, anthropic, gemini-native, azure-openai) and **capability** (chat, embeddings)
2. Order them: Main, Fallback 1, Fallback 2...
3. Generate API Keys for your AI agents
4. Use the **Chat** tab to test providers interactively with response time display (toggle **Proxy** to route through the full failover/cache pipeline)

### Proxy API

The `model` field is a **provider selector**: use a provider name or ID to route directly to it, or `"auto"` to enable failover across providers. The model sent to each provider is always the one configured for that provider. The name `auto` is reserved for failover/proxy mode and cannot be used as a provider name.

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
| GET | `/v1/models` | API Key | List available providers (OpenAI-compatible, `id` = provider name) |
| POST | `/v1/chat/completions` | API Key | Chat/vision (multimodal) |
| POST | `/v1/embeddings` | API Key | Embeddings |

`GET /v1/models` lists the configured Relio providers that are currently available (active, both `chat` and `embeddings` capabilities), using an OpenAI-compatible shape:

```json
{
  "object": "list",
  "data": [
    { "id": "auto", "object": "model", "created": 0, "owned_by": "relio" },
    { "id": "AlphaChat", "object": "model", "created": 1735765445, "owned_by": "relio" }
  ]
}
```

`auto` is always present and enables failover/proxy mode; the other `id`s are provider names, which are also the model selectors to send in `POST /v1/chat/completions` / `POST /v1/embeddings`. Paused and in-cooldown providers are excluded. The response is cached for 60 seconds.

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
├── config/                 # Config compartida por npm/pm2/docker
│   ├── .gitkeep            # Mantiene el dir en clones limpios (trackeado)
│   ├── config.example.json # Plantilla (trackeada)
│   └── config.json         # Config real (gitignored)
├── db/                     # Database (gitignored)
├── tests/                  # Vitest tests
└── docs/                   # Documentation
```

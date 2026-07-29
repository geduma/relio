# Relio — LLM Relay

> **Personal-use, self-hosted LLM proxy.** Relio centralizes multiple LLM providers behind a single OpenAI-compatible API, with automatic failover, caching, audit logging, and a management dashboard.

## Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express.js |
| Database | SQLite (better-sqlite3) |
| Frontend | React + Vite (self-served by Express) |
| HTTP Client | Native fetch (Node 18+) |
| Auth | Pluggable (Geduma OAuth / none) + local API Keys |
| Testing | Vitest |
| Infra | Docker multi-stage (`docker/`) |

## Features

- **OpenAI-compatible proxy** — `/v1/chat/completions`, `/v1/embeddings`
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

Open `http://localhost:3000/admin` — no login required by default.

## Configuration

All settings are in `config.json` at the project root. Copy `config.example.json` and edit:

```json
{
  "auth": { "provider": "none" },
  "db": { "path": "./db/db.sqlite" },
  "cache": { "ttlSeconds": 2592000 },
  "server": {
    "port": 3000,
    "host": "0.0.0.0",
    "baseUrl": "http://localhost:3000",
    "nodeEnv": "development"
  },
  "cookie": {
    "secure": false,
    "sameSite": "strict",
    "httpOnly": true
  }
}
```

| Key | Description |
|---|---|
| `auth.provider` | `none` (anonymous, default) or `geduma` (OAuth) |
| `geduma.apiUrl` | Geduma API base URL (only needed for `geduma` provider) |
| `geduma.appId` | App ID registered on geduma-auth (only needed for `geduma` provider) |
| `db.path` | SQLite database file path |
| `cache.ttlSeconds` | Cache TTL in seconds (default 30 days) |
| `server.port` | Server port |
| `server.host` | Server host |
| `server.baseUrl` | Public URL for OAuth redirects |
| `server.nodeEnv` | `development` or `production` |

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

Relio uses a pluggable auth provider system. Set `auth.provider` in `config.json`:

- **`none`** (default) — anonymous session, no login page shown.
- **`geduma`** — OAuth via Geduma API. Requires a registered `appId` and setting `auth.provider` to `"geduma"`.

### Geduma Auth Flow

1. Login page fetches available OAuth providers from Geduma
2. User clicks a provider → Relio redirects to Geduma's OAuth initiation endpoint
3. User authenticates (Google, GitHub, etc.) → Geduma handles the OAuth callback
4. Geduma redirects back to Relio with a session token in the URL hash
5. Relio exchanges the session token for user data and creates a local session

To implement a custom provider, see `src/auth/base.js` and `docs/AGENTS.md`.

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

1. Add providers — select **provider type** (openai-compatible, anthropic, gemini-native, azure-openai) and **capability** (chat, embeddings, vision)
2. Order them: Main, Fallback 1, Fallback 2...
3. Generate API Keys for your AI agents
4. Use the **Chat** tab to test providers interactively with response time display

### Proxy API

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer llm_pk_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

## API Endpoints

### Authentication

| Method | Route | Auth | Description |
|---|---|---|---|
| GET | `/admin/api/auth/providers` | No | List login providers |
| POST | `/admin/api/auth/login` | No | Initiate OAuth login |
| POST | `/admin/api/auth/callback` | No | Exchange session token |
| POST | `/admin/api/auth/logout` | Cookie | Logout |

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
| POST | `/admin/api/auth/api-keys` | Create API Key |
| GET | `/admin/api/auth/api-keys` | List API Keys |
| DELETE | `/admin/api/auth/api-keys/:keyPreview` | Revoke API Key |

### Proxy (public)

| Method | Route | Auth | Description |
|---|---|---|---|
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
│   ├── auth/               # Pluggable auth providers
│   │   ├── base.js         # AuthProvider interface
│   │   ├── geduma.js       # Geduma OAuth provider
│   │   ├── none.js         # Anonymous session provider
│   │   └── index.js        # Factory
│   ├── adapters/           # Pluggable LLM provider adapters
│   │   ├── base.js         # ProviderAdapter interface
│   │   ├── index.js        # Factory + registry (singleton cache)
│   │   ├── openai-compatible.js
│   │   ├── anthropic.js
│   │   ├── gemini-native.js
│   │   └── azure-openai.js
│   ├── services/           # Business logic
│   ├── middleware/          # Auth middleware
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

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
- **Auto-maintenance** — daily backups, data retention cleanup

## Requirements

- Node.js 18+
- npm

## Quick Start

```bash
git clone <repo> relio
cd relio

cp config.example.json config.json
# Edit config.json — set your Geduma appId or change authProvider

npm install
cd frontend && npm install && cd ..

npm run dev
```

Open `http://localhost:3000/admin` and log in via OAuth.

## Configuration

All settings are in `config.json` at the project root. Copy `config.example.json` and edit:

```json
{
  "auth": { "provider": "geduma" },
  "geduma": {
    "apiUrl": "https://api.geduma.com",
    "appId": "app_replace_with_your_app_id"
  },
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
| `auth.provider` | `geduma` (OAuth) or `none` (anonymous) |
| `geduma.apiUrl` | Geduma API base URL (only for `geduma` provider) |
| `geduma.appId` | App ID registered on geduma-auth (only for `geduma` provider) |
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

- **`geduma`** (default) — OAuth via Geduma API. Requires a registered `appId`.
- **`none`** — anonymous session, no login page shown.

### Geduma Auth Flow

1. Login page fetches available OAuth providers from Geduma
2. User clicks a provider → Relio redirects to Geduma's OAuth initiation endpoint
3. User authenticates (Google, GitHub, etc.) → Geduma handles the OAuth callback
4. Geduma redirects back to Relio with a session token in the URL hash
5. Relio exchanges the session token for user data and creates a local session

To implement a custom provider, see `src/auth/base.js` and `docs/AGENTS.md`.

## Docker

```bash
cp config.example.json config.json
# Edit config.json — set your Geduma appId or change authProvider

docker compose -f docker/docker-compose.yml up -d
```

The compose file mounts `config.json`, `db/`, and `logs/` from the host so data persists across restarts.

## Usage

### Dashboard

Open `http://localhost:3000/admin`:

1. Log in via OAuth
2. Add providers (OpenAI, Anthropic, Groq...)
3. Order them: Main, Fallback 1, Fallback 2...
4. Generate API Keys for your AI agents

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
| GET | `/admin/api/metrics` | Metrics by date range |
| GET | `/admin/api/metrics/logs` | Recent requests |
| GET | `/admin/api/metrics/health` | Health check |
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
│   ├── services/           # Business logic
│   ├── middleware/          # Auth middleware
│   ├── routes/             # API routes
│   ├── handlers/           # Request processing
│   └── utils/              # Logger, validators
├── frontend/               # Frontend (React + Vite)
│   ├── src/components/     # React components
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

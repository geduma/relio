# Relio — LLM Relay

> **Personal-use, self-hosted LLM proxy.** Relio is designed for individual developers who want to centralize multiple LLM providers behind a single OpenAI-compatible API, with automatic failover, caching, audit logging, and a management dashboard.

## Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express.js |
| Database | SQLite (better-sqlite3) |
| Frontend | React + Vite (self-served by Express) |
| HTTP Client | Native fetch (Node 18+) |
| Auth | Geduma API (OAuth) + local API Keys |
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

cp .env.example .env
# Edit .env — set GEDUMA_API_TOKEN and other secrets

npm install
cd frontend && npm install && cd ..

npm run dev
```

Open `http://localhost:3000/admin` and log in via OAuth.

## Development

The frontend is self-served by Express (production) or via Vite dev server with hot reload:

```bash
# Terminal 1: Backend (with auto-build + watch)
npm run dev

# Terminal 2: Frontend (hot reload)
cd frontend && npm run dev
```

In dev mode, the frontend runs on `http://localhost:5173` and proxies API requests to the backend.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `GEDUMA_API_URL` | `https://geduma-api.com` | Geduma API base URL |
| `GEDUMA_API_TOKEN` | — | Geduma integration token |
| `APP_BASE_URL` | `http://localhost:3000` | Base URL for OAuth callbacks |
| `DB_PATH` | `./db/db.sqlite` | SQLite database path |
| `CACHE_TTL_SECONDS` | `2592000` (30 days) | Cache TTL |
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Server host |
| `COOKIE_SECURE` | `true` | Secure cookies (HTTPS) |
| `COOKIE_SAME_SITE` | `strict` | SameSite policy |
| `NODE_ENV` | `development` | Environment |

## Docker

```bash
cp .env.example .env
docker compose -f docker/docker-compose.yml up -d
```

## Usage

### Dashboard

Open `http://localhost:3000/admin`:

1. Log in via OAuth (Google, GitHub, etc.)
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
| POST | `/admin/api/auth/login` | No | Login via Geduma |
| GET | `/admin/api/auth/callback` | No | OAuth callback |
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
│   ├── config.js           # Env var config
│   ├── db.js               # SQLite setup + queries
│   ├── services/           # Business logic
│   ├── middleware/          # Auth middleware
│   ├── routes/             # API routes
│   ├── handlers/           # Request processing
│   ├── utils/              # Logger, validators
│   └── external/           # Geduma client
├── frontend/               # Frontend (React + Vite)
│   ├── src/components/     # React components
│   ├── index.html
│   └── vite.config.js
├── docker/                 # Docker multi-stage
│   ├── Dockerfile
│   └── docker-compose.yml
├── db/                     # Database (gitignored)
├── tests/                  # Vitest tests
└── docs/                   # Documentation
```

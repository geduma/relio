# Relio: LLM Relay — Full Technical Specification

> **⚠️ Legacy document — covers the initial v1.0 release. For current feature documentation see [PRD.md](./PRD.md) (requirements) and [README.md](../README.md) (overview).**
>
> **v1.1 updates (see [Validation Guide](./validation-guide.md) for full compliance checklist):**
> - Embeddings now routed through dedicated adapter method (not chat endpoint)
> - `GET /v1/models` endpoint added (now lists configured available providers, OpenAI-compatible; `id` = provider name; reserved `auto` entry returned first for failover/proxy mode; provider name `auto` is blocked)
> - Errors normalized to OpenAI `{error: {message, type, code}}` format
> - `_provider` field made configurable via `config.relay.exposeProvider`
> - Gemini: `role: 'tool'` → `functionResponse`, streaming tool calls fixed
> - Anthropic: `tool_choice` mapped correctly
> - Gemini: `response_format` → `generationConfig.responseMimeType`
>
> **v1.2 update:**
> - Login/auth removed entirely — no dashboard authentication, no Geduma/OAuth, no cookies/sessions
> - Dashboard endpoints are open; only the proxy API (`/v1/*`) requires a local API Key
> - `sessions` and `login_history` tables removed from the schema
> - `auth.trustedProxy` moved to `server.trustedProxy`

**Name:** Relio (LLM Relay)  
**Version:** 1.2  
**Stack:** Node.js + Express.js + SQLite (better-sqlite3)  
**Authentication:** Local API Keys (proxy `/v1/*`); dashboard open (no login)  
**Local DB:** SQLite (audit and configuration)  
**Frontend:** React + Vite (self-served by Express)  
**HTTP Client:** Native `fetch` (Node 18+)  
**Testing:** Vitest  
**Infra:** Docker multi-stage (`docker/`)

---

## 1. EXECUTIVE SUMMARY

**Relio** is an intelligent, minimalistic proxy that:
- ✅ Centralizes multiple LLM providers
- ✅ Implements automatic failover with intelligent circuit breaker
- ✅ Exposes an OpenAI-compatible API (`/v1/chat/completions`, `/v1/embeddings`)
- ✅ Logs every request to SQLite for full audit
- ✅ Caches identical responses persistently
- ✅ Open dashboard (no login) with local API Keys for AI agents
- ✅ Generates local API Keys for AI agents
- ✅ Intuitive provider ordering (Main, Fallback 1, 2, 3...)
- ✅ Self-hosted, no external dependencies beyond configured providers

---

## 2. SYSTEM ARCHITECTURE

### 2.1 Request Flow

```
┌─────────────────────────────────────────────────────────┐
│              Client (Dashboard / AI Agent)               │
└─────────────────────────────────────────────────────────┘
                            ▲
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
    ┌───▼────────┐    ┌─────▼────────┐   ┌─────▼──────┐
    │  Dashboard │    │  /v1/* proxy │   │ API Keys   │
    │   (open)   │    │   requests   │   │ (SQLite)   │
    └───┬────────┘    └─────┬────────┘   └─────┬──────┘
        └───────────────────┼──────────────────┘
                            │
                    ┌───────▼────────┐
                    │  authMiddleware│
                    │  (API Key only)│
                    └───────┬────────┘
                            │
        ┌───────────────────┼────────────────────┐
        │                   │                    │
    ┌───▼────────┐    ┌─────▼─────────┐   ┌─────▼────┐
    │  Dashboard │    │ FailoverEngine│   │  Cache   │
    │   Routes   │    │  (selects     │   │ Manager  │
    │            │    │   provider)   │   │          │
    └────────────┘    └─────┬─────────┘   └─────┬────┘
                            │                  │
                    ┌───────▼──────────────────▼────┐
                    │  Circuit Breaker + Rate Limit  │
                    │  (validation before sending)   │
                    └───────┬─────────────────────┘
                            │
        ┌───────────────────┴────────────────────┐
        │                                        │
   ┌────▼────────┐  ┌─────────┐  ┌─────────┐  ┌─────▼──┐
   │ Provider A │  │Provider B│ │Provider C│  │ ... N  │
   │    API     │  │   API    │  │   API    │  │Providers
   └────────────┘  └──────────┘  └──────────┘  └────────┘

        DB Layer (SQLite)
        ├── providers (config)
        ├── requests_log (audit)
        ├── api_keys (local keys)
        ├── cache (deduplication)
        ├── metrics (aggregates)
        └── circuit_breaker_state (temporal state)
```

### 2.2 Core Components

| Component | Responsibility | Technology |
|------------|----------------|-----------|
| **authService** | API Key management + validation | Node.js |
| **authMiddleware** | API Key validation for `/v1/*` | Express |
| **failoverEngine** | Select provider by order | Node.js |
| **circuitBreaker** | Manage provider states | SQLite + memory |
| **cacheManager** | Deduplicate responses | SQLite |
| **metricsLogger** | Log requests + calculate metrics | SQLite |
| **dashboard** | Provider management UI | React + Vite (self-served) |

---

## 3. AUTHENTICATION: LOCAL API KEYS

The dashboard requires **no login** — all `/admin/*` endpoints are open. Only the proxy API (`/v1/*`) is authenticated.

### 3.1 API Keys

Keys are generated in the dashboard (*Keys* tab), stored locally in the `api_keys` table, and used as Bearer tokens:

```
Authorization: Bearer llm_pk_xxx...
```

- Keys are shown **only once** at creation (never retrievable again)
- Keys can be revoked at any time
- `/v1` requests are rate-limited per API Key + IP (`rateLimit.proxyPerMinute`)

### 3.2 Auth Flow (Proxy)

```
1. AI agent requests /v1/chat/completions
   Header: Authorization: Bearer llm_pk_xxx...

2. authMiddleware:
   ├─ Extract and validate API key in SQLite
   ├─ Check not revoked
   └─ Update last_used_at

3. FailoverEngine processes normally
   └─> Log in requests_log
```

---

## 4. DATABASE: SQLITE

### 4.1 Table: `providers`

LLM provider configuration.

```sql
CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  api_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  model TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('chat', 'embeddings', 'vision')),

  -- Intuitive ordering (Main, Fallback 1, 2, ...)
  order_position INT NOT NULL DEFAULT 0,
  order_label TEXT,

  -- Status
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'paused', 'cooldown')),

  -- Per-token costs (configurable per provider)
  cost_per_input_token REAL DEFAULT 0,
  cost_per_output_token REAL DEFAULT 0,

  -- Configurable limits
  rate_limit_req_per_min INT DEFAULT 60,
  tokens_per_day INT DEFAULT 0,
  cost_per_day REAL DEFAULT 0,

  -- Circuit Breaker
  cooldown_after_failures INT DEFAULT 5,
  cooldown_duration_seconds INT DEFAULT 300,
  current_failure_count INT DEFAULT 0,
  last_failure_at DATETIME,
  cooldown_until DATETIME,

  -- Audit
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  INDEX(order_position, status),
  INDEX(type, order_position),
  INDEX(status)
);
```

### 4.2 Table: `requests_log`

Every proxy request is logged here.

```sql
CREATE TABLE requests_log (
  id TEXT PRIMARY KEY,
  provider_id TEXT REFERENCES providers(id),

  -- Request Info
  endpoint TEXT NOT NULL,
  request_body TEXT NOT NULL,
  origin_ip TEXT,
  origin_header TEXT,

  -- Response Info
  status_code INT,
  response_body TEXT,
  error_message TEXT,

  -- Tokens and Costs
  input_tokens INT DEFAULT 0,
  output_tokens INT DEFAULT 0,
  total_tokens INT DEFAULT 0,
  estimated_cost REAL DEFAULT 0,

  -- Timing and Audit
  request_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  response_time_ms INT,
  authenticated_via TEXT,
  cache_hit BOOLEAN DEFAULT FALSE,
  was_retry BOOLEAN DEFAULT FALSE,
  retry_count INT DEFAULT 0,

  INDEX(provider_id, request_at),
  INDEX(request_at),
  INDEX(endpoint, request_at),
  INDEX(cache_hit)
);
```

### 4.3 Table: `cache`

Persistent deduplication of identical queries.

```sql
CREATE TABLE cache (
  id TEXT PRIMARY KEY,
  query_hash TEXT UNIQUE NOT NULL,
  endpoint TEXT NOT NULL,
  request_body TEXT NOT NULL,
  response_body TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME,
  hit_count INT DEFAULT 1,

  INDEX(query_hash),
  INDEX(endpoint, expires_at)
);
```

### 4.4 Table: `api_keys`

Locally generated API Keys.

```sql
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME,
  revoked BOOLEAN DEFAULT FALSE,
  revoked_at DATETIME,

  INDEX(key),
  INDEX(revoked, created_at)
);
```

### 4.5 Table: `circuit_breaker_state`

Current circuit breaker state.

```sql
CREATE TABLE circuit_breaker_state (
  provider_id TEXT PRIMARY KEY REFERENCES providers(id),
  state TEXT DEFAULT 'healthy',
  failure_count INT DEFAULT 0,
  last_failure_at DATETIME,
  cooldown_until DATETIME,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  INDEX(state, cooldown_until)
);
```

### 4.6 Table: `metrics`

Pre-calculated daily aggregates.

```sql
CREATE TABLE metrics (
  id TEXT PRIMARY KEY,
  provider_id TEXT REFERENCES providers(id),
  metric_date DATE NOT NULL,

  total_requests INT DEFAULT 0,
  total_input_tokens INT DEFAULT 0,
  total_output_tokens INT DEFAULT 0,
  total_cost REAL DEFAULT 0,
  error_count INT DEFAULT 0,
  cache_hits INT DEFAULT 0,
  avg_response_time_ms REAL DEFAULT 0,

  UNIQUE(provider_id, metric_date),
  INDEX(metric_date)
);
```

---

## 5. AUTHENTICATION FLOWS

### 5.1 API Key Auth (Proxy Endpoints)

```
1. AI agent requests /v1/chat/completions
   Header: Authorization: Bearer llm_pk_xxx...

2. authMiddleware:
   ├─ Extract and validate API key in SQLite
   ├─ Check not revoked
   └─ Update last_used_at

3. FailoverEngine processes normally
   └─> Log in requests_log
```

### 5.2 Dashboard Access

All `/admin/*` endpoints are open — no authentication or session required. The dashboard is intended for personal/self-hosted use.

---

## 6. FAILOVER: PROVIDER SELECTION

### 6.1 Algorithm

```javascript
async function selectProvider(modelType) {
  const providers = await db.all(`
    SELECT * FROM providers
    WHERE type = ? AND status = 'active'
    ORDER BY order_position ASC
  `, [modelType]);

  for (const provider of providers) {
    if (provider.cooldown_until && provider.cooldown_until > NOW()) {
      continue;
    }

    if (await isRateLimitExceeded(provider)) {
      continue;
    }

    if (await isDailyLimitExceeded(provider)) {
      continue;
    }

    return provider;
  }

  return null;
}
```

### 6.2 Provider Order

```
order_position = 0  → "Main" (first attempt)
order_position = 1  → "Fallback 1" (second attempt)
order_position = 2  → "Fallback 2" (third attempt)
order_position = 3  → "Fallback 3" (fourth attempt)
```

### 6.3 Circuit Breaker: States

```
HEALTHY:
├─ Use normally
├─ Count failures
└─ If failures >= cooldown_after_failures → COOLDOWN

COOLDOWN:
├─ Skip for cooldown_duration_seconds
├─ After time → returns to HEALTHY
└─ Reset failure counter

PAUSED (manual):
└─ Skip while paused
```

### 6.4 Complete Failover Flow

```
┌────────────────────────────────────────────────┐
│ Client: POST /v1/chat/completions             │
└────────────────────────────────────────────────┘
                    ▼
┌────────────────────────────────────────────────┐
│ 1. Validate authentication (API Key)           │
└────────────────────────────────────────────────┘
                    ▼
┌────────────────────────────────────────────────┐
│ 2. Check cache (query_hash)                    │
│    Hit? → Return + log cache_hit=true          │
└────────────────────────────────────────────────┘
                    ▼
┌────────────────────────────────────────────────┐
│ 3. Select provider (order_position)            │
│    Gets: Main → Fallback 1 → Fallback 2...    │
└────────────────────────────────────────────────┘
                    ▼
┌────────────────────────────────────────────────┐
│ 4. For each provider in order:                 │
│    a. Is healthy? → Try                        │
│    b. In cooldown? → Skip                      │
│    c. Rate limit? → Skip                       │
│    d. Daily limit? → Skip                      │
└────────────────────────────────────────────────┘
                    ▼
┌────────────────────────────────────────────────┐
│ 5. Call provider:                              │
│    a. OK: Return response + cache              │
│    b. FAILS:                                   │
│       ├─ Increment failure_count               │
│       ├─ If >= cooldown_after_failures         │
│       │  └─ Enter COOLDOWN                     │
│       ├─ Log failure                           │
│       └─ Try next provider                     │
└────────────────────────────────────────────────┘
                    ▼
┌────────────────────────────────────────────────┐
│ 6. If ALL fail:                                │
│    Return 503 + detailed error                 │
└────────────────────────────────────────────────┘
                    ▼
┌────────────────────────────────────────────────┐
│ 7. Log request_log (for audit)                 │
└────────────────────────────────────────────────┘
```

---

## 7. API ENDPOINTS

### 7.1 Dashboard: Providers

#### GET /admin/api/providers?type=chat
Lists ordered providers.

```javascript
// No auth required
// Query params: type ('chat', 'embeddings', 'vision' - optional)
// Returns: [ { id, name, model, order_position, order_label, status, ... } ]
```

#### POST /admin/api/providers
Creates a new provider.

```javascript
// Body: {
//   "name": "Example Provider",
//   "api_url": "https://api.provider.com/v1",
//   "api_key": "sk-...",
//   "model": "model-chat",
//   "type": "chat",
//   "rate_limit_req_per_min": 60,
//   "tokens_per_day": 0,
//   "cost_per_input_token": 0.00001,
//   "cost_per_output_token": 0.00003,
//   "cooldown_after_failures": 5,
//   "cooldown_duration_seconds": 300
// }
// Returns: { success: true, provider_id: "..." }
```

#### PATCH /admin/api/providers/:id
Edits provider (without changing order).

```javascript
// Body: { "status": "paused", "rate_limit_req_per_min": 120, ... }
// Does NOT allow: order_position, order_label
// Returns: { success: true }
```

#### PATCH /admin/api/providers/reorder
Changes provider order.

```javascript
// Body: { "provider_ids": ["id_1", "id_3", "id_2"] }
// Updates order_position for each
// Auto-regenerates order_label (Main, Fallback 1, ...)
// Returns: { success: true }
```

#### DELETE /admin/api/providers/:id
Deletes provider.

```javascript
// Auto-reorganizes order_position for remaining providers
// Returns: { success: true }
```

### 7.2 Dashboard: Metrics

#### GET /admin/api/metrics?from=2024-01-01&to=2024-01-31
Per-provider metrics in a date range.

```javascript
// Query: from, to (ISO dates)
// Returns: {
//   "period": "2024-01-01 to 2024-01-31",
//   "providers": [
//     {
//       "provider_id": "...",
//       "provider_name": "...",
//       "total_requests": 1523,
//       "total_input_tokens": 450000,
//       "total_output_tokens": 89000,
//       "total_cost": 12.45,
//       "error_count": 3,
//       "cache_hits": 127,
//       "avg_response_time_ms": 2345
//     }
//   ],
//   "totals": { ... }
// }
```

#### GET /admin/api/metrics/logs?limit=50&offset=0
Recent requests.

```javascript
// Query: limit, offset (for pagination)
// Returns: [ { id, provider_id, endpoint, status_code, ... } ]
```

#### GET /admin/api/metrics/health
Proxy health check.

```javascript
// No auth required (can be used by monitoring)
// Returns: {
//   "status": "healthy",
//   "providers_healthy": 3,
//   "providers_cooldown": 1,
//   "providers_paused": 0
// }
```

### 7.3 Dashboard: API Keys

#### POST /admin/api/keys
Creates a new API Key.

```javascript
// Body: { "name": "Production App" }
// Returns: { "apiKey": "llm_pk_xxx...", "message": "..." }
// NOTE: Key shown only once
```

#### GET /admin/api/keys
Lists API Keys (sanitized).

```javascript
// Returns: [
//   {
//     "key_preview": "llm_pk_...xxx",
//     "name": "Production App",
//     "created_at": "2024-01-15T10:00:00Z",
//     "last_used_at": "2024-01-31T15:30:00Z",
//     "revoked": false
//   }
// ]
```

#### DELETE /admin/api/keys/:keyPreview
Revokes an API Key.

```javascript
// Param: keyPreview (e.g. "llm_pk_...xxx")
// Returns: { success: true }
```

### 7.4 Proxy Endpoints (Public)

#### POST /v1/chat/completions
OpenAI-compatible chat/vision.

```javascript
// Requires: Authorization: Bearer llm_pk_xxx...
// Body: { "model": "model-chat", "messages": [...], ... }
// Returns: OpenAI-identical response
```

#### POST /v1/embeddings
OpenAI-compatible embeddings.

```javascript
// Requires: Authorization: Bearer llm_pk_xxx...
// Body: { "model": "text-embedding-ada-002", "input": "...", ... }
// Returns: OpenAI-identical response
```

> **Note:** Multimodal vision is handled inside `/v1/chat/completions`
> by automatically detecting image content in `messages`. There is no
> separate `/v1/vision` endpoint.

---

## 8. CONFIGURATION

All configuration lives in `config/config.json`. Copy `config/config.example.json` and edit (the folder is shared by npm, pm2 and Docker).

| Key | Type | Default | Description |
|---|---|---|---|
| `db.path` | string | `./db/db.sqlite` | SQLite database path |
| `cache.ttlSeconds` | number | `2592000` | Cache TTL in seconds (30 days) |
| `security.encryptionKey` | string | auto-derived | AES-256-GCM key for API key encryption at rest |
| `server.port` | number | `3000` | Server port |
| `server.host` | string | `0.0.0.0` | Server host |
| `server.nodeEnv` | string | `development` | `development` or `production` |
| `server.trustedProxy` | boolean | `false` | Set to `true` only behind a trusted reverse proxy so `X-Forwarded-For` is honored |
| `relay.exposeProvider` | boolean | `false` | Include `_provider` metadata in proxy responses |
| `relay.streamTimeoutSeconds` | number | `300` | Max duration for streaming requests |
| `relay.streamIdleTimeoutMs` | number | `30000` | Abort a stream if no data arrives for this long |
| `rateLimit.dashboardPerMinute` | number | `120` | Dashboard API requests per minute |
| `rateLimit.proxyPerMinute` | number | `120` | `/v1` requests per minute, keyed by API key + IP |

Env var overrides (for testing): `DB_PATH`, `PORT`, `HOST`, `NODE_ENV`, `CONFIG_PATH`, `ENCRYPTION_KEY`.

---

## 9. FOLDER STRUCTURE

```
relio/
├── src/
│   ├── index.js                    # Entry point (Express)
│   ├── config.js                   # Reads config.json
│   ├── db.js                       # SQLite setup + migrations
│   ├── services/
│   │   ├── authService.js          # API Key management + validation
│   │   ├── failoverEngine.js       # Provider selection
│   │   ├── circuitBreaker.js       # States and cooldown
│   │   ├── cacheManager.js         # Deduplication with TTL
│   │   └── metricsLogger.js        # Logging and daily aggregates
│   ├── middleware/
│   │   └── authMiddleware.js       # API Key validation (/v1/*)
│   ├── routes/
│   │   ├── providers.routes.js     # /admin/api/providers/*
│   │   ├── metrics.routes.js       # /admin/api/metrics/*
│   │   ├── keys.routes.js          # /admin/api/keys/*
│   │   ├── chat.routes.js          # /admin/api/chat/*
│   │   └── proxy.routes.js         # /v1/chat/completions, /v1/embeddings
│   ├── handlers/
│   │   ├── requestHandler.js       # Proxy request processing
│   │   └── dashboardHandler.js     # Dashboard endpoints
│   └── utils/
│       └── logger.js               # File logging
├── frontend/
│   ├── src/
│   │   ├── main.jsx                # React entry point
│   │   ├── App.jsx                 # Main router
│   │   ├── components/
│   │   │   ├── Dashboard.jsx       # Layout + internal routing
│   │   │   ├── ProvidersList.jsx   # List + reorder
│   │   │   ├── ProviderForm.jsx    # Create/edit provider
│   │   │   ├── Metrics.jsx         # Metrics and stats
│   │   │   ├── ApiKeys.jsx         # API Key management
│   │   │   ├── Logs.jsx            # Recent requests
│   │   │   └── Chat.jsx            # Chat testing interface
│   │   └── style.css               # Global styles
│   ├── index.html                  # HTML template
│   ├── vite.config.js              # Vite config (proxy to Express in dev)
│   └── package.json                # Frontend dependencies
├── docker/
│   ├── Dockerfile                  # Multi-stage: build frontend + backend
│   ├── docker-compose.yml          # Relio service
│   └── .dockerignore               # Docker ignore rules
├── db/
│   ├── db.sqlite                   # Database (git-ignored)
│   ├── migrations/                 # Versioned SQL migrations
│   └── backups/                    # Automatic backups
├── logs/
│   ├── app.log                     # Application logs
│   └── archive/                    # Compressed old logs
├── config/
│   ├── config.json                   # Configuration (git-ignored)
│   └── config.example.json           # Configuration template
├── .gitignore
├── package.json                    # Backend dependencies
└── README.md
```

---

## 10. COMPLETE PROXY + FAILOVER FLOW

```
1. AI agent: POST /v1/chat/completions
   Header: Authorization: Bearer llm_pk_xxx...
   Body: { "model": "model-chat", "messages": [...] }

2. Backend - authMiddleware:
   ├─ Extract API key: "llm_pk_xxx..."
   ├─ Lookup in SQLite: api_keys
   ├─ Validate: not revoked, exists
   └─> Continue to next step

3. Backend - cacheManager:
   ├─ Calculate query_hash
   ├─ Check cache
   ├─ Hit? Return + cache_hit=true
   └─> If miss, continue

4. Backend - failoverEngine:
   ├─ Get providers by type = 'chat'
   ├─ Order by order_position
   └─> For each provider in order:

5. First attempt (order_position = 0 "Main"):
   ├─ Check circuitBreaker (healthy?)
   ├─ Check rate limits
   ├─ Call with 30s timeout
   ├─ OK → Return response + cache
   └─> If FAILS:
       ├─ Increment failure_count
       ├─ If >= cooldown_after_failures → COOLDOWN
       ├─ Log failure in SQLite
       └─> Try next provider

6. If all fail:
   ├─ 503 Service Unavailable
   ├─ Detailed error message
   └─> Log in requests_log

7. If success:
   ├─ Log in requests_log (provider_id, tokens, cost, time)
   ├─ Update daily metrics
   ├─ Cache response
   └─> Return to client
```

---

## 11. METRICS AND AUDIT

### 11.1 Automatic Metrics

**Per request:**
- Input/output tokens
- Response time
- Provider used
- Cache hit/miss
- Auth method used

**Daily aggregates (metrics table):**
- Total requests
- Total tokens
- Estimated cost
- Error rate
- Average response time
- Cache effectiveness

**Global:**
- Total cost/day
- Load distribution
- Per-provider uptime
- Cache hit rate

### 11.2 Audit: Requests

```sql
SELECT
  request_at,
  provider_id,
  endpoint,
  status_code,
  input_tokens,
  output_tokens,
  response_time_ms,
  cache_hit,
  authenticated_via
FROM requests_log
ORDER BY request_at DESC
LIMIT 100;
```

---

## 12. DATA MANAGEMENT AND ROTATION

### 12.1 Data Retention

- **requests_log:** 90 days
- **cache:** 30 days (TTL per entry)
- **metrics:** 365 days (aggregates)
- **circuit_breaker_state:** Temporal (no retention)

### 12.2 Automatic Backup

```
Every day at 02:00 AM:
├─ Backup: cp db.sqlite → backups/db-YYYY-MM-DD.sqlite
├─ Keep between 2-10 backups (configurable)
├─ Clean logs older than 90 days
└─ Archive old logs to logs/archive/
```

---

## 13. PERFORMANCE AND OVERHEAD

### 13.1 Expected Latency

```
Provider DB lookup:                    ~2-5ms
Request routing + failover logic:      ~5-10ms
Cache lookup:                          ~1-3ms
Call to provider (HTTP):               ~1,000-5,000ms
Logging to DB:                         ~5-10ms

TOTAL OVERHEAD:                        ~15-25ms (0.3%-2.5% of total)
```

### 13.2 Optimizations

- ✅ In-memory provider cache (refresh every 60s)
- ✅ Strategic SQLite indexes
- ✅ Native async/await in Express
- ✅ Circuit breaker in memory + sync to DB
- ✅ Async logging

---

## 14. V1 IMPLEMENTATION CHECKLIST

- [x] Setup Express.js + better-sqlite3 + native fetch
- [x] Create all tables (7 tables)
- [x] Implement authService.js (API Key management)
- [x] Implement authMiddleware.js (API Key for proxy)
- [x] Implement failoverEngine.js
- [x] Implement circuitBreaker.js
- [x] Implement cacheManager.js (configurable TTL)
- [x] Implement metricsLogger.js
- [x] Create providers endpoints (/admin/api/providers/*)
- [x] Create metrics endpoints (/admin/api/metrics/*)
- [x] Create keys endpoints (/admin/api/keys/*)
- [x] Create proxy endpoints (/v1/chat/completions, /v1/embeddings)
- [x] Setup React + Vite in frontend/
- [x] Implement Dashboard.jsx + navigation
- [x] Implement ProvidersList.jsx + drag-and-drop
- [x] Implement ProviderForm.jsx
- [x] Implement Metrics.jsx
- [x] Implement ApiKeys.jsx
- [x] Implement Logs.jsx
- [x] Backend self-serves frontend build (express.static)
- [x] Add .env.example
- [x] Create Dockerfile multi-stage in docker/
- [x] Create docker-compose.yml in docker/
- [x] Tests with Vitest (unit + integration)
- [x] Create README.md

---

## 15. SECURITY

- ✅ API Keys shown only at creation (never retrieved)
- ✅ Full access audit (requests_log)
- ✅ Input validation on all endpoints
- ✅ `/v1` rate limiting per API Key + IP (`rateLimit.proxyPerMinute`)
- ✅ Provider API keys encrypted at rest (AES-256-GCM with `security.encryptionKey`)
- ✅ Client API keys stored as SHA-256 hashes (`api_keys.key_hash`); only a prefix is shown
- ✅ SSRF guard on provider URL create/update/test (rejects localhost/loopback/private/link-local)

---

## 16. EXAMPLE: CREATE PROVIDER AND USE

### 16.1 User creates first provider

```
Dashboard:
1. Click "Add Provider"
2. Fill in:
   - Name: "Example Provider"
   - API URL: "https://api.provider.com/v1"
   - API Key: "sk-..."
   - Model: "model-chat"
   - Type: "chat"
   - Rate limit: 60 req/min
   - Tokens/day: 0 (no limit)
   - Cooldown after failures: 5
   - Cooldown duration: 300s

3. Click "Create"
4. Provider created with order_position = 0 ("Main")
```

### 16.2 User creates second provider

```
Dashboard:
1. Click "Add Provider"
2. Fill in provider details
3. Click "Create"
4. Provider created with order_position = 1 ("Fallback 1")
```

### 16.3 User generates API Key

```
Dashboard:
1. Click "Manage API Keys"
2. Click "Create New Key"
3. Name: "My AI Agent"
4. Click "Create"
5. Shows: "llm_pk_abc123def456..."
6. Message: "Save this key now, you won't see it again"
7. User copies the key
```

### 16.4 AI Agent uses API Key

```javascript
const response = await fetch('http://localhost:3000/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer llm_pk_abc123def456...',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    model: 'model-chat',
    messages: [
      { role: 'user', content: 'Hello, how are you?' }
    ]
  })
});

const data = await response.json();
console.log(data.choices[0].message.content);
```

### 16.5 Failover in Action

```
Agent requests /v1/chat/completions

Relio tries in order:
1. Provider A (order_position=0, "Main")
   └─> Fails: rate limit exceeded

2. Provider B (order_position=1, "Fallback 1")
   └─> OK: Returns response + caches

Agent receives OpenAI-identical response
(Does not know which provider served it)
```

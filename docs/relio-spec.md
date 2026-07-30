# Relio: LLM Relay — Full Technical Specification

> **⚠️ Legacy document — covers the initial v1.0 release. For current feature documentation see [PRD.md](./PRD.md) (requirements) and [README.md](../README.md) (overview).**
>
> **v1.1 updates (see [Validation Guide](./validation-guide.md) for full compliance checklist):**
> - Embeddings now routed through dedicated adapter method (not chat endpoint)
> - `GET /v1/models` endpoint added
> - Errors normalized to OpenAI `{error: {message, type, code}}` format
> - `_provider` field made configurable via `config.relay.exposeProvider`
> - Gemini: `role: 'tool'` → `functionResponse`, streaming tool calls fixed
> - Anthropic: `tool_choice` mapped correctly
> - Gemini: `response_format` → `generationConfig.responseMimeType`

**Name:** Relio (LLM Relay)  
**Version:** 1.0  
**Stack:** Node.js + Express.js + SQLite (better-sqlite3)  
**Authentication:** Geduma API (3 external endpoints)  
**Local DB:** SQLite (audit and configuration)  
**Frontend:** React + Vite (self-served by Express)  
**HTTP Client:** Native `fetch` (Node 18+)  
**Testing:** Vitest  
**Infra:** Docker multi-stage (`docker/`)

---

## 1. EXECUTIVE SUMMARY

**Relio** is an intelligent, minimalistic proxy that:
- ✅ Centralizes multiple LLM providers (OpenAI, Anthropic, Groq, etc.)
- ✅ Implements automatic failover with intelligent circuit breaker
- ✅ Exposes an OpenAI-compatible API (`/v1/chat/completions`, `/v1/embeddings`)
- ✅ Logs every request to SQLite for full audit
- ✅ Caches identical responses persistently
- ✅ Uses Geduma API for user authentication (OAuth)
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
    ┌───▼──────────┐   ┌────▼─────────┐   ┌───▼──────┐
    │ OAuth Login  │   │  /v1/* proxy  │   │API Keys  │
    │  (Geduma)    │   │   requests    │   │(SQLite)  │
    └───┬──────────┘   └────┬─────────┘   └───┬──────┘
        │                    │                │
        └────────────────────┼────────────────┘
                             │
                    ┌────────▼────────┐
                    │  authMiddleware │
                    │  (Geduma + Key) │
                    └────────┬────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
    ┌───▼────────┐    ┌──────▼─────────┐   ┌────▼────┐
    │  Dashboard │    │ FailoverEngine │   │  Cache  │
    │   Routes   │    │  (selects      │   │ Manager │
    │            │    │   provider)    │   │         │
    └────────────┘    └──────┬─────────┘   └────┬────┘
                             │                  │
                    ┌────────▼──────────────────▼────┐
                    │  Circuit Breaker + Rate Limit  │
                    │  (validation before sending)   │
                    └────────┬─────────────────────┘
                             │
        ┌────────────────────┴────────────────────┐
        │                                         │
   ┌────▼─────┐  ┌────────┐  ┌────────┐  ┌─────▼──┐
   │  OpenAI  │  │Anthropic│ │ Groq  │  │ ... N  │
   │   API    │  │   API   │  │  API  │  │Providers
   └──────────┘  └─────────┘  └───────┘  └────────┘

        DB Layer (SQLite)
        ├── providers (config)
        ├── requests_log (audit)
        ├── api_keys (local keys)
        ├── login_history (auth logs)
        ├── cache (deduplication)
        ├── metrics (aggregates)
        ├── circuit_breaker_state (temporal state)
        └── sessions (dashboard sessions)
```

### 2.2 Core Components

| Component | Responsibility | Technology |
|------------|----------------|-----------|
| **authService** | Auth provider abstraction, API Key validation | Node.js |
| **authMiddleware** | Validate incoming requests | Express |
| **AuthProvider** (base) | Pluggable auth interface | Node.js |
| **GedumaAuthProvider** | Geduma OAuth implementation | Node.js |
| **NoneAuthProvider** | Anonymous session provider | Node.js |
| **failoverEngine** | Select provider by order | Node.js |
| **circuitBreaker** | Manage provider states | SQLite + memory |
| **cacheManager** | Deduplicate responses | SQLite |
| **metricsLogger** | Log requests + calculate metrics | SQLite |
| **dashboard** | Provider management UI | React + Vite (self-served) |

---

## 3. AUTHENTICATION: PLUGGABLE PROVIDERS

Relio uses a pluggable auth provider system. The active provider is selected via `auth.provider` in `config.json`. This allows anyone to implement their own authentication by creating a class that extends `AuthProvider` (see `src/auth/base.js`).

### 3.1 Built-in Providers

| Provider | `auth.provider` | Login UI | Description |
|---|---|---|---|
| **Geduma** (default) | `geduma` | OAuth buttons | OAuth via Geduma API (3 endpoints, no API token needed) |
| **None** | `none` | None (auto-login) | Anonymous session, no authentication |

### 3.2 Implementing a Custom Provider

Create a file in `src/auth/` that extends the `AuthProvider` base class:

```js
// src/auth/myprovider.js
import AuthProvider from './base.js'

export default class MyProvider extends AuthProvider {
  static get type() { return 'myprovider' }
  get loginView() { return 'oauth' } // or 'none'
  async getLoginConfig() { ... }
  async initiateLogin({ provider }) { return { redirect: '...' } }
  async login(credentials) { ... }
  async logout(sessionId) { ... }
  async getSession(sessionId) { ... }
}
```

Set `auth.provider` in `config.json` to the provider type. The factory (`src/auth/index.js`) loads it automatically.

### 3.3 Geduma Auth Flow

Relio uses the **Geduma Auth** module (`/auth` endpoints on `api.geduma.com`). No API token is required — only an `appId` registered on the platform.

#### 3.3.1 Endpoints Consumed

| Method | Path | Purpose |
|---|---|---|
| GET | `/auth/providers/:appId` | List OAuth providers enabled for the app |
| POST | `/auth/login/:appId/:provider` | Initiate OAuth login, returns redirect URL |
| GET | `/auth/session/:sessionToken` | Exchange session token for user data |

#### 3.3.2 Login Flow (Step by Step)

```
Relio Frontend          Relio Backend           Geduma API          OAuth Provider
     │                       │                      │                    │
     │  GET /providers        │                      │                    │
     │──────────────────────►│                      │                    │
     │                       │  GET /auth/providers/:appId               │
     │                       │─────────────────────►│                    │
     │                       │◄─────────────────────┤                    │
     │◄──────────────────────┤  { providers }       │                    │
     │                       │                      │                    │
     │  POST /login          │                      │                    │
     │  { provider }         │                      │                    │
     │──────────────────────►│                      │                    │
     │                       │  POST /auth/login/:appId/:provider       │
     │                       │─────────────────────►│                    │
     │                       │◄─────────────────────┤                    │
     │◄──────────────────────┤  { redirect }        │                    │
     │                       │                      │                    │
     │──── redirect ────────────────────────────────│──── OAuth ────────►│
     │                       │                      │                    │
     │                       │                      │◄── callback ──────┤
     │                       │                      │ (code + state)    │
     │                       │                      │                    │
     │                       │                      │  ── HTML ──►      │
     │◄─── redirect#session_token=xxx ──────────────┤  (redirect)       │
     │                       │                      │                    │
     │  POST /callback       │                      │                    │
     │  { sessionToken }     │                      │                    │
     │──────────────────────►│                      │                    │
     │                       │  GET /auth/session/:sessionToken          │
     │                       │─────────────────────►│                    │
     │                       │◄─────────────────────┤  { user }         │
     │                       │  create session      │                    │
     │◄──────────────────────┤  set cookie          │                    │
     │                       │                      │                    │
     │── dashboard ─────────►│                      │                    │
```

#### 3.3.3 Request/Response Examples

**1. GET /auth/providers/:appId**

```
GET https://api.geduma.com/auth/providers/app_mrjlwiq7sdny2i

Response: { ok: true, data: [{ providerId: "google", name: "google", displayName: "Google" }] }
```

**2. POST /auth/login/:appId/:provider**

```
POST https://api.geduma.com/auth/login/app_mrjlwiq7sdny2i/google

Response: { ok: true, data: { redirect: "https://accounts.google.com/o/oauth2/..." } }
```

**3. GET /auth/session/:sessionToken**

```
GET https://api.geduma.com/auth/session/550e8400-e29b-41d4-a716-446655440000

Response: { ok: true, data: { email: "user@example.com", displayName: "User", picture: "...", provider: "google", allowed: true } }
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

### 4.5 Table: `login_history`

Logs all login attempts.

```sql
CREATE TABLE login_history (
  id TEXT PRIMARY KEY,
  email TEXT,
  method TEXT NOT NULL,
  provider TEXT,
  status TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  error_message TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,

  INDEX(email, timestamp),
  INDEX(timestamp)
);
```

### 4.6 Table: `circuit_breaker_state`

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

### 4.7 Table: `sessions`

Local dashboard sessions (Geduma token is single-use).

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_email TEXT,
  user_name TEXT,
  user_avatar TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME,

  INDEX(token_hash),
  INDEX(expires_at)
);
```

### 4.8 Table: `metrics`

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

### 5.1 Flow 1: Dashboard Login (Geduma OAuth)

```
1. User visits http://localhost:3000/admin
   └─> Not authenticated → Redirect to /admin/login

2. Frontend: GET /admin/api/auth/providers
   └─> Gets provider list from Geduma

3. User clicks: "Login with Google"
   └─> Google OAuth flow → Gets authorization_code

4. Frontend: POST /admin/api/auth/login
   { "provider": "google", "code": "authorization_code" }

5. Backend → Geduma API:
   POST https://geduma-api.com/api/auth/login

6. If valid:
   ├─ Store session token in httpOnly cookie
   ├─ Log login in SQLite
   └─ Return { user }

7. Client redirects to /admin/dashboard
   └─> Cookie has token automatically
```

### 5.2 Flow 2: Dashboard Access

```
Client makes request:
GET /admin/api/summary
Cookie: relio_session=...

Backend:
├─ Validate cookie
├─ Check local session in SQLite
└─> Process request

Returns protected data
```

### 5.3 Flow 3: API Key Auth (Proxy Endpoints)

```
1. AI agent requests /v1/chat/completions
   Header: Authorization: Bearer llm_pk_xxx...

2. authMiddleware:
   ├─ Extract and validate API key in SQLite
   ├─ Check not revoked
   ├─ Update last_used_at
   └─ Log in login_history

3. FailoverEngine processes normally
   └─> Log in requests_log
```

### 5.4 Flow 4: Logout

```
User: POST /admin/api/auth/logout
Backend:
├─ Clear relio_session cookie
├─ Log logout in login_history
└─> Redirect to /admin/login
```

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

### 7.1 Authentication

#### GET /admin/api/auth/providers
Gets available login providers.

```javascript
// No auth required
// Returns: { providers: [...] }
```

#### POST /admin/api/auth/login
Initiates OAuth login. Returns the URL to redirect the user to.

```javascript
// No auth required
// Body: { "provider": "google" }
// Returns: { redirect: "https://accounts.google.com/o/oauth2/..." }
```

#### POST /admin/api/auth/callback
Exchanges a session token (from Geduma redirect) for a local session.

```javascript
// No auth required
// Body: { "sessionToken": "550e8400-e29b-41d4-a716-446655440000" }
// Returns: { user: { email, name, avatar } }
// Sets: relio_session cookie
```

#### POST /admin/api/auth/logout
Ends session.

```javascript
// Requires: relio_session cookie
// Returns: { success: true }
```

### 7.2 Dashboard: Providers

#### GET /admin/api/providers?type=chat
Lists ordered providers.

```javascript
// Requires: relio_session cookie
// Query params: type ('chat', 'embeddings', 'vision' - optional)
// Returns: [ { id, name, model, order_position, order_label, status, ... } ]
```

#### POST /admin/api/providers
Creates a new provider.

```javascript
// Requires: relio_session cookie
// Body: {
//   "name": "OpenAI GPT-4",
//   "api_url": "https://api.provider.com/v1",
//   "api_key": "sk-...",
//   "model": "gpt-4",
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
// Requires: relio_session cookie
// Body: { "status": "paused", "rate_limit_req_per_min": 120, ... }
// Does NOT allow: order_position, order_label
// Returns: { success: true }
```

#### PATCH /admin/api/providers/reorder
Changes provider order.

```javascript
// Requires: relio_session cookie
// Body: { "provider_ids": ["id_1", "id_3", "id_2"] }
// Updates order_position for each
// Auto-regenerates order_label (Main, Fallback 1, ...)
// Returns: { success: true }
```

#### DELETE /admin/api/providers/:id
Deletes provider.

```javascript
// Requires: relio_session cookie
// Auto-reorganizes order_position for remaining providers
// Returns: { success: true }
```

### 7.3 Dashboard: Metrics

#### GET /admin/api/metrics?from=2024-01-01&to=2024-01-31
Per-provider metrics in a date range.

```javascript
// Requires: relio_session cookie
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
// Requires: relio_session cookie
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

### 7.4 Dashboard: API Keys

#### POST /admin/api/auth/api-keys
Creates a new API Key.

```javascript
// Requires: relio_session cookie
// Body: { "name": "Production App" }
// Returns: { "apiKey": "llm_pk_xxx...", "message": "..." }
// NOTE: Key shown only once
```

#### GET /admin/api/auth/api-keys
Lists API Keys (sanitized).

```javascript
// Requires: relio_session cookie
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

#### DELETE /admin/api/auth/api-keys/:keyPreview
Revokes an API Key.

```javascript
// Requires: relio_session cookie
// Param: keyPreview (e.g. "llm_pk_...xxx")
// Returns: { success: true }
```

### 7.5 Proxy Endpoints (Public)

#### POST /v1/chat/completions
OpenAI-compatible chat/vision.

```javascript
// Requires: Authorization: Bearer llm_pk_xxx...
// Body: { "model": "gpt-4", "messages": [...], ... }
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

All configuration lives in `config.json` at the project root. Copy `config.example.json` and edit.

| Key | Type | Default | Description |
|---|---|---|---|
| `auth.provider` | string | `geduma` | Auth provider: `geduma` or `none` |
| `geduma.apiUrl` | string | `https://api.geduma.com` | Geduma API base URL |
| `geduma.appId` | string | `app_...` | App ID registered on geduma-auth |
| `db.path` | string | `./db/db.sqlite` | SQLite database path |
| `cache.ttlSeconds` | number | `2592000` | Cache TTL in seconds (30 days) |
| `server.port` | number | `3000` | Server port |
| `server.host` | string | `0.0.0.0` | Server host |
| `server.baseUrl` | string | `http://localhost:3000` | Public URL for OAuth redirects |
| `server.nodeEnv` | string | `development` | `development` or `production` |
| `cookie.secure` | boolean | `false` | Secure cookie flag |
| `cookie.sameSite` | string | `strict` | SameSite cookie policy |
| `cookie.httpOnly` | boolean | `true` | HTTP-only cookie flag |

Env var overrides (for testing): `DB_PATH`, `PORT`, `HOST`, `NODE_ENV`, `CONFIG_PATH`.

---

## 9. FOLDER STRUCTURE

```
relio/
├── src/
│   ├── index.js                    # Entry point (Express)
│   ├── config.js                   # Reads config.json
│   ├── db.js                       # SQLite setup + migrations
│   ├── auth/                       # Pluggable auth providers
│   │   ├── base.js                 # AuthProvider abstract class
│   │   ├── geduma.js               # Geduma OAuth provider
│   │   ├── none.js                 # Anonymous session provider
│   │   └── index.js                # Factory (loads from AUTH_PROVIDER)
│   ├── services/
│   │   ├── authService.js          # Auth provider abstraction + API Keys
│   │   ├── failoverEngine.js       # Provider selection
│   │   ├── circuitBreaker.js       # States and cooldown
│   │   ├── cacheManager.js         # Deduplication with TTL
│   │   └── metricsLogger.js        # Logging and daily aggregates
│   ├── middleware/
│   │   └── authMiddleware.js       # Cookie/API Key validation
│   ├── routes/
│   │   ├── auth.routes.js          # /admin/api/auth/*
│   │   ├── providers.routes.js     # /admin/api/providers/*
│   │   ├── metrics.routes.js       # /admin/api/metrics/*
│   │   ├── keys.routes.js          # /admin/api/auth/api-keys/*
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
│   │   │   ├── Login.jsx           # Login screen
│   │   │   ├── Dashboard.jsx       # Protected layout
│   │   │   ├── ProvidersList.jsx   # List + reorder
│   │   │   ├── ProviderForm.jsx    # Create/edit provider
│   │   │   ├── Metrics.jsx         # Metrics and stats
│   │   │   ├── ApiKeys.jsx         # API Key management
│   │   │   └── Logs.jsx            # Recent requests
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
├── config.json                     # Configuration (git-ignored)
├── config.example.json             # Configuration template
├── .gitignore
├── package.json                    # Backend dependencies
└── README.md
```

---

## 10. COMPLETE LOGIN FLOW

```
1. User opens http://localhost:3000/admin
   └─> GET /admin/api/auth/providers
       └─> Backend calls GET /auth/providers/:appId (Geduma API)
       └─> Frontend shows OAuth provider buttons

2. User clicks "Google"
   └─> Frontend: POST /admin/api/auth/login { provider: "google" }
       └─> Backend calls POST /auth/login/:appId/google (Geduma API)
       └─> Returns { redirect: "https://accounts.google.com/o/oauth2/..." }

3. Browser redirects to Google OAuth
   └─> User authenticates

4. Google redirects to Geduma API: /auth?code=xxx&state=yyy
   └─> Geduma processes OAuth callback, creates session
   └─> Geduma returns HTML that redirects to Relio's redirectUrl#session_token=xxx

5. Browser arrives at Relio with #session_token=xxx
   └─> Frontend detects hash → POST /admin/api/auth/callback { sessionToken }

6. Backend:
   └─> Calls GET /auth/session/:sessionToken (Geduma API)
   └─> Gets user data (email, name, avatar)
   └─> Creates local session in SQLite
   └─> Sets httpOnly cookie (relio_session)
   └─> Returns { user }

7. Frontend navigates to /admin/dashboard

8. Subsequent requests use relio_session cookie automatically
```

---

## 11. COMPLETE PROXY + FAILOVER FLOW

```
1. AI agent: POST /v1/chat/completions
   Header: Authorization: Bearer llm_pk_xxx...
   Body: { "model": "gpt-4", "messages": [...] }

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

## 12. METRICS AND AUDIT

### 12.1 Automatic Metrics

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

### 12.2 Audit: Login History

```sql
SELECT email, method, provider, status, timestamp
FROM login_history
ORDER BY timestamp DESC
LIMIT 50;
```

### 12.3 Audit: Requests

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

## 13. DATA MANAGEMENT AND ROTATION

### 13.1 Data Retention

- **requests_log:** 90 days
- **cache:** 30 days (TTL per entry)
- **login_history:** 90 days
- **metrics:** 365 days (aggregates)
- **circuit_breaker_state:** Temporal (no retention)
- **sessions:** 7 days (expired sessions)

### 13.2 Automatic Backup

```
Every day at 02:00 AM:
├─ Backup: cp db.sqlite → backups/db-YYYY-MM-DD.sqlite
├─ Keep between 2-10 backups (configurable)
├─ Clean logs older than 90 days
├─ Archive old logs to logs/archive/
└─ Clean expired sessions
```

---

## 14. PERFORMANCE AND OVERHEAD

### 14.1 Expected Latency

```
Provider DB lookup:                    ~2-5ms
Request routing + failover logic:      ~5-10ms
Cache lookup:                          ~1-3ms
Call to provider (HTTP):               ~1,000-5,000ms
Logging to DB:                         ~5-10ms

TOTAL OVERHEAD:                        ~15-25ms (0.3%-2.5% of total)
```

### 14.2 Optimizations

- ✅ In-memory provider cache (refresh every 60s)
- ✅ Strategic SQLite indexes
- ✅ Native async/await in Express
- ✅ Circuit breaker in memory + sync to DB
- ✅ Async logging

---

## 15. V1 IMPLEMENTATION CHECKLIST

- [x] Setup Express.js + better-sqlite3 + native fetch
- [x] Create all tables (9 tables)
- [x] Implement authService.js (Geduma login, local sessions)
- [x] Implement authMiddleware.js (cookie for dashboard, API Key for proxy)
- [x] Implement failoverEngine.js
- [x] Implement circuitBreaker.js
- [x] Implement cacheManager.js (configurable TTL)
- [x] Implement metricsLogger.js
- [x] Create auth endpoints (/admin/api/auth/*)
- [x] Create providers endpoints (/admin/api/providers/*)
- [x] Create metrics endpoints (/admin/api/metrics/*)
- [x] Create keys endpoints (/admin/api/auth/api-keys/*)
- [x] Create proxy endpoints (/v1/chat/completions, /v1/embeddings)
- [x] Setup React + Vite in frontend/
- [x] Implement Login.jsx
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

## 16. SECURITY

- ✅ API Keys shown only at creation (never retrieved)
- ✅ Full access audit (login_history, requests_log)
- ✅ Input validation on all endpoints
- ✅ httpOnly cookies for session tokens
- ⬜ IP-based rate limiting (planned)
- ⬜ API key encryption at rest (planned)

---

## 17. EXAMPLE: CREATE PROVIDER AND USE

### 17.1 User creates first provider

```
Dashboard:
1. Click "Add Provider"
2. Fill in:
   - Name: "OpenAI GPT-4"
   - API URL: "https://api.provider.com/v1"
   - API Key: "sk-..."
   - Model: "gpt-4"
   - Type: "chat"
   - Rate limit: 60 req/min
   - Tokens/day: 0 (no limit)
   - Cooldown after failures: 5
   - Cooldown duration: 300s

3. Click "Create"
4. Provider created with order_position = 0 ("Main")
```

### 17.2 User creates second provider

```
Dashboard:
1. Click "Add Provider"
2. Fill in Anthropic Claude details
3. Click "Create"
4. Provider created with order_position = 1 ("Fallback 1")
```

### 17.3 User generates API Key

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

### 17.4 AI Agent uses API Key

```javascript
const response = await fetch('http://localhost:3000/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer llm_pk_abc123def456...',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    model: 'gpt-4',
    messages: [
      { role: 'user', content: 'Hello, how are you?' }
    ]
  })
});

const data = await response.json();
console.log(data.choices[0].message.content);
```

### 17.5 Failover in Action

```
Agent requests /v1/chat/completions

Relio tries in order:
1. OpenAI (order_position=0, "Main")
   └─> Fails: rate limit exceeded

2. Anthropic Claude (order_position=1, "Fallback 1")
   └─> OK: Returns response + caches

Agent receives OpenAI-identical response
(Does not know it came from Anthropic)
```

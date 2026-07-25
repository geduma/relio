# Relio — Implementation Plan v1

## Architectural Decisions

| Aspect | Decision |
|---|---|
| Frontend | React + Vite, self-served by Express (express.static) |
| HTTP Client | Native `fetch` (Node 18+) — no axios |
| Database | better-sqlite3 (synchronous, fast) + raw SQL |
| Migrations | Versioned SQL in `db/migrations/` |
| Costs | `cost_per_input_token` / `cost_per_output_token` per provider |
| Cache TTL | Configurable via `CACHE_TTL_SECONDS` (default 30 days) |
| Sessions | Local `sessions` table (Geduma token is single-use) |
| Vision | Unified in `/v1/chat/completions` (multimodal) |
| Testing | Vitest |
| Docker | `docker/` dedicated folder with multi-stage build |
| Dashboard | httpOnly cookie with local session ID |

---

## Implementation Phases

### Phase 0: Scaffolding

**Files to create:**
- `package.json` (backend) — express, better-sqlite3, cookie-parser, uuid, dotenv, node-cron
- `frontend/package.json` — react, react-dom, vite, @vitejs/plugin-react
- `src/index.js` — minimal Express entry point
- `src/config.js` — env var loading with defaults
- `frontend/vite.config.js` — proxy to Express in dev, output to `../frontend/dist/`
- `.env.example`
- `.gitignore`
- `docker/Dockerfile`
- `docker/docker-compose.yml`
- `docker/.dockerignore`

**Commands:** `npm init`, `npm install`, git init (optional)

---

### Phase 1: Database

**File:** `src/db.js`

- Initialize better-sqlite3 with WAL mode
- Run migrations in order from `db/migrations/`
- Create 9 tables: providers, requests_log, cache, api_keys, login_history, circuit_breaker_state, sessions, metrics
- Helper functions: `dbAll()`, `dbGet()`, `dbRun()`, `dbExec()`, `dbTransaction()`

**Additional fields vs original spec:**
- `providers`: +`cost_per_input_token`, +`cost_per_output_token`
- `sessions`: new table (token_hash, user_email, user_name, user_avatar, expires_at)

---

### Phase 2: Core Services

#### 2.1 `src/external/gedumaClient.js`
- Native fetch for the 3 Geduma endpoints
- `getProviders()` → GET /api/auth/providers
- `login(provider, code)` → POST /api/auth/login
- `getUser(token)` → GET /api/auth/user (not used at runtime, token single-use)
- Configurable timeout, error handling

#### 2.2 `src/services/authService.js`
- `login(provider, code)`: calls Geduma, stores session in SQLite, returns session_id
- `logout(sessionId)`: removes session from SQLite
- `getSession(sessionId)`: looks up active non-expired session
- `createApiKey(name)`: generates `llm_pk_` + uuid, stores hash, returns plain key
- `validateApiKey(key)`: looks up non-revoked key, updates last_used_at
- `listApiKeys()`: returns sanitized keys (key_preview)
- `revokeApiKey(keyPreview)`: marks revoked = true

#### 2.3 `src/services/failoverEngine.js`
- `selectProvider(modelType)`: queries active providers ordered by order_position
- Filters: cooldown, rate limit, daily limits
- `callProvider(provider, requestBody)`: fetch to provider API with 30s timeout
- HTTP error handling + response parsing

#### 2.4 `src/services/circuitBreaker.js`
- States: `healthy`, `cooldown`, `paused`
- `recordFailure(providerId)`: increments counter, if >= threshold → cooldown
- `recordSuccess(providerId)`: resets counter
- `getState(providerId)`: queries current state

#### 2.5 `src/services/cacheManager.js`
- `generateHash(requestBody)`: SHA-256 of serialized body
- `get(queryHash)`: looks up non-expired cache, increments hit_count
- `set(endpoint, requestBody, responseBody)`: inserts with expires_at
- TTL from `CACHE_TTL_SECONDS` (env)

#### 2.6 `src/services/metricsLogger.js`
- `logRequest(data)`: inserts into requests_log with all fields
- `updateMetrics(providerId, data)`: upsert in daily metrics
- `getMetrics(providerId, from, to)`: aggregated query by range
- `getLogs(limit, offset)`: paginated requests_log
- Cost calculation: `input_tokens * cost_per_input_token + output_tokens * cost_per_output_token`

---

### Phase 3: Middleware

#### `src/middleware/authMiddleware.js`
- **Dashboard auth**: extracts `relio_session` cookie, looks up in `sessions` table, rejects if nonexistent/expired
- **Proxy auth**: extracts `Authorization: Bearer`, validates against `api_keys`, rejects if revoked/missing
- Public routes: `/admin/api/auth/providers`, `/admin/api/auth/login`, `/admin/api/metrics/health`

---

### Phase 4: API Routes

#### 4.1 `src/routes/auth.routes.js` — `/admin/api/auth/*`
| Method | Route | Auth | Description |
|---|---|---|---|
| GET | /providers | No | List Geduma login providers |
| POST | /login | No | Login via Geduma |
| GET | /callback | No | OAuth callback handler |
| POST | /logout | Cookie | Logout |

#### 4.2 `src/routes/providers.routes.js` — `/admin/api/providers/*`
| Method | Route | Description |
|---|---|---|
| GET | / | List providers (optional type filter) |
| POST | / | Create provider |
| PATCH | /:id | Edit (does not change order) |
| PATCH | /reorder | Reorder (array of ids) |
| DELETE | /:id | Delete + reorganize positions |

#### 4.3 `src/routes/metrics.routes.js` — `/admin/api/metrics/*`
| Method | Route | Description |
|---|---|---|
| GET | / | Metrics by date range (from, to) |
| GET | /logs | Recent requests (limit, offset) |
| GET | /health | Proxy health check |

#### 4.4 `src/routes/keys.routes.js` — `/admin/api/auth/api-keys/*`
| Method | Route | Description |
|---|---|---|
| POST | / | Create API Key (shown once) |
| GET | / | List (preview only) |
| DELETE | /:keyPreview | Revoke |

#### 4.5 `src/routes/proxy.routes.js` — `/v1/*`
| Method | Route | Description |
|---|---|---|
| POST | /chat/completions | Proxy with failover |
| POST | /embeddings | Proxy with failover |

---

### Phase 5: Handlers

#### `src/handlers/requestHandler.js`
Full proxy flow:
1. Validate API Key (via middleware)
2. Calculate query_hash → check cache
3. Cache hit → return immediately
4. Cache miss → failoverEngine.selectProviders(type)
5. For each provider in order:
   - Circuit breaker check
   - Rate/daily limit check
   - Fetch provider
   - Success → cache + log + return
   - Fail → circuitBreaker.recordFailure + next provider
6. All fail → 503 + detailed error

#### `src/handlers/dashboardHandler.js`
Summary metrics for dashboard (request count, tokens, daily costs).

---

### Phase 6: React Frontend

**Setup:**
- Vite with React plugin
- `frontend/vite.config.js`: proxy `/admin/api`, `/v1` to `http://localhost:3000` in dev
- Build output to `frontend/dist/` → Express serves as static

**Components:**

| Component | Route | Description |
|---|---|---|
| `Login.jsx` | `/admin/login` | OAuth login buttons |
| `Dashboard.jsx` | `/admin/dashboard/*` | Layout with sidebar + internal routing |
| `ProvidersList.jsx` | `/admin/dashboard/providers` | Table with reorder controls |
| `ProviderForm.jsx` | Modal | Create/edit provider |
| `Metrics.jsx` | `/admin/dashboard/metrics` | Per-provider metrics by range |
| `ApiKeys.jsx` | `/admin/dashboard/keys` | List + create/revoke |
| `Logs.jsx` | `/admin/dashboard/logs` | Recent requests table |

**Routing:** React Router v6 (in App.jsx)

---

### Phase 7: Backend Serves Frontend

In `src/index.js`:
```js
app.use(express.static(path.join(__dirname, '../frontend/dist')));
app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
});
```

In production, Express serves the React build.
In development, Vite proxies requests to the backend.

---

### Phase 8: Docker

**`docker/Dockerfile`** multi-stage:
1. **Stage 1 (frontend-build):** node:20-alpine, build frontend/
2. **Stage 2 (backend):** node:20-alpine, copy backend + frontend/dist, expose 3000

**`docker/docker-compose.yml`:**
```yaml
services:
  relio:
    build:
      context: ..
      dockerfile: docker/Dockerfile
    ports:
      - "3000:3000"
    volumes:
      - ./db:/app/db
      - ./logs:/app/logs
    env_file: ../.env
    restart: unless-stopped
```

---

### Phase 9: Testing (Vitest)

**Structure:** `tests/` in root

| Test file | Description |
|---|---|
| `db.test.js` | Table creation, CRUD operations |
| `cache.test.js` | Hash generation, hit/miss, TTL |
| `failover.test.js` | Provider selection, ordering, rate/daily limit checks |

---

### Phase 10: Maintenance (Retention + Backups)

**File:** `src/maintenance.js` (scheduled via node-cron)

- Every 24h:
  - Backup: copy `db.sqlite` → `db/backups/db-YYYY-MM-DD.sqlite`
  - Clean logs > 90 days
  - Clean expired cache
  - Clean login_history > 90 days
  - Clean metrics > 365 days
  - Clean expired sessions
  - Archive old app logs
  - Keep max 10 backups

---

## Recommended Implementation Order

| Order | Phase | Depends on |
|---|---|---|
| 1 | Phase 0: Scaffolding | — |
| 2 | Phase 1: Database | Phase 0 |
| 3 | Phase 2.1: gedumaClient | Phase 0 |
| 4 | Phase 2.2: authService | Phase 1, 2.1 |
| 5 | Phase 2.3-2.6: failover, CB, cache, metrics | Phase 1 |
| 6 | Phase 3: authMiddleware | Phase 2.2 |
| 7 | Phase 4: API Routes (auth, providers, metrics, keys) | Phase 3, 2.x |
| 8 | Phase 5: Handlers (requestHandler) | Phase 4 |
| 9 | Phase 4.5: proxy.routes | Phase 5 |
| 10 | Phase 6: React Frontend | — (parallel to 3-9) |
| 11 | Phase 7: Backend serves frontend | Phase 6 |
| 12 | Phase 8: Docker | Phase 7 |
| 13 | Phase 9: Testing | Phase 5, 7 |
| 14 | Phase 10: Maintenance | Phase 1 |

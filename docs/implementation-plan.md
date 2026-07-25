# Relio — Plan de Implementación v1

## Decisiones Arquitectónicas

| Aspecto | Decisión |
|---|---|
| Frontend | React + Vite, backend lo auto-sirve (express.static) |
| HTTP Client | Native `fetch` (Node 18+) — sin axios |
| Base de datos | better-sqlite3 (síncrono, rápido) + raw SQL |
| Migraciones | SQL versionadas en `db/migrations/` |
| Costos | `cost_per_input_token` / `cost_per_output_token` por provider |
| Cache TTL | Configurable vía `CACHE_TTL_SECONDS` (default 30 días) |
| Sesiones | Tabla `sessions` local (token Geduma es single-use) |
| Vision | Unificado en `/v1/chat/completions` (multimodal) |
| Testing | Vitest |
| Docker | `docker/` carpeta dedicada con multi-stage build |
| Dashboard | httpOnly cookie con session ID local |

---

## Fases de Implementación

### Fase 0: Scaffolding

**Archivos a crear:**
- `package.json` (backend) — express, better-sqlite3, cookie-parser, uuid, dotenv, node-cron
- `frontend/package.json` — react, react-dom, vite, @vitejs/plugin-react
- `src/index.js` — entry point Express mínimo
- `src/config.js` — carga de .env con defaults
- `frontend/vite.config.js` — proxy a Express en dev, output a `../frontend/dist/`
- `.env.example`
- `.gitignore`
- `docker/Dockerfile`
- `docker/docker-compose.yml`
- `docker/.dockerignore`

**Comandos:** `npm init`, `npm install`, git init (opcional)

---

### Fase 1: Base de Datos

**Archivo:** `src/db.js`

- Inicializar better-sqlite3 con WAL mode
- Ejecutar migraciones en orden desde `db/migrations/`
- Migration 001: Crear tabla `providers`
- Migration 002: Crear tabla `requests_log`
- Migration 003: Crear tabla `cache`
- Migration 004: Crear tabla `api_keys`
- Migration 005: Crear tabla `login_history`
- Migration 006: Crear tabla `circuit_breaker_state`
- Migration 007: Crear tabla `sessions`
- Migration 008: Crear tabla `metrics`
- Migration 009: Índices compuestos

**Campos adicionales vs spec original:**
- `providers`: +`cost_per_input_token`, +`cost_per_output_token`
- `sessions`: tabla nueva (token_hash, user_email, user_name, user_avatar, expires_at)

**Funciones helper:** `db.all(sql, params)`, `db.get(sql, params)`, `db.run(sql, params)`

---

### Fase 2: Servicios Core

#### 2.1 `src/external/gedumaClient.js`
- Native fetch para los 3 endpoints de Geduma
- `getProviders()` → GET /api/auth/providers
- `login(provider, code)` → POST /api/auth/login
- `getUser(token)` → GET /api/auth/user (no se usará en runtime, token single-use)
- Timeout configurable, error handling

#### 2.2 `src/services/authService.js`
- `login(provider, code)`: llama Geduma, almacena sesión en SQLite, retorna session_id
- `logout(sessionId)`: elimina sesión de SQLite
- `getSession(sessionId)`: busca sesión activa no expirada
- `createApiKey(name)`: genera `llm_pk_` + uuid, almacena hash, retorna key plana
- `validateApiKey(key)`: busca key no revocada, actualiza last_used_at
- `listApiKeys()`: retorna keys sanitizadas (key_preview)
- `revokeApiKey(keyPreview)`: marca revoked = true

#### 2.3 `src/services/failoverEngine.js`
- `selectProvider(modelType)`: query a providers activos ordenados por order_position
- Filtra: cooldown, rate limit, daily limits
- `callProvider(provider, requestBody)`: fetch a provider API con timeout 30s
- Manejo de errores HTTP + parseo de response

#### 2.4 `src/services/circuitBreaker.js`
- Estados: `healthy`, `cooldown`, `paused`
- `recordFailure(providerId)`: incrementa contador, si >= threshold → cooldown
- `recordSuccess(providerId)`: resetea contador
- `getState(providerId)`: consulta estado actual
- Sincronización: estado en SQLite, pero lectura en memoria con refresh periódico

#### 2.5 `src/services/cacheManager.js`
- `generateHash(requestBody)`: SHA-256 del body serializado
- `get(queryHash)`: busca en cache no expirado, incrementa hit_count
- `set(endpoint, requestBody, responseBody, ttl)`: inserta con expires_at
- TTL desde `CACHE_TTL_SECONDS` (env)

#### 2.6 `src/services/metricsLogger.js`
- `logRequest(data)`: inserta en requests_log con todos los campos
- `updateMetrics(providerId, data)`: upsert en metrics del día
- `getMetrics(providerId, from, to)`: query agregada por rango
- `getLogs(limit, offset)`: paginación de requests_log
- Cálculo de `estimated_cost`: `input_tokens * cost_per_input_token + output_tokens * cost_per_output_token`

---

### Fase 3: Middleware

#### `src/middleware/authMiddleware.js`
- **Dashboard auth**: extrae cookie `relio_session`, busca en tabla `sessions`, rechaza si no existe o expiró
- **Proxy auth**: extrae `Authorization: Bearer`, valida contra `api_keys`, rechaza si revocada o inexistente
- Rutas públicas: `/admin/api/auth/providers`, `/admin/api/auth/login`, `/admin/api/health`
- Decorator: adjunta `req.user` o `req.apiKey` según corresponda

---

### Fase 4: Rutas API

#### 4.1 `src/routes/auth.routes.js` — `/admin/api/auth/*`
| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | /providers | No | Lista providers de login (Geduma) |
| POST | /login | No | Login con Geduma |
| POST | /logout | Cookie | Cerrar sesión |

#### 4.2 `src/routes/providers.routes.js` — `/admin/api/providers/*`
| Método | Ruta | Descripción |
|---|---|---|
| GET | / | Lista providers (filtro type opcional) |
| POST | / | Crear provider |
| PATCH | /:id | Editar (no cambia orden) |
| PATCH | /reorder | Reordenar (array de ids) |
| DELETE | /:id | Eliminar + reorganizar posiciones |

#### 4.3 `src/routes/metrics.routes.js` — `/admin/api/metrics/*`
| Método | Ruta | Descripción |
|---|---|---|
| GET | / | Métricas por rango (from, to) |
| GET | /logs | Últimos requests (limit, offset) |
| GET | /health | Health check del proxy |

#### 4.4 `src/routes/keys.routes.js` — `/admin/api/auth/api-keys/*`
| Método | Ruta | Descripción |
|---|---|---|
| POST | / | Crear API Key (muestra una vez) |
| GET | / | Listar (solo preview) |
| DELETE | /:keyPreview | Revocar |

#### 4.5 `src/routes/proxy.routes.js` — `/v1/*`
| Método | Ruta | Descripción |
|---|---|---|
| POST | /chat/completions | Proxy con failover |
| POST | /embeddings | Proxy con failover |

---

### Fase 5: Handlers

#### `src/handlers/requestHandler.js`
Flujo completo del proxy:
1. Validar API Key (via middleware)
2. Calcular query_hash → buscar en cache
3. Cache hit → retornar inmediatamente
4. Cache miss → failoverEngine.selectProvider(type)
5. Para cada provider en orden:
   - Circuit breaker check
   - Rate/daily limit check
   - Fetch a provider
   - Éxito → cachear + log + retornar
   - Falla → circuitBreaker.recordFailure + siguiente provider
6. Todos fallan → 503 + error detallado

#### `src/handlers/dashboardHandler.js`
Métricas resumidas para el dashboard (request count, tokens, costos del día).

---

### Fase 6: Frontend React

**Setup:**
- Vite con React plugin
- `frontend/vite.config.js`: proxy `/admin/api`, `/v1` a `http://localhost:3000` en dev
- Build output a `frontend/dist/` → Express lo sirve como static

**Componentes:**

| Componente | Ruta | Descripción |
|---|---|---|
| `Login.jsx` | `/admin/login` | Botones de OAuth (Google, GitHub) |
| `Dashboard.jsx` | `/admin/dashboard` | Layout con sidebar + stats |
| `ProvidersList.jsx` | `/admin/dashboard/providers` | Tabla con drag-and-drop reorder |
| `ProviderForm.jsx` | Modal | Crear/editar provider |
| `Metrics.jsx` | `/admin/dashboard/metrics` | Métricas por provider + rango |
| `ApiKeys.jsx` | `/admin/dashboard/keys` | Lista + crear/revocar |
| `Logs.jsx` | `/admin/dashboard/logs` | Últimos requests tabla |

**Routing:** React Router (incluido en App.jsx)

---

### Fase 7: Backend auto-sirve Frontend

En `src/index.js`:
```js
app.use(express.static(path.join(__dirname, '../frontend/dist')));
app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
});
```

En producción, Express sirve el build de React.
En desarrollo, Vite proxy los requests al backend.

---

### Fase 8: Docker

**`docker/Dockerfile`** multi-stage:
1. **Stage 1 (frontend-build):** node:20-alpine, build frontend/
2. **Stage 2 (backend):** node:20-alpine, copia backend + frontend/dist, expone 3000

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
```

**`docker/.dockerignore`**:
```
node_modules
.git
db/db.sqlite
logs
```

---

### Fase 9: Testing (Vitest)

**Estructura:** `tests/` en raíz

| Test | Descripción |
|---|---|
| `auth.test.js` | Login Geduma mock, sesiones, API keys |
| `failover.test.js` | Selección de provider, orden, saltos |
| `circuit-breaker.test.js` | Estados, cooldown, reset |
| `cache.test.js` | Hash, hit/miss, TTL |
| `api.test.js` | Integración de rutas con supertest |
| `proxy.test.js` | Flujo completo proxy + failover |

**Mock de Geduma API** usando `vi.mock` + fetch mocking.

---

### Fase 10: Mantenimiento (Retención + Backups)

**Archivo:** `src/maintenance.js` (ejecutado por node-cron)

- Cada 24h:
  - Backup: copia `db.sqlite` → `db/backups/db-YYYY-MM-DD.sqlite`
  - Limpiar logs > 90 días
  - Limpiar cache expirado
  - Limpiar login_history > 90 días
  - Limpiar metrics > 365 días
  - Limpiar sessions expiradas
  - Archivar logs de app viejos

---

## Orden de Implementación Recomendado

| Orden | Fase | Depende de |
|---|---|---|
| 1 | Fase 0: Scaffolding | — |
| 2 | Fase 1: Base de datos | Fase 0 |
| 3 | Fase 2.1: gedumaClient | Fase 0 |
| 4 | Fase 2.2: authService | Fase 1, 2.1 |
| 5 | Fase 2.3-2.6: failover, CB, cache, metrics | Fase 1 |
| 6 | Fase 3: authMiddleware | Fase 2.2 |
| 7 | Fase 4: Rutas API (auth, providers, metrics, keys) | Fase 3, 2.x |
| 8 | Fase 5: Handlers (requestHandler) | Fase 4 |
| 9 | Fase 4.5: proxy.routes | Fase 5 |
| 10 | Fase 6: Frontend React | — (paralelo a 3-9) |
| 11 | Fase 7: Backend sirve frontend | Fase 6 |
| 12 | Fase 8: Docker | Fase 7 |
| 13 | Fase 9: Testing | Fase 5, 7 |
| 14 | Fase 10: Mantenimiento | Fase 1 |

# Relio: LLM Relay - Especificación Técnica Completa

**Nombre:** Relio (LLM Relay)  
**Versión:** 1.0  
**Stack:** Node.js + Express.js + SQLite (better-sqlite3)  
**Autenticación:** Geduma API (3 endpoints externos)  
**BD Local:** SQLite (auditoría y configuración)  
**Frontend:** React + Vite (auto-servido por Express)  
**HTTP Client:** Native `fetch` (Node 18+)  
**Testing:** Vitest  
**Infra:** Docker multi-stage (`docker/`)

---

## 1. RESUMEN EJECUTIVO

**Relio** es un proxy inteligente y minimalista que:
- ✅ Centraliza múltiples LLM providers (OpenAI, Anthropic, Groq, etc)
- ✅ Implementa failover automático con circuit breaker inteligente
- ✅ Expone API compatible con OpenAI (`/v1/chat/completions`, `/v1/embeddings`, `/v1/vision`)
- ✅ Registra cada request en SQLite para auditoría completa
- ✅ Cachea respuestas idénticas persistentemente
- ✅ Usa Geduma API para autenticación de usuarios (OAuth)
- ✅ Genera API Keys locales para agentes AI
- ✅ Sistema intuitivo para ordenar providers (Main, Fallback 1, 2, 3...)
- ✅ Self-hosted, sin dependencias externas excepto los providers configurados

---

## 2. ARQUITECTURA GENERAL

### 2.1 Flujo de Requests

```
┌─────────────────────────────────────────────────────────┐
│         Cliente (Dashboard / Agente AI)                  │
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
    │   Routes   │    │  (selecciona   │   │ Manager │
    │            │    │   provider)    │   │         │
    └────────────┘    └──────┬─────────┘   └────┬────┘
                             │                  │
                    ┌────────▼──────────────────▼────┐
                    │  Circuit Breaker + Rate Limit  │
                    │  (validación antes de enviar)  │
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
        ├── requests_log (auditoría)
        ├── api_keys (keys locales)
        ├── login_history (logs de auth)
        ├── cache (deduplicación)
        ├── metrics (agregados)
        └── circuit_breaker_state (estado temporal)
```

### 2.2 Componentes Principales

| Componente | Responsabilidad | Tecnología |
|------------|-----------------|-----------|
| **authService** | Login Geduma, validación API keys | Node.js |
| **authMiddleware** | Validar requests entrantes | Express |
| **failoverEngine** | Seleccionar provider según orden | Node.js |
| **circuitBreaker** | Gestionar estado de providers | SQLite + memoria |
| **cacheManager** | Deduplicar responses | SQLite |
| **metricsLogger** | Registrar requests + calcular métricas | SQLite |
| **dashboard** | UI para gestión de providers | React + Vite (auto-servido) |
| **gedumaClient** | Cliente HTTP para Geduma API | Native fetch |

---

## 3. AUTENTICACIÓN: GEDUMA API

Relio consume **3 endpoints de Geduma API**. No maneja usuarios internamente.

### 3.1 Los 3 Endpoints de Geduma

#### 1. GET /api/auth/providers
Lista de providers de login disponibles.

```
Request:
GET https://geduma-api.com/api/auth/providers
Authorization: Bearer GEDUMA_API_TOKEN

Response:
{
  "providers": [
    { "id": "google", "name": "Google", "icon": "https://..." },
    { "id": "github", "name": "GitHub", "icon": "https://..." }
  ]
}
```

#### 2. POST /api/auth/login
Inicia login con un provider específico.

```
Request:
POST https://geduma-api.com/api/auth/login
Authorization: Bearer GEDUMA_API_TOKEN
{
  "provider": "google",
  "code": "authorization_code_from_oauth"
}

Response:
{
  "success": true,
  "token": "geduma_session_token",
  "user": {
    "email": "user@example.com",
    "name": "User Name",
    "avatar": "https://..."
  }
}
```

#### 3. GET /api/auth/user
Obtiene datos del usuario autenticado.

```
Request:
GET https://geduma-api.com/api/auth/user
Authorization: Bearer geduma_session_token

Response:
{
  "email": "user@example.com",
  "name": "User Name",
  "avatar": "https://...",
  "createdAt": "2024-01-15T10:00:00Z"
}
```

---

## 4. BASE DE DATOS: SQLITE

### 4.1 Tabla: `providers`

Configuración de cada LLM provider.

```sql
CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  api_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  model TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('chat', 'embeddings', 'vision')),
  
  -- Ordenamiento intuitivo (Main, Fallback 1, 2, ...)
  order_position INT NOT NULL DEFAULT 0,
  order_label TEXT,
  
  -- Estado
  status TEXT NOT NULL DEFAULT 'active' 
    CHECK(status IN ('active', 'paused', 'cooldown')),
  
  -- Costos por token (configurable por provider)
  cost_per_input_token REAL DEFAULT 0,
  cost_per_output_token REAL DEFAULT 0,

  -- Limites configurables
  rate_limit_req_per_min INT DEFAULT 60,
  tokens_per_day INT DEFAULT 0,
  cost_per_day REAL DEFAULT 0,
  
  -- Circuit Breaker
  cooldown_after_failures INT DEFAULT 5,
  cooldown_duration_seconds INT DEFAULT 300,
  current_failure_count INT DEFAULT 0,
  last_failure_at DATETIME,
  cooldown_until DATETIME,
  
  -- Auditoría
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  notes TEXT,
  
  INDEX(order_position, status),
  INDEX(type, order_position),
  INDEX(status)
);
```

### 4.2 Tabla: `requests_log`

Cada request al proxy se registra aquí.

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
  
  -- Tokens y Costos
  input_tokens INT DEFAULT 0,
  output_tokens INT DEFAULT 0,
  total_tokens INT DEFAULT 0,
  estimated_cost REAL DEFAULT 0,
  
  -- Timing y Auditoría
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

### 4.3 Tabla: `cache`

Deduplicación persistente de queries idénticas.

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

### 4.4 Tabla: `api_keys`

API Keys generadas localmente.

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

### 4.5 Tabla: `login_history`

Registra todos los intentos de login.

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

### 4.6 Tabla: `circuit_breaker_state`

Estado actual del circuit breaker.

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

### 4.8 Tabla: `sessions`

Sesiones locales de dashboard (el token Geduma es de un solo uso).

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

### 4.9 Tabla: `metrics`

Agregados diarios precalculados.

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

## 5. FLUJOS DE AUTENTICACIÓN

### 5.1 Flujo 1: Login en Dashboard (OAuth Geduma)

```
1. Usuario accede a http://localhost:3000/admin
   └─> Sin autenticación → Redirige a /admin/login

2. Frontend: GET /admin/api/auth/providers
   └─> Obtiene lista de providers de Geduma

3. Usuario hace click: "Login with Google"
   └─> OAuth flow de Google → Obtiene authorization_code

4. Frontend: POST /admin/api/auth/login
   { "provider": "google", "code": "authorization_code" }

5. Backend → Geduma API:
   POST https://geduma-api.com/api/auth/login

6. Si válido:
   ├─ Almacena token Geduma en httpOnly cookie
   ├─ Registra login en SQLite
   └─ Retorna { user }

7. Cliente redirige a /admin/dashboard
   └─> Cookie tiene token automáticamente
```

### 5.2 Flujo 2: Acceso a Dashboard

```
Cliente hace request:
GET /admin/api/summary
Cookie: gedumaToken=...

Backend:
├─ Valida cookie
├─ Opcional: verifica con Geduma
└─> Procesa request

Retorna datos protegidos
```

### 5.3 Flujo 3: API Key Auth (Proxy Endpoints)

```
1. Agente AI hace request a /v1/chat/completions
   Header: Authorization: Bearer llm_pk_xxx...

2. authMiddleware:
   ├─ Extrae y valida API key en SQLite
   ├─ Verifica no revocada
   ├─ Actualiza last_used_at
   └─ Registra en login_history

3. FailoverEngine procesa normalmente
   └─> Registra en requests_log
```

### 5.4 Flujo 4: Logout

```
User: POST /admin/api/auth/logout
Backend:
├─ Limpia cookie gedumaToken
├─ Registra logout en login_history
└─> Redirige a /admin/login
```

---

## 6. FAILOVER: SELECCIÓN DE PROVIDER

### 6.1 Algoritmo

```javascript
/**
 * Selecciona siguiente provider para request
 */
async function selectProvider(modelType) {
  // 1. Obtener providers activos ordenados por order_position
  const providers = await db.all(`
    SELECT * FROM providers
    WHERE type = ? AND status = 'active'
    ORDER BY order_position ASC
  `, [modelType]);

  // 2. Iterar en orden hasta encontrar disponible
  for (const provider of providers) {
    // ¿Está en cooldown?
    if (provider.cooldown_until && provider.cooldown_until > NOW()) {
      continue;  // Saltar
    }

    // ¿Rate limit alcanzado?
    if (await isRateLimitExceeded(provider)) {
      continue;  // Saltar
    }

    // ¿Tokens diarios alcanzados?
    if (await isDailyLimitExceeded(provider)) {
      continue;  // Saltar
    }

    // Este es el próximo a intentar
    return provider;
  }

  return null;  // No hay providers disponibles
}
```

### 6.2 Orden de Providers

```
order_position = 0  → "Main" (primer intento)
order_position = 1  → "Fallback 1" (segundo intento)
order_position = 2  → "Fallback 2" (tercer intento)
order_position = 3  → "Fallback 3" (cuarto intento)
```

### 6.3 Circuit Breaker: Estados

```
HEALTHY:
├─ Usa normalmente
├─ Cuenta fallos
└─ Si fallos >= cooldown_after_failures → COOLDOWN

COOLDOWN:
├─ No intenta durante cooldown_duration_seconds
├─ Después del tiempo → vuelve a HEALTHY
└─ Reinicia contador de fallos

PAUSED (manual):
└─ No intenta mientras esté paused
```

### 6.4 Flujo de Failover Completo

```
┌────────────────────────────────────────────────┐
│ Cliente: POST /v1/chat/completions            │
└────────────────────────────────────────────────┘
                    ▼
┌────────────────────────────────────────────────┐
│ 1. Validar autenticación (API Key)             │
└────────────────────────────────────────────────┘
                    ▼
┌────────────────────────────────────────────────┐
│ 2. Buscar en cache (query_hash)                │
│    ¿Hit? → Retorna + log cache_hit=true        │
└────────────────────────────────────────────────┘
                    ▼
┌────────────────────────────────────────────────┐
│ 3. Seleccionar provider (orden_position)       │
│    Obtiene: Main → Fallback 1 → Fallback 2... │
└────────────────────────────────────────────────┘
                    ▼
┌────────────────────────────────────────────────┐
│ 4. Para cada provider en orden:                │
│    a. ¿Está healthy? → Intenta                 │
│    b. ¿En cooldown? → Pasa al siguiente        │
│    c. ¿Rate limit? → Pasa al siguiente         │
│    d. ¿Daily limit? → Pasa al siguiente        │
└────────────────────────────────────────────────┘
                    ▼
┌────────────────────────────────────────────────┐
│ 5. Call a provider:                            │
│    a. OK: Retorna response + cachea            │
│    b. FALLA:                                   │
│       ├─ Incrementa failure_count              │
│       ├─ Si >= cooldown_after_failures         │
│       │  └─ Entra en COOLDOWN                  │
│       ├─ Registra fallo                        │
│       └─ Intenta siguiente provider            │
└────────────────────────────────────────────────┘
                    ▼
┌────────────────────────────────────────────────┐
│ 6. Si TODOS fallan:                            │
│    Retorna 503 + error detallado               │
└────────────────────────────────────────────────┘
                    ▼
┌────────────────────────────────────────────────┐
│ 7. Registra request_log (para auditoría)       │
└────────────────────────────────────────────────┘
```

---

## 7. ENDPOINTS API

### 7.1 Autenticación

#### GET /admin/api/auth/providers
Obtiene providers de login disponibles.

```javascript
// Sin requiere autenticación
// Retorna: { providers: [...] }
```

#### POST /admin/api/auth/login
Inicia login con Geduma.

```javascript
// Sin requiere autenticación
// Body: { "provider": "google", "code": "..." }
// Retorna: { user: { email, name, ... } }
```

#### POST /admin/api/auth/logout
Termina sesión.

```javascript
// Requiere: gedumaToken en cookie
// Retorna: { success: true }
```

### 7.2 Dashboard: Providers

#### GET /admin/api/providers?type=chat
Lista providers ordenados.

```javascript
// Requiere: gedumaToken en cookie
// Query params: type ('chat', 'embeddings', 'vision' - opcional)
// Retorna: [ { id, name, model, order_position, order_label, status, ... } ]
```

#### POST /admin/api/providers
Crear nuevo provider.

```javascript
// Requiere: gedumaToken en cookie
// Body: {
//   "name": "OpenAI GPT-4",
//   "api_url": "https://api.openai.com/v1",
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
// Retorna: { success: true, provider_id: "..." }
```

#### PATCH /admin/api/providers/:id
Editar provider (sin cambiar orden).

```javascript
// Requiere: gedumaToken en cookie
// Body: { "status": "paused", "rate_limit_req_per_min": 120, ... }
// NO permite cambiar: order_position, order_label
// Retorna: { success: true }
```

#### PATCH /admin/api/providers/reorder
Cambiar orden de providers.

```javascript
// Requiere: gedumaToken en cookie
// Body: { "provider_ids": ["id_1", "id_3", "id_2"] }
// Actualiza order_position de cada uno
// Auto-regenera order_label (Main, Fallback 1, ...)
// Retorna: { success: true }
```

#### DELETE /admin/api/providers/:id
Eliminar provider.

```javascript
// Requiere: gedumaToken en cookie
// Reorganiza automáticamente order_position de otros providers
// Retorna: { success: true }
```

### 7.3 Dashboard: Métricas

#### GET /admin/api/metrics?from=2024-01-01&to=2024-01-31
Métricas por provider en rango.

```javascript
// Requiere: gedumaToken en cookie
// Query: from, to (fechas ISO)
// Retorna: {
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

#### GET /admin/api/logs?limit=50&offset=0
Últimos requests.

```javascript
// Requiere: gedumaToken en cookie
// Query: limit, offset (para paginación)
// Retorna: [ { id, provider_id, endpoint, status_code, ... } ]
```

#### GET /admin/api/health
Health check del proxy.

```javascript
// Sin requiere autenticación (puede ser usado por monitoreo)
// Retorna: {
//   "status": "healthy",
//   "providers_healthy": 3,
//   "providers_cooldown": 1,
//   "providers_paused": 0,
//   "uptime_seconds": 86400,
//   "db_size_mb": 2.3
// }
```

### 7.4 Dashboard: API Keys

#### POST /admin/api/auth/api-keys
Crear nueva API Key.

```javascript
// Requiere: gedumaToken en cookie
// Body: { "name": "Production App" }
// Retorna: { "apiKey": "llm_pk_xxx...", "message": "..." }
// NOTA: Mostrar key solo una vez
```

#### GET /admin/api/auth/api-keys
Listar API Keys (sanitizadas).

```javascript
// Requiere: gedumaToken en cookie
// Retorna: [
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
Revocar API Key.

```javascript
// Requiere: gedumaToken en cookie
// Param: keyPreview (ej: "llm_pk_...xxx")
// Retorna: { success: true }
```

### 7.5 Proxy Endpoints (Públicos)

#### POST /v1/chat/completions
Compatible OpenAI.

```javascript
// Requiere: Authorization: Bearer llm_pk_xxx...
// Body: { "model": "gpt-4", "messages": [...], ... }
// Retorna: Response idéntica a OpenAI API
```

#### POST /v1/embeddings
Compatible OpenAI.

```javascript
// Requiere: Authorization: Bearer llm_pk_xxx...
// Body: { "model": "text-embedding-ada-002", "input": "...", ... }
// Retorna: Response idéntica a OpenAI API
```

> **Nota:** Vision multimodal se maneja dentro de `/v1/chat/completions`
> detectando automáticamente contenido de imagen en `messages`. No hay
> endpoint `/v1/vision` separado.

---

## 8. VARIABLES DE ENTORNO

```env
# Geduma API Integration
GEDUMA_API_URL=https://geduma-api.com
GEDUMA_API_TOKEN=your_geduma_api_token_here

# SQLite Database
DB_PATH=./db/db.sqlite

# Cache TTL (segundos, default 30 días = 2592000)
CACHE_TTL_SECONDS=2592000

# Node Environment
NODE_ENV=development
PORT=3000
HOST=0.0.0.0

# Cookies
COOKIE_SECURE=true
COOKIE_SAME_SITE=strict
COOKIE_HTTP_ONLY=true
```

---

## 9. ESTRUCTURA DE CARPETAS

```
relio/
├── src/
│   ├── index.js                    # Entry point (Express)
│   ├── config.js                   # Config desde .env
│   ├── db.js                       # SQLite setup + migrations
│   ├── services/
│   │   ├── authService.js          # Geduma API + sesiones locales
│   │   ├── failoverEngine.js       # Selección de provider
│   │   ├── circuitBreaker.js       # Estados y cooldown
│   │   ├── cacheManager.js         # Deduplicación con TTL
│   │   └── metricsLogger.js        # Logging y agregados diarios
│   ├── middleware/
│   │   └── authMiddleware.js       # Validación cookie/API Key
│   ├── routes/
│   │   ├── auth.routes.js          # /admin/api/auth/*
│   │   ├── providers.routes.js     # /admin/api/providers/*
│   │   ├── metrics.routes.js       # /admin/api/metrics/*
│   │   ├── keys.routes.js          # /admin/api/auth/api-keys/*
│   │   └── proxy.routes.js         # /v1/chat/completions, /v1/embeddings
│   ├── handlers/
│   │   ├── requestHandler.js       # Procesa requests proxy
│   │   └── dashboardHandler.js     # Endpoints dashboard
│   ├── utils/
│   │   ├── logger.js               # Logs a archivo
│   │   └── validators.js           # Validación de inputs
│   └── external/
│       └── gedumaClient.js         # Cliente Geduma con native fetch
├── frontend/
│   ├── src/
│   │   ├── main.jsx                # Entry point React
│   │   ├── App.jsx                 # Router principal
│   │   ├── components/
│   │   │   ├── Login.jsx           # Pantalla de login
│   │   │   ├── Dashboard.jsx       # Layout protegido
│   │   │   ├── ProvidersList.jsx   # Lista + drag-and-drop
│   │   │   ├── ProviderForm.jsx    # Crear/editar provider
│   │   │   ├── Metrics.jsx         # Métricas y gráficas
│   │   │   ├── ApiKeys.jsx         # Gestión de API Keys
│   │   │   └── Logs.jsx            # Últimos requests
│   │   └── style.css               # Estilos globales
│   ├── index.html                  # HTML template
│   ├── vite.config.js              # Vite config (proxy a Express en dev)
│   └── package.json                # Dependencias frontend
├── docker/
│   ├── Dockerfile                  # Multi-stage: build frontend + backend
│   ├── docker-compose.yml          # Servicio relio
│   └── .dockerignore               # Ignorados para Docker
├── db/
│   ├── db.sqlite                   # Base de datos (git-ignored)
│   ├── migrations/                 # Migraciones SQL versionadas
│   └── backups/                    # Backups automáticos
├── logs/
│   ├── app.log                     # Logs de aplicación
│   └── archive/                    # Logs comprimidos antiguos
├── .env.example                    # Template variables
├── .gitignore
├── package.json                    # Dependencias backend
└── README.md
```

---

## 10. FLUJO COMPLETO: LOGIN

```
1. Usuario en http://localhost:3000/admin
   └─> GET /admin/api/auth/providers
       └─> Backend llama Geduma
       └─> Frontend muestra botones (Google, GitHub, etc)

2. Usuario: "Login with Google"
   └─> OAuth flow de Google → authorization_code

3. Frontend: POST /admin/api/auth/login
   { "provider": "google", "code": "..." }

4. Backend:
   └─> POST https://geduma-api.com/api/auth/login
   └─> Geduma valida
   └─> Retorna { success: true, token, user }

5. Backend:
   ├─ Almacena token en httpOnly cookie
   ├─ Registra login en SQLite
   └─ Retorna { user }

6. Frontend:
   ├─ localStorage.removeItem('jwt') (si existía)
   ├─ Redirige a /admin/dashboard
   └─> Cookie tiene token automáticamente

7. Requests posteriores:
   GET /admin/api/summary
   Cookie: gedumaToken=... (automático)
   └─> Backend valida, procesa
```

---

## 11. FLUJO COMPLETO: PROXY + FAILOVER

```
1. Agente AI: POST /v1/chat/completions
   Header: Authorization: Bearer llm_pk_xxx...
   Body: { "model": "gpt-4", "messages": [...] }

2. Backend - authMiddleware:
   ├─ Extrae API key: "llm_pk_xxx..."
   ├─ Busca en SQLite: api_keys
   ├─ Valida: no revocada, existe
   └─> Continúa a siguiente paso

3. Backend - cacheManager:
   ├─ Calcula query_hash
   ├─ Busca en cache
   ├─ ¿Hit? Retorna + cache_hit=true
   └─> Si miss, continúa

4. Backend - failoverEngine:
   ├─ Obtiene providers por type = 'chat'
   ├─ Ordena por order_position
   └─> Para cada provider en orden:

5. Primer intento (order_position = 0 "Main"):
   ├─ Verifica circuitBreaker (¿healthy?)
   ├─ Verifica rate limits
   ├─ Intenta call con timeout 30s
   ├─ OK → Retorna response + cachea
   └─> Si FALLA:
       ├─ Incrementa failure_count
       ├─ Si >= cooldown_after_failures
       │  └─ Entra en COOLDOWN
       ├─ Registra fallo en SQLite
       └─> Intenta siguiente provider

6. Segundo intento (order_position = 1 "Fallback 1"):
   └─> Mismo flujo que paso 5

7. Tercer intento (order_position = 2 "Fallback 2"):
   └─> Mismo flujo que paso 5

8. Si TODOS fallan:
   ├─ 503 Service Unavailable
   ├─ Error detallado de qué falló
   └─> Registra en requests_log

9. Si alguno tiene éxito:
   ├─ Registra en requests_log (provider_id, tokens, cost, tiempo)
   ├─ Actualiza metrics agregados
   ├─ Cachea response
   └─> Retorna al cliente
```

---

## 12. MÉTRICAS Y AUDITORÍA

### 12.1 Métricas Automáticas

**Por cada request:**
- Tokens entrada/salida
- Tiempo de respuesta
- Provider utilizado
- Cache hit/miss
- Autenticación usada

**Agregados diarios (tabla metrics):**
- Total requests
- Total tokens
- Costo estimado
- Error rate
- Tiempo promedio respuesta
- Efectividad del caché

**Globales:**
- Costo total/día
- Distribución de carga
- Uptime por provider
- Hit rate del caché

### 12.2 Auditoría: Login History

```sql
SELECT email, method, provider, status, timestamp 
FROM login_history 
ORDER BY timestamp DESC 
LIMIT 50;
```

### 12.3 Auditoría: Requests

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

## 13. MANEJO DE DATOS Y ROTACIÓN

### 13.1 Retención de Datos

- **requests_log:** 90 días
- **cache:** 30 días (TTL por entry)
- **login_history:** 90 días
- **metrics:** 365 días (agregados)
- **circuit_breaker_state:** Temporal (sin retención)

### 13.2 Backup Automático

```
Cada día a las 02:00 AM:
├─ Backup: cp db.sqlite → backups/db-YYYY-MM-DD.sqlite
├─ Comprimir backups antiguos
├─ Mantener entre 2-10 backups (configurable)
├─ Limpiar logs de 90+ días
└─ Archivar logs viejos a logs/archive/
```

---

## 14. PERFORMANCE Y OVERHEAD

### 14.1 Latencia Esperada

```
Lookup en BD providers:              ~2-5ms
Request routing + failover logic:    ~5-10ms
Cache lookup:                        ~1-3ms
Call a provider (HTTP):              ~1,000-5,000ms
Logging a DB (async):                ~5-10ms

TOTAL OVERHEAD:                      ~15-25ms (0.3%-2.5% del total)
```

### 14.2 Optimizaciones Implementadas

- ✅ In-memory cache para providers (refresh c/60s)
- ✅ Índices estratégicos en SQLite
- ✅ Async/await nativo en Express
- ✅ Circuit breaker en memoria + sincronización a BD
- ✅ Logging asincrónico

---

## 15. CHECKLIST DE IMPLEMENTACIÓN V1

- [ ] Setup Express.js + better-sqlite3 + native fetch
- [ ] Crear todas las tablas (9 tablas: providers, requests_log, cache, api_keys, login_history, circuit_breaker_state, sessions, metrics + migraciones)
- [ ] Implementar authService.js (login Geduma, sesiones locales)
- [ ] Implementar authMiddleware.js (cookie para dashboard, API Key para proxy)
- [ ] Implementar failoverEngine.js
- [ ] Implementar circuitBreaker.js
- [ ] Implementar cacheManager.js (TTL configurable)
- [ ] Implementar metricsLogger.js
- [ ] Crear endpoints auth (/admin/api/auth/*)
- [ ] Crear endpoints providers (/admin/api/providers/*)
- [ ] Crear endpoints metrics (/admin/api/metrics/*)
- [ ] Crear endpoints keys (/admin/api/auth/api-keys/*)
- [ ] Crear endpoints proxy (/v1/chat/completions, /v1/embeddings)
- [ ] Setup React + Vite en frontend/
- [ ] Implementar Login.jsx
- [ ] Implementar Dashboard.jsx + navegación
- [ ] Implementar ProvidersList.jsx + drag-and-drop
- [ ] Implementar ProviderForm.jsx
- [ ] Implementar Metrics.jsx
- [ ] Implementar ApiKeys.jsx
- [ ] Implementar Logs.jsx
- [ ] Backend auto-sirve frontend build (express.static)
- [ ] Agregar variables .env.example
- [ ] Crear Dockerfile multi-stage en docker/
- [ ] Crear docker-compose.yml en docker/
- [ ] Tests con Vitest (unit + integración)
- [ ] Crear README.md

---

## 16. SEGURIDAD

- ✅ API Keys solo se muestran al crear (no se recuperan)
- ✅ Auditoría completa de accesos (login_history, requests_log)
- ✅ Validación de todos los inputs (express-validator o manual)
- ✅ httpOnly cookies para tokens de sesión
- ✅ Rate limiting por IP (agregar después)
- ✅ Encriptación de API keys en DB (agregar después)

---

## 17. EJEMPLO: CREAR PROVIDER Y USAR

### 17.1 Usuario crea provider

```
Dashboard:
1. Click "Add Provider"
2. Completa:
   - Name: "OpenAI GPT-4"
   - API URL: "https://api.openai.com/v1"
   - API Key: "sk-..."
   - Model: "gpt-4"
   - Type: "chat"
   - Rate limit: 60 req/min
   - Tokens/day: 0 (sin limite)
   - Cooldown after failures: 5
   - Cooldown duration: 300s

3. Click "Create"
4. Provider se crea con order_position = 0 ("Main")
```

### 17.2 Usuario crea segunda provider

```
Dashboard:
1. Click "Add Provider"
2. Completa datos de Anthropic Claude
3. Click "Create"
4. Provider se crea con order_position = 1 ("Fallback 1")
```

### 17.3 Usuario genera API Key

```
Dashboard:
1. Click "Manage API Keys"
2. Click "Create New Key"
3. Nombre: "My AI Agent"
4. Click "Create"
5. Muestra: "llm_pk_abc123def456..."
6. Mensaje: "Save this key now, you won't see it again"
7. Usuario copia la key
```

### 17.4 Agente AI usa API Key

```javascript
// En el agente/app
const response = await fetch('http://localhost:3000/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer llm_pk_abc123def456...',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    model: 'gpt-4',
    messages: [
      { role: 'user', content: 'Hola, ¿cómo estás?' }
    ]
  })
});

// Response es idéntica a OpenAI API
const data = await response.json();
console.log(data.choices[0].message.content);
```

### 17.5 Failover en Acción

```
Agente hace request a /v1/chat/completions

Relio intenta en orden:
1. OpenAI (order_position=0, "Main")
   └─> Falla: rate limit exceeded

2. Anthropic Claude (order_position=1, "Fallback 1")
   └─> OK: Retorna respuesta + cachea

Agente recibe respuesta idéntica a OpenAI API
(No sabe que vino de Anthropic)
```

---


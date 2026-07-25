# AGENTS.md — Relio

Instrucciones para asistentes AI que trabajen en este código.

## Stack

- **Runtime:** Node.js 18+ (ESM — `"type": "module"`)
- **Backend:** Express.js 4.x
- **DB:** better-sqlite3 (síncrono, sin ORM)
- **Frontend:** React 18 + Vite 5 (sin TypeScript)
- **HTTP:** Native `fetch` (no axios)
- **Auth:** Geduma API (OAuth) + API Keys locales
- **Testing:** Vitest
- **Docker:** multi-stage en `docker/`

## Convenciones de Código

- **Sin comentarios** en código fuente (salvo jsdocs si es necesario)
- **ESM** — usar `import`/`export`, no `require`
- **Nombres de archivos:** kebab-case (`auth.routes.js`, `cacheManager.js`)
- **Nombres de componentes React:** PascalCase (`Login.jsx`, `ProvidersList.jsx`)
- **Variables y funciones:** camelCase
- **Constantes en mayúscula** solo para valores mágicos exportados
- **Sin TypeScript** — JS plano con JSDoc opcional para tipos complejos

## Base de Datos

Se usa `better-sqlite3` con helpers en `src/db.js`:

```js
import { dbAll, dbGet, dbRun, dbExec, dbTransaction } from '../db.js'

// Consultas
const rows = dbAll('SELECT * FROM providers WHERE type = ?', ['chat'])
const row  = dbGet('SELECT * FROM providers WHERE id = ?', [id])
const result = dbRun('UPDATE providers SET name = ? WHERE id = ?', [name, id])
```

- **No** usar `db.prepare().all()` directamente — siempre usar helpers
- **Transacciones** con `dbTransaction(fn)`
- **WAL mode** activado por defecto
- **`:memory:`** para tests

## Arquitectura

```
src/
├── index.js              # Express setup, rutas, static, error handler
├── config.js             # Getters lazy de env vars
├── db.js                 # Helpers SQLite + migraciones
├── services/             # Lógica pura (sin Express)
│   ├── authService.js    # Geduma login, sesiones, API keys
│   ├── failoverEngine.js # Selección de providers, rate/daily limit
│   ├── circuitBreaker.js # Estados healthy/cooldown/paused
│   ├── cacheManager.js   # Hash + TTL cache
│   └── metricsLogger.js  # Logging + métricas diarias
├── middleware/
│   └── authMiddleware.js # Cookie session + API Key validation
├── routes/               # Express routers
│   ├── auth.routes.js    # /admin/api/auth/*
│   ├── providers.routes.js
│   ├── metrics.routes.js
│   ├── keys.routes.js
│   └── proxy.routes.js   # /v1/*
├── handlers/
│   ├── requestHandler.js # Cache → failover → response
│   └── dashboardHandler.js
├── external/
│   └── gedumaClient.js   # Native fetch a Geduma API
└── utils/
    ├── logger.js         # App logger a archivo
    └── validators.js     # URL, type, sanitize
```

### Flujo de un Request Proxy

1. `proxy.routes.js` recibe POST → `authMiddleware.requireApiKey`
2. `requestHandler.processRequest()`:
   - Calcula `queryHash` → busca en cache
   - Cache hit → retorna inmediatamente
   - Cache miss → `selectProviders(modelType)` ordenados por `order_position`
   - Para cada provider: verifica `isProviderAvailable()`, `isRateLimitExceeded()`, `isDailyLimitExceeded()`
   - `callProvider()` con timeout 30s
   - Éxito → `recordSuccess()`, `setCache()`, `logRequest()`, `updateMetrics()`
   - Falla → `recordFailure()`, siguiente provider
3. Todos fallan → 503

### Flujo de Login

1. `GET /admin/api/auth/providers` → Geduma API → botones OAuth
2. Usuario click → redirect a OAuth provider → callback a `/admin/api/auth/callback`
3. `POST /admin/api/auth/login` (o callback) → Geduma API → `loginWithGeduma()`
4. Crea sesión local, setea cookie `relio_session`, redirige a dashboard

## Variables de Entorno

Todas se leen lazy via getters en `src/config.js`. Agregar nuevas variables así:

```js
export const config = {
  nuevoModulo: {
    get nuevaVar() { return env('NUEVA_VAR', 'default') },
  },
}
```

Siempre agregar a `.env.example` y a la tabla de `README.md`.

## Tests

```bash
npm test                  # Una vez
npm run test:watch        # Modo watch
```

- Tests en `tests/` con Vitest
- Usar `:memory:` para DB en tests (configurar en `beforeAll` vía `process.env.DB_PATH`)
- Import dinámico `await import(...)` en tests para que env vars se seteen antes
- Mockear Geduma API con `vi.mock` o interceptando fetch

Patrón de test:

```js
import { beforeAll, afterAll, describe, it, expect } from 'vitest'

beforeAll(async () => {
  process.env.DB_PATH = ':memory:'
  // ... imports dinámicos
})
```

## Frontend

- React 18 con React Router v6
- Vite con proxy a Express en dev (`vite.config.js`)
- Build output en `frontend/dist/` — Express lo sirve como static
- Sin TypeScript, sin CSS framework, sin librerías externas (solo react + react-router-dom)
- Estilos en `frontend/src/style.css` (CSS plano, sin módulos)

### Componentes

| Componente | Ruta | Propósito |
|---|---|---|
| `Login.jsx` | `/admin/login` | Botones OAuth |
| `Dashboard.jsx` | `/admin/dashboard/*` | Layout + routing interno |
| `ProvidersList.jsx` | `/admin/dashboard/providers` | Lista con reorder |
| `ProviderForm.jsx` | Modal | Crear/editar provider |
| `Metrics.jsx` | `/admin/dashboard/metrics` | Stats + tabla |
| `ApiKeys.jsx` | `/admin/dashboard/keys` | CRUD API keys |
| `Logs.jsx` | `/admin/dashboard/logs` | Tabla de requests |

## Docker

```bash
# Build y run
docker compose -f docker/docker-compose.yml up --build

# Estructura
docker/
├── Dockerfile            # Multi-stage build
├── docker-compose.yml    # Puerto 3000, volúmenes para db/logs
└── .dockerignore
```

## Tareas Comunes

### Agregar un endpoint

1. Crear/editar route en `src/routes/`
2. Agregar middleware de auth si aplica
3. Si tiene lógica nueva, crear servicio en `src/services/`
4. Registrar en `src/index.js`
5. Agregar test en `tests/`

### Agregar una tabla

1. Agregar `CREATE TABLE IF NOT EXISTS` en `src/db.js > initDb()`
2. Agregar índices en `createIndexes()`
3. Actualizar tests de DB

### Agregar un provider de LLM

1. Dashboard → Add Provider
2. Completar: nombre, API URL, API Key, modelo, tipo, costos
3. Se ordena automáticamente como siguiente fallback

## Comandos

```bash
npm run dev        # Backend con watch
npm start          # Producción
npm test           # Tests
npm run build      # Build frontend
```

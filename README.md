# Relio — LLM Relay

Proxy inteligente y minimalista para LLMs con failover automático, caching, auditoría y dashboard.

## Stack

| Capa | Tecnología |
|---|---|
| Backend | Node.js + Express.js |
| Base de datos | SQLite (better-sqlite3) |
| Frontend | React + Vite (auto-servido) |
| HTTP Client | Native fetch (Node 18+) |
| Auth | Geduma API (OAuth) + API Keys locales |
| Testing | Vitest |
| Infra | Docker multi-stage |

## Funcionalidades

- **Proxy compatible con OpenAI** — `/v1/chat/completions`, `/v1/embeddings`
- **Failover automático** — selecciona provider en orden (Main → Fallback 1 → N)
- **Circuit breaker** — cooldown automático tras N fallos consecutivos
- **Cache persistente** — respuestas idénticas no viajan al provider
- **Rate limiting** — control por provider (req/min, tokens/día)
- **Costos estimados** — por provider (input/output token)
- **Auditoría completa** — cada request queda registrado en SQLite
- **API Keys locales** — para agentes AI, con revocación
- **Dashboard** — gestión visual de providers, métricas, logs, API keys
- **Métricas diarias** — requests, tokens, costos, errores, cache hits
- **Mantenimiento automático** — backups diarios, limpieza de datos antiguos

## Requisitos

- Node.js 18+
- npm

## Instalación

```bash
git clone <repo> relio
cd relio

cp .env.example .env
# Editar .env con GEDUMA_API_TOKEN

npm install
cd frontend && npm install && cd ..

npm run build        # Build frontend
npm run dev          # Desarrollo (backend)
```

## Desarrollo

El frontend se sirve desde Express (producción) o mediante Vite dev server con proxy:

```bash
# Terminal 1: Backend
npm run dev

# Terminal 2: Frontend (hot reload)
cd frontend && npm run dev
```

En desarrollo, el frontend corre en `http://localhost:5173` y proxy los requests al backend.

## Variables de Entorno

| Variable | Default | Descripción |
|---|---|---|
| `GEDUMA_API_URL` | `https://geduma-api.com` | URL base de Geduma API |
| `GEDUMA_API_TOKEN` | — | Token de integración con Geduma |
| `APP_BASE_URL` | `http://localhost:3000` | URL base para callbacks OAuth |
| `DB_PATH` | `./db/db.sqlite` | Ruta a la base de datos |
| `CACHE_TTL_SECONDS` | `2592000` (30 días) | TTL del cache |
| `PORT` | `3000` | Puerto del servidor |
| `HOST` | `0.0.0.0` | Host del servidor |
| `COOKIE_SECURE` | `true` | Cookies seguras (https) |
| `COOKIE_SAME_SITE` | `strict` | Política SameSite |
| `NODE_ENV` | `development` | Entorno |

## Docker

```bash
cp .env.example .env
docker compose -f docker/docker-compose.yml up -d
```

## Uso

### Dashboard

Acceder a `http://localhost:3000/admin`:

1. Login via OAuth (Google, GitHub, etc.)
2. Agregar providers (OpenAI, Anthropic, Groq...)
3. Ordenar: Main, Fallback 1, Fallback 2...
4. Generar API Keys para agentes AI

### API Proxy

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer llm_pk_tu_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hola"}]
  }'
```

## API Endpoints

### Autenticación

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/admin/api/auth/providers` | No | Lista providers de login |
| POST | `/admin/api/auth/login` | No | Login con Geduma |
| GET | `/admin/api/auth/callback` | No | Callback OAuth |
| POST | `/admin/api/auth/logout` | Cookie | Cerrar sesión |

### Dashboard

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/admin/api/summary` | Resumen del dashboard |
| GET/POST | `/admin/api/providers` | Listar/crear providers |
| PATCH | `/admin/api/providers/:id` | Editar provider |
| PATCH | `/admin/api/providers/reorder` | Reordenar providers |
| DELETE | `/admin/api/providers/:id` | Eliminar provider |
| GET | `/admin/api/metrics` | Métricas por rango |
| GET | `/admin/api/metrics/logs` | Últimos requests |
| GET | `/admin/api/metrics/health` | Health check |
| POST | `/admin/api/auth/api-keys` | Crear API Key |
| GET | `/admin/api/auth/api-keys` | Listar API Keys |
| DELETE | `/admin/api/auth/api-keys/:keyPreview` | Revocar API Key |

### Proxy (públicos)

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/v1/chat/completions` | API Key | Chat/vision (multimodal) |
| POST | `/v1/embeddings` | API Key | Embeddings |

## Tests

```bash
npm test
```

## Estructura del Proyecto

```
relio/
├── src/                    # Backend (Express)
│   ├── index.js            # Entry point
│   ├── config.js           # Variables de entorno
│   ├── db.js               # SQLite setup + queries
│   ├── services/           # Lógica de negocio
│   ├── middleware/          # Auth middleware
│   ├── routes/             # Rutas API
│   ├── handlers/           # Procesamiento de requests
│   ├── utils/              # Logger, validadores
│   └── external/           # Cliente Geduma
├── frontend/               # Frontend (React + Vite)
│   ├── src/components/     # Componentes React
│   ├── index.html
│   └── vite.config.js
├── docker/                 # Docker multi-stage
│   ├── Dockerfile
│   └── docker-compose.yml
├── db/                     # Base de datos (gitignored)
├── tests/                  # Tests (Vitest)
└── docs/                   # Documentación
```

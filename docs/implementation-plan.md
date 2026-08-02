# Relio — Plan de Implementación v1.3

> **Estado:** Pendiente de ejecución.
> **Alcance:** Revisión profunda de producción — seguridad (self-hosted / uso personal), funcionalidad, rendimiento LLM proxy, código muerto, dependencias, tests y docs.
> **Fecha:** 2026-07-30

---

## Contexto y decisiones confirmadas

| Tema | Decisión |
|---|---|
| Autenticación del dashboard | Sin auth (por diseño, v1.2). Se despliega en entorno seguro. Los logins de terceros parametrizables se evalúan a futuro. |
| Protección del proxy `/v1/*` | Debe quedar blindado con las API keys locales (`llm_pk_*`). |
| Routing Strategies (`docs/features.md`) | NO se implementan. Corregir el doc (duplicado) y marcar como roadmap v2. |
| Selector de modelo (`model`) | Se mantiene estricto (nombre/ID de proveedor o `auto`). Documentar claramente. |
| Cobertura de tests | Ampliar a los módulos sin cobertura Y limpiar los tests redundantes/irrelevantes existentes. |

---

## Hallazgos verificados (línea base)

### Bugs críticos de funcionalidad

| # | Severidad | Problema | Ubicación |
|---|---|---|---|
| 1 | Crítico | Chat dashboard "Proxy (Auto failover)" siempre devuelve 400: `Chat.jsx` envía `provider_id: null` con `use_proxy=true`, pero el backend lo rechaza antes de evaluar `use_proxy` | `frontend/src/components/Chat.jsx:52` ↔ `src/routes/chat.routes.js:14` |
| 2 | Alto | `ProviderForm.handleSubmit` sin try/catch: error de red deja el botón en "Saving…" y genera unhandled rejection | `frontend/src/components/ProviderForm.jsx:88-111` |
| 3 | Medio | Refetch post-creación de API keys sin verificar `res.ok` → paginación `NaN` | `frontend/src/components/ApiKeys.jsx:38-39` |
| 4 | Medio | Reorder mezcla capacidades (chat + embeddings): reescribe posiciones/labels globales y puede duplicar "Main" | `frontend/src/components/ProvidersList.jsx:46` ↔ `src/routes/providers.routes.js:107-127` |
| 5 | Medio | `npm start` en clon fresco no sirve el dashboard: `frontend/dist/` está gitignoreado → `/admin` devuelve 500/404 | `src/index.js:92-96`, `.gitignore:5` |
| 6 | Medio | `Logs` pagina client-side sobre 100 filas hardcodeadas (`?limit=100`), ignora `limit/offset` server-side | `frontend/src/components/Logs.jsx:29` |
| 7 | Bajo | Respuestas fuera de orden en `Metrics`/`ProvidersList` al cambiar rango/filtro rápido (sin guard) | `Metrics.jsx:16-25`, `ProvidersList.jsx:19-28` |
| 8 | Bajo | Parsing de fechas inconsistente: `api_keys.created_at` (UTC sin `Z`) vs `requests_log` (ISO con `Z`) | `ApiKeys.jsx:91-92` vs `Logs.jsx:4-10` |
| 9 | Bajo | Chat vuelca `JSON.stringify` crudo cuando el content viene vacío | `Chat.jsx:58` |
| 10 | Bajo | Edge case en reorder: `indexOf` devuelve `-1` → `splice(-1,1)` borra el último elemento | `ProvidersList.jsx:47-50` |
| 11 | Bajo | Cambiar `pageSize` no resetea `page`; el control desaparece con `totalPages <= 1` | `Pagination.jsx:8-12,27` |

### Seguridad (postura: dashboard abierto + proxy blindado)

| # | Severidad | Problema | Ubicación |
|---|---|---|---|
| S1 | Alto | API keys de agentes en texto plano en `api_keys.key`; validación por `===` (timing attack) | `src/services/authService.js:26,43` |
| S2 | Alto | Clave de cifrado por defecto `relio-default-key-change-me` con solo `console.warn`; placeholder conocido en `config.example.json` → claves cifradas con secretos públicos en producción | `src/db.js:9-13`, `config.example.json:3` |
| S3 | Alto | SSRF: `test-connection`, create y update aceptan `api_url` arbitrario y hacen fetch server-side (p.ej. `169.254.169.254`, hosts internos) | `src/routes/providers.routes.js:32-52,73,161-170` |
| S4 | Bajo | `api_url` completo expuesto al navegador en el endpoint de chat (el UI no lo usa) | `src/routes/chat.routes.js:89` |

### Rendimiento (LLM proxy)

- Overhead actual estimado: **~5–15 ms** por request (cumple NF-01 <25ms).
- `recordSuccess` ejecuta una transacción de 2 statements en SQLite en **cada** request exitoso | `src/handlers/requestHandler.js:87` + `src/services/circuitBreaker.js:12-30`.
- `isDailyLimitExceeded` ejecuta un SELECT por proveedor en cada request | `src/services/failoverEngine.js:106-118`.
- Cadena asíncrona correcta: colas (`logQueue`), batched flush, mem-caches acotados (`memCache` 1000, `apiKeyCache` 500), `rateBuckets` acotado por proveedores.
- Cache: `getCache` (mem → SQLite) + `setCache` (SQLite sync). Aceptable para uso personal; no escalar sin rediseñar.

### Código muerto

| Item | Ubicación |
|---|---|
| `stopFlushTimer` (sin uso) | `src/services/logQueue.js:113` |
| `stopCacheFlushTimer` (sin uso) | `src/services/cacheManager.js:64` |
| `resetDbPath` (sin uso) | `src/db.js:45` |
| `logger.debug` (nunca llamado) | `src/utils/logger.js:66` |
| `?? true` muerto/engañoso en `exposeProvider` | `src/handlers/requestHandler.js:33,102` |
| Import `dbGet` sin uso | `src/routes/chat.routes.js:2` |
| Import `decrypt` sin uso | `src/routes/providers.routes.js:3` |
| `tests/test-config.json` huérfano | `tests/test-config.json` |
| Param `providers` sin uso en `msgLabel` | `frontend/src/components/Chat.jsx:4` |
| `slice(0,8)` redundante | `frontend/src/components/Logs.jsx:18` |
| CSS muerto: `.form-grid textarea`, `.empty-state code` | `frontend/src/style.css:211,361` |
| `db/migrations/` vacío; `.env.example` referenciado pero inexistente | `db/migrations/`, `docs/relio-spec.md:865` |

### Dependencias

- **No hay dependencias sin uso** (verificado en root y frontend).
- `npm audit`:
  - `uuid < 11.1.1` (moderate) — usado directamente y por `node-cron`. Sustituible por `crypto.randomUUID()` nativo.
  - `vite`/`esbuild` (moderate, dev-only) — requiere upgrade a vite 6/7.
  - `react-router-dom` 6.x (moderate + high). El "high" (deserializeErrors) aplica a SSR/hydration, no a este CSR; aun así conviene migrar a 7.x.

### Docs desalineados

- `relio-spec.md:879` dice cifrado at-rest "planned" → **ya implementado** (providers api_key con AES-256-GCM).
- `PRD.md:111` NF-08 "API keys en texto plano" → falso para `providers.api_key`.
- `features.md` duplicado verbatim (líneas 1-45 y 47-127) y describe Routing Strategies sin implementar.
- `README.md` dice Node 18+ vs `engines >=20`; endpoint `DELETE /admin/api/keys/:keyPreview` vs código `:id`.
- `validation-guide.md` sin nota de roadmap.

---

## Fases de implementación

### Fase 1 — Fixes de funcionalidad (P0)

- [ ] **Bug #1 (crítico)** — `src/routes/chat.routes.js`: validar `provider_id` solo cuando `!use_proxy`; permitir la ruta proxy sin provider. Ajustar `frontend/src/components/Chat.jsx` si hace falta (puede seguir enviando `null`).
- [ ] **Bug #2** — `frontend/src/components/ProviderForm.jsx`: try/catch + guard `res.ok` en `handleSubmit`; garantizar `setSaving(false)` en `finally`.
- [ ] **Bug #3** — `frontend/src/components/ApiKeys.jsx`: verificar `r.ok` y wrap en try/catch en el refetch post-creación.
- [ ] **Bug #4** — Scoping del reorder por `capability`:
  - `providers.routes.js`: `PATCH /reorder` recibe `capability` y solo reordena providers activos de esa capacidad.
  - `ProvidersList.jsx`: enviar `capability`; guard `indexOf === -1` (Bug #10) para evitar `splice(-1,1)`.
- [ ] **Bug #5** — `package.json`: script `prestart` (build frontend) o fallback claro en `src/index.js` si `frontend/dist` no existe.
- [ ] **Bug #6** — `Logs.jsx`: paginación real server-side con `limit/offset` desde el backend (`metrics.routes.js` ya lo soporta).
- [ ] **Bug #7** — Guard contra respuestas fuera de orden en `Metrics.jsx` y `ProvidersList.jsx` (token de secuencia o `AbortController`).
- [ ] **Bug #8** — Estandarizar fechas UTC: `ApiKeys.jsx` tratando el formato SQLite como UTC (mismo helper que `Logs.jsx`); opcionalmente unificar a ISO con `Z` en `authService.js`/DB.
- [ ] **Bug #9** — `Chat.jsx`: no volcar `JSON.stringify` crudo cuando el content es vacío.
- [ ] **Bug #11** — `Pagination.jsx`: reset de página al cambiar `pageSize`; mantener visible el selector aunque `totalPages <= 1`.

### Fase 2 — Seguridad (proxy blindado + hardening)

- [ ] **S1 — API keys hasheadas**: guardar `sha256(key)` + columna `key_prefix` (primeros 10 chars del texto plano) en `api_keys`; validar con `crypto.timingSafeEqual(sha256(input), sha256(stored))`; migración de keys existentes en `initDb()` (`runMigrations`).
- [ ] **S1 — Validación de formato** en `validateApiKey`: prefijo `llm_pk_` y longitud mínima antes de tocar DB (evita consultas con basura).
- [ ] **S2 — Cifrado at-rest**:
  - `config.js`: en producción, error fatal si falta `security.encryptionKey` o si es el placeholder de `config.example.json`.
  - Validar formato 64-hex cuando se provee. Mantener auto-derive solo en development.
  - `db.js`: eliminar el fallback silencioso por defecto.
- [ ] **S3 — SSRF mínimo** en `test-connection`/create/update (`providers.routes.js`): permitir solo `http/https`; bloquear por defecto rangos privados/link-local/metadata (`127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254.169.254`, `::1`, `0.0.0.0`) con allowlist configurable (`security.allowedApiNetworks`). Defense-in-depth dado el dashboard abierto.
- [ ] **S4** — Quitar `api_url` de `GET /admin/api/chat/providers` (`chat.routes.js:89`).
- [ ] **Documentación de despliegue** — README: postura de seguridad (dashboard abierto → localhost/LAN/VPN/reverse proxy; proxy `/v1/*` blindado por keys).
- [ ] *(No aplica)* Auth del dashboard — sin cambios, por decisión confirmada.

### Fase 3 — Rendimiento (LLM proxy)

- [ ] `recordSuccess` condicional: escribir a DB solo si `provider.status !== 'active'` o `failure_count > 0` o `cooldown_until` seteado (`src/services/circuitBreaker.js`). Elimina ~2 escrituras síncronas por request.
- [ ] `isDailyLimitExceeded`: caché en memoria `{providerId}_{today}` con TTL 30s (`src/services/failoverEngine.js`). Elimina SELECT por proveedor/request. Documentar que el presupuesto diario es soft.
- [ ] Test de overhead: mide `processRequest` con provider mock y fija el objetivo <25ms (Fase 5).
- [ ] Re-verificar overhead real tras los cambios y registrar medición en este doc.

### Fase 4 — Código muerto, dependencias, lint

- [ ] Eliminar: `stopFlushTimer`, `stopCacheFlushTimer`, `resetDbPath`, `logger.debug`, imports muertos (`chat.routes.js:2`, `providers.routes.js:3`), `tests/test-config.json`, CSS muerto (`style.css:211,361`), param `providers` de `msgLabel`, `?? true` en `requestHandler.js:33,102`.
- [ ] Sustituir `uuid` por `crypto.randomUUID()` en `cacheManager.js`, `logQueue.js`, `authService.js`, `providers.routes.js` → eliminar dependencia `uuid` (arregla audit).
- [ ] Frontend: upgrade `vite` a 6.x/7.x patched y `react-router-dom` a 7.x. Verificar build y flujo dev.
- [ ] Añadir ESLint (config + scripts `lint`) y script `test:coverage` (vitest coverage).
- [ ] Añadir GitHub Actions: `npm ci`, `npm test`, `npm run build` (root + frontend).

### Fase 5 — Tests (revisión + ampliación)

- [ ] **Revisar tests existentes (87)** y eliminar redundantes/irrelevantes (especialmente `tests/adapter.test.js`: casos triviales duplicados). Conservar solo los relevantes.
- [ ] Añadir cobertura para módulos sin tests:
  - `authService` (create/validate/revoke, constant-time, prefix), `authMiddleware`, `circuitBreaker` (transiciones cooldown), `logQueue` (upserts), `metricsLogger` (getMetrics/getHealth/getLogs), `dashboardHandler` (getSummary), `config` (env overrides, error de clave), `maintenance` (recoverCooldowns/cleanup con `:memory:`).
  - Rutas: `keys.routes`, `metrics.routes`, `providers.routes` (CRUD/reorder/test-connection), `chat.routes` (incluye el Bug #1 del proxy), `proxy.routes` (chat/embeddings/models/streaming).
- [ ] Test de overhead de `processRequest` (Fase 3).
- [ ] Criterio: `npm test` verde y cobertura significativa de los módulos core.

### Fase 6 — Producción + Docker + Docs

- [ ] `package.json`: bump `1.3.0`; `engines >=20` alineado con README; scripts `prestart`/`start:prod` consistentes.
- [ ] `docker/Dockerfile`: usuario no-root (`USER node`) + `HEALTHCHECK` contra `/admin/api/metrics/health`. Ajustar permisos de volúmenes en `docker-compose.yml` si es necesario.
- [ ] Eliminar `db/migrations/` vacío (o añadir README) y quitar mención a `.env.example` inexistente.
- [ ] Docs:
  - `features.md`: deduplicar; marcar Routing Strategies como **roadmap v2**.
  - `PRD.md`: corregir NF-08 (API keys de proveedores cifradas at-rest); mover "API key encryption at rest" fuera del roadmap v2 (ya hecho).
  - `relio-spec.md`: actualizar sección 15 (cifrado ✅) y el bloque de notas del header.
  - `README.md`: endpoint keys `:id`, Node 20+, postura de despliegue/seguridad, nota de selector de modelo estricto.
  - `validation-guide.md`: nota de roadmap para items no implementados.
  - `AGENTS.md`: reflejar cambios de authService, reorder por capability y los nuevos helpers.
- [ ] Verificación final: `npm test`, `npm run build`, arranque con `npm start`, smoke test manual de `/v1/*` (auth, failover, cache, streaming) y del dashboard.

---

## Criterios de salida a producción

1. `npm test` verde con la suite limpia y ampliada.
2. `npm run build` y `npm start` funcionando en clon fresco (dashboard servido).
3. Proxy `/v1/*` blindado: keys hasheadas + constant-time + rate limiting + validación de formato.
4. Sin dependencias con vulnerabilidades conocidas accionables (audit limpio o documentado).
5. Overhead de proxy verificado < 25ms.
6. Docker build OK con usuario no-root y healthcheck.
7. Docs alineados (sin referencias obsoletas a login/cifrado "planned"/routing strategies implementadas).
8. Lint/CI verde en CI.

---

## Fuera de alcance (v2)

- Routing Strategies (Cheapest/Budget/Smart/etc.) — roadmap v2.
- `/v1/responses` (opcional según spec).
- Mapeo modelo→proveedor (selector estricto se mantiene).
- Autenticación del dashboard / logins de terceros parametrizables (a evaluar a futuro).
- Multi-usuario, Prometheus, webhooks, alerts (PRD v2.0).

# PRD — Relio (LLM Relay)

**Status:** v1.0 Implementado  
**Última actualización:** Julio 2026

---

## 1. Resumen Ejecutivo

Relio es un proxy inteligente y self-hosted para Large Language Models (LLMs). Centraliza múltiples providers (OpenAI, Anthropic, Groq, etc.), implementa failover automático con circuit breaker, cachea respuestas, audita cada request en SQLite, y expone una API compatible con OpenAI para que cualquier agente AI pueda consumirla sin cambios.

**Problema que resuelve:** Las aplicaciones AI que usan múltiples providers LLM necesitan manejar failover, rate limits, costos, auditoría y caching por su cuenta. Relio centraliza todo esto en un solo servicio, con dashboard visual para gestión.

---

## 2. User Personas

### 2.1 Desarrollador de Agentes AI
- Necesita una API única compatible con OpenAI
- No quiere manejar failover manual
- Quiere una API Key por agente para controlar acceso
- Necesita auditoría de cada request

### 2.2 Admin / DevOps
- Gestiona múltiples providers (OpenAI, Anthropic, Groq...)
- Necesita dashboard visual para monitorear costos y uso
- Quiere controlar rate limits y orden de failover
- Requiere métricas diarias y logs de auditoría

---

## 3. Requerimientos Funcionales

### 3.1 Proxy LLM
| ID | Requerimiento | Prioridad |
|---|---|---|
| F-01 | Exponer endpoint `/v1/chat/completions` compatible con OpenAI API | P0 |
| F-02 | Exponer endpoint `/v1/embeddings` compatible con OpenAI API | P0 |
| F-03 | Detectar contenido multimodal (vision) dentro de `/v1/chat/completions` | P1 |
| F-04 | Timeout de 30s por llamada a provider | P0 |
| F-05 | Mantener formato de response idéntico a OpenAI | P0 |

### 3.2 Failover
| ID | Requerimiento | Prioridad |
|---|---|---|
| F-06 | Seleccionar provider según orden configurable (Main, Fallback 1, N) | P0 |
| F-07 | Saltar providers en cooldown | P0 |
| F-08 | Saltar providers que excedieron rate limit (req/min) | P0 |
| F-09 | Saltar providers que excedieron daily token limit | P1 |
| F-10 | Si todos fallan, retornar 503 con detalle | P0 |

### 3.3 Circuit Breaker
| ID | Requerimiento | Prioridad |
|---|---|---|
| F-11 | Estado HEALTHY: uso normal, cuenta fallos | P0 |
| F-12 | Estado COOLDOWN: no intentar durante N segundos tras M fallos | P0 |
| F-13 | Estado PAUSED: no intentar (manual) | P1 |
| F-14 | Configurar umbral de fallos y duración de cooldown por provider | P0 |

### 3.4 Cache
| ID | Requerimiento | Prioridad |
|---|---|---|
| F-15 | Cachear respuestas por hash del body del request | P0 |
| F-16 | TTL configurable por variable de entorno (default 30 días) | P0 |
| F-17 | Cache hit incrementa contador y se registra en log | P1 |
| F-18 | Cache expire cleanup automático en mantenimiento diario | P1 |

### 3.5 Autenticación y API Keys
| ID | Requerimiento | Prioridad |
|---|---|---|
| F-19 | Login vía Geduma API (3 endpoints: providers, login, user) | P0 |
| F-20 | Sesiones locales en SQLite (token Geduma es single-use) | P0 |
| F-21 | API Keys locales para agentes AI (formato `llm_pk_xxx`) | P0 |
| F-22 | API Key se muestra solo al crear | P0 |
| F-23 | Revocación de API Keys | P0 |
| F-24 | httpOnly cookie para sesión de dashboard | P0 |

### 3.6 Dashboard
| ID | Requerimiento | Prioridad |
|---|---|---|
| F-25 | Login con providers OAuth (Google, GitHub, etc.) | P0 |
| F-26 | Listar providers con orden y estado | P0 |
| F-27 | Crear/editar/eliminar providers | P0 |
| F-28 | Reordenar providers (Main, Fallback 1, 2...) | P0 |
| F-29 | Ver métricas por rango de fechas | P0 |
| F-30 | Ver últimos requests (logs) | P0 |
| F-31 | Gestionar API Keys (crear, listar, revocar) | P0 |
| F-32 | Health check del proxy | P1 |

### 3.7 Auditoría y Métricas
| ID | Requerimiento | Prioridad |
|---|---|---|
| F-33 | Registrar cada request en `requests_log` | P0 |
| F-34 | Calcular costo estimado por request | P0 |
| F-35 | Métricas diarias agregadas por provider | P0 |
| F-36 | Historial de login en `login_history` | P1 |
| F-37 | Backup automático diario de BD | P1 |

---

## 4. Requerimientos No Funcionales

| ID | Requerimiento | Objetivo |
|---|---|---|
| NF-01 | Overhead del proxy | < 25ms por request (sin contar LLM) |
| NF-02 | Startup time | < 2s |
| NF-03 | Consumo de memoria | < 100MB idle |
| NF-04 | Almacenamiento logs | 90 días de retención |
| NF-05 | Almacenamiento cache | 30 días TTL |
| NF-06 | Almacenamiento métricas | 365 días |
| NF-07 | Disponibilidad | Sin single point of failure (múltiples providers) |
| NF-08 | Seguridad | API keys en texto plano en DB local, httpOnly cookies |
| NF-09 | Portabilidad | Docker multi-stage, sin dependencias externas |

---

## 5. Arquitectura

### 5.1 Diagrama de Componentes

```
Cliente (HTTP)
    │
    ▼
authMiddleware
    │
    ├── Cache Hit? → Response
    │
    ▼
failoverEngine → Provider 1 (Main)
                    → Provider 2 (Fallback 1)
                    → Provider N
    │
    ▼
metricsLogger + SQLite
```

### 5.2 Stack Tecnológico

| Componente | Tecnología | Versión |
|---|---|---|
| Backend | Node.js + Express.js | 20 LTS + 4.x |
| Base de datos | SQLite (better-sqlite3) | 11.x |
| Frontend | React + Vite | 18 + 5.x |
| HTTP Client | Native fetch | Node 18+ |
| Auth | Geduma API | Externa |
| Testing | Vitest | 1.x |
| Container | Docker multi-stage | — |

### 5.3 Base de Datos

9 tablas:
- `providers` — configuración de cada LLM provider
- `requests_log` — cada request al proxy
- `cache` — respuestas cacheadas por hash
- `api_keys` — API keys locales para agentes AI
- `login_history` — historial de autenticación
- `circuit_breaker_state` — estado del circuit breaker
- `sessions` — sesiones de dashboard (token Geduma)
- `metrics` — agregados diarios

---

## 6. Flujos Principales

### 6.1 Proxy + Failover

```
POST /v1/chat/completions
  Authorization: Bearer llm_pk_xxx

1. Validar API Key
2. Calcular hash del body → buscar en cache
3. Cache hit → retornar (log cache_hit=true)
4. Cache miss → seleccionar providers activos ordenados
5. Para cada provider:
   a. Verificar estado (healthy/cooldown/paused)
   b. Verificar rate limit (req/min)
   c. Verificar daily limit (tokens/día)
   d. Llamar provider con timeout 30s
   e. Éxito → cachear + log + métricas + retornar
   f. Falla → incrementar contador, si >= umbral → cooldown
6. Todos fallan → 503 Service Unavailable
```

### 6.2 Login

```
1. GET /admin/api/auth/providers → lista providers OAuth
2. Usuario click "Login with Google"
3. Redirect a OAuth provider → callback con code
4. POST /admin/api/auth/login { provider, code }
5. Backend → Geduma API → token + user info
6. Crear sesión local → cookie relio_session
7. Redirect a /admin/dashboard
```

---

## 7. Métricas de Éxito

| Métrica | Objetivo |
|---|---|
| Tiempo de setup (desde clone hasta dashboard) | < 5 min |
| Tests pasando | 100% |
| Overhead del proxy | < 25ms |
| Cobertura de providers soportados | Cualquiera con API compatible OpenAI |
| Uptime | > 99.9% (failover automático) |

---

## 8. Roadmap

### v1.0 (Actual)
- Core proxy + failover + circuit breaker
- Dashboard React con gestión de providers
- API Keys locales
- Auditoría y métricas diarias
- Cache persistente con TTL
- Docker multi-stage
- Rate limiting por provider

### v2.0 (Futuro)
- Encriptación de API keys en DB
- Rate limiting por IP
- Alertas y notificaciones
- Exportación de métricas (Prometheus)
- Múltiples usuarios
- Webhook de eventos

---

## 9. Riesgos y Mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Dependencia de Geduma API | Alto — sin auth no hay dashboard | Caché de sesiones, fallback a auth local (futuro) |
| Pérdida de datos SQLite | Medio — pérdida de logs | Backup diario automático |
| Provider LLM caído | Bajo — failover automático | Circuit breaker + múltiples fallbacks |
| API Key comprometida | Alto — uso no autorizado | Revocación inmediata desde dashboard |

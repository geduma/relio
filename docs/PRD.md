# PRD — Relio (LLM Relay)

**Status:** v1.0 Implemented  
**Last updated:** July 2026  
**Target audience:** Personal / Self-hosted use

---

## 1. Executive Summary

Relio is a self-hosted, intelligent proxy for Large Language Models (LLMs). It centralizes multiple providers (OpenAI, Anthropic, Groq, etc.), implements automatic failover with circuit breaker, caches responses, audits every request in SQLite, and exposes an OpenAI-compatible API so any AI agent can consume it without changes.

**Problem it solves:** AI applications using multiple LLM providers need to handle failover, rate limits, costs, auditing, and caching themselves. Relio centralizes all of this into a single service with a visual management dashboard, designed for personal/self-hosted use.

---

## 2. User Personas

### 2.1 AI Agent Developer
- Needs a single OpenAI-compatible API
- Does not want to handle manual failover
- Wants one API Key per agent for access control
- Needs audit trail for every request

### 2.2 Solo Admin / Hobbyist
- Manages multiple providers (OpenAI, Anthropic, Groq...)
- Needs a visual dashboard for cost and usage monitoring
- Wants to control rate limits and failover order
- Requires daily metrics and audit logs

---

## 3. Functional Requirements

### 3.1 LLM Proxy
| ID | Requirement | Priority |
|---|---|---|
| F-01 | Expose `/v1/chat/completions` endpoint compatible with OpenAI API | P0 |
| F-02 | Expose `/v1/embeddings` endpoint compatible with OpenAI API | P0 |
| F-03 | Detect multimodal (vision) content inside `/v1/chat/completions` | P1 |
| F-04 | 30s timeout per provider call | P0 |
| F-05 | Maintain OpenAI-identical response format | P0 |

### 3.2 Failover
| ID | Requirement | Priority |
|---|---|---|
| F-06 | Select provider by configured order (Main, Fallback 1, N) | P0 |
| F-07 | Skip providers in cooldown | P0 |
| F-08 | Skip providers exceeding rate limit (req/min) | P0 |
| F-09 | Skip providers exceeding daily token limit | P1 |
| F-10 | Return 503 with details if all providers fail | P0 |

### 3.3 Circuit Breaker
| ID | Requirement | Priority |
|---|---|---|
| F-11 | HEALTHY state: normal use, counts failures | P0 |
| F-12 | COOLDOWN state: skip for N seconds after M failures | P0 |
| F-13 | PAUSED state: skip until manually resumed | P1 |
| F-14 | Configurable failure threshold and cooldown duration per provider | P0 |

### 3.4 Cache
| ID | Requirement | Priority |
|---|---|---|
| F-15 | Cache responses by request body hash | P0 |
| F-16 | Configurable TTL via env var (default 30 days) | P0 |
| F-17 | Cache hits increment counter and are logged | P1 |
| F-18 | Automatic expired cache cleanup in daily maintenance | P1 |

### 3.5 Authentication & API Keys
| ID | Requirement | Priority |
|---|---|---|
| F-19 | Login via Geduma API (3 endpoints: providers, login, user) | P0 |
| F-20 | Local SQLite sessions (Geduma token is single-use) | P0 |
| F-21 | Local API Keys for AI agents (`llm_pk_xxx` format) | P0 |
| F-22 | API Key shown only once at creation | P0 |
| F-23 | API Key revocation | P0 |
| F-24 | httpOnly cookie for dashboard session | P0 |

### 3.6 Dashboard
| ID | Requirement | Priority |
|---|---|---|
| F-25 | Login with OAuth providers (Google, GitHub, etc.) | P0 |
| F-26 | List providers with order and status | P0 |
| F-27 | Create/edit/delete providers | P0 |
| F-28 | Reorder providers (Main, Fallback 1, 2...) | P0 |
| F-29 | View metrics by date range | P0 |
| F-30 | View recent request logs | P0 |
| F-31 | Manage API Keys (create, list, revoke) | P0 |
| F-32 | Health check endpoint | P1 |
| F-38 | Chat dashboard for interactive provider testing | P1 |
| F-39 | Dark mode with toggle and localStorage persistence | P2 |
| F-40 | Provider connection test with API key validation and masked key handling | P1 |

### 3.7 Audit & Metrics
| ID | Requirement | Priority |
|---|---|---|
| F-33 | Log every request in `requests_log` | P0 |
| F-34 | Calculate estimated cost per request | P0 |
| F-35 | Daily aggregated metrics per provider | P0 |
| F-36 | Login history in `login_history` | P1 |
| F-37 | Automatic daily DB backup | P1 |

---

## 4. Non-Functional Requirements

| ID | Requirement | Target |
|---|---|---|
| NF-01 | Proxy overhead | < 25ms per request (excluding LLM) |
| NF-02 | Startup time | < 2s |
| NF-03 | Memory usage | < 100MB idle |
| NF-04 | Log retention | 90 days |
| NF-05 | Cache retention | 30 days TTL |
| NF-06 | Metrics retention | 365 days |
| NF-07 | Availability | No single point of failure (multiple providers) |
| NF-08 | Security | API keys in plain text in local DB, httpOnly cookies |
| NF-09 | Portability | Docker multi-stage, no external dependencies |

---

## 5. Architecture

### 5.1 Component Diagram

```
Client (HTTP)
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

### 5.2 Technology Stack

| Component | Technology | Version |
|---|---|---|
| Backend | Node.js + Express.js | 20 LTS + 4.x |
| Database | SQLite (better-sqlite3) | 11.x |
| Frontend | React + Vite | 18 + 5.x |
| HTTP Client | Native fetch | Node 18+ |
| Auth | Geduma API | External |
| Testing | Vitest | 1.x |
| Container | Docker multi-stage | — |

### 5.3 Database Schema

9 tables:
- `providers` — LLM provider configuration
- `requests_log` — every proxy request
- `cache` — cached responses by hash
- `api_keys` — local API keys for AI agents
- `login_history` — authentication history
- `circuit_breaker_state` — circuit breaker status
- `sessions` — dashboard sessions (Geduma token)
- `metrics` — daily aggregated metrics

---

## 6. Core Flows

### 6.1 Proxy + Failover

```
POST /v1/chat/completions
  Authorization: Bearer llm_pk_xxx

1. Validate API Key
2. Hash request body → check cache
3. Cache hit → return (log cache_hit=true)
4. Cache miss → select active providers ordered by position
5. For each provider:
   a. Check state (healthy/cooldown/paused)
   b. Check rate limit (req/min)
   c. Check daily limit (tokens/day)
   d. Call provider with 30s timeout
   e. Success → cache + log + metrics + return
   f. Failure → increment counter, if >= threshold → cooldown
6. All fail → 503 Service Unavailable
```

### 6.2 Login

```
1. GET /admin/api/auth/providers → list OAuth providers
2. User clicks "Login with Google"
3. Redirect to OAuth provider → callback with code
4. POST /admin/api/auth/login { provider, code }
5. Backend → Geduma API → token + user info
6. Create local session → set relio_session cookie
7. Redirect to /admin/dashboard
```

---

### 6.3 Chat (Dashboard)

```
POST /admin/api/chat/send
  { provider_id, messages, use_proxy }

1. Chat.jsx loads providers from GET /admin/api/chat/providers
2. User selects provider, types message, optionally enables proxy toggle
3. Proxy disabled (default):
   a. POST /admin/api/chat/send with { provider_id, messages }
   b. Backend calls callProvider() directly — bypasses failover, cache, metrics
4. Proxy enabled:
   a. POST /admin/api/chat/send with { provider_id, messages, use_proxy: true }
   b. Backend calls processRequest() — full pipeline (failover, cache, circuit breaker, metrics)
5. Response includes response_time_ms displayed in each assistant message bubble
```

### 6.4 Provider Connection Test

```
POST /admin/api/providers/test-connection
  { api_url, api_key } or { provider_id } for masked key resolution

1. Primary: GET /v1/models with Authorization header
   - 200 → also verify with POST /v1/chat/completions
   - 401/403 → API key invalid
   - 404 → fallback to POST /v1/chat/completions
2. Fallback: POST /v1/chat/completions with fake model
   - Check res.ok and response body for auth-related error messages
3. Timeout: 5s per request via AbortController
4. Security: PATCH ignores '***' api_key (no DB update);
   test sends provider_id to resolve real key from DB
```

---

## 7. Success Metrics

| Metric | Target |
|---|---|
| Setup time (clone to dashboard) | < 5 min |
| Tests passing | 100% |
| Proxy overhead | < 25ms |
| Supported providers | Any OpenAI-compatible API |
| Uptime | > 99.9% (automatic failover) |

---

## 8. Roadmap

### v1.0 (Current)
- Core proxy + failover + circuit breaker
- React dashboard with provider management
- Local API Keys
- Audit logging and daily metrics
- Persistent cache with configurable TTL
- Docker multi-stage
- Per-provider rate limiting
- Chat dashboard for interactive provider testing
- Dark mode with toggle and localStorage persistence
- Provider connection test with API key validation and masked key handling

### v2.0 (Future)
- API key encryption at rest
- IP-based rate limiting
- Alerts and notifications
- Prometheus metrics export
- Multi-user support
- Event webhooks

---

## 9. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Geduma API dependency | High — no auth without it | Session caching, local auth fallback (future) |
| SQLite data loss | Medium — log loss | Daily automatic backup |
| LLM provider outage | Low — automatic failover | Circuit breaker + multiple fallbacks |
| Compromised API Key | High — unauthorized usage | Immediate revocation from dashboard |

import { dbAll, dbGet, dbRun, getDb } from '../db.js'
import { callProvider, getProvider, invalidateProviderCache, isQuotaError, isProviderRenderError, extractRetryAfter } from './failoverEngine.js'
import { invalidateModelsCache } from '../routes/proxy.routes.js'
import { logger } from '../utils/logger.js'
import { config } from '../config.js'

const ORDER_LABELS = ['Main', 'Fallback 1', 'Fallback 2', 'Fallback 3', 'Fallback 4', 'Fallback 5']

const MODEL_NOT_FOUND_MARKERS = [
  'model not found',
  'model does not exist',
  'model_not_found',
  'models.notfound',
  'unknown model',
  'modelunavailable',
  'deployment not found',
  'deployment_not_found',
  'not found for requested',
]

export function isModelNotFoundError(data, message) {
  const text = `${message || ''} ${JSON.stringify(data || {})}`.toLowerCase()
  return MODEL_NOT_FOUND_MARKERS.some(marker => text.includes(marker))
}

export function classifyHealthCheckError(err) {
  if (!err) return { kind: 'network', action: 'cooldown' }
  if (err.name === 'AbortError') return { kind: 'timeout', action: 'cooldown' }
  const status = err.status
  if (!status) return { kind: 'network', action: 'cooldown' }
  if (status === 401 || status === 403) return { kind: 'auth', action: 'paused' }
  if (status === 402) return { kind: 'quota', action: 'paused' }
  if (status === 404) return { kind: 'not_found', action: 'paused' }
  if (status === 429) {
    return isQuotaError(err.data)
      ? { kind: 'quota', action: 'paused' }
      : { kind: 'rate', action: 'cooldown' }
  }
  if (status === 400 && (isProviderRenderError(err.data, err.message) || isModelNotFoundError(err.data, err.message))) {
    return { kind: 'model', action: 'paused' }
  }
  if (status === 408 || status >= 500) return { kind: 'server', action: 'cooldown' }
  if (status === 400) return { kind: 'invalid', action: 'cooldown' }
  return { kind: 'unknown', action: 'cooldown' }
}

export async function probeProvider(provider) {
  const start = Date.now()
  const controller = new AbortController()
  const timeoutMs = config.healthCheck?.timeoutMs || 10000
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (timer.unref) timer.unref()

  const body = provider.capability === 'embeddings'
    ? { model: provider.model, input: 'ping' }
    : { model: provider.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }

  try {
    await callProvider(provider, body, controller.signal, provider.capability || 'chat')
    return { ok: true, status: 200, latencyMs: Date.now() - start }
  } catch (err) {
    return {
      ok: false,
      status: err.status || null,
      error: err,
      errorMessage: err.message || String(err),
      latencyMs: Date.now() - start,
    }
  } finally {
    clearTimeout(timer)
  }
}

function pauseThreshold() {
  return config.healthCheck?.pauseAfterConsecutiveFailures || 2
}

function computeCooldownUntil(provider, err) {
  const retryAfter = extractRetryAfter(err)
  let seconds
  if (retryAfter && retryAfter > 0) {
    seconds = Math.min(retryAfter, config.relay.retryAfterMaxSeconds || 900)
  } else {
    seconds = provider.cooldown_duration_seconds || config.relay.rateLimitCooldownSeconds || 60
  }
  return new Date(Date.now() + seconds * 1000).toISOString()
}

function setCircuitState(providerId, state, failureCount, cooldownUntil) {
  dbRun(
    `INSERT INTO circuit_breaker_state (provider_id, state, failure_count, last_failure_at, cooldown_until, updated_at)
     VALUES (?, ?, ?, datetime('now'), ?, datetime('now'))
     ON CONFLICT(provider_id) DO UPDATE SET
       state = ?,
       failure_count = ?,
       last_failure_at = datetime('now'),
       cooldown_until = ?,
       updated_at = datetime('now')`,
    [providerId, state, failureCount, cooldownUntil, state, failureCount, cooldownUntil]
  )
}

export function pauseProvider(provider, failureCount) {
  const db = getDb()
  const tx = db.transaction(() => {
    dbRun(
      "UPDATE providers SET status = 'paused', cooldown_until = NULL, health_failures = ?, updated_at = datetime('now') WHERE id = ?",
      [failureCount, provider.id]
    )
    setCircuitState(provider.id, 'paused', failureCount, null)
    const lastPos = dbGet(
      "SELECT COUNT(*) AS count FROM providers WHERE capability = ? AND status = 'active'",
      [provider.capability]
    ).count
    dbRun(
      "UPDATE providers SET order_position = ?, order_label = 'Paused' WHERE id = ?",
      [lastPos, provider.id]
    )
  })
  tx()
  invalidateProviderCache(provider.id)
  invalidateModelsCache()
}

export function cooldownProvider(provider, failureCount, cooldownUntil) {
  const db = getDb()
  const tx = db.transaction(() => {
    dbRun(
      "UPDATE providers SET status = 'cooldown', cooldown_until = ?, health_failures = ?, updated_at = datetime('now') WHERE id = ?",
      [cooldownUntil, failureCount, provider.id]
    )
    setCircuitState(provider.id, 'cooldown', failureCount, cooldownUntil)
  })
  tx()
  invalidateProviderCache(provider.id)
  invalidateModelsCache()
}

export function reactivateProvider(provider) {
  const db = getDb()
  const tx = db.transaction(() => {
    dbRun(
      "UPDATE providers SET status = 'active', cooldown_until = NULL, health_failures = 0, updated_at = datetime('now') WHERE id = ?",
      [provider.id]
    )
    setCircuitState(provider.id, 'healthy', 0, null)
    const maxPos = dbGet(
      "SELECT MAX(order_position) AS max FROM providers WHERE capability = ? AND status = 'active'",
      [provider.capability]
    ).max
    const nextPos = (maxPos ?? -1) + 1
    const label = ORDER_LABELS[nextPos] || `Fallback ${nextPos}`
    dbRun(
      'UPDATE providers SET order_position = ?, order_label = ? WHERE id = ?',
      [nextPos, label, provider.id]
    )
  })
  tx()
  invalidateProviderCache(provider.id)
  invalidateModelsCache()
}

function resetFailures(providerId) {
  dbRun("UPDATE providers SET health_failures = 0, updated_at = datetime('now') WHERE id = ?", [providerId])
}

function upsertHealthCheck(record) {
  dbRun(
    `INSERT INTO provider_health_checks
      (provider_id, status, http_status, error_code, error_type, error_message, latency_ms, previous_status, new_status, action_taken, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider_id) DO UPDATE SET
       status = excluded.status,
       http_status = excluded.http_status,
       error_code = excluded.error_code,
       error_type = excluded.error_type,
       error_message = excluded.error_message,
       latency_ms = excluded.latency_ms,
       previous_status = excluded.previous_status,
       new_status = excluded.new_status,
       action_taken = excluded.action_taken,
       checked_at = excluded.checked_at`,
    [
      record.provider_id, record.status, record.http_status, record.error_code, record.error_type,
      record.error_message, record.latency_ms, record.previous_status, record.new_status,
      record.action_taken, record.checked_at || new Date().toISOString(),
    ]
  )
}

export async function checkAndApply(provider) {
  const probe = await probeProvider(provider)
  const previousStatus = provider.status

  const record = {
    provider_id: provider.id,
    status: probe.ok ? 'ok' : 'error',
    http_status: probe.status,
    error_message: probe.ok ? null : probe.errorMessage,
    latency_ms: probe.latencyMs,
    previous_status: previousStatus,
  }

  if (probe.ok) {
    if (previousStatus === 'active') {
      resetFailures(provider.id)
      record.new_status = 'active'
      record.action_taken = 'none'
    } else {
      reactivateProvider(provider)
      record.new_status = 'active'
      record.action_taken = 'reactivated'
    }
    record.error_type = null
    record.error_code = null
  } else {
    const cls = classifyHealthCheckError(probe.error)
    const newCount = (provider.health_failures || 0) + 1
    const shouldPause = cls.action === 'paused' || newCount >= pauseThreshold()
    if (shouldPause) {
      pauseProvider(provider, newCount)
      record.new_status = 'paused'
      record.action_taken = 'paused'
    } else {
      cooldownProvider(provider, newCount, computeCooldownUntil(provider, probe.error))
      record.new_status = 'cooldown'
      record.action_taken = 'cooldown'
    }
    record.error_type = cls.kind
    record.error_code = probe.status != null ? String(probe.status) : null
  }

  upsertHealthCheck(record)
  const summary = {
    provider: provider.name,
    status: record.status,
    new_status: record.new_status,
    action: record.action_taken,
    error_type: record.error_type,
    http_status: record.http_status,
    latency_ms: record.latency_ms,
    error: record.error_message,
  }
  if (record.status === 'error') logger.warn('Health check failed', summary)
  return { ...record, provider_name: provider.name, capability: provider.capability, model: provider.model }
}

export async function checkProviderNow(providerId) {
  const provider = getProvider(providerId)
  if (!provider) throw new Error('Provider not found')
  return checkAndApply(provider)
}

export async function runHealthCheck() {
  if (!config.healthCheck?.enabled) return []
  const rows = dbAll("SELECT id FROM providers WHERE status = 'active' ORDER BY order_position ASC")
  dbRun('DELETE FROM provider_health_checks')
  const results = []
  for (const row of rows) {
    const provider = getProvider(row.id)
    if (!provider) continue
    try {
      results.push(await checkAndApply(provider))
    } catch (err) {
      logger.error('Health check failed for provider', { provider_id: row.id, error: err.message })
    }
  }
  logger.info('Health check run complete', { checked: results.length })
  return results
}

let timer = null
let running = false

function nextDelayMs() {
  const minutes = Math.max(1, config.healthCheck?.intervalMinutes || 10)
  return minutes * 60 * 1000
}

export function startHealthCheckScheduler() {
  stopHealthCheckScheduler()
  if (!config.healthCheck?.enabled) return
  timer = setTimeout(async () => {
    if (!running) {
      running = true
      try {
        await runHealthCheck()
      } catch (err) {
        logger.error('Health check run failed', { error: err.message })
      } finally {
        running = false
      }
    }
    startHealthCheckScheduler()
  }, nextDelayMs())
  if (timer.unref) timer.unref()
}

export function stopHealthCheckScheduler() {
  if (timer) clearTimeout(timer)
  timer = null
}

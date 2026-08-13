import crypto from 'crypto'
import { getDb } from '../db.js'
import { config } from '../config.js'

function maxBatchSize() {
  return config.relay?.writeBuffer?.maxBufferSize || 50
}

const logQueue = []
const metricQueue = []
const apiKeyTouchQueue = []
const circuitCounterQueue = []
let flushTimer = null

function toArray(queue) {
  const len = Math.min(queue.length, maxBatchSize())
  return queue.splice(0, len)
}

function flush() {
  const logs = toArray(logQueue)
  const metrics = toArray(metricQueue)
  const touches = toArray(apiKeyTouchQueue)
  const circuitCounters = toArray(circuitCounterQueue)

  if (logs.length === 0 && metrics.length === 0 && touches.length === 0 && circuitCounters.length === 0) return

  const db = getDb()

  try {
    const tx = db.transaction(() => {
      for (const d of logs) {
        const totalTokens = (d.inputTokens || 0) + (d.outputTokens || 0)
        const now = new Date().toISOString()
        db.prepare(`INSERT INTO requests_log
          (id, provider_id, provider_name, endpoint, request_body, origin_ip, origin_header,
           status_code, response_body, error_message,
           input_tokens, output_tokens, total_tokens, estimated_cost,
           response_time_ms, ttft_ms, authenticated_via, requester_name, requester_key, cache_hit, was_retry, retry_count, tokens_saved_estimate, request_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          crypto.randomUUID(), d.providerId, d.providerName || null, d.endpoint,
          JSON.stringify(d.requestBody), d.originIp, d.originHeader,
          d.statusCode, d.responseBody ? JSON.stringify(d.responseBody) : null, d.errorMessage,
          d.inputTokens || 0, d.outputTokens || 0, totalTokens, d.estimatedCost || 0,
          d.responseTimeMs, d.ttftMs != null ? d.ttftMs : null, d.authenticatedVia, d.requesterName || null, d.requesterKey || null, d.cacheHit ? 1 : 0, d.wasRetry ? 1 : 0, d.retryCount || 0,
          d.tokensSavedEstimate || 0,
          now
        )
      }

      for (const { providerId, data } of metrics) {
        const today = new Date().toISOString().slice(0, 10)
        const id = `${providerId}_${today}`
        const inputTokens = data.inputTokens || 0
        const outputTokens = data.outputTokens || 0
        const cost = data.cost || 0
        const error = data.error ? 1 : 0
        const cacheHit = data.cacheHit ? 1 : 0
        const responseTimeMs = data.responseTimeMs || 0

        db.prepare(`INSERT INTO metrics
          (id, provider_id, metric_date, total_requests, total_input_tokens, total_output_tokens,
           total_cost, error_count, cache_hits, avg_response_time_ms)
          VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(provider_id, metric_date) DO UPDATE SET
            total_requests = total_requests + 1,
            total_input_tokens = total_input_tokens + ?,
            total_output_tokens = total_output_tokens + ?,
            total_cost = total_cost + ?,
            error_count = error_count + ?,
            cache_hits = cache_hits + ?,
            avg_response_time_ms = (avg_response_time_ms * total_requests + ?) / (total_requests + 1)`
        ).run(
          id, providerId, today,
          inputTokens, outputTokens, cost,
          error, cacheHit, responseTimeMs,
          inputTokens, outputTokens, cost,
          error, cacheHit, responseTimeMs
        )
      }

      for (const id of touches) {
        db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(id)
      }

      for (const { providerId, failureCount } of circuitCounters) {
        db.prepare(`INSERT INTO circuit_breaker_state (provider_id, state, failure_count, last_failure_at, updated_at)
           VALUES (?, 'healthy', ?, datetime('now'), datetime('now'))
           ON CONFLICT(provider_id) DO UPDATE SET
             failure_count = excluded.failure_count,
             last_failure_at = datetime('now'),
             updated_at = datetime('now')`
        ).run(providerId, failureCount)
      }
    })
    tx()
  } catch (err) {
    console.error('[logQueue] Flush failed, data may be lost:', err.message)
  }
}

export function enqueueLog(data) {
  logQueue.push(data)
  if (logQueue.length >= maxBatchSize()) flush()
}

export function enqueueMetric(providerId, data) {
  metricQueue.push({ providerId, data })
  if (metricQueue.length >= maxBatchSize()) flush()
}

export function enqueueApiKeyTouch(id) {
  apiKeyTouchQueue.push(id)
  if (apiKeyTouchQueue.length >= maxBatchSize()) flush()
}

export function enqueueCircuitCounter(providerId, failureCount) {
  circuitCounterQueue.push({ providerId, failureCount })
  if (circuitCounterQueue.length >= maxBatchSize()) flush()
}

export function dropCircuitCounters(providerId) {
  if (providerId === undefined) return
  for (let i = circuitCounterQueue.length - 1; i >= 0; i -= 1) {
    if (circuitCounterQueue[i].providerId === providerId) {
      circuitCounterQueue.splice(i, 1)
    }
  }
}

export function flushAll() {
  flush()
  if (logQueue.length > 0 || metricQueue.length > 0 || apiKeyTouchQueue.length > 0 || circuitCounterQueue.length > 0) flush()
}

export function startFlushTimer() {
  if (flushTimer) return
  scheduleFlush()
}

function scheduleFlush() {
  const intervalMs = Math.max(1, config.relay?.writeBuffer?.flushIntervalMs || 500)
  flushTimer = setTimeout(() => {
    flush()
    scheduleFlush()
  }, intervalMs)
  if (flushTimer.unref) flushTimer.unref()
}

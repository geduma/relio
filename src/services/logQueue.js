import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db.js'

const MAX_BATCH = 500

const logQueue = []
const metricQueue = []
const apiKeyTouchQueue = []
let flushTimer = null

function toArray(queue) {
  const len = Math.min(queue.length, MAX_BATCH)
  return queue.splice(0, len)
}

function flush() {
  const logs = toArray(logQueue)
  const metrics = toArray(metricQueue)
  const touches = toArray(apiKeyTouchQueue)

  if (logs.length === 0 && metrics.length === 0 && touches.length === 0) return

  const db = getDb()

  try {
    const tx = db.transaction(() => {
      for (const d of logs) {
        const totalTokens = (d.inputTokens || 0) + (d.outputTokens || 0)
        const now = new Date().toISOString()
        db.prepare(`INSERT INTO requests_log
          (id, provider_id, endpoint, request_body, origin_ip, origin_header,
           status_code, response_body, error_message,
           input_tokens, output_tokens, total_tokens, estimated_cost,
           response_time_ms, authenticated_via, cache_hit, was_retry, retry_count, request_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          uuidv4(), d.providerId, d.endpoint,
          JSON.stringify(d.requestBody), d.originIp, d.originHeader,
          d.statusCode, d.responseBody ? JSON.stringify(d.responseBody) : null, d.errorMessage,
          d.inputTokens || 0, d.outputTokens || 0, totalTokens, d.estimatedCost || 0,
          d.responseTimeMs, d.authenticatedVia, d.cacheHit ? 1 : 0, d.wasRetry ? 1 : 0, d.retryCount || 0,
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
    })
    tx()
  } catch (err) {
    console.error('[logQueue] Flush failed, data may be lost:', err.message)
  }
}

export function enqueueLog(data) {
  logQueue.push(data)
  if (logQueue.length >= MAX_BATCH) flush()
}

export function enqueueMetric(providerId, data) {
  metricQueue.push({ providerId, data })
  if (metricQueue.length >= MAX_BATCH) flush()
}

export function enqueueApiKeyTouch(id) {
  apiKeyTouchQueue.push(id)
  if (apiKeyTouchQueue.length >= MAX_BATCH) flush()
}

export function flushAll() {
  flush()
  if (logQueue.length > 0 || metricQueue.length > 0 || apiKeyTouchQueue.length > 0) flush()
}

export function startFlushTimer(intervalMs = 1000) {
  if (flushTimer) return
  flushTimer = setInterval(flush, intervalMs)
  if (flushTimer.unref) flushTimer.unref()
}

export function stopFlushTimer() {
  if (flushTimer) {
    clearInterval(flushTimer)
    flushTimer = null
  }
}

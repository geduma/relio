import { v4 as uuidv4 } from 'uuid'
import { dbAll, dbGet, dbRun } from '../db.js'

export function logRequest({
  providerId, endpoint, requestBody, originIp, originHeader,
  statusCode, responseBody, errorMessage,
  inputTokens, outputTokens, estimatedCost,
  responseTimeMs, authenticatedVia, cacheHit, wasRetry, retryCount,
}) {

  const totalTokens = (inputTokens || 0) + (outputTokens || 0)

  dbRun(
    `INSERT INTO requests_log
     (id, provider_id, endpoint, request_body, origin_ip, origin_header,
      status_code, response_body, error_message,
      input_tokens, output_tokens, total_tokens, estimated_cost,
      response_time_ms, authenticated_via, cache_hit, was_retry, retry_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidv4(), providerId, endpoint,
      JSON.stringify(requestBody), originIp, originHeader,
      statusCode, responseBody ? JSON.stringify(responseBody) : null, errorMessage,
      inputTokens || 0, outputTokens || 0, totalTokens, estimatedCost || 0,
      responseTimeMs, authenticatedVia, cacheHit ? 1 : 0, wasRetry ? 1 : 0, retryCount || 0,
    ]
  )
}

export function updateMetrics(providerId, { inputTokens, outputTokens, cost, responseTimeMs, cacheHit, error }) {

  const today = new Date().toISOString().slice(0, 10)
  const id = `${providerId}_${today}`

  dbRun(
    `INSERT INTO metrics
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
       avg_response_time_ms = (avg_response_time_ms * (total_requests - 1) + ?) / total_requests`,
    [
      id, providerId, today,
      inputTokens || 0, outputTokens || 0, cost || 0,
      error ? 1 : 0, cacheHit ? 1 : 0, responseTimeMs || 0,
      inputTokens || 0, outputTokens || 0, cost || 0,
      error ? 1 : 0, cacheHit ? 1 : 0, responseTimeMs || 0,
    ]
  )
}

export function getMetrics(from, to) {

  const rows = dbAll(
    `SELECT m.provider_id, p.name AS provider_name,
            SUM(m.total_requests) AS total_requests,
            SUM(m.total_input_tokens) AS total_input_tokens,
            SUM(m.total_output_tokens) AS total_output_tokens,
            SUM(m.total_cost) AS total_cost,
            SUM(m.error_count) AS error_count,
            SUM(m.cache_hits) AS cache_hits,
            AVG(m.avg_response_time_ms) AS avg_response_time_ms
     FROM metrics m
     JOIN providers p ON p.id = m.provider_id
     WHERE m.metric_date >= ? AND m.metric_date <= ?
     GROUP BY m.provider_id`,
    [from, to]
  )

  const totals = {
    total_requests: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cost: 0,
    error_count: 0,
    cache_hits: 0,
  }

  for (const r of rows) {
    totals.total_requests += r.total_requests
    totals.total_input_tokens += r.total_input_tokens
    totals.total_output_tokens += r.total_output_tokens
    totals.total_cost += r.total_cost
    totals.error_count += r.error_count
    totals.cache_hits += r.cache_hits
  }

  return { period: `${from} to ${to}`, providers: rows, totals }
}

export function getLogs(limit = 50, offset = 0) {

  return dbAll(
    `SELECT id, provider_id, endpoint, status_code, input_tokens, output_tokens,
            response_time_ms, cache_hit, authenticated_via, request_at, error_message
     FROM requests_log
     ORDER BY request_at DESC
     LIMIT ? OFFSET ?`,
    [limit, offset]
  )
}

export function getHealth() {

  const healthy = dbGet("SELECT COUNT(*) AS count FROM providers WHERE status = 'active'").count
  const cooldown = dbGet("SELECT COUNT(*) AS count FROM providers WHERE status = 'cooldown'").count
  const paused = dbGet("SELECT COUNT(*) AS count FROM providers WHERE status = 'paused'").count
  return { healthy, cooldown, paused }
}

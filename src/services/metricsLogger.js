import { dbAll } from '../db.js'

export function getMetrics(from, to) {
  const rows = dbAll(
    `SELECT m.provider_id, p.name AS provider_name,
            SUM(m.total_requests) AS total_requests,
            SUM(m.total_input_tokens) AS total_input_tokens,
            SUM(m.total_output_tokens) AS total_output_tokens,
            SUM(m.total_cost) AS total_cost,
            SUM(m.error_count) AS error_count,
            SUM(m.cache_hits) AS cache_hits,
            SUM(m.avg_response_time_ms * m.total_requests) / NULLIF(SUM(m.total_requests), 0) AS avg_response_time_ms
     FROM metrics m
     LEFT JOIN providers p ON p.id = m.provider_id
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
  const rows = dbAll("SELECT status, COUNT(*) AS count FROM providers GROUP BY status")
  const result = { healthy: 0, cooldown: 0, paused: 0 }
  for (const r of rows) {
    if (r.status === 'active') result.healthy = r.count
    else if (r.status === 'cooldown') result.cooldown = r.count
    else if (r.status === 'paused') result.paused = r.count
  }
  return result
}

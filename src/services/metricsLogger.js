import { dbAll, dbGet } from '../db.js'

export function getMetrics(from, to) {
  const rows = dbAll(
    `SELECT p.id AS provider_id, p.name AS provider_name,
            COALESCE(SUM(m.total_requests), 0) AS total_requests,
            COALESCE(SUM(m.total_input_tokens), 0) AS total_input_tokens,
            COALESCE(SUM(m.total_output_tokens), 0) AS total_output_tokens,
            COALESCE(SUM(m.total_cost), 0) AS total_cost,
            COALESCE(SUM(m.error_count), 0) AS error_count,
            COALESCE(SUM(m.cache_hits), 0) AS cache_hits,
            COALESCE(SUM(m.avg_response_time_ms * m.total_requests) / NULLIF(SUM(m.total_requests), 0), 0) AS avg_response_time_ms
     FROM providers p
     LEFT JOIN metrics m ON m.provider_id = p.id AND m.metric_date >= ? AND m.metric_date <= ?
     WHERE p.status != 'paused'
     GROUP BY p.id
     ORDER BY p.order_position ASC`,
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
  const logs = dbAll(
    `SELECT l.id, l.provider_id, COALESCE(l.provider_name, p.name) AS provider_name,
            l.endpoint, l.status_code, l.input_tokens, l.output_tokens,
            l.response_time_ms, l.cache_hit, l.authenticated_via,
            l.requester_name, l.requester_key, l.origin_ip, l.request_at, l.error_message
     FROM requests_log l
     LEFT JOIN providers p ON p.id = l.provider_id
     ORDER BY l.request_at DESC
     LIMIT ? OFFSET ?`,
    [limit, offset]
  )
  const total = dbGet('SELECT COUNT(*) AS count FROM requests_log').count
  return { logs, total }
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

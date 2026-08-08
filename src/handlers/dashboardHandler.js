import { dbGet } from '../db.js'

export function getSummary() {

  const today = new Date().toISOString().slice(0, 10)

  const todayMetrics = dbGet(
    `SELECT SUM(total_requests) AS requests,
            SUM(total_input_tokens + total_output_tokens) AS tokens,
            SUM(total_cost) AS cost
     FROM metrics WHERE metric_date = ?`,
    [today]
  )

  const todayTokensSaved = dbGet(
    `SELECT COALESCE(SUM(tokens_saved_estimate), 0) AS total
     FROM requests_log WHERE substr(request_at, 1, 10) = ?`,
    [today]
  ).total

  const providerCount = dbGet('SELECT COUNT(*) AS count FROM providers WHERE status = \'active\'').count

  return {
    today_requests: todayMetrics?.requests || 0,
    today_tokens: todayMetrics?.tokens || 0,
    today_cost: todayMetrics?.cost || 0,
    today_tokens_saved: todayTokensSaved,
    active_providers: providerCount,
  }
}

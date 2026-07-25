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

  const providerCount = dbGet('SELECT COUNT(*) AS count FROM providers WHERE status = \'active\'').count

  return {
    today_requests: todayMetrics?.requests || 0,
    today_tokens: todayMetrics?.tokens || 0,
    today_cost: todayMetrics?.cost || 0,
    active_providers: providerCount,
  }
}

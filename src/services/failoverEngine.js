import { dbAll, dbGet, dbRun } from '../db.js'

export function selectProviders(modelType) {
  dbRun(
    `UPDATE providers SET status = 'active', cooldown_until = NULL
     WHERE type = ? AND status = 'cooldown' AND cooldown_until IS NOT NULL AND cooldown_until <= datetime('now')`,
    [modelType]
  )

  dbRun(
    `UPDATE circuit_breaker_state SET state = 'healthy', failure_count = 0, cooldown_until = NULL, updated_at = datetime('now')
     WHERE provider_id IN (SELECT id FROM providers WHERE type = ? AND status = 'active')
     AND state = 'cooldown' AND cooldown_until <= datetime('now')`,
    [modelType]
  )

  return dbAll(
    `SELECT * FROM providers
     WHERE type = ? AND status = 'active'
     ORDER BY order_position ASC`,
    [modelType]
  )
}

export function isProviderAvailable(provider) {
  if (provider.status === 'paused') return false
  if (provider.cooldown_until && new Date(provider.cooldown_until) > new Date()) {
    return false
  }
  return true
}

export function isRateLimitExceeded(provider) {
  if (!provider.rate_limit_req_per_min || provider.rate_limit_req_per_min <= 0) return false

  const windowStart = new Date(Date.now() - 60000).toISOString()
  const count = dbGet(
    `SELECT COUNT(*) AS cnt FROM requests_log
     WHERE provider_id = ? AND request_at > ?`,
    [provider.id, windowStart]
  ).cnt

  return count >= provider.rate_limit_req_per_min
}

export function isDailyLimitExceeded(provider) {
  if (provider.tokens_per_day <= 0) return false

  const today = new Date().toISOString().slice(0, 10)
  const used = dbGet(
    `SELECT COALESCE(SUM(total_tokens), 0) AS used FROM requests_log
     WHERE provider_id = ? AND request_at >= ?`,
    [provider.id, today]
  ).used

  return used >= provider.tokens_per_day
}

export async function callProvider(provider, requestBody, signal) {
  let url = provider.api_url.replace(/\/+$/, '')

  const isChat = !!requestBody.messages
  if (!url.endsWith('/chat/completions') && !url.endsWith('/embeddings')) {
    const suffix = url.endsWith('/v1') ? '' : '/v1'
    url += `${suffix}/${isChat ? 'chat/completions' : 'embeddings'}`
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${provider.api_key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
    signal,
  })

  const data = await response.json()

  if (!response.ok) {
    const err = new Error(data.error?.message || `Provider returned ${response.status}`)
    err.status = response.status
    err.data = data
    throw err
  }

  return data
}

export function getModelTypeFromBody(body) {
  if (body.messages) return 'chat'
  if (body.input) return 'embeddings'
  return 'chat'
}

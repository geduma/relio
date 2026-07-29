import { dbAll, dbGet, dbRun } from '../db.js'

export function selectProviders(modelType) {
  return dbAll(
    `SELECT * FROM providers
     WHERE type = ? AND (status = 'active' OR (status = 'cooldown' AND cooldown_until <= datetime('now')))
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

  const controller = signal ? null : new AbortController()
  const timeout = controller ? setTimeout(() => controller.abort(), 30000) : null
  const actualSignal = signal || (controller ? controller.signal : null)

  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${provider.api_key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: actualSignal,
    })
  } finally {
    if (timeout) clearTimeout(timeout)
  }

  let data
  try {
    data = await response.json()
  } catch {
    const err = new Error(`Provider returned non-JSON response (status ${response.status})`)
    err.status = response.status
    err.data = null
    throw err
  }

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

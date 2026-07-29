import { dbAll, dbGet, decrypt } from '../db.js'
import { getAdapter } from '../adapters/index.js'

function decryptProvider(p) {
  return { ...p, api_key: decrypt(p.api_key) }
}

export function getProvider(id) {
  const p = dbGet('SELECT * FROM providers WHERE id = ?', [id])
  return p ? decryptProvider(p) : null
}

export function selectProviders(capability) {
  return dbAll(
    `SELECT * FROM providers
     WHERE capability = ? AND (status = 'active' OR (status = 'cooldown' AND cooldown_until <= datetime('now')))
     ORDER BY order_position ASC`,
    [capability]
  ).map(decryptProvider)
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
  const adapter = getAdapter(provider.provider_type)
  return adapter.chat(provider, requestBody, signal)
}

export async function streamProvider(provider, requestBody, signal) {
  const adapter = getAdapter(provider.provider_type)
  return adapter.stream(provider, requestBody, signal)
}

export function getCapabilityFromBody(body) {
  if (body.messages) return 'chat'
  if (body.input) return 'embeddings'
  return 'chat'
}

import { dbAll, dbGet, decrypt } from '../db.js'
import { getAdapter } from '../adapters/index.js'
import { config } from '../config.js'
import { ROUTING_STRATEGIES } from './configValidation.js'

const KEY_CACHE_TTL_MS = 60_000
const keyCache = new Map()

function decryptProvider(p) {
  const cached = keyCache.get(p.id)
  if (cached && Date.now() < cached.expiresAt) {
    return { ...p, api_key: cached.key }
  }
  const key = decrypt(p.api_key)
  keyCache.set(p.id, { key, expiresAt: Date.now() + KEY_CACHE_TTL_MS })
  return { ...p, api_key: key }
}

export function invalidateProviderCache(id) {
  if (id) {
    keyCache.delete(id)
    for (const k of [...dailyLimitCache.keys()]) {
      if (k.startsWith(`${id}:`)) dailyLimitCache.delete(k)
    }
  } else {
    keyCache.clear()
    dailyLimitCache.clear()
  }
}

export function clearDailyLimitCache() {
  dailyLimitCache.clear()
}

const rateBuckets = new Map()
const DAILY_LIMIT_CACHE_TTL_MS = 10_000
const dailyLimitCache = new Map()

function trimBucket(providerId) {
  const arr = rateBuckets.get(providerId)
  if (!arr) return null
  const windowStart = Date.now() - 60_000
  while (arr.length && arr[0] <= windowStart) arr.shift()
  if (arr.length === 0) rateBuckets.delete(providerId)
  return arr
}

export function recordProviderRequest(providerId) {
  const arr = rateBuckets.get(providerId) || []
  rateBuckets.set(providerId, arr)
  arr.push(Date.now())
}

export function isRateLimitExceeded(provider) {
  if (!provider.rate_limit_req_per_min || provider.rate_limit_req_per_min <= 0) return false
  const arr = trimBucket(provider.id)
  if (!arr) return false
  return arr.length >= provider.rate_limit_req_per_min
}

export const FAILOVER_MODEL = 'auto'

export function getRoutingStrategy() {
  const fromConfig = config.relay.routingStrategy
  return ROUTING_STRATEGIES.includes(fromConfig) ? fromConfig : 'order'
}

export function getUsedTokensToday(provider) {
  const today = new Date().toISOString().slice(0, 10)
  const cacheKey = `${provider.id}:${today}`
  const cached = dailyLimitCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.used
  }

  const used = dbGet(
    `SELECT COALESCE(SUM(total_input_tokens + total_output_tokens), 0) AS used
     FROM metrics
     WHERE provider_id = ? AND metric_date = ?`,
    [provider.id, today]
  ).used
  dailyLimitCache.set(cacheKey, { used, expiresAt: Date.now() + DAILY_LIMIT_CACHE_TTL_MS })
  if (dailyLimitCache.size > 500) dailyLimitCache.clear()
  return used
}

export function orderProvidersForRouting(providers) {
  if (getRoutingStrategy() !== 'least-used') return providers
  return [...providers].sort((a, b) => {
    const diff = getUsedTokensToday(a) - getUsedTokensToday(b)
    if (diff !== 0) return diff
    return a.order_position - b.order_position
  })
}

export function getProvider(id) {
  const p = dbGet('SELECT * FROM providers WHERE id = ?', [id])
  return p ? decryptProvider(p) : null
}

export function resolveProvider(selector, capability) {
  if (!selector) return null
  const byId = dbGet('SELECT * FROM providers WHERE id = ? AND capability = ?', [selector, capability])
  if (byId) return decryptProvider(byId)
  const byName = dbGet('SELECT * FROM providers WHERE name = ? COLLATE NOCASE AND capability = ?', [selector, capability])
  return byName ? decryptProvider(byName) : null
}

export function parseModelSelector(model, capability) {
  if (!model) return { error: 'missing' }
  if (String(model).trim().toLowerCase() === FAILOVER_MODEL) return { mode: 'failover' }
  const provider = resolveProvider(model, capability)
  if (!provider) return { error: 'unknown' }
  return { mode: 'provider', provider }
}

export function stripModel(body) {
  if (!body || body.model === undefined) return body
  const clone = { ...body }
  delete clone.model
  return clone
}

export function selectProviders(capability) {
  return dbAll(
    `SELECT * FROM providers
     WHERE capability = ? AND (status = 'active' OR (status = 'cooldown' AND cooldown_until <= ?))
     ORDER BY order_position ASC`,
    [capability, new Date().toISOString()]
  ).map(decryptProvider)
}

export function isProviderAvailable(provider) {
  if (provider.status === 'paused') return false
  if (provider.cooldown_until && new Date(provider.cooldown_until) > new Date()) {
    return false
  }
  return true
}

export function isRetryableError(err) {
  if (!err) return false
  if (err.name === 'AbortError') return true
  const status = err.status
  if (!status) return true
  if (status >= 500) return true
  if (status === 408 || status === 429) return true
  return false
}

export function isDailyLimitExceeded(provider) {
  if (provider.tokens_per_day <= 0) return false
  return getUsedTokensToday(provider) >= provider.tokens_per_day
}

export async function callProvider(provider, requestBody, signal, capability) {
  const adapter = getAdapter(provider.provider_type)
  if (capability === 'embeddings') {
    return adapter.embeddings(provider, requestBody, signal)
  }
  return adapter.chat(provider, requestBody, signal)
}

export async function streamProvider(provider, requestBody, signal) {
  const adapter = getAdapter(provider.provider_type)
  return adapter.stream(provider, requestBody, signal)
}

export async function listModels(provider) {
  const adapter = getAdapter(provider.provider_type)
  try {
    return await adapter.models(provider.api_url, provider.api_key)
  } catch (err) {
    throw new Error(`Failed to list models for ${provider.name}: ${err.message}`)
  }
}

export function getCapabilityFromBody(body) {
  if (body.messages) return 'chat'
  if (body.input) return 'embeddings'
  return 'chat'
}

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
  const arr = trimBucket(provider.id)
  if (!provider.rate_limit_req_per_min || provider.rate_limit_req_per_min <= 0) return false
  if (!arr) return false
  return arr.length >= provider.rate_limit_req_per_min
}

export const FAILOVER_MODEL = 'auto'

export function getRoutingStrategy() {
  const fromConfig = config.relay.routingStrategy
  return ROUTING_STRATEGIES.includes(fromConfig) ? fromConfig : 'order'
}

function getUsedTokensToday(provider) {
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

export function selectProviders(capability, allowedProviderIds = null) {
  const providers = dbAll(
    `SELECT * FROM providers
     WHERE capability = ? AND (status = 'active' OR (status = 'cooldown' AND cooldown_until <= ?))
     ORDER BY order_position ASC`,
    [capability, new Date().toISOString()]
  ).map(decryptProvider)

  if (allowedProviderIds) {
    return providers.filter(p => allowedProviderIds.includes(p.id))
  }
  return providers
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

const PROVIDER_RENDER_ERROR_RE = /(tools? should have a name|template|harmony|render)/i
const QUOTA_MARKERS = [
  'insufficient_quota',
  'credit_balance_exhausted',
  'spend_limit',
  'quota_exceeded',
  'quota',
  'billing_not_active',
  'billing',
  'payment',
  'x-should-retry":false',
]

export function isProviderRenderError(data, message) {
  const text = `${message || ''} ${JSON.stringify(data || {})}`.toLowerCase()
  return PROVIDER_RENDER_ERROR_RE.test(text)
}

export function isQuotaError(body) {
  if (!body || typeof body !== 'object') return false
  const text = JSON.stringify(body).toLowerCase()
  if (/retry in \d/.test(text) || text.includes('retry_after_seconds')) return false
  return QUOTA_MARKERS.some(marker => text.includes(marker))
}

export function classifyProviderError(err, provider = null) {
  if (!err) return { retryable: false, immediateCooldown: null }
  if (err.name === 'AbortError') return { retryable: true, immediateCooldown: 'circuit' }
  const status = err.status
  if (!status) return { retryable: true, immediateCooldown: 'circuit' }

  if (status === 402 || status === 413) {
    if (!config.relay.failoverOnQuota) return { retryable: false, immediateCooldown: null }
    if (status === 413) return { retryable: true, immediateCooldown: 'none' }
    return provider?.provider_type === 'anthropic'
      ? { retryable: true, immediateCooldown: 'rate' }
      : { retryable: true, immediateCooldown: 'quota' }
  }

  if (status === 400 && isProviderRenderError(err.data, err.message)) {
    if (!config.relay.failoverOnQuota) return { retryable: false, immediateCooldown: null }
    return { retryable: true, immediateCooldown: 'none' }
  }

  if (status === 429) {
    if (!config.relay.failoverOnQuota) return { retryable: true, immediateCooldown: 'circuit' }
    return isQuotaError(err.data)
      ? { retryable: true, immediateCooldown: 'quota' }
      : { retryable: true, immediateCooldown: 'rate' }
  }

  if (status >= 500 || status === 408) {
    return { retryable: true, immediateCooldown: 'circuit' }
  }

  return { retryable: false, immediateCooldown: null }
}

export function extractRetryAfter(err) {
  if (!err) return null
  if (typeof err.retryAfter === 'number' && Number.isFinite(err.retryAfter) && err.retryAfter > 0) {
    return Math.ceil(err.retryAfter)
  }
  if (!err.data || typeof err.data !== 'object') return null
  const text = JSON.stringify(err.data)
  const inSeconds = text.match(/retry_after_seconds["']?\s*[:=]\s*(\d+(?:\.\d+)?)/i)
  if (inSeconds) return Math.ceil(parseFloat(inSeconds[1]))
  const retryIn = text.match(/retry in\s+(\d+(?:\.\d+)?)\s*s/i)
  if (retryIn) return Math.ceil(parseFloat(retryIn[1]))
  return null
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

export function getCapabilityFromBody(body) {
  if (body.messages) return 'chat'
  if (body.input) return 'embeddings'
  return 'chat'
}

import crypto from 'crypto'
import { dbAll, dbGet, dbRun, getDb, hashApiKey } from '../db.js'
import { enqueueApiKeyTouch } from './logQueue.js'

const API_KEY_CACHE_TTL = 300_000
const CACHE_MAX = 500
export const API_KEY_PREFIX = 'relio_sk_'
export const API_KEY_PATTERN = /^relio_sk_[0-9a-f]{64}$/

export function isValidApiKeyFormat(key) {
  return API_KEY_PATTERN.test(key)
}
const apiKeyCache = new Map()
const apiKeyOrder = []

function boundedSet(map, order, key, value) {
  if (map.has(key)) {
    const idx = order.indexOf(key)
    if (idx !== -1) order.splice(idx, 1)
  }
  if (map.size >= CACHE_MAX) {
    const oldest = order.shift()
    map.delete(oldest)
  }
  map.set(key, value)
  order.push(key)
}

function invalidateApiKeyCache(id) {
  for (const [key, entry] of apiKeyCache) {
    if (entry.id === id) {
      apiKeyCache.delete(key)
      const idx = apiKeyOrder.indexOf(key)
      if (idx !== -1) apiKeyOrder.splice(idx, 1)
    }
  }
}

function validateProviderIds(providerIds) {
  if (!Array.isArray(providerIds) || providerIds.length === 0) {
    const err = new Error('providerIds array (non-empty) is required')
    err.status = 400
    throw err
  }

  const uniqueIds = [...new Set(providerIds)]
  const placeholders = uniqueIds.map(() => '?').join(', ')
  const row = dbGet(`SELECT COUNT(*) AS count FROM providers WHERE id IN (${placeholders})`, uniqueIds)
  if (row.count !== uniqueIds.length) {
    const err = new Error('One or more providers do not exist')
    err.status = 400
    throw err
  }
  return uniqueIds
}

export function createApiKey({ name, providerIds }) {
  const providerIdList = validateProviderIds(providerIds)
  const key = `${API_KEY_PREFIX}${crypto.randomBytes(32).toString('hex')}`
  const id = crypto.randomUUID()

  const db = getDb()
  const insertKey = db.prepare('INSERT INTO api_keys (id, key_hash, key_prefix, name) VALUES (?, ?, ?, ?)')
  const insertLink = db.prepare('INSERT INTO api_key_providers (api_key_id, provider_id) VALUES (?, ?)')

  const tx = db.transaction(() => {
    insertKey.run(id, hashApiKey(key), key.slice(0, 10), name)
    for (const providerId of providerIdList) {
      insertLink.run(id, providerId)
    }
  })
  tx()

  return key
}

export function validateApiKey(key) {
  const cached = apiKeyCache.get(key)
  if (cached && Date.now() < cached.expiresAt) {
    enqueueApiKeyTouch(cached.id)
    return cached.row
  }

  if (cached) {
    apiKeyCache.delete(key)
    const idx = apiKeyOrder.indexOf(key)
    if (idx !== -1) apiKeyOrder.splice(idx, 1)
  }

  const row = dbGet('SELECT * FROM api_keys WHERE key_hash = ?', [hashApiKey(key)])
  if (row) {
    const allowedProviderIds = rowAllowedProviderIds(row.id)
    const apiKeyEntry = { ...row, allowedProviderIds }
    boundedSet(apiKeyCache, apiKeyOrder, key, { id: row.id, row: apiKeyEntry, expiresAt: Date.now() + API_KEY_CACHE_TTL })
    enqueueApiKeyTouch(row.id)
    return apiKeyEntry
  }
  return null
}

function rowAllowedProviderIds(apiKeyId) {
  return dbAll('SELECT provider_id FROM api_key_providers WHERE api_key_id = ?', [apiKeyId]).map(r => r.provider_id)
}

export function listApiKeys() {
  const rows = dbAll(
    'SELECT id, key_prefix, name, created_at, last_used_at FROM api_keys ORDER BY created_at DESC'
  )

  let providersByKey = new Map()
  if (rows.length > 0) {
    const ids = rows.map(r => r.id)
    const placeholders = ids.map(() => '?').join(', ')
    const links = dbAll(
      `SELECT akp.api_key_id, p.id AS provider_id, p.name AS provider_name, p.capability
       FROM api_key_providers akp
       JOIN providers p ON p.id = akp.provider_id
       WHERE akp.api_key_id IN (${placeholders})`,
      ids
    )
    providersByKey = new Map(ids.map(id => [id, []]))
    for (const l of links) {
      providersByKey.get(l.api_key_id).push({ id: l.provider_id, name: l.provider_name, capability: l.capability })
    }
  }

  return rows.map(r => ({
    id: r.id,
    key_preview: r.key_prefix + '...',
    name: r.name,
    created_at: r.created_at,
    last_used_at: r.last_used_at,
    providers: providersByKey.get(r.id) || [],
  }))
}

export function updateApiKeyProviders(keyId, providerIds) {
  const key = dbGet('SELECT * FROM api_keys WHERE id = ?', [keyId])
  if (!key) {
    const err = new Error('API key not found')
    err.status = 404
    throw err
  }

  const providerIdList = validateProviderIds(providerIds)
  const db = getDb()
  const deleteLinks = db.prepare('DELETE FROM api_key_providers WHERE api_key_id = ?')
  const insertLink = db.prepare('INSERT INTO api_key_providers (api_key_id, provider_id) VALUES (?, ?)')

  const tx = db.transaction(() => {
    deleteLinks.run(keyId)
    for (const providerId of providerIdList) {
      insertLink.run(keyId, providerId)
    }
  })
  tx()

  invalidateApiKeyCache(keyId)
  return listApiKeys().find(k => k.id === keyId)
}

export function revokeApiKey(id) {
  invalidateApiKeyCache(id)
  const result = dbRun('DELETE FROM api_keys WHERE id = ?', [id])
  return result.changes > 0
}

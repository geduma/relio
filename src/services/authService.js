import crypto from 'crypto'
import { dbAll, dbGet, dbRun, hashApiKey } from '../db.js'
import { enqueueApiKeyTouch } from './logQueue.js'

const API_KEY_CACHE_TTL = 300_000
const CACHE_MAX = 500
const API_KEY_PREFIX = 'llm_pk_'
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

export function createApiKey(name) {
  const key = `${API_KEY_PREFIX}${crypto.randomBytes(32).toString('hex')}`
  const id = crypto.randomUUID()
  dbRun('INSERT INTO api_keys (id, key_hash, key_prefix, name) VALUES (?, ?, ?, ?)', [id, hashApiKey(key), key.slice(0, 10), name])
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
    boundedSet(apiKeyCache, apiKeyOrder, key, { id: row.id, row, expiresAt: Date.now() + API_KEY_CACHE_TTL })
    enqueueApiKeyTouch(row.id)
  }
  return row || null
}

export function listApiKeys() {
  const rows = dbAll(
    'SELECT id, key_prefix, name, created_at, last_used_at FROM api_keys ORDER BY created_at DESC'
  )
  return rows.map(r => ({
    id: r.id,
    key_preview: r.key_prefix + '...',
    name: r.name,
    created_at: r.created_at,
    last_used_at: r.last_used_at,
  }))
}

export function revokeApiKey(id) {
  for (const [key, entry] of apiKeyCache) {
    if (entry.id === id) {
      apiKeyCache.delete(key)
      const idx = apiKeyOrder.indexOf(key)
      if (idx !== -1) apiKeyOrder.splice(idx, 1)
    }
  }
  const result = dbRun('DELETE FROM api_keys WHERE id = ?', [id])
  return result.changes > 0
}

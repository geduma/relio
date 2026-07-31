import { v4 as uuidv4 } from 'uuid'
import { dbAll, dbGet, dbRun } from '../db.js'
import { enqueueApiKeyTouch } from './logQueue.js'

const API_KEY_CACHE_TTL = 300_000
const CACHE_MAX = 500
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
  const key = `llm_pk_${uuidv4().replace(/-/g, '')}${uuidv4().replace(/-/g, '')}`
  const id = uuidv4()
  dbRun('INSERT INTO api_keys (id, key, name) VALUES (?, ?, ?)', [id, key, name])
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

  const row = dbGet('SELECT * FROM api_keys WHERE key = ?', [key])
  if (row) {
    boundedSet(apiKeyCache, apiKeyOrder, key, { id: row.id, row, expiresAt: Date.now() + API_KEY_CACHE_TTL })
    enqueueApiKeyTouch(row.id)
  }
  return row || null
}

export function listApiKeys() {
  const rows = dbAll(
    'SELECT id, substr(key, 1, 10) AS key_prefix, name, created_at, last_used_at FROM api_keys ORDER BY created_at DESC'
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

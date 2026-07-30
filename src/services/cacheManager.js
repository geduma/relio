import crypto from 'crypto'
import { v4 as uuidv4 } from 'uuid'
import { dbGet, dbRun } from '../db.js'
import { config } from '../config.js'

const MEM_TTL_MS = 300_000
const MEM_MAX = 1000
const memCache = new Map()
const memOrder = []

function memGet(key) {
  const entry = memCache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    memCache.delete(key)
    const idx = memOrder.indexOf(key)
    if (idx !== -1) memOrder.splice(idx, 1)
    return null
  }
  return entry.data
}

function memSet(key, data) {
  if (memCache.has(key)) {
    const idx = memOrder.indexOf(key)
    if (idx !== -1) memOrder.splice(idx, 1)
  }
  if (memCache.size >= MEM_MAX) {
    const oldest = memOrder.shift()
    memCache.delete(oldest)
  }
  memCache.set(key, { data, expiresAt: Date.now() + MEM_TTL_MS })
  memOrder.push(key)
}

export function generateHash(body) {
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

export function getCache(queryHash) {
  const fromMem = memGet(queryHash)
  if (fromMem) {
    dbRun('UPDATE cache SET hit_count = hit_count + 1 WHERE id = ?', [fromMem.id])
    return fromMem
  }

  const entry = dbGet(
    `SELECT * FROM cache
     WHERE query_hash = ? AND (expires_at IS NULL OR expires_at > datetime('now'))`,
    [queryHash]
  )

  if (entry) {
    memSet(queryHash, entry)
    dbRun('UPDATE cache SET hit_count = hit_count + 1 WHERE id = ?', [entry.id])
    return entry
  }

  return null
}

export function setCache(endpoint, requestBody, responseBody, providerId) {
  const id = uuidv4()
  const queryHash = generateHash(requestBody)
  const expiresAt = new Date(Date.now() + config.cache.ttlSeconds * 1000).toISOString()

  const entry = { id, query_hash: queryHash, endpoint, request_body: JSON.stringify(requestBody), response_body: JSON.stringify(responseBody), provider_id: providerId, expires_at: expiresAt }
  memSet(queryHash, entry)

  dbRun(
    `INSERT OR REPLACE INTO cache (id, query_hash, endpoint, request_body, response_body, provider_id, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, queryHash, endpoint, JSON.stringify(requestBody), JSON.stringify(responseBody), providerId, expiresAt]
  )
}

export function cleanExpiredCache() {
  const now = Date.now()
  for (const [key, entry] of memCache) {
    if (now > entry.expiresAt) memCache.delete(key)
  }
  const result = dbRun("DELETE FROM cache WHERE expires_at < datetime('now')")
  return result.changes
}

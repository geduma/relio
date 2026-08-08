import crypto from 'crypto'
import { dbGet, dbRun } from '../db.js'
import { config } from '../config.js'

const MEM_MAX = 1000
const memCache = new Map()
const memOrder = []
const HIT_QUEUE_BATCH = 200
const HIT_FLUSH_MS = 1000
let hitQueue = []
let hitTimer = null

function memDelete(key) {
  memCache.delete(key)
  const idx = memOrder.indexOf(key)
  if (idx !== -1) memOrder.splice(idx, 1)
}

function memGet(key) {
  const entry = memCache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    memDelete(key)
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
  memCache.set(key, { data, expiresAt: Date.now() + Math.max(0, config.cache.ttlSeconds * 1000) })
  memOrder.push(key)
}

function flushHits() {
  if (hitQueue.length === 0) return
  const batch = hitQueue
  hitQueue = []
  for (const id of batch) {
    dbRun('UPDATE cache SET hit_count = hit_count + 1 WHERE id = ?', [id])
  }
}

function enqueueHit(id) {
  hitQueue.push(id)
  if (hitQueue.length >= HIT_QUEUE_BATCH) flushHits()
}

export function startCacheFlushTimer(intervalMs = HIT_FLUSH_MS) {
  if (hitTimer) return
  hitTimer = setInterval(flushHits, intervalMs)
  if (hitTimer.unref) hitTimer.unref()
}

export function flushCacheHits() {
  flushHits()
}

export function generateHash(body) {
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

export function getCache(endpoint, queryHash) {
  const memKey = `${endpoint}:${queryHash}`
  const fromMem = memGet(memKey)
  if (fromMem) {
    enqueueHit(fromMem.id)
    return fromMem
  }

  const entry = dbGet(
    `SELECT * FROM cache
     WHERE endpoint = ? AND query_hash = ? AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))`,
    [endpoint, queryHash]
  )

  if (entry) {
    memSet(memKey, entry)
    enqueueHit(entry.id)
    return entry
  }

  return null
}

export function setCache(endpoint, requestBody, responseBody, providerId) {
  const id = crypto.randomUUID()
  const queryHash = generateHash(requestBody)
  const expiresAt = new Date(Date.now() + config.cache.ttlSeconds * 1000).toISOString()

  const entry = { id, query_hash: queryHash, endpoint, request_body: JSON.stringify(requestBody), response_body: JSON.stringify(responseBody), provider_id: providerId, expires_at: expiresAt }
  memSet(`${endpoint}:${queryHash}`, entry)

  dbRun(
    `INSERT OR REPLACE INTO cache (id, query_hash, endpoint, request_body, response_body, provider_id, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, queryHash, endpoint, JSON.stringify(requestBody), JSON.stringify(responseBody), providerId, expiresAt]
  )
}

export function cleanExpiredCache() {
  const now = Date.now()
  for (const [key, entry] of memCache) {
    if (now > entry.expiresAt) memDelete(key)
  }
  const result = dbRun("DELETE FROM cache WHERE expires_at IS NOT NULL AND julianday(expires_at) < julianday('now')")
  return result.changes
}

import crypto from 'crypto'
import { v4 as uuidv4 } from 'uuid'
import { dbGet, dbRun } from '../db.js'
import { config } from '../config.js'

export function generateHash(body) {
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

export function getCache(queryHash) {
  const entry = dbGet(
    `SELECT * FROM cache
     WHERE query_hash = ? AND (expires_at IS NULL OR expires_at > datetime('now'))`,
    [queryHash]
  )

  if (entry) {
    dbRun('UPDATE cache SET hit_count = hit_count + 1 WHERE id = ?', [entry.id])
    return entry
  }

  return null
}

export function setCache(endpoint, requestBody, responseBody) {
  const id = uuidv4()
  const queryHash = generateHash(requestBody)
  const expiresAt = new Date(Date.now() + config.cache.ttlSeconds * 1000).toISOString()

  dbRun(
    `INSERT OR REPLACE INTO cache (id, query_hash, endpoint, request_body, response_body, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, queryHash, endpoint, JSON.stringify(requestBody), JSON.stringify(responseBody), expiresAt]
  )
}

export function cleanExpiredCache() {
  const result = dbRun("DELETE FROM cache WHERE expires_at < datetime('now')")
  return result.changes
}

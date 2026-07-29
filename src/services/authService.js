import { v4 as uuidv4 } from 'uuid'
import { dbAll, dbGet, dbRun } from '../db.js'
import { getAuthProvider } from '../auth/index.js'
import { enqueueApiKeyTouch } from './logQueue.js'

const API_KEY_CACHE_TTL = 300_000
const SESSION_CACHE_TTL = 60_000
const apiKeyCache = new Map()
const sessionCache = new Map()

export async function login(credentials) {
  const provider = await getAuthProvider()
  return provider.login(credentials)
}

export async function logout(sessionId) {
  sessionCache.delete(sessionId)
  const provider = await getAuthProvider()
  return provider.logout(sessionId)
}

export async function getSession(sessionId) {
  const cached = sessionCache.get(sessionId)
  if (cached && Date.now() < cached.expiresAt) return cached.data

  const provider = await getAuthProvider()
  const session = await provider.getSession(sessionId)
  if (session) {
    sessionCache.set(sessionId, { data: session, expiresAt: Date.now() + SESSION_CACHE_TTL })
  }
  return session || null
}

export async function getLoginConfig() {
  const provider = await getAuthProvider()
  return provider.getLoginConfig()
}

export async function initiateLogin(credentials) {
  const provider = await getAuthProvider()
  return provider.initiateLogin(credentials)
}

export async function getLoginView() {
  const provider = await getAuthProvider()
  return provider.loginView
}

export async function autoLogin() {
  const provider = await getAuthProvider()
  return provider.login({})
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

  const row = dbGet('SELECT * FROM api_keys WHERE key = ?', [key])
  if (row) {
    apiKeyCache.set(key, { id: row.id, row, expiresAt: Date.now() + API_KEY_CACHE_TTL })
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
    if (entry.id === id) apiKeyCache.delete(key)
  }
  const result = dbRun('DELETE FROM api_keys WHERE id = ?', [id])
  return result.changes > 0
}

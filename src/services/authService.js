import { v4 as uuidv4 } from 'uuid'
import { dbAll, dbGet, dbRun } from '../db.js'
import { getAuthProvider } from '../auth/index.js'

export async function login(credentials) {
  const provider = await getAuthProvider()
  return provider.login(credentials)
}

export async function logout(sessionId) {
  const provider = await getAuthProvider()
  return provider.logout(sessionId)
}

export async function getSession(sessionId) {
  const provider = await getAuthProvider()
  return provider.getSession(sessionId)
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
  const row = dbGet('SELECT * FROM api_keys WHERE key = ?', [key])
  if (row) {
    dbRun('UPDATE api_keys SET last_used_at = datetime(\'now\') WHERE id = ?', [row.id])
  }
  return row || null
}

export function listApiKeys() {
  const rows = dbAll(
    'SELECT id, key, name, created_at, last_used_at FROM api_keys ORDER BY created_at DESC'
  )
  return rows.map(r => ({
    id: r.id,
    key_preview: r.key.slice(0, 10) + '...' + r.key.slice(-6),
    name: r.name,
    created_at: r.created_at,
    last_used_at: r.last_used_at,
  }))
}

export function revokeApiKey(keyPreview) {
  const result = dbRun(
    'DELETE FROM api_keys WHERE key LIKE ?',
    [`${keyPreview.slice(0, 10)}%`]
  )
  return result.changes > 0
}

import { v4 as uuidv4 } from 'uuid'
import crypto from 'crypto'
import { dbAll, dbGet, dbRun } from '../db.js'
import { login as gedumaLogin } from '../external/gedumaClient.js'

const SESSION_DURATION_MS = 24 * 60 * 60 * 1000 // 24h

function hash(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export async function loginWithGeduma(provider, code) {
  const data = await gedumaLogin(provider, code)

  const sessionId = uuidv4()
  const tokenHash = hash(data.token)
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString()


  dbRun(
    `INSERT INTO sessions (id, token_hash, user_email, user_name, user_avatar, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [sessionId, tokenHash, data.user.email, data.user.name, data.user.avatar, expiresAt]
  )

  dbRun(
    `INSERT INTO login_history (id, email, method, provider, status)
     VALUES (?, ?, ?, ?, ?)`,
    [uuidv4(), data.user.email, 'geduma_oauth', provider, 'success']
  )

  return { sessionId, user: data.user }
}

export function logout(sessionId) {

  const session = dbGet('SELECT * FROM sessions WHERE id = ?', [sessionId])
  if (session) {
    dbRun('DELETE FROM sessions WHERE id = ?', [sessionId])
    dbRun(
      `INSERT INTO login_history (id, email, method, provider, status)
       VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), session.user_email, 'logout', null, 'success']
    )
  }
}

export function getSession(sessionId) {

  const session = dbGet(
    `SELECT * FROM sessions WHERE id = ? AND expires_at > datetime('now')`,
    [sessionId]
  )
  return session || null
}

export function createApiKey(name) {

  const key = `llm_pk_${uuidv4().replace(/-/g, '')}${uuidv4().replace(/-/g, '')}`
  const id = uuidv4()
  dbRun('INSERT INTO api_keys (id, key, name) VALUES (?, ?, ?)', [id, key, name])
  return key
}

export function validateApiKey(key) {

  const row = dbGet(
    `SELECT * FROM api_keys WHERE key = ? AND revoked = 0`,
    [key]
  )
  if (row) {
    dbRun('UPDATE api_keys SET last_used_at = datetime(\'now\') WHERE id = ?', [row.id])
  }
  return row || null
}

export function listApiKeys() {

  const rows = dbAll(
    `SELECT id, key, name, created_at, last_used_at, revoked FROM api_keys ORDER BY created_at DESC`
  )
  return rows.map(r => ({
    id: r.id,
    key_preview: r.key.slice(0, 10) + '...' + r.key.slice(-6),
    name: r.name,
    created_at: r.created_at,
    last_used_at: r.last_used_at,
    revoked: !!r.revoked,
  }))
}

export function revokeApiKey(keyPreview) {

  const result = dbRun(
    `UPDATE api_keys SET revoked = 1, revoked_at = datetime('now')
     WHERE key LIKE ? AND revoked = 0`,
    [`${keyPreview.slice(0, 10)}%`]
  )
  return result.changes > 0
}

import { v4 as uuidv4 } from 'uuid'
import crypto from 'crypto'
import { dbRun, dbGet } from '../db.js'
import { config } from '../config.js'
import AuthProvider from './base.js'

const SESSION_DURATION_MS = 24 * 60 * 60 * 1000

function hash(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function gedumaHeaders(extraToken) {
  return {
    'Authorization': `Bearer ${extraToken || config.geduma.apiToken}`,
    'Content-Type': 'application/json',
  }
}

async function gedumaFetch(path, options = {}) {
  const url = `${config.geduma.apiUrl}${path}`
  const res = await fetch(url, {
    headers: gedumaHeaders(options.token),
    ...options,
  })
  if (!res.ok) {
    throw new Error(`Geduma request failed (${res.status}): ${path}`)
  }
  return res.json()
}

export default class GedumaAuthProvider extends AuthProvider {
  static get type() { return 'geduma' }

  get loginView() { return 'oauth' }

  async getLoginConfig() {
    const data = await gedumaFetch('/api/auth/providers')
    const providers = (data.providers || []).map(p => ({
      ...p,
      oauth_url: `${config.geduma.apiUrl}/oauth/${p.id}?redirect=${encodeURIComponent(`${config.server.baseUrl}/admin/api/auth/callback?provider=${p.id}`)}`,
    }))
    return { providers }
  }

  async login({ provider, code }) {
    const data = await gedumaFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ provider, code }),
      token: config.geduma.apiToken,
    })

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

  async logout(sessionId) {
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

  async getSession(sessionId) {
    const session = dbGet(
      `SELECT * FROM sessions WHERE id = ? AND expires_at > datetime('now')`,
      [sessionId]
    )
    return session || null
  }
}

import { v4 as uuidv4 } from 'uuid'
import crypto from 'crypto'
import { dbRun, dbGet } from '../db.js'
import { config } from '../config.js'
import AuthProvider from './base.js'

const SESSION_DURATION_MS = 24 * 60 * 60 * 1000

function hash(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

async function gedumaFetch(path, options = {}) {
  const url = `${config.geduma.apiUrl}${path}`
  const res = await fetch(url, options)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Geduma request failed (${res.status}): ${path} — ${text}`)
  }
  return res.json()
}

export default class GedumaAuthProvider extends AuthProvider {
  static get type() { return 'geduma' }

  get loginView() { return 'oauth' }

  async getLoginConfig() {
    const data = await gedumaFetch(`/auth/providers/${config.geduma.appId}`)
    const providers = (data.data || []).map(p => ({
      id: p.providerId,
      name: p.displayName || p.name,
      icon: p.icon || null,
      providerId: p.providerId,
    }))
    return { providers }
  }

  async initiateLogin({ provider }) {
    const data = await gedumaFetch(`/auth/login/${config.geduma.appId}/${provider}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    return { redirect: data.data.redirect }
  }

  async login({ sessionToken }) {
    const data = await gedumaFetch(`/auth/session/${sessionToken}`)

    const sessionId = uuidv4()
    const tokenHash = hash(sessionToken)
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString()

    dbRun(
      `INSERT INTO sessions (id, token_hash, user_email, user_name, user_avatar, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [sessionId, tokenHash, data.data.email, data.data.displayName, data.data.picture, expiresAt]
    )

    dbRun(
      `INSERT INTO login_history (id, email, method, provider, status)
       VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), data.data.email, 'geduma_oauth', data.data.provider, 'success']
    )

    return {
      sessionId,
      user: {
        email: data.data.email,
        name: data.data.displayName,
        avatar: data.data.picture,
      },
    }
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

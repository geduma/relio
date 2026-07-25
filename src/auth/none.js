import { v4 as uuidv4 } from 'uuid'
import { dbRun, dbGet } from '../db.js'
import AuthProvider from './base.js'

const SESSION_DURATION_MS = 24 * 60 * 60 * 1000

export default class NoneAuthProvider extends AuthProvider {
  static get type() { return 'none' }

  get loginView() { return 'none' }

  async getLoginConfig() {
    return { providers: [] }
  }

  async login() {
    const sessionId = uuidv4()
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString()

    dbRun(
      `INSERT INTO sessions (id, token_hash, user_email, user_name, user_avatar, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [sessionId, 'anonymous', 'anonymous@local', 'Anonymous User', null, expiresAt]
    )

    dbRun(
      `INSERT INTO login_history (id, email, method, provider, status)
       VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), 'anonymous@local', 'none', 'local', 'success']
    )

    return { sessionId, user: { email: 'anonymous@local', name: 'Anonymous User', avatar: null } }
  }

  async logout(sessionId) {
    const session = dbGet('SELECT * FROM sessions WHERE id = ?', [sessionId])
    if (session) {
      dbRun('DELETE FROM sessions WHERE id = ?', [sessionId])
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

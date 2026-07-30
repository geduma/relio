import { getSession, validateApiKey } from '../services/authService.js'
import { config } from '../config.js'

export function requireDashboardSession(req, res, next) {
  if (config.auth?.trustedProxy) {
    const email = req.headers['x-user-email']
    const name = req.headers['x-user-name'] || email
    if (email) {
      req.user = { email, name, avatar: null }
      return next()
    }
  }

  const sessionId = req.cookies?.relio_session
  if (!sessionId) {
    return res.status(401).json({ error: 'Not authenticated' })
  }

  const session = getSession(sessionId)
  if (!session) {
    return res.status(401).json({ error: 'Session expired or invalid' })
  }

  req.user = {
    email: session.user_email,
    name: session.user_name,
    avatar: session.user_avatar,
  }
  next()
}

export function requireApiKey(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' })
  }

  const key = authHeader.slice(7)
  const apiKey = validateApiKey(key)
  if (!apiKey) {
    return res.status(403).json({ error: 'Invalid or revoked API key' })
  }

  req.apiKey = apiKey
  next()
}

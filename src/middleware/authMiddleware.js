import { validateApiKey } from '../services/authService.js'

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

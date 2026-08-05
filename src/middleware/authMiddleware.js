import { validateApiKey, isValidApiKeyFormat } from '../services/authService.js'
import { normalizeError } from '../utils/logger.js'

export function requireApiKey(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const err = new Error('Missing or invalid Authorization header')
    err.status = 401
    return res.status(401).json(normalizeError(err))
  }

  const key = authHeader.slice(7)
  if (!isValidApiKeyFormat(key)) {
    const err = new Error('Invalid API key')
    err.status = 403
    return res.status(403).json(normalizeError(err))
  }
  const apiKey = validateApiKey(key)
  if (!apiKey) {
    const err = new Error('Invalid or revoked API key')
    err.status = 403
    return res.status(403).json(normalizeError(err))
  }

  req.apiKey = apiKey
  next()
}

import { Router } from 'express'
import { dbGet, dbAll } from '../db.js'
import { requireDashboardSession } from '../middleware/authMiddleware.js'
import { callProvider } from '../services/failoverEngine.js'
import { processRequest } from '../handlers/requestHandler.js'
import { logger } from '../utils/logger.js'

const router = Router()

router.use(requireDashboardSession)

router.post('/send', async (req, res) => {
  const { provider_id, messages, use_proxy } = req.body
  const start = Date.now()

  if (!provider_id || !messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'provider_id and messages array are required' })
  }

  function addTime(data) {
    return { ...data, response_time_ms: Date.now() - start }
  }

  if (use_proxy) {
    try {
      const model = req.body.model || dbGet('SELECT model FROM providers WHERE id = ?', [provider_id])?.model
      const result = await processRequest({
        endpoint: '/v1/chat/completions',
        requestBody: { messages, model },
        originIp: req.ip,
        originHeader: req.headers['user-agent'],
        authenticatedVia: 'dashboard_chat',
        apiKey: null,
      })
      return res.status(result.statusCode).json(addTime(result.body))
    } catch (err) {
      return res.status(503).json(addTime({ error: err.message }))
    }
  }

  const provider = dbGet('SELECT * FROM providers WHERE id = ?', [provider_id])
  if (!provider) {
    return res.status(404).json(addTime({ error: 'Provider not found' }))
  }

  try {
    const data = await callProvider(provider, { messages, model: req.body.model || provider.model }, null)
    res.json(addTime(data))
  } catch (err) {
    logger.warn('Chat test failed', { provider_id, error: err.message })
    res.status(err.status || 503).json(addTime({ error: err.message, details: err.data || null }))
  }
})

router.get('/providers', (req, res) => {
  const rows = dbAll(
    "SELECT id, name, model, api_url FROM providers WHERE type = 'chat' ORDER BY order_position ASC"
  )
  res.json(rows)
})

export default router

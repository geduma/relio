import { Router } from 'express'
import { dbGet, dbAll } from '../db.js'
import { requireDashboardSession } from '../middleware/authMiddleware.js'
import { callProvider, getProvider } from '../services/failoverEngine.js'
import { processRequest } from '../handlers/requestHandler.js'
import { enqueueLog, enqueueMetric } from '../services/logQueue.js'
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
      const result = await processRequest({
        endpoint: '/v1/chat/completions',
        requestBody: { messages },
        originIp: req.ip,
        originHeader: req.headers['user-agent'],
        authenticatedVia: 'dashboard_chat',
        apiKey: null,
        providerId: null,
      })
      return res.status(result.statusCode).json(addTime(result.body))
    } catch (err) {
      return res.status(err.status || 503).json(addTime({ error: err.message, details: err.data || null }))
    }
  }

  const provider = getProvider(provider_id)
  if (!provider) {
    return res.status(404).json(addTime({ error: 'Provider not found' }))
  }

  try {
    const data = await callProvider(provider, { messages, model: req.body.model || provider.model }, null)
    const responseTimeMs = Date.now() - start
    const inputTokens = data.usage?.prompt_tokens || 0
    const outputTokens = data.usage?.completion_tokens || 0
    const estimatedCost = (inputTokens * provider.cost_per_input_token) + (outputTokens * provider.cost_per_output_token)

    enqueueLog({
      providerId: provider.id, endpoint: '/admin/api/chat/send', requestBody: req.body,
      originIp: req.ip, originHeader: req.headers['user-agent'],
      statusCode: 200, responseBody: data,
      inputTokens, outputTokens, estimatedCost,
      responseTimeMs, authenticatedVia: 'dashboard_chat', cacheHit: false, retryCount: 0,
    })

    enqueueMetric(provider.id, { inputTokens, outputTokens, cost: estimatedCost, responseTimeMs, cacheHit: false })

    res.json(addTime({ ...data, _provider: { id: provider.id, name: provider.name, model: provider.model } }))
  } catch (err) {
    const responseTimeMs = Date.now() - start
    logger.warn('Chat test failed', { provider_id, error: err.message })

    enqueueLog({
      providerId: provider.id, endpoint: '/admin/api/chat/send', requestBody: req.body,
      originIp: req.ip, originHeader: req.headers['user-agent'],
      statusCode: err.status || 503, errorMessage: err.message,
      responseTimeMs, authenticatedVia: 'dashboard_chat', cacheHit: false, wasRetry: false, retryCount: 0,
    })

    enqueueMetric(provider.id, { error: true, responseTimeMs })

    res.status(err.status || 503).json(addTime({ error: err.message, details: err.data || null }))
  }
})

router.get('/providers', (req, res) => {
  const rows = dbAll(
    "SELECT id, name, model, api_url, provider_type FROM providers WHERE capability = 'chat' ORDER BY order_position ASC"
  )
  res.json(rows)
})

export default router

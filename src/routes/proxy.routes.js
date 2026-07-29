import { Router } from 'express'
import { requireApiKey } from '../middleware/authMiddleware.js'
import { streamProvider, selectProviders, getProvider } from '../services/failoverEngine.js'
import { processRequest } from '../handlers/requestHandler.js'
import { recordSuccess } from '../services/circuitBreaker.js'
import { enqueueLog, enqueueMetric } from '../services/logQueue.js'
import { pipeline } from 'stream/promises'

const router = Router()

router.use(requireApiKey)

router.post('/chat/completions', async (req, res) => {
  if (req.body.stream) {
    return handleStreamingRequest(req, res)
  }

  try {
    const result = await processRequest({
      endpoint: '/v1/chat/completions',
      requestBody: req.body,
      originIp: req.ip,
      originHeader: req.headers['user-agent'],
      authenticatedVia: 'api_key',
      apiKey: req.apiKey,
    })
    res.status(result.statusCode).json(result.body)
  } catch (err) {
    res.status(err.status || 503).json({ error: err.message })
  }
})

router.post('/embeddings', async (req, res) => {
  try {
    const result = await processRequest({
      endpoint: '/v1/embeddings',
      requestBody: req.body,
      originIp: req.ip,
      originHeader: req.headers['user-agent'],
      authenticatedVia: 'api_key',
      apiKey: req.apiKey,
    })
    res.status(result.statusCode).json(result.body)
  } catch (err) {
    res.status(err.status || 503).json({ error: err.message })
  }
})

async function handleStreamingRequest(req, res) {
  const startTime = Date.now()
  const controller = new AbortController()

  req.on('close', () => controller.abort())

  try {
    const providerId = req.query.provider_id || req.body.provider_id

    let provider
    if (providerId) {
      provider = getProvider(providerId)
    } else {
      const providers = selectProviders('chat')
      provider = providers[0]
    }

    if (!provider) {
      res.status(404).json({ error: 'No available provider for streaming' })
      return
    }

    const stream = await streamProvider(provider, req.body, controller.signal)

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    await pipeline(stream, res)

    recordSuccess(provider.id)
    enqueueLog({
      providerId: provider.id, endpoint: '/v1/chat/completions', requestBody: req.body,
      originIp: req.ip, originHeader: req.headers['user-agent'],
      statusCode: 200, responseBody: { stream: true },
      responseTimeMs: Date.now() - startTime,
      authenticatedVia: 'api_key', cacheHit: false, retryCount: 0,
    })
    enqueueMetric(provider.id, {
      responseTimeMs: Date.now() - startTime, cacheHit: false,
    })
  } catch (err) {
    if (res.headersSent) return
    res.status(err.status || 503).json({ error: err.message })
  }
}

export default router

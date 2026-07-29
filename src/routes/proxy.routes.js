import { Router } from 'express'
import { requireApiKey } from '../middleware/authMiddleware.js'
import { streamProvider } from '../services/failoverEngine.js'
import { processRequest } from '../handlers/requestHandler.js'

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

  try {
    const { dbGet } = await import('../db.js')
    const { selectProviders } = await import('../services/failoverEngine.js')
    const providerId = req.query.provider_id || req.body.provider_id

    let provider
    if (providerId) {
      provider = dbGet('SELECT * FROM providers WHERE id = ?', [providerId])
    } else {
      const providers = selectProviders('chat')
      provider = providers[0]
    }

    if (!provider) {
      res.status(404).json({ error: 'No available provider for streaming' })
      return
    }

    const controller = new AbortController()
    req.on('close', () => controller.abort())

    const stream = await streamProvider(provider, req.body, controller.signal)

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const reader = stream.getReader ? stream.getReader() : null

    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(value)
        }
      } catch (err) {
        if (!res.headersSent) {
          res.status(503).json({ error: err.message })
        }
      }
    } else {
      stream.pipe(res)
    }

    req.on('close', () => {
      controller.abort()
    })

    const { recordSuccess } = await import('../services/circuitBreaker.js')
    const { enqueueLog, enqueueMetric } = await import('../services/logQueue.js')
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

    res.end()
  } catch (err) {
    if (!res.headersSent) {
      res.status(err.status || 503).json({ error: err.message })
    } else {
      res.write(`data: {"error":"${err.message}"}\n\n`)
      res.end()
    }
  }
}

export default router

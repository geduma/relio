import { Router } from 'express'
import { requireApiKey } from '../middleware/authMiddleware.js'
import { streamProvider, selectProviders, listModels, parseModelSelector, stripModel, isProviderAvailable, FAILOVER_MODEL } from '../services/failoverEngine.js'
import { processRequest } from '../handlers/requestHandler.js'
import { recordSuccess } from '../services/circuitBreaker.js'
import { enqueueLog, enqueueMetric } from '../services/logQueue.js'
import { pipeline } from 'stream/promises'
import { normalizeError } from '../utils/logger.js'

const router = Router()

router.use(requireApiKey)

function selectorError(selection, model) {
  const message = selection.error === 'missing'
    ? `model is required. Use a provider name/ID or "${FAILOVER_MODEL}".`
    : `Unknown provider "${model}". Use a provider name/ID or "${FAILOVER_MODEL}".`
  return { error: { message, type: 'invalid_request_error', code: 'unknown_provider' } }
}

function selectionProviderId(selection) {
  return selection.mode === 'provider' ? selection.provider.id : null
}

router.get('/models', async (_req, res) => {
  try {
    const providers = selectProviders('chat')
    const allModels = []
    for (const p of providers) {
      try {
        const models = await listModels(p)
        allModels.push(...models)
      } catch (err) {
        console.warn(`[proxy] Models endpoint failed for ${p.name}: ${err.message}`)
      }
    }
    res.json({ object: 'list', data: allModels })
  } catch (err) {
    res.status(503).json(normalizeError(Object.assign(err, { status: 503 })))
  }
})

router.post('/chat/completions', async (req, res) => {
  if (req.body.stream) {
    return handleStreamingRequest(req, res)
  }

  const selection = parseModelSelector(req.body.model, 'chat')
  if (selection.error) {
    return res.status(400).json(selectorError(selection, req.body.model))
  }

  try {
    const result = await processRequest({
      endpoint: '/v1/chat/completions',
      requestBody: stripModel(req.body),
      originIp: req.ip,
      originHeader: req.headers['user-agent'],
      authenticatedVia: 'api_key',
      apiKey: req.apiKey,
      providerId: selectionProviderId(selection),
    })
    res.status(result.statusCode).json(result.body)
  } catch (err) {
    res.status(err.status || 503).json(normalizeError(err))
  }
})

router.post('/embeddings', async (req, res) => {
  const selection = parseModelSelector(req.body.model, 'embeddings')
  if (selection.error) {
    return res.status(400).json(selectorError(selection, req.body.model))
  }

  try {
    const result = await processRequest({
      endpoint: '/v1/embeddings',
      requestBody: stripModel(req.body),
      originIp: req.ip,
      originHeader: req.headers['user-agent'],
      authenticatedVia: 'api_key',
      apiKey: req.apiKey,
      providerId: selectionProviderId(selection),
    })
    res.status(result.statusCode).json(result.body)
  } catch (err) {
    res.status(err.status || 503).json(normalizeError(err))
  }
})

async function handleStreamingRequest(req, res) {
  const startTime = Date.now()
  const controller = new AbortController()

  req.on('close', () => controller.abort())

  const selection = parseModelSelector(req.body.model, 'chat')
  if (selection.error) {
    res.status(400).json(selectorError(selection, req.body.model))
    return
  }

  try {
    let provider
    if (selection.mode === 'provider') {
      if (!isProviderAvailable(selection.provider)) {
        res.status(503).json(normalizeError(Object.assign(new Error(`Provider "${selection.provider.name}" is paused or in cooldown`), { status: 503 })))
        return
      }
      provider = selection.provider
    } else {
      const providers = selectProviders('chat')
      provider = providers[0]
    }

    if (!provider) {
      res.status(404).json(normalizeError(Object.assign(new Error('No available provider for streaming'), { status: 404 })))
      return
    }

    const stream = await streamProvider(provider, stripModel(req.body), controller.signal)

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
    res.status(err.status || 503).json(normalizeError(err))
  }
}

export default router

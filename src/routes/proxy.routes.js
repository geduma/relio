import { Router } from 'express'
import { requireApiKey } from '../middleware/authMiddleware.js'
import { streamProvider, selectProviders, parseModelSelector, stripModel, isProviderAvailable, isRateLimitExceeded, isDailyLimitExceeded, isRetryableError, recordProviderRequest, FAILOVER_MODEL, orderProvidersForRouting } from '../services/failoverEngine.js'
import { processRequest } from '../handlers/requestHandler.js'
import { recordSuccess, recordFailure } from '../services/circuitBreaker.js'
import { enqueueLog, enqueueMetric } from '../services/logQueue.js'
import { pipeline } from 'stream/promises'
import { normalizeError } from '../utils/logger.js'
import { config } from '../config.js'

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

const MODELS_CACHE_TTL_MS = 60_000
const modelsCache = new Map()

export function invalidateModelsCache() {
  modelsCache.clear()
}

const PROVIDER_ACCESS_DENIED = {
  error: { message: 'API key does not have access to this provider', type: 'invalid_request_error', code: 'provider_access_denied' },
}

function createdUnix(value) {
  if (!value) return 0
  const ts = Date.parse(String(value).replace(' ', 'T') + 'Z')
  return Number.isNaN(ts) ? 0 : Math.floor(ts / 1000)
}

router.get('/models', (req, res) => {
  try {
    const allowed = req.apiKey.allowedProviderIds || []
    const cacheKey = req.apiKey.id
    const cached = modelsCache.get(cacheKey)
    if (cached && Date.now() - cached.at < MODELS_CACHE_TTL_MS) {
      return res.json(cached.body)
    }

    const providers = [
      ...selectProviders('chat', allowed),
      ...selectProviders('embeddings', allowed),
    ].filter(p => p.name !== FAILOVER_MODEL)
      .filter((p, i, all) => all.findIndex(x => x.name === p.name) === i)

    const body = {
      object: 'list',
      data: [
        ...(allowed.length > 0 ? [{ id: FAILOVER_MODEL, object: 'model', created: 0, owned_by: 'relio' }] : []),
        ...providers.map(p => ({
          id: p.name,
          object: 'model',
          created: createdUnix(p.created_at),
          owned_by: 'relio',
        })),
      ],
    }
    modelsCache.set(cacheKey, { at: Date.now(), body })
    res.json(body)
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
      providerId: selectionProviderId(selection),
      allowedProviderIds: req.apiKey.allowedProviderIds,
      requester: { name: req.apiKey.name, keyPrefix: req.apiKey.key_prefix },
    })
    res.status(result.statusCode).json(result.body)
  } catch (err) {
    if (err.code === 'provider_access_denied') {
      return res.status(403).json(PROVIDER_ACCESS_DENIED)
    }
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
      providerId: selectionProviderId(selection),
      allowedProviderIds: req.apiKey.allowedProviderIds,
      requester: { name: req.apiKey.name, keyPrefix: req.apiKey.key_prefix },
    })
    res.status(result.statusCode).json(result.body)
  } catch (err) {
    if (err.code === 'provider_access_denied') {
      return res.status(403).json(PROVIDER_ACCESS_DENIED)
    }
    res.status(err.status || 503).json(normalizeError(err))
  }
})

async function handleStreamingRequest(req, res) {
  const startTime = Date.now()
  const controller = new AbortController()

  res.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })

  const selection = parseModelSelector(req.body.model, 'chat')
  if (selection.error) {
    res.status(400).json(selectorError(selection, req.body.model))
    return
  }

  let provider
  if (selection.mode === 'provider') {
    if (!req.apiKey.allowedProviderIds.includes(selection.provider.id)) {
      res.status(403).json(PROVIDER_ACCESS_DENIED)
      return
    }
    if (!isProviderAvailable(selection.provider)) {
      res.status(503).json(normalizeError(Object.assign(new Error(`Provider "${selection.provider.name}" is paused or in cooldown`), { status: 503 })))
      return
    }
    if (isRateLimitExceeded(selection.provider) || isDailyLimitExceeded(selection.provider)) {
      res.status(503).json(normalizeError(Object.assign(new Error(`Provider "${selection.provider.name}" has reached its rate or daily limit`), { status: 503 })))
      return
    }
    provider = selection.provider
  } else {
    const providers = orderProvidersForRouting(selectProviders('chat', req.apiKey.allowedProviderIds))
    for (const p of providers) {
      if (!isProviderAvailable(p)) continue
      if (isRateLimitExceeded(p)) continue
      if (isDailyLimitExceeded(p)) continue
      provider = p
      break
    }
  }

  if (!provider) {
    res.status(404).json(normalizeError(Object.assign(new Error('No available provider for streaming'), { status: 404 })))
    return
  }

  const maxDurationMs = config.relay.streamTimeoutSeconds * 1000
  const idleMs = config.relay.streamIdleTimeoutMs

  let idleTimer = null
  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
  }
  const resetIdle = () => {
    clearIdle()
    idleTimer = setTimeout(() => controller.abort(), idleMs)
    if (idleTimer.unref) idleTimer.unref()
  }
  const durationTimer = setTimeout(() => controller.abort(), maxDurationMs)
  if (durationTimer.unref) durationTimer.unref()

  try {
    recordProviderRequest(provider.id)
    const stream = await streamProvider(provider, stripModel(req.body), controller.signal)

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    resetIdle()
    stream.on('data', resetIdle)

    await pipeline(stream, res)

    clearIdle()
    clearTimeout(durationTimer)

    recordSuccess(provider.id)
    enqueueLog({
      providerId: provider.id, providerName: provider.name, endpoint: '/v1/chat/completions', requestBody: req.body,
      originIp: req.ip, originHeader: req.headers['user-agent'],
      statusCode: 200, responseBody: { stream: true },
      responseTimeMs: Date.now() - startTime,
      authenticatedVia: 'api_key',
      requesterName: req.apiKey.name, requesterKey: req.apiKey.key_prefix,
      cacheHit: false, retryCount: 0,
    })
    enqueueMetric(provider.id, {
      responseTimeMs: Date.now() - startTime, cacheHit: false,
    })
  } catch (err) {
    clearIdle()
    clearTimeout(durationTimer)
    if (res.headersSent) return

    enqueueLog({
      providerId: provider.id, providerName: provider.name, endpoint: '/v1/chat/completions', requestBody: req.body,
      originIp: req.ip, originHeader: req.headers['user-agent'],
      statusCode: err.status || 503, errorMessage: err.message,
      responseTimeMs: Date.now() - startTime,
      authenticatedVia: 'api_key',
      requesterName: req.apiKey.name, requesterKey: req.apiKey.key_prefix,
      cacheHit: false, retryCount: 0,
    })
    enqueueMetric(provider.id, {
      error: true, responseTimeMs: Date.now() - startTime,
    })

    if (isRetryableError(err)) {
      recordFailure(provider.id, provider.cooldown_after_failures, provider.cooldown_duration_seconds)
    }
    res.status(err.status || 503).json(normalizeError(err))
  }
}

export default router

import { Router } from 'express'
import { requireApiKey } from '../middleware/authMiddleware.js'
import { streamProvider, selectProviders, parseModelSelector, stripModel, isProviderAvailable, isRateLimitExceeded, isDailyLimitExceeded, classifyProviderError, extractRetryAfter, recordProviderRequest, FAILOVER_MODEL, orderProvidersForRouting } from '../services/failoverEngine.js'
import { processRequest, optimizeRelayBody } from '../handlers/requestHandler.js'
import { recordSuccess, recordFailure, recordProviderFailure } from '../services/circuitBreaker.js'
import { enqueueLog, enqueueMetric } from '../services/logQueue.js'
import { createStreamSession, ABORT_REASONS } from '../services/streamSession.js'
import { describeStreamError, resolveStreamAbortReason } from '../utils/streamErrors.js'
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

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
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

  const optimized = optimizeRelayBody(req.body)
  const requestBody = optimized.body
  const tokensSavedEstimate = optimized.tokensSavedEstimate

  const session = createStreamSession(res, {
    idleMs: config.relay.streamIdleTimeoutMs,
    maxDurationMs: config.relay.streamTimeoutSeconds * 1000,
    keepAliveMs: config.relay.streamKeepAliveMs || 0,
    startTime,
    sseHeaders: SSE_HEADERS,
  })

  const selection = parseModelSelector(req.body.model, 'chat')
  if (selection.error) {
    session.dispose()
    res.status(400).json(selectorError(selection, req.body.model))
    return
  }

  const logError = (provider, statusCode, errorMessage, retryCount) => {
    enqueueLog({
      providerId: provider.id, providerName: provider.name, endpoint: '/v1/chat/completions', requestBody,
      originIp: req.ip, originHeader: req.headers['user-agent'],
      statusCode, errorMessage,
      responseTimeMs: Date.now() - startTime,
      authenticatedVia: 'api_key',
      requesterName: req.apiKey.name, requesterKey: req.apiKey.key_prefix,
      cacheHit: false, wasRetry: retryCount > 0, retryCount,
      tokensSavedEstimate,
    })
    enqueueMetric(provider.id, { error: true, responseTimeMs: Date.now() - startTime })
  }

  let provider = null
  let stream = null
  let lastError = null
  let retryCount = 0

  if (selection.mode === 'provider') {
    const p = selection.provider
    if (!req.apiKey.allowedProviderIds.includes(p.id)) {
      session.dispose()
      res.status(403).json(PROVIDER_ACCESS_DENIED)
      return
    }
    if (!isProviderAvailable(p)) {
      session.dispose()
      res.status(503).json(normalizeError(Object.assign(new Error(`Provider "${p.name}" is paused or in cooldown`), { status: 503 })))
      return
    }
    if (isRateLimitExceeded(p) || isDailyLimitExceeded(p)) {
      session.dispose()
      res.status(503).json(normalizeError(Object.assign(new Error(`Provider "${p.name}" has reached its rate or daily limit`), { status: 503 })))
      return
    }
    try {
      recordProviderRequest(p.id)
      stream = await streamProvider(p, stripModel(requestBody), session.signal)
      provider = p
    } catch (err) {
      lastError = err
      provider = null
      logError(p, err.status || 503, describeStreamError(err, session), 0)
      if (!session.isAborted()) {
        const { immediateCooldown } = classifyProviderError(err, p)
        recordProviderFailure(p, immediateCooldown, extractRetryAfter(err))
        if (immediateCooldown === 'circuit') {
          recordFailure(p.id, p.cooldown_after_failures, p.cooldown_duration_seconds)
        }
      }
    }
  } else {
    const providers = orderProvidersForRouting(selectProviders('chat', req.apiKey.allowedProviderIds))
    for (const p of providers) {
      if (!isProviderAvailable(p)) continue
      if (isRateLimitExceeded(p)) continue
      if (isDailyLimitExceeded(p)) continue
      try {
        recordProviderRequest(p.id)
        stream = await streamProvider(p, stripModel(requestBody), session.signal)
        provider = p
        break
      } catch (err) {
        lastError = err
        retryCount++
        logError(p, err.status || 503, describeStreamError(err, session), retryCount)
        if (session.isAborted()) break
        const { retryable, immediateCooldown } = classifyProviderError(err, p)
        recordProviderFailure(p, immediateCooldown, extractRetryAfter(err))
        if (!retryable) break
        if (immediateCooldown === 'circuit') {
          recordFailure(p.id, p.cooldown_after_failures, p.cooldown_duration_seconds)
        }
      }
    }
  }

  if (!provider) {
    session.dispose()
    if (lastError) {
      const reason = resolveStreamAbortReason(lastError, session)
      const finalErr = new Error(describeStreamError(lastError, session))
      finalErr.status = lastError.status || 503
      finalErr.data = lastError.data || null
      finalErr.abortReason = reason
      res.status(finalErr.status).json(normalizeError(finalErr))
      return
    }
    res.status(503).json(normalizeError(Object.assign(new Error('No available provider for streaming (all providers paused, in cooldown, or rate/daily limited)'), { status: 503 })))
    return
  }

  try {
    session.start()

    const { ttftMs, usage } = await session.run(stream)

    session.dispose()

    const inputTokens = usage.prompt_tokens || 0
    const outputTokens = usage.completion_tokens || 0
    const estimatedCost = (inputTokens * provider.cost_per_input_token) + (outputTokens * provider.cost_per_output_token)

    recordSuccess(provider.id)
    enqueueLog({
      providerId: provider.id, providerName: provider.name, endpoint: '/v1/chat/completions', requestBody,
      originIp: req.ip, originHeader: req.headers['user-agent'],
      statusCode: 200, responseBody: { stream: true },
      responseTimeMs: Date.now() - startTime, ttftMs,
      inputTokens, outputTokens, estimatedCost,
      authenticatedVia: 'api_key',
      requesterName: req.apiKey.name, requesterKey: req.apiKey.key_prefix,
      cacheHit: false, retryCount, tokensSavedEstimate,
    })
    enqueueMetric(provider.id, {
      inputTokens, outputTokens, cost: estimatedCost, responseTimeMs: Date.now() - startTime, cacheHit: false,
    })
  } catch (err) {
    const reason = resolveStreamAbortReason(err, session)
    session.dispose()
    if (res.headersSent) {
      enqueueLog({
        providerId: provider.id, providerName: provider.name, endpoint: '/v1/chat/completions', requestBody,
        originIp: req.ip, originHeader: req.headers['user-agent'],
        statusCode: 503, errorMessage: describeStreamError(err, session),
        responseTimeMs: Date.now() - startTime, ttftMs: session.ttftMs(),
        authenticatedVia: 'api_key',
        requesterName: req.apiKey.name, requesterKey: req.apiKey.key_prefix,
        cacheHit: false, wasRetry: retryCount > 0, retryCount,
        tokensSavedEstimate,
      })
      enqueueMetric(provider.id, { error: true, responseTimeMs: Date.now() - startTime })
      if (reason === ABORT_REASONS.IDLE_TIMEOUT) {
        recordFailure(provider.id, provider.cooldown_after_failures, provider.cooldown_duration_seconds)
      }
      return
    }

    if (!session.isAborted()) {
      const { retryable, immediateCooldown } = classifyProviderError(err, provider)
      recordProviderFailure(provider, immediateCooldown, extractRetryAfter(err))
      if (retryable && immediateCooldown === 'circuit') {
        recordFailure(provider.id, provider.cooldown_after_failures, provider.cooldown_duration_seconds)
      }
    }
    res.status(err.status || 503).json(normalizeError(err))
  }
}

export default router

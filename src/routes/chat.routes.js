import { Router } from 'express'
import { pipeline } from 'stream/promises'
import { dbAll } from '../db.js'
import {
  callProvider, getProvider, streamProvider,
  orderProvidersForRouting, selectProviders,
  isProviderAvailable, isRateLimitExceeded, isDailyLimitExceeded,
  recordProviderRequest, classifyProviderError, extractRetryAfter,
} from '../services/failoverEngine.js'
import { recordSuccess, recordFailure, recordProviderFailure } from '../services/circuitBreaker.js'
import { generateHash, getCache } from '../services/cacheManager.js'
import { processRequest } from '../handlers/requestHandler.js'
import { enqueueLog, enqueueMetric } from '../services/logQueue.js'
import { logger } from '../utils/logger.js'
import { config } from '../config.js'

const router = Router()

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
}

router.post('/send', async (req, res) => {
  const { provider_id, messages, use_proxy, stream } = req.body
  const start = Date.now()

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' })
  }

  if (!use_proxy && !provider_id) {
    return res.status(400).json({ error: 'provider_id is required when proxy is disabled' })
  }

  if (stream) {
    return handleStreamingSend(req, res, { provider_id, messages, use_proxy, start })
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
        providerId: null,
        forceExposeProvider: true,
        requester: { name: 'Dashboard Chat', keyPrefix: null },
      })
      return res.status(result.statusCode).json(addTime({
        ...result.body,
        _provider: result.body._provider || null,
      }))
    } catch (err) {
      return res.status(err.status || 503).json(addTime({ error: err.message, details: err.data || null, _provider: err._provider || null }))
    }
  }

  const provider = getProvider(provider_id)
  if (!provider) {
    return res.status(404).json(addTime({ error: 'Provider not found' }))
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)
  req.on('close', () => { clearTimeout(timeout); controller.abort() })

  try {
    const data = await callProvider(provider, { messages, model: req.body.model || provider.model }, controller.signal)
    const responseTimeMs = Date.now() - start
    const inputTokens = data.usage?.prompt_tokens || 0
    const outputTokens = data.usage?.completion_tokens || 0
    const estimatedCost = (inputTokens * provider.cost_per_input_token) + (outputTokens * provider.cost_per_output_token)

    enqueueLog({
      providerId: provider.id, providerName: provider.name, endpoint: '/admin/api/chat/send', requestBody: req.body,
      originIp: req.ip, originHeader: req.headers['user-agent'],
      statusCode: 200, responseBody: data,
      inputTokens, outputTokens, estimatedCost,
      responseTimeMs, authenticatedVia: 'dashboard_chat', requesterName: 'Dashboard Chat', cacheHit: false, retryCount: 0,
    })

    enqueueMetric(provider.id, { inputTokens, outputTokens, cost: estimatedCost, responseTimeMs, cacheHit: false })

    res.json(addTime({ ...data, _provider: { id: provider.id, name: provider.name, model: provider.model } }))
  } catch (err) {
    const responseTimeMs = Date.now() - start
    logger.warn('Chat test failed', { provider_id, error: err.message })

    enqueueLog({
      providerId: provider.id, providerName: provider.name, endpoint: '/admin/api/chat/send', requestBody: req.body,
      originIp: req.ip, originHeader: req.headers['user-agent'],
      statusCode: err.status || 503, errorMessage: err.message,
      responseTimeMs, authenticatedVia: 'dashboard_chat', requesterName: 'Dashboard Chat', cacheHit: false, wasRetry: false, retryCount: 0,
    })

    enqueueMetric(provider.id, { error: true, responseTimeMs })

    res.status(err.status || 503).json(addTime({ error: err.message, details: err.data || null, _provider: { id: provider.id, name: provider.name, model: provider.model } }))
  }
})

async function handleStreamingSend(req, res, { provider_id, messages, use_proxy, start }) {
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })

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

  if (use_proxy) {
    const queryHash = generateHash({ messages })
    const cached = getCache('/v1/chat/completions', queryHash)
    if (cached) {
      const responseBody = JSON.parse(cached.response_body)
      const provider = cached.provider_id ? getProvider(cached.provider_id) : null
      const text = responseBody.choices?.[0]?.message?.content || ''

      res.writeHead(200, SSE_HEADERS)
      res.write(`data: ${JSON.stringify({
        _provider: provider ? { id: provider.id, name: provider.name, model: provider.model } : null,
        _cache_hit: true,
        choices: [{ delta: { content: text } }],
      })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()

      enqueueLog({
        providerId: cached.provider_id, providerName: provider?.name || null,
        endpoint: '/admin/api/chat/send', requestBody: req.body,
        originIp: req.ip, originHeader: req.headers['user-agent'],
        responseBody, statusCode: 200,
        responseTimeMs: Date.now() - start,
        authenticatedVia: 'dashboard_chat', requesterName: 'Dashboard Chat', cacheHit: true, retryCount: 0,
      })
      if (cached.provider_id) {
        enqueueMetric(cached.provider_id, { cacheHit: true, responseTimeMs: Date.now() - start })
      }
      return
    }
  }

  const logError = (provider, statusCode, errorMessage, retryCount) => {
    enqueueLog({
      providerId: provider.id, providerName: provider.name, endpoint: '/admin/api/chat/send', requestBody: req.body,
      originIp: req.ip, originHeader: req.headers['user-agent'],
      statusCode, errorMessage,
      responseTimeMs: Date.now() - start,
      authenticatedVia: 'dashboard_chat', requesterName: 'Dashboard Chat', cacheHit: false, wasRetry: retryCount > 0, retryCount,
    })
    enqueueMetric(provider.id, { error: true, responseTimeMs: Date.now() - start })
  }

  let provider
  let stream
  let lastError = null
  let lastFailedProvider = null
  let retryCount = 0

  if (use_proxy) {
    const providers = orderProvidersForRouting(selectProviders('chat'))
    for (const p of providers) {
      if (!isProviderAvailable(p)) continue
      if (isRateLimitExceeded(p)) continue
      if (isDailyLimitExceeded(p)) continue
      try {
        recordProviderRequest(p.id)
        stream = await streamProvider(p, { messages, model: req.body.model || p.model }, controller.signal)
        provider = p
        break
      } catch (err) {
        lastError = err
        retryCount++
        logError(p, err.status || 503, err.message, retryCount)
        lastFailedProvider = p
        const { retryable, immediateCooldown } = classifyProviderError(err, p)
        recordProviderFailure(p, immediateCooldown, extractRetryAfter(err))
        if (!retryable) break
        if (immediateCooldown === 'circuit') {
          recordFailure(p.id, p.cooldown_after_failures, p.cooldown_duration_seconds)
        }
      }
    }
  } else {
    provider = getProvider(provider_id)
    if (!provider) {
      clearTimeout(durationTimer)
      return res.status(404).json({ error: 'Provider not found', response_time_ms: Date.now() - start })
    }
    if (!isProviderAvailable(provider)) {
      clearTimeout(durationTimer)
      return res.status(503).json({ error: `Provider "${provider.name}" is paused or in cooldown`, response_time_ms: Date.now() - start })
    }
    try {
      recordProviderRequest(provider.id)
      stream = await streamProvider(provider, { messages, model: req.body.model || provider.model }, controller.signal)
    } catch (err) {
      lastError = err
      lastFailedProvider = provider
      logError(provider, err.status || 503, err.message, 0)
      const { immediateCooldown } = classifyProviderError(err, provider)
      recordProviderFailure(provider, immediateCooldown, extractRetryAfter(err))
      if (immediateCooldown === 'circuit') {
        recordFailure(provider.id, provider.cooldown_after_failures, provider.cooldown_duration_seconds)
      }
      provider = null
    }
  }

  if (!provider) {
    clearTimeout(durationTimer)
    const err = lastError
    return res.status(err?.status || 503).json({
      error: err?.message || 'No available provider', details: err?.data || null,
      _provider: lastFailedProvider ? { id: lastFailedProvider.id, name: lastFailedProvider.name, model: lastFailedProvider.model } : null,
      response_time_ms: Date.now() - start,
    })
  }

  try {
    res.writeHead(200, SSE_HEADERS)
    res.write(`data: ${JSON.stringify({ _provider: { id: provider.id, name: provider.name, model: provider.model } })}\n\n`)

    resetIdle()
    stream.on('data', resetIdle)

    await pipeline(stream, res)

    clearIdle()
    clearTimeout(durationTimer)

    recordSuccess(provider.id)
    enqueueLog({
      providerId: provider.id, providerName: provider.name, endpoint: '/admin/api/chat/send', requestBody: req.body,
      originIp: req.ip, originHeader: req.headers['user-agent'],
      statusCode: 200, responseBody: { stream: true },
      responseTimeMs: Date.now() - start,
      authenticatedVia: 'dashboard_chat', requesterName: 'Dashboard Chat', cacheHit: false, retryCount,
    })
    enqueueMetric(provider.id, { responseTimeMs: Date.now() - start, cacheHit: false })
  } catch (err) {
    clearIdle()
    clearTimeout(durationTimer)
    if (res.headersSent) return

    const { retryable, immediateCooldown } = classifyProviderError(err, provider)
    recordProviderFailure(provider, immediateCooldown, extractRetryAfter(err))
    if (retryable && immediateCooldown === 'circuit') {
      recordFailure(provider.id, provider.cooldown_after_failures, provider.cooldown_duration_seconds)
    }
    res.status(err.status || 503).json({
      error: err.message, details: err.data || null,
      _provider: { id: provider.id, name: provider.name, model: provider.model },
      response_time_ms: Date.now() - start,
    })
  }
}

router.get('/providers', (req, res) => {
  const rows = dbAll(
    "SELECT id, name, model, provider_type FROM providers WHERE capability = 'chat' AND status != 'paused' ORDER BY order_position ASC"
  )
  res.json(rows)
})

export default router

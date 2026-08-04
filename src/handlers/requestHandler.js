import { getCapabilityFromBody, selectProviders, getProvider, isProviderAvailable, isRateLimitExceeded, isDailyLimitExceeded, callProvider, isRetryableError, recordProviderRequest, orderProvidersForRouting } from '../services/failoverEngine.js'
import { recordSuccess, recordFailure } from '../services/circuitBreaker.js'
import { generateHash, getCache, setCache } from '../services/cacheManager.js'
import { enqueueLog, enqueueMetric } from '../services/logQueue.js'
import { config } from '../config.js'

export async function processRequest({ endpoint, requestBody, originIp, originHeader, authenticatedVia, providerId, forceExposeProvider = false, requester = null }) {
  const startTime = Date.now()

  const requesterName = requester?.name || null
  const requesterKey = requester?.keyPrefix || null

  const capability = getCapabilityFromBody(requestBody)

  const hasTools = Array.isArray(requestBody.tools) && requestBody.tools.length > 0
  const cacheable = !hasTools && !requestBody.tool_choice

  let lastError = null
  let lastProvider = null
  let retryCount = 0

  const cacheKeyBody = providerId ? { _provider: providerId, ...requestBody } : requestBody
  const queryHash = cacheable ? generateHash(cacheKeyBody) : null
  const cached = cacheable ? getCache(endpoint, queryHash) : null
  if (cached) {
    const responseBody = JSON.parse(cached.response_body)
    const provider = cached.provider_id ? getProvider(cached.provider_id) : null
    enqueueLog({
      providerId: cached.provider_id, providerName: provider?.name || null,
      endpoint, requestBody, originIp, originHeader,
      responseBody, statusCode: 200,
      responseTimeMs: Date.now() - startTime,
      authenticatedVia, requesterName, requesterKey, cacheHit: true,
    })
    if (cached.provider_id) {
      enqueueMetric(cached.provider_id, {
        cacheHit: true, responseTimeMs: Date.now() - startTime,
      })
    }
    const exposeProvider = forceExposeProvider || config.relay.exposeProvider
    return {
      statusCode: 200,
      body: exposeProvider
        ? { ...responseBody, _cache_hit: true, ...(provider && { _provider: { id: provider.id, name: provider.name, model: provider.model } }) }
        : responseBody,
    }
  }

  let providers
  if (providerId) {
    const p = getProvider(providerId)
    if (!p) {
      const err = new Error('Provider not found')
      err.status = 404
      throw err
    }
    if (!isProviderAvailable(p)) {
      const err = new Error(`Provider "${p.name}" is paused or in cooldown`)
      err.status = 503
      throw err
    }
    providers = [p]
  } else {
    providers = orderProvidersForRouting(selectProviders(capability))
  }

  for (const provider of providers) {
    if (!isProviderAvailable(provider)) {
      continue
    }

    if (isRateLimitExceeded(provider)) {
      continue
    }

    if (isDailyLimitExceeded(provider)) {
      continue
    }

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), config.relay.requestTimeoutMs)

      recordProviderRequest(provider.id)
      const data = await callProvider(provider, requestBody, controller.signal, capability)
      clearTimeout(timeout)

      const responseTimeMs = Date.now() - startTime

      const inputTokens = data.usage?.prompt_tokens || 0
      const outputTokens = data.usage?.completion_tokens || 0
      const estimatedCost = (inputTokens * provider.cost_per_input_token) + (outputTokens * provider.cost_per_output_token)

      recordSuccess(provider.id)
      if (cacheable) setCache(endpoint, cacheKeyBody, data, provider.id)

      enqueueLog({
        providerId: provider.id, providerName: provider.name, endpoint, requestBody, originIp, originHeader,
        statusCode: 200, responseBody: data,
        inputTokens, outputTokens, estimatedCost,
        responseTimeMs, authenticatedVia, requesterName, requesterKey, cacheHit: false, retryCount,
      })

      enqueueMetric(provider.id, {
        inputTokens, outputTokens, cost: estimatedCost,
        responseTimeMs, cacheHit: false,
      })

    const exposeProvider = forceExposeProvider || config.relay.exposeProvider
      return {
        statusCode: 200,
        body: exposeProvider
          ? { ...data, _provider: { id: provider.id, name: provider.name, model: provider.model } }
          : data,
      }
    } catch (err) {
      lastError = err
      lastProvider = provider

      enqueueLog({
        providerId: provider.id, providerName: provider.name, endpoint, requestBody, originIp, originHeader,
        statusCode: err.status || 503, errorMessage: err.message,
        responseTimeMs: Date.now() - startTime,
        authenticatedVia, requesterName, requesterKey, cacheHit: false, wasRetry: retryCount > 0, retryCount,
      })

      retryCount++

      enqueueMetric(provider.id, {
        error: true, responseTimeMs: Date.now() - startTime,
      })

      if (!isRetryableError(err)) {
        const finalErr = new Error(err.message)
        finalErr.status = err.status || 400
        finalErr.data = err.data || null
        finalErr._provider = { id: provider.id, name: provider.name, model: provider.model }
        throw finalErr
      }

      recordFailure(provider.id, provider.cooldown_after_failures, provider.cooldown_duration_seconds)
    }
  }

  enqueueLog({
    endpoint, requestBody, originIp, originHeader,
    statusCode: 503, errorMessage: lastError?.message || 'All providers unavailable',
    responseTimeMs: Date.now() - startTime,
    authenticatedVia, requesterName, requesterKey, cacheHit: false, retryCount,
  })

  const finalErr = new Error(lastError?.message || 'All providers failed')
  finalErr.status = lastError?.status || 503
  finalErr.data = lastError?.data || null
  if (lastProvider) {
    finalErr._provider = { id: lastProvider.id, name: lastProvider.name, model: lastProvider.model }
  }
  throw finalErr
}

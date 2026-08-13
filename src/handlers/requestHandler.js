import { getCapabilityFromBody, selectProviders, getProvider, isProviderAvailable, isRateLimitExceeded, isDailyLimitExceeded, callProvider, classifyProviderError, extractRetryAfter, recordProviderRequest, orderProvidersForRouting } from '../services/failoverEngine.js'
import { recordSuccess, recordFailure, recordProviderFailure } from '../services/circuitBreaker.js'
import { generateHash, getCache, setCache } from '../services/cacheManager.js'
import { enqueueLog, enqueueMetric } from '../services/logQueue.js'
import { optimizeRequestBody } from '../services/tokenOptimizer.js'
import { config } from '../config.js'

function describeRequestError(err) {
  if (err?.name === 'AbortError') {
    return `Request timed out after ${config.relay.requestTimeoutMs}ms`
  }
  return err?.message || 'Unknown error'
}

export function optimizeRelayBody(requestBody) {
  const tokenOpt = config.relay.tokenOptimization
  if (!tokenOpt.enabled) {
    return { body: requestBody, tokensSavedEstimate: 0 }
  }
  const result = optimizeRequestBody(requestBody, {
    aggressiveNormalization: tokenOpt.aggressiveNormalization,
  })
  return tokenOpt.logSavings
    ? result
    : { body: result.body, tokensSavedEstimate: 0 }
}

export async function processRequest({ endpoint, requestBody, originIp, originHeader, authenticatedVia, providerId, forceExposeProvider = false, requester = null, allowedProviderIds = null }) {
  const startTime = Date.now()

  const optimized = optimizeRelayBody(requestBody)
  const effectiveBody = optimized.body
  const tokensSavedEstimate = optimized.tokensSavedEstimate

  const requesterName = requester?.name || null
  const requesterKey = requester?.keyPrefix || null

  if (providerId && allowedProviderIds && !allowedProviderIds.includes(providerId)) {
    const err = new Error('API key does not have access to this provider')
    err.status = 403
    err.code = 'provider_access_denied'
    throw err
  }

  const capability = getCapabilityFromBody(effectiveBody)

  const hasTools = Array.isArray(effectiveBody.tools) && effectiveBody.tools.length > 0
  const cacheable = !hasTools && !effectiveBody.tool_choice

  let lastError = null
  let lastProvider = null
  let retryCount = 0

  const cacheKeyBody = providerId ? { _provider: providerId, ...effectiveBody } : effectiveBody
  const queryHash = cacheable ? generateHash(cacheKeyBody) : null
  const cached = cacheable ? getCache(endpoint, queryHash) : null
  if (cached) {
    const responseBody = JSON.parse(cached.response_body)
    const provider = cached.provider_id ? getProvider(cached.provider_id) : null
    enqueueLog({
      providerId: cached.provider_id, providerName: provider?.name || null,
      endpoint, requestBody: effectiveBody, originIp, originHeader,
      responseBody, statusCode: 200,
      responseTimeMs: Date.now() - startTime,
      authenticatedVia, requesterName, requesterKey, cacheHit: true,
      tokensSavedEstimate,
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
    providers = orderProvidersForRouting(selectProviders(capability, allowedProviderIds))
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
      const data = await callProvider(provider, effectiveBody, controller.signal, capability)
      clearTimeout(timeout)

      const responseTimeMs = Date.now() - startTime

      const inputTokens = data.usage?.prompt_tokens || 0
      const outputTokens = data.usage?.completion_tokens || 0
      const estimatedCost = (inputTokens * provider.cost_per_input_token) + (outputTokens * provider.cost_per_output_token)

      recordSuccess(provider.id)
      if (cacheable) setCache(endpoint, cacheKeyBody, data, provider.id)

      enqueueLog({
        providerId: provider.id, providerName: provider.name, endpoint, requestBody: effectiveBody, originIp, originHeader,
        statusCode: 200, responseBody: data,
        inputTokens, outputTokens, estimatedCost,
        responseTimeMs, authenticatedVia, requesterName, requesterKey, cacheHit: false, retryCount,
        tokensSavedEstimate,
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
        providerId: provider.id, providerName: provider.name, endpoint, requestBody: effectiveBody, originIp, originHeader,
        statusCode: err.status || 503, errorMessage: describeRequestError(err),
        responseTimeMs: Date.now() - startTime,
        authenticatedVia, requesterName, requesterKey, cacheHit: false, wasRetry: retryCount > 0, retryCount,
        tokensSavedEstimate,
      })

      retryCount++

      enqueueMetric(provider.id, {
        error: true, responseTimeMs: Date.now() - startTime,
      })

      const { retryable, immediateCooldown } = classifyProviderError(err, provider)
      recordProviderFailure(provider, immediateCooldown, extractRetryAfter(err))

      if (!retryable) {
        const finalErr = new Error(describeRequestError(err))
        finalErr.status = err.status || 400
        finalErr.data = err.data || null
        finalErr._provider = { id: provider.id, name: provider.name, model: provider.model }
        throw finalErr
      }

      if (immediateCooldown === 'circuit') {
        recordFailure(provider.id, provider.cooldown_after_failures, provider.cooldown_duration_seconds)
      }
    }
  }

  enqueueLog({
    endpoint, requestBody: effectiveBody, originIp, originHeader,
    statusCode: 503, errorMessage: describeRequestError(lastError) || 'All providers unavailable',
    responseTimeMs: Date.now() - startTime,
    authenticatedVia, requesterName, requesterKey, cacheHit: false, retryCount,
    tokensSavedEstimate,
  })

  const finalErr = new Error(describeRequestError(lastError) || 'All providers failed')
  finalErr.status = lastError?.status || 503
  finalErr.data = lastError?.data || null
  if (lastProvider) {
    finalErr._provider = { id: lastProvider.id, name: lastProvider.name, model: lastProvider.model }
  }
  throw finalErr
}

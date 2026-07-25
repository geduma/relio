import { getModelTypeFromBody, selectProviders, isProviderAvailable, isRateLimitExceeded, isDailyLimitExceeded, callProvider } from '../services/failoverEngine.js'
import { recordSuccess, recordFailure } from '../services/circuitBreaker.js'
import { generateHash, getCache, setCache } from '../services/cacheManager.js'
import { logRequest, updateMetrics } from '../services/metricsLogger.js'

export async function processRequest({ endpoint, requestBody, originIp, originHeader, authenticatedVia, apiKey }) {
  const startTime = Date.now()

  const modelType = getModelTypeFromBody(requestBody)

  let lastError = null
  let retryCount = 0

  const queryHash = generateHash(requestBody)
  const cached = getCache(queryHash)
  if (cached) {
    const responseBody = JSON.parse(cached.response_body)
    logRequest({
      endpoint, requestBody, originIp, originHeader,
      responseBody, statusCode: 200,
      responseTimeMs: Date.now() - startTime,
      authenticatedVia, cacheHit: true,
    })
    return { statusCode: 200, body: responseBody }
  }

  const providers = selectProviders(modelType)

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
      const timeout = setTimeout(() => controller.abort(), 30000)

      const data = await callProvider(provider, requestBody, controller.signal)
      clearTimeout(timeout)

      const responseTimeMs = Date.now() - startTime

      const inputTokens = data.usage?.prompt_tokens || 0
      const outputTokens = data.usage?.completion_tokens || 0
      const estimatedCost = (inputTokens * provider.cost_per_input_token) + (outputTokens * provider.cost_per_output_token)

      recordSuccess(provider.id)
      setCache(endpoint, requestBody, data)

      logRequest({
        providerId: provider.id, endpoint, requestBody, originIp, originHeader,
        statusCode: 200, responseBody: data,
        inputTokens, outputTokens, estimatedCost,
        responseTimeMs, authenticatedVia, cacheHit: false, retryCount,
      })

      updateMetrics(provider.id, {
        inputTokens, outputTokens, cost: estimatedCost,
        responseTimeMs, cacheHit: false,
      })

      return { statusCode: 200, body: data }
    } catch (err) {
      lastError = err
      retryCount++

      recordFailure(provider.id, provider.cooldown_after_failures, provider.cooldown_duration_seconds)

      logRequest({
        providerId: provider.id, endpoint, requestBody, originIp, originHeader,
        statusCode: err.status || 503, errorMessage: err.message,
        responseTimeMs: Date.now() - startTime,
        authenticatedVia, cacheHit: false, wasRetry: retryCount > 0, retryCount,
      })

      updateMetrics(provider.id, {
        error: true, responseTimeMs: Date.now() - startTime,
      })
    }
  }

  logRequest({
    endpoint, requestBody, originIp, originHeader,
    statusCode: 503, errorMessage: lastError?.message || 'All providers unavailable',
    responseTimeMs: Date.now() - startTime,
    authenticatedVia, cacheHit: false, retryCount,
  })

  throw new Error(lastError?.message || 'All providers failed')
}

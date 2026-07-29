import { getCapabilityFromBody, selectProviders, isProviderAvailable, isRateLimitExceeded, isDailyLimitExceeded, callProvider } from '../services/failoverEngine.js'
import { recordSuccess, recordFailure } from '../services/circuitBreaker.js'
import { generateHash, getCache, setCache } from '../services/cacheManager.js'
import { enqueueLog, enqueueMetric } from '../services/logQueue.js'
import { dbGet } from '../db.js'

export async function processRequest({ endpoint, requestBody, originIp, originHeader, authenticatedVia, apiKey, providerId }) {
  const startTime = Date.now()

  const capability = getCapabilityFromBody(requestBody)

  let lastError = null
  let retryCount = 0

  const queryHash = generateHash(requestBody)
  const cached = getCache(queryHash)
  if (cached) {
    const responseBody = JSON.parse(cached.response_body)
    enqueueLog({
      endpoint, requestBody, originIp, originHeader,
      responseBody, statusCode: 200,
      responseTimeMs: Date.now() - startTime,
      authenticatedVia, cacheHit: true,
    })
    if (cached.provider_id) {
      enqueueMetric(cached.provider_id, {
        cacheHit: true, responseTimeMs: Date.now() - startTime,
      })
    }
    return { statusCode: 200, body: responseBody }
  }

  let providers
  if (providerId) {
    const p = dbGet('SELECT * FROM providers WHERE id = ?', [providerId])
    providers = p ? [p] : []
  } else {
    providers = selectProviders(capability)
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
      const timeout = setTimeout(() => controller.abort(), 30000)

      const data = await callProvider(provider, requestBody, controller.signal)
      clearTimeout(timeout)

      const responseTimeMs = Date.now() - startTime

      const inputTokens = data.usage?.prompt_tokens || 0
      const outputTokens = data.usage?.completion_tokens || 0
      const estimatedCost = (inputTokens * provider.cost_per_input_token) + (outputTokens * provider.cost_per_output_token)

      recordSuccess(provider.id)
      setCache(endpoint, requestBody, data, provider.id)

      enqueueLog({
        providerId: provider.id, endpoint, requestBody, originIp, originHeader,
        statusCode: 200, responseBody: data,
        inputTokens, outputTokens, estimatedCost,
        responseTimeMs, authenticatedVia, cacheHit: false, retryCount,
      })

      enqueueMetric(provider.id, {
        inputTokens, outputTokens, cost: estimatedCost,
        responseTimeMs, cacheHit: false,
      })

      return { statusCode: 200, body: data }
    } catch (err) {
      lastError = err
      retryCount++

      recordFailure(provider.id, provider.cooldown_after_failures, provider.cooldown_duration_seconds)

      enqueueLog({
        providerId: provider.id, endpoint, requestBody, originIp, originHeader,
        statusCode: err.status || 503, errorMessage: err.message,
        responseTimeMs: Date.now() - startTime,
        authenticatedVia, cacheHit: false, wasRetry: retryCount > 0, retryCount,
      })

      enqueueMetric(provider.id, {
        error: true, responseTimeMs: Date.now() - startTime,
      })
    }
  }

  enqueueLog({
    endpoint, requestBody, originIp, originHeader,
    statusCode: 503, errorMessage: lastError?.message || 'All providers unavailable',
    responseTimeMs: Date.now() - startTime,
    authenticatedVia, cacheHit: false, retryCount,
  })

  const finalErr = new Error(lastError?.message || 'All providers failed')
  finalErr.status = lastError?.status || 503
  finalErr.data = lastError?.data || null
  throw finalErr
}

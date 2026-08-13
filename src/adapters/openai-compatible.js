import ProviderAdapter from './base.js'
import { Readable } from 'stream'
import { logger } from '../utils/logger.js'
import { config } from '../config.js'
import { sanitizeChatBody } from './messageSerializer.js'
import { redactAuthHeaders, truncate } from './debugUtils.js'

export default class OpenAICompatibleAdapter extends ProviderAdapter {
  static get type() { return 'openai-compatible' }

  _stripQuery(url) {
    const idx = url.indexOf('?')
    return idx === -1 ? url : url.slice(0, idx)
  }

  _normalizeBase(baseUrl) {
    return this._stripQuery(baseUrl).replace(/\/+$/, '')
  }

  _hasVersionSegment(url) {
    return /\/v\d[\w.-]*(\/|$)/.test(url)
  }

  _appendEndpoint(baseUrl, endpoint) {
    const base = this._normalizeBase(baseUrl)
    const cleaned = base.replace(/\/chat\/completions$/, '')
    const suffix = this._hasVersionSegment(cleaned) ? '' : '/v1'
    return `${cleaned}${suffix}/${endpoint}`
  }

  buildUrl(baseUrl) {
    const base = this._normalizeBase(baseUrl)
    if (base.endsWith('/chat/completions')) return base
    return this._appendEndpoint(base, 'chat/completions')
  }

  buildUrlForEmbeddings(baseUrl) {
    return this._appendEndpoint(baseUrl, 'embeddings')
  }

  buildUrlForModels(baseUrl) {
    return this._appendEndpoint(baseUrl, 'models')
  }

  buildHeaders(apiKey) {
    return {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }
  }

  _logRequest(method, url, headers, body) {
    if (!config.relay.debugProviderRequests) return
    logger.debug('OpenAI-compatible request →', {
      method,
      url,
      headers: redactAuthHeaders(headers),
      body: truncate(body),
    })
  }

  _logResponse(method, url, response, data) {
    if (!config.relay.debugProviderRequests) return
    logger.debug('OpenAI-compatible response ←', {
      method,
      url,
      responseStatus: response.status,
      responseBody: truncate(data),
    })
  }

  async _fetch(method, url, headers, body, signal) {
    this._logRequest(method, url, headers, body)
    return fetch(url, { method, headers, body, signal })
  }

  async chat(provider, requestBody, signal) {
    const url = this.buildUrl(provider.api_url)
    const headers = this.buildHeaders(provider.api_key)
    const body = sanitizeChatBody(requestBody)
    if (!body.model && provider.model) body.model = provider.model

    const response = await this._fetch('POST', url, headers, JSON.stringify(body), signal)

    let data
    try {
      data = await response.json()
    } catch {
      this._logResponse('POST', url, response, null)
      const err = new Error(`Provider returned non-JSON response (status ${response.status})`)
      err.status = response.status
      err.data = null
      throw err
    }

    this._logResponse('POST', url, response, data)

    if (!response.ok) {
      const detail = JSON.stringify(data).slice(0, 500)
      const errMsg = ProviderAdapter.extractErrorMsg(data)
      const msg = errMsg
        ? `Provider error: ${errMsg} (status ${response.status})`
        : `Provider returned ${response.status} — body: ${detail}`
      const err = new Error(msg)
      err.status = response.status
      err.data = data
      ProviderAdapter.attachRetryAfter(err, response)
      throw err
    }

    return data
  }

  async stream(provider, requestBody, signal) {
    const url = this.buildUrl(provider.api_url)
    const headers = this.buildHeaders(provider.api_key)
    const body = sanitizeChatBody(requestBody)
    if (!body.model && provider.model) body.model = provider.model
    if (!body.stream_options?.include_usage) {
      body.stream_options = { include_usage: true }
    }

    const response = await this._fetch('POST', url, headers, JSON.stringify({ ...body, stream: true }), signal)

    if (!response.ok) {
      let data
      try { data = await response.json() } catch { data = null }
      this._logResponse('POST', url, response, data)
      const detail = data ? JSON.stringify(data).slice(0, 500) : 'no body'
      const errMsg = ProviderAdapter.extractErrorMsg(data)
      const err = new Error(errMsg || `Stream request failed (status ${response.status}) — body: ${detail}`)
      err.status = response.status
      err.data = data
      ProviderAdapter.attachRetryAfter(err, response)
      throw err
    }

    await this.assertSseResponse(response)
    this._logResponse('POST', url, response, null)
    return Readable.fromWeb(response.body)
  }

  async embeddings(provider, requestBody, signal) {
    const url = this.buildUrlForEmbeddings(provider.api_url)
    const headers = this.buildHeaders(provider.api_key)
    const body = sanitizeChatBody(requestBody)
    if (!body.model && provider.model) body.model = provider.model

    const response = await this._fetch('POST', url, headers, JSON.stringify(body), signal)

    let data
    try {
      data = await response.json()
    } catch {
      this._logResponse('POST', url, response, null)
      const err = new Error(`Provider returned non-JSON response (status ${response.status})`)
      err.status = response.status
      err.data = null
      throw err
    }

    this._logResponse('POST', url, response, data)

    if (!response.ok) {
      const detail = JSON.stringify(data).slice(0, 500)
      const errMsg = ProviderAdapter.extractErrorMsg(data)
      const err = new Error(errMsg || `Provider returned ${response.status} — body: ${detail}`)
      err.status = response.status
      err.data = data
      ProviderAdapter.attachRetryAfter(err, response)
      throw err
    }

    return data
  }

  async testConnection(apiUrl, apiKey, options = {}) {
    const model = options.model || null
    const base = apiUrl.replace(/\/+$/, '')
    const modelsUrl = this.buildUrlForModels(base)
    const chatUrl = this.buildUrl(base)

    async function tryFetch(url, fetchOptions, timeoutMs = 5000) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      try {
        return await fetch(url, { ...fetchOptions, signal: controller.signal })
      } finally {
        clearTimeout(timeout)
      }
    }

    const probeChat = async () => {
      const payload = {
        model: model || 'relio-test-connection',
        messages: [{ role: 'user', content: 'hi' }],
      }
      const res = await tryFetch(chatUrl, {
        method: 'POST',
        headers: this.buildHeaders(apiKey),
        body: JSON.stringify(payload),
      })
      let body = null
      try { body = await res.json() } catch { body = null }
      this._logResponse('POST', chatUrl, res, body)

      if (res.status === 401 || res.status === 403) return 'invalid_key'
      if (res.ok) return 'valid'
      if (ProviderAdapter.extractErrorMsg(body)) return 'valid'
      if (res.status === 404) return 'not_found'
      return 'valid'
    }

    try {
      this._logRequest('GET', modelsUrl, this.buildHeaders(apiKey), null)
      const modelsRes = await tryFetch(modelsUrl, {
        headers: this.buildHeaders(apiKey),
      })
      let modelsBody = null
      try { modelsBody = await modelsRes.json() } catch { modelsBody = null }
      this._logResponse('GET', modelsUrl, modelsRes, modelsBody)

      if (modelsRes.status === 401 || modelsRes.status === 403) {
        return { valid: false, error: 'API key is invalid' }
      }

      if (modelsRes.status === 200) {
        return { valid: true, status: modelsRes.status }
      }

      const chatResult = await probeChat()
      if (chatResult === 'invalid_key') {
        return { valid: false, error: 'API key is invalid' }
      }
      if (chatResult === 'not_found') {
        return { valid: false, error: `Endpoint not found at ${base}. Check the API URL or provider type.` }
      }
      return { valid: true }
    } catch (err) {
      const msg = err.name === 'AbortError' ? 'Connection timed out' : `Cannot reach server: ${err.message}`
      return { valid: false, error: msg }
    }
  }
}

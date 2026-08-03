import ProviderAdapter from './base.js'
import { Readable } from 'stream'

export default class OpenAICompatibleAdapter extends ProviderAdapter {
  static get type() { return 'openai-compatible' }

  _stripQuery(url) {
    const idx = url.indexOf('?')
    return idx === -1 ? url : url.slice(0, idx)
  }

  buildUrl(baseUrl) {
    const base = this._stripQuery(baseUrl).replace(/\/+$/, '')
    if (!base.endsWith('/chat/completions')) {
      const hasVersion = /\/v\d[\w.]*(\/|$)/.test(base)
      const suffix = hasVersion ? '' : '/v1'
      return `${base}${suffix}/chat/completions`
    }
    return base
  }

  buildUrlForEmbeddings(baseUrl) {
    const base = this._stripQuery(baseUrl).replace(/\/+$/, '')
    const cleaned = base.replace(/\/chat\/completions$/, '')
    if (!/\/v\d[\w.]*(\/|$)/.test(cleaned)) return `${cleaned}/v1/embeddings`
    return `${cleaned}/embeddings`
  }

  buildUrlForModels(baseUrl) {
    const base = this._stripQuery(baseUrl).replace(/\/+$/, '')
    const cleaned = base.replace(/\/chat\/completions$/, '')
    if (!/\/v\d[\w.]*(\/|$)/.test(cleaned)) return `${cleaned}/v1/models`
    return `${cleaned}/models`
  }

  buildHeaders(apiKey) {
    return {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }
  }

  async chat(provider, requestBody, signal) {
    const url = this.buildUrl(provider.api_url)
    const headers = this.buildHeaders(provider.api_key)
    const body = { ...requestBody }
    if (!body.model && provider.model) body.model = provider.model

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    })

    let data
    try {
      data = await response.json()
    } catch {
      const err = new Error(`Provider returned non-JSON response (status ${response.status})`)
      err.status = response.status
      err.data = null
      throw err
    }

    if (!response.ok) {
      const detail = JSON.stringify(data).slice(0, 500)
      const errMsg = ProviderAdapter.extractErrorMsg(data)
      const msg = errMsg
        ? `Provider error: ${errMsg} (status ${response.status})`
        : `Provider returned ${response.status} — body: ${detail}`
      const err = new Error(msg)
      err.status = response.status
      err.data = data
      throw err
    }

    return data
  }

  async stream(provider, requestBody, signal) {
    const url = this.buildUrl(provider.api_url)
    const headers = this.buildHeaders(provider.api_key)
    const body = { ...requestBody }
    if (!body.model && provider.model) body.model = provider.model

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    })

    if (!response.ok) {
      let data
      try { data = await response.json() } catch { data = null }
      const detail = data ? JSON.stringify(data).slice(0, 500) : 'no body'
      const errMsg = ProviderAdapter.extractErrorMsg(data)
      const err = new Error(errMsg || `Stream request failed (status ${response.status}) — body: ${detail}`)
      err.status = response.status
      err.data = data
      throw err
    }

    await this.assertSseResponse(response)
    return Readable.fromWeb(response.body)
  }

  async embeddings(provider, requestBody, signal) {
    const url = this.buildUrlForEmbeddings(provider.api_url)
    const headers = this.buildHeaders(provider.api_key)
    const body = { ...requestBody }
    if (!body.model && provider.model) body.model = provider.model

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    })

    let data
    try {
      data = await response.json()
    } catch {
      const err = new Error(`Provider returned non-JSON response (status ${response.status})`)
      err.status = response.status
      err.data = null
      throw err
    }

    if (!response.ok) {
      const detail = JSON.stringify(data).slice(0, 500)
      const errMsg = ProviderAdapter.extractErrorMsg(data)
      const err = new Error(errMsg || `Provider returned ${response.status} — body: ${detail}`)
      err.status = response.status
      err.data = data
      throw err
    }

    return data
  }

  async testConnection(apiUrl, apiKey) {
    const base = apiUrl.replace(/\/+$/, '')
    const modelsUrl = this.buildUrlForModels(base)
    const chatUrl = this.buildUrl(base)

    async function tryFetch(url, options, timeoutMs = 5000) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      try {
        return await fetch(url, { ...options, signal: controller.signal })
      } finally {
        clearTimeout(timeout)
      }
    }

    async function tryChatCompletions() {
      const res = await tryFetch(chatUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'relio-test-connection', messages: [{ role: 'user', content: 'hi' }] }),
      })
      if (res.status === 401 || res.status === 403) return 'invalid_key'
      let body
      try { body = await res.json() } catch { body = null }
      if (res.status === 404) {
        const errMsg = ProviderAdapter.extractErrorMsg(body)
        if (errMsg) return 'valid'
        return 'not_found'
      }
      const errMsg = ProviderAdapter.extractErrorMsg(body)
      if (errMsg && /invalid|unauthorized|auth|api.key/.test(errMsg.toLowerCase())) {
        return 'invalid_key'
      }
      return 'valid'
    }

    try {
      const modelsRes = await tryFetch(modelsUrl, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      })

      if (modelsRes.status === 401 || modelsRes.status === 403) {
        return { valid: false, error: 'API key is invalid' }
      }

      if (modelsRes.status === 200) {
        const chatResult = await tryChatCompletions()
        if (chatResult === 'invalid_key') {
          return { valid: false, error: 'API key is invalid' }
        }
        if (chatResult === 'not_found') {
          return { valid: false, error: `Chat endpoint not found at ${base}. Check the API URL or provider type.` }
        }
        return { valid: true, status: modelsRes.status }
      }

      if (modelsRes.status === 404) {
        const chatResult = await tryChatCompletions()
        if (chatResult === 'invalid_key') {
          return { valid: false, error: 'API key is invalid' }
        }
        if (chatResult === 'not_found') {
          return { valid: false, error: `Endpoint not found at ${base}. Check the API URL.` }
        }
        return { valid: true }
      }

      return { valid: false, error: `Provider returned status ${modelsRes.status}` }
    } catch (err) {
      const msg = err.name === 'AbortError' ? 'Connection timed out' : `Cannot reach server: ${err.message}`
      return { valid: false, error: msg }
    }
  }
}

import ProviderAdapter from './base.js'
import { Readable } from 'stream'

export default class OpenAICompatibleAdapter extends ProviderAdapter {
  static get type() { return 'openai-compatible' }

  buildUrl(baseUrl) {
    let url = baseUrl.replace(/\/+$/, '')
    if (!url.endsWith('/chat/completions')) {
      const hasVersion = /\/v\d[\w.]*(\/|$)/.test(url)
      const suffix = hasVersion ? '' : '/v1'
      url += `${suffix}/chat/completions`
    }
    return url
  }

  buildUrlForEmbeddings(baseUrl) {
    let url = baseUrl.replace(/\/+$/, '')
    url = url.replace(/\/chat\/completions$/, '')
    if (!/\/v\d[\w.]*(\/|$)/.test(url)) url += '/v1'
    return `${url}/embeddings`
  }

  buildUrlForModels(baseUrl) {
    let url = baseUrl.replace(/\/+$/, '')
    url = url.replace(/\/chat\/completions$/, '')
    if (!/\/v\d[\w.]*(\/|$)/.test(url)) url += '/v1'
    return `${url}/models`
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
      const err = new Error(data.error?.message || `Provider returned ${response.status}`)
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
      const err = new Error(data?.error?.message || `Stream request failed (status ${response.status})`)
      err.status = response.status
      err.data = data
      throw err
    }

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
      const err = new Error(data.error?.message || `Provider returned ${response.status}`)
      err.status = response.status
      err.data = data
      throw err
    }

    return data
  }

  async models(apiUrl, apiKey) {
    const url = this.buildUrlForModels(apiUrl)
    const headers = this.buildHeaders(apiKey)

    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(5000),
    })

    if (!response.ok) {
      return []
    }

    let data
    try {
      data = await response.json()
    } catch {
      return []
    }

    return data.data || data.models || []
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
      if (res.status === 404) return 'not_found'
      let body
      try { body = await res.json() } catch { body = null }
      if (body?.error?.message) {
        if (/invalid|unauthorized|auth|api.key/.test(body.error.message.toLowerCase())) {
          return 'invalid_key'
        }
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

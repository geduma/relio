import ProviderAdapter from './base.js'
import { Readable } from 'stream'

const AZURE_API_VERSION = '2024-02-15-preview'

export default class AzureOpenAIAdapter extends ProviderAdapter {
  static get type() { return 'azure-openai' }

  buildUrl(baseUrl) {
    let url = baseUrl.replace(/\/+$/, '')
    const separator = url.includes('?') ? '&' : '?'
    if (!url.includes('api-version=')) {
      url += `${separator}api-version=${AZURE_API_VERSION}`
    }
    if (!url.endsWith('/chat/completions') && !url.includes('/chat/completions')) {
      url += '/chat/completions'
    }
    return url
  }

  buildUrlForModels(baseUrl) {
    let url = baseUrl.replace(/\/+$/, '')
    const separator = url.includes('?') ? '&' : '?'
    if (!url.includes('api-version=')) {
      url += `${separator}api-version=${AZURE_API_VERSION}`
    }
    const deploymentMatch = url.match(/\/deployments\/[^/?]+/)
    if (deploymentMatch) {
      url = url.slice(0, deploymentMatch.index) + '/models'
    }
    return url
  }

  buildHeaders(apiKey) {
    return {
      'api-key': apiKey,
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
      const err = new Error(`Azure returned non-JSON response (status ${response.status})`)
      err.status = response.status
      err.data = null
      throw err
    }

    if (!response.ok) {
      const detail = JSON.stringify(data).slice(0, 500)
      const err = new Error(data.error?.message || `Azure returned ${response.status} — body: ${detail}`)
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
      const err = new Error(data?.error?.message || `Azure stream request failed (status ${response.status}) — body: ${detail}`)
      err.status = response.status
      err.data = data
      throw err
    }

    return Readable.fromWeb(response.body)
  }

  async models(apiUrl, apiKey) {
    const url = this.buildUrlForModels(apiUrl)
    const headers = this.buildHeaders(apiKey)

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) return []
      const data = await response.json()
      return data.data || []
    } catch {
      return []
    }
  }

  async testConnection(apiUrl, apiKey) {
    const base = apiUrl.replace(/\/+$/, '')
    const separator = base.includes('?') ? '&' : '?'

    async function tryFetch(url, options, timeoutMs = 5000) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      try {
        return await fetch(url, { ...options, signal: controller.signal })
      } finally {
        clearTimeout(timeout)
      }
    }

    try {
      const modelsUrl = `${base}${separator}api-version=${AZURE_API_VERSION}`
      const res = await tryFetch(modelsUrl, {
        headers: { 'api-key': apiKey },
      })

      if (res.status === 401 || res.status === 403) {
        return { valid: false, error: 'API key is invalid' }
      }

      if (res.ok) {
        return { valid: true }
      }

      if (res.status === 404) {
        const chatUrl = this.buildUrl(apiUrl)
        const chatRes = await tryFetch(chatUrl, {
          method: 'POST',
          headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
        })

        if (chatRes.status === 401 || chatRes.status === 403) {
          return { valid: false, error: 'API key is invalid' }
        }

        if (chatRes.status === 400) {
          const body = await chatRes.json().catch(() => ({}))
          if (body.error?.code === 'DeploymentNotFound') {
            return { valid: false, error: 'Deployment not found. Check the model/deployment name in the URL.' }
          }
          return { valid: true }
        }

        if (chatRes.ok) {
          return { valid: true }
        }

        return { valid: false, error: `Azure returned status ${chatRes.status}` }
      }

      return { valid: false, error: `Azure returned status ${res.status}` }
    } catch (err) {
      const msg = err.name === 'AbortError' ? 'Connection timed out' : `Cannot reach server: ${err.message}`
      return { valid: false, error: msg }
    }
  }
}

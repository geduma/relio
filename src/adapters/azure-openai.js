import ProviderAdapter from './base.js'
import { Readable } from 'stream'

const AZURE_API_VERSION = '2024-02-15-preview'

export default class AzureOpenAIAdapter extends ProviderAdapter {
  static get type() { return 'azure-openai' }

  buildUrl(baseUrl) {
    const url = new URL(baseUrl)
    if (!url.pathname.endsWith('/chat/completions')) {
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`
    }
    if (!url.searchParams.has('api-version')) {
      url.searchParams.set('api-version', AZURE_API_VERSION)
    }
    return url.toString()
  }

  buildUrlForModels(baseUrl) {
    const url = new URL(baseUrl)
    const deploymentMatch = url.pathname.match(/^(.+?)\/deployments\/[^/]+$/)
    if (deploymentMatch) {
      url.pathname = `${deploymentMatch[1]}/models`
    }
    if (!url.searchParams.has('api-version')) {
      url.searchParams.set('api-version', AZURE_API_VERSION)
    }
    return url.toString()
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
      const errMsg = ProviderAdapter.extractErrorMsg(data)
      const err = new Error(errMsg || `Azure returned ${response.status} — body: ${detail}`)
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
      const err = new Error(errMsg || `Azure stream request failed (status ${response.status}) — body: ${detail}`)
      err.status = response.status
      err.data = data
      throw err
    }

    await this.assertSseResponse(response)
    return Readable.fromWeb(response.body)
  }

  async testConnection(apiUrl, apiKey) {
    const base = apiUrl.replace(/\/+$/, '')
    const probeUrl = new URL(base)
    if (!probeUrl.searchParams.has('api-version')) {
      probeUrl.searchParams.set('api-version', AZURE_API_VERSION)
    }

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
      const res = await tryFetch(probeUrl, {
        headers: { 'api-key': apiKey },
      })

      if (res.status === 401 || res.status === 403) {
        return { valid: false, error: 'API key is invalid' }
      }

      if (res.ok) {
        return { valid: true }
      }

      if (res.status === 404) {
        let body
        try { body = await res.json() } catch { body = null }
        if (ProviderAdapter.extractErrorMsg(body)) return { valid: true }

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
          const chatBody = await chatRes.json().catch(() => ({}))
          if (chatBody.error?.code === 'DeploymentNotFound') {
            return { valid: false, error: 'Deployment not found. Check the model/deployment name in the URL.' }
          }
          return { valid: true }
        }

        if (chatRes.ok) {
          return { valid: true }
        }

        if (chatRes.status === 404) {
          let chatBody
          try { chatBody = await chatRes.json() } catch { chatBody = null }
          if (ProviderAdapter.extractErrorMsg(chatBody)) return { valid: true }
          return { valid: false, error: `Chat endpoint not found at ${base}. Check the API URL.` }
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

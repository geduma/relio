export default class ProviderAdapter {
  static get type() {
    throw new Error('ProviderAdapter must define static get type()')
  }

  static extractErrorMsg(data) {
    if (!data) return null
    if (Array.isArray(data)) return data[0]?.error?.message || null
    return data.error?.message || null
  }

  static attachRetryAfter(err, response) {
    if (!response || typeof response.headers?.get !== 'function') return err
    const header = response.headers.get('retry-after')
    if (!header) return err
    const secs = Number(header)
    if (Number.isFinite(secs) && secs >= 0) {
      err.retryAfter = secs
    } else {
      const parsed = Date.parse(header)
      if (!Number.isNaN(parsed)) {
        err.retryAfter = Math.max(0, Math.ceil((parsed - Date.now()) / 1000))
      }
    }
    return err
  }

  async assertSseResponse(response) {
    const type = (response.headers.get('content-type') || '').toLowerCase()
    if (!type.includes('application/json')) return
    if (type.includes('jsonl') || type.includes('ndjson')) return

    let data = null
    try { data = await response.json() } catch { data = null }
    const errMsg = ProviderAdapter.extractErrorMsg(data)
    const err = new Error(errMsg || `Provider returned a non-streaming JSON response (status ${response.status})`)
    err.status = 502
    err.data = data
    throw err
  }

  async chat(_provider, _requestBody, _signal) {
    throw new Error(`${this.constructor.type} must implement chat()`)
  }

  async stream(_provider, _requestBody, _signal) {
    throw new Error(`${this.constructor.type} must implement stream()`)
  }

  async embeddings(_provider, _requestBody, _signal) {
    throw new Error(`${this.constructor.type} must implement embeddings()`)
  }

  async testConnection(_apiUrl, _apiKey) {
    throw new Error(`${this.constructor.type} must implement testConnection()`)
  }

  buildUrl(_baseUrl) {
    throw new Error(`${this.constructor.type} must implement buildUrl()`)
  }

  buildHeaders(_apiKey) {
    throw new Error(`${this.constructor.type} must implement buildHeaders()`)
  }
}

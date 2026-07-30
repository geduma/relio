export default class ProviderAdapter {
  static get type() {
    throw new Error('ProviderAdapter must define static get type()')
  }

  static extractErrorMsg(data) {
    if (!data) return null
    if (Array.isArray(data)) return data[0]?.error?.message || null
    return data.error?.message || null
  }

  async chat(provider, requestBody, signal) {
    throw new Error(`${this.constructor.type} must implement chat()`)
  }

  async stream(provider, requestBody, signal) {
    throw new Error(`${this.constructor.type} must implement stream()`)
  }

  async embeddings(provider, requestBody, signal) {
    throw new Error(`${this.constructor.type} must implement embeddings()`)
  }

  async models(apiUrl, apiKey) {
    throw new Error(`${this.constructor.type} must implement models()`)
  }

  async testConnection(apiUrl, apiKey) {
    throw new Error(`${this.constructor.type} must implement testConnection()`)
  }

  buildUrl(baseUrl) {
    throw new Error(`${this.constructor.type} must implement buildUrl()`)
  }

  buildHeaders(apiKey) {
    throw new Error(`${this.constructor.type} must implement buildHeaders()`)
  }
}

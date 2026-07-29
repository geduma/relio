export default class ProviderAdapter {
  static get type() {
    throw new Error('ProviderAdapter must define static get type()')
  }

  async chat(provider, requestBody, signal) {
    throw new Error(`${this.constructor.type} must implement chat()`)
  }

  async stream(provider, requestBody, signal) {
    throw new Error(`${this.constructor.type} must implement stream()`)
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

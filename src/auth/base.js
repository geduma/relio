/**
 * AuthProvider — abstract interface for authentication providers.
 *
 * To implement a custom provider:
 *   1. Create a file in src/auth/ that exports a class extending AuthProvider.
 *   2. Implement all required methods.
 *   3. Set AUTH_PROVIDER=your_class_name (matching the file name) in .env.
 *
 * The factory in src/auth/index.js automatically loads and instantiates
 * the provider based on the AUTH_PROVIDER env var.
 *
 * @example
 * ```js
 * // src/auth/myprovider.js
 * import AuthProvider from './base.js'
 *
 * export default class MyProvider extends AuthProvider {
 *   static get type() { return 'myprovider' }
 *   get loginView() { return 'oauth' }
 *   async getLoginConfig() { return { providers: [...] } }
 *   async login(credentials) { return { sessionId, user } }
 *   async logout(sessionId) { ... }
 *   async getSession(sessionId) { return session || null }
 * }
 * ```
 */
export default class AuthProvider {
  /**
   * Unique identifier matching the file name and AUTH_PROVIDER env var.
   * Must be overridden by subclasses.
   */
  static get type() {
    throw new Error('AuthProvider must define static get type()')
  }

  /**
   * How the frontend should render the login page.
   * - 'oauth': show provider buttons (redirect-based OAuth)
   * - 'none':  no login UI, auto-create anonymous session
   */
  get loginView() {
    return 'none'
  }

  /**
   * Returns configuration data for the login UI.
   * For 'oauth' providers, should return { providers: [...] }.
   * Called by GET /admin/api/auth/providers.
   */
  async getLoginConfig() {
    return {}
  }

  /**
   * Authenticate with the given credentials and return a session.
   *
   * @param {Object} credentials
   * @param {string} credentials.provider - Provider id (for OAuth flows)
   * @param {string} credentials.code     - Authorization code (for OAuth flows)
   * @returns {Promise<{sessionId: string, user: Object}>}
   */
  async login(credentials) {
    throw new Error('AuthProvider must implement login()')
  }

  /**
   * Destroy a session (logout).
   * @param {string} sessionId
   */
  async logout(sessionId) {
    throw new Error('AuthProvider must implement logout()')
  }

  /**
   * Validate and return an active session, or null if invalid/expired.
   * @param {string} sessionId
   * @returns {Promise<Object|null>}
   */
  async getSession(sessionId) {
    throw new Error('AuthProvider must implement getSession()')
  }
}

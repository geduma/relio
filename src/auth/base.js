export default class AuthProvider {
  static get type() {
    throw new Error('AuthProvider must define static get type()')
  }

  get loginView() {
    return 'none'
  }

  async getLoginConfig() {
    return {}
  }

  async login(credentials) {
    throw new Error('AuthProvider must implement login()')
  }

  async initiateLogin({ provider }) {
    throw new Error('AuthProvider must implement initiateLogin() or loginView must be "none"')
  }

  async logout(sessionId) {
    throw new Error('AuthProvider must implement logout()')
  }

  async getSession(sessionId) {
    throw new Error('AuthProvider must implement getSession()')
  }
}

function env(key, fallback) {
  return process.env[key] !== undefined ? process.env[key] : fallback
}

export const config = {
  auth: {
    get provider() { return env('AUTH_PROVIDER', 'geduma') },
  },
  geduma: {
    get apiUrl() { return env('GEDUMA_API_URL', 'https://geduma-api.com') },
    get apiToken() { return env('GEDUMA_API_TOKEN', '') },
  },
  db: {
    get path() { return env('DB_PATH', './db/db.sqlite') },
  },
  cache: {
    get ttlSeconds() { return parseInt(env('CACHE_TTL_SECONDS', '2592000'), 10) },
  },
  server: {
    get port() { return parseInt(env('PORT', '3000'), 10) },
    get host() { return env('HOST', '0.0.0.0') },
    get baseUrl() { return env('APP_BASE_URL', 'http://localhost:3000') },
    get nodeEnv() { return env('NODE_ENV', 'development') },
  },
  cookie: {
    get secure() { return env('COOKIE_SECURE', 'true') === 'true' },
    get sameSite() { return env('COOKIE_SAME_SITE', 'strict') },
    get httpOnly() { return env('COOKIE_HTTP_ONLY', 'true') !== 'false' },
  },
}

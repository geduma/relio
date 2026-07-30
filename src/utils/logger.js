import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { config } from '../config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const logDir = path.resolve(__dirname, '../../logs')

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true })
}

const logFile = path.join(logDir, 'app.log')

function log(level, message, data = null) {
  const timestamp = new Date().toISOString()
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${data ? ' ' + JSON.stringify(data) : ''}`
  fs.appendFile(logFile, line + '\n', (err) => { if (err) console.error('Log write failed', err) })
  if (config.server.nodeEnv !== 'production') {
    console.log(line)
  }
}

export function normalizeError(err) {
  const message = err?.message || 'Unknown error'
  const status = err?.status || 500
  const data = err?.data || {}

  let type = 'provider_error'
  let code = status.toString()

  const msg = (data?.error?.message || message).toLowerCase()

  if (status === 401 || status === 403 || /invalid.*api.?key|unauthorized|auth/.test(msg)) {
    type = 'authentication_error'
    code = 'authentication'
  } else if (status === 429 || /rate.?limit|too many requests/.test(msg)) {
    type = 'rate_limit_error'
    code = 'rate_limit'
  } else if (status === 404 || /not.?found|deployment.?not.?found/.test(msg)) {
    type = 'not_found_error'
    code = 'model_not_found'
  } else if (/context.?length|maximum.?context|too many tokens|tokens.*exceed/.test(msg)) {
    type = 'invalid_request_error'
    code = 'context_length_exceeded'
  } else if (/safety|blocked|recitation/.test(msg)) {
    type = 'content_filter_error'
    code = 'content_filter'
  } else if (/timeout|timed out|abort/.test(msg)) {
    type = 'timeout_error'
    code = 'timeout'
  } else if (status >= 500) {
    type = 'server_error'
    code = 'provider_unavailable'
  }

  return {
    error: { message: err?.message || 'Unknown error', type, code },
  }
}

export const logger = {
  info: (msg, data) => log('info', msg, data),
  warn: (msg, data) => log('warn', msg, data),
  error: (msg, data) => log('error', msg, data),
  debug: (msg, data) => log('debug', msg, data),
}

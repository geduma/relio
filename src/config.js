import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadConfig() {
  const configPath = process.env.CONFIG_PATH || join(__dirname, '..', 'config.json')
  let raw
  try {
    raw = readFileSync(configPath, 'utf-8')
  } catch {
    throw new Error(
      `config.json not found at ${configPath}. Copy config.example.json to config.json and fill in values.`
    )
  }
  const cfg = JSON.parse(raw)

  cfg.server ??= {}
  cfg.server.port = parseInt(process.env.PORT, 10) || cfg.server.port
  cfg.server.host = process.env.HOST || cfg.server.host
  cfg.server.nodeEnv = process.env.NODE_ENV || cfg.server.nodeEnv
  cfg.server.trustedProxy ??= false

  cfg.db ??= {}
  cfg.db.path = process.env.DB_PATH || cfg.db.path || ''

  cfg.security ??= {}

  cfg.relay ??= {}
  cfg.relay.exposeProvider ??= false
  cfg.relay.streamTimeoutSeconds ??= 300
  cfg.relay.streamIdleTimeoutMs ??= 30000
  cfg.relay.requestTimeoutMs ??= 30000

  cfg.rateLimit ??= {}
  cfg.rateLimit.proxyPerMinute ??= 120
  cfg.rateLimit.dashboardPerMinute ??= 120

  return cfg
}

export const config = loadConfig()

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const ENV_OVERRIDES = {
  'server.port': 'PORT',
  'server.host': 'HOST',
  'server.nodeEnv': 'NODE_ENV',
  'db.path': 'DB_PATH',
  'security.encryptionKey': 'ENCRYPTION_KEY',
}

export function getConfigPath() {
  return process.env.CONFIG_PATH || join(__dirname, '..', 'config', 'config.json')
}

export function getEnvOverrides() {
  const overrides = {}
  for (const [key, envName] of Object.entries(ENV_OVERRIDES)) {
    if (process.env[envName] !== undefined && process.env[envName] !== '') {
      overrides[key] = envName
    }
  }
  return overrides
}

function validateEncryptionKey(encryptionKey) {
  if (!encryptionKey || typeof encryptionKey !== 'string') {
    throw new Error(
      'config.security.encryptionKey is required. Generate one with: openssl rand -hex 32'
    )
  }
  if (encryptionKey.length < 32) {
    throw new Error('config.security.encryptionKey must be at least 32 characters long')
  }
  if (encryptionKey.includes('replace-with-a-random')) {
    throw new Error(
      'config.security.encryptionKey is still the example placeholder. Generate a real one with: openssl rand -hex 32'
    )
  }
  return encryptionKey
}

export function normalizeConfig(raw) {
  const cfg = JSON.parse(JSON.stringify(raw))

  cfg.server ??= {}
  cfg.server.port = parseInt(process.env.PORT, 10) || cfg.server.port
  cfg.server.host = process.env.HOST || cfg.server.host
  cfg.server.nodeEnv = process.env.NODE_ENV || cfg.server.nodeEnv
  cfg.server.trustedProxy ??= false

  cfg.db ??= {}
  cfg.db.path = process.env.DB_PATH || cfg.db.path || ''

  cfg.cache ??= {}
  cfg.cache.ttlSeconds ??= 2592000

  cfg.security ??= {}
  cfg.security.encryptionKey = process.env.ENCRYPTION_KEY || cfg.security.encryptionKey
  validateEncryptionKey(cfg.security.encryptionKey)

  cfg.relay ??= {}
  cfg.relay.writeBuffer ??= {}
  cfg.relay.writeBuffer.flushIntervalMs ??= 500
  cfg.relay.writeBuffer.maxBufferSize ??= 50
  cfg.relay.tokenOptimization ??= {}
  cfg.relay.tokenOptimization.enabled ??= false
  cfg.relay.tokenOptimization.logSavings ??= true
  cfg.relay.tokenOptimization.aggressiveNormalization ??= false
  cfg.relay.exposeProvider ??= false
  cfg.relay.debugProviderRequests ??= false
  cfg.relay.streamTimeoutSeconds ??= 300
  cfg.relay.streamIdleTimeoutMs ??= 30000
  cfg.relay.requestTimeoutMs ??= 30000
  cfg.relay.routingStrategy ??= 'order'
  cfg.relay.failoverOnQuota ??= true
  cfg.relay.quotaCooldownSeconds ??= 3600
  cfg.relay.rateLimitCooldownSeconds ??= 60
  cfg.relay.retryAfterMaxSeconds ??= 900

  cfg.rateLimit ??= {}
  cfg.rateLimit.proxyPerMinute ??= 120
  cfg.rateLimit.dashboardPerMinute ??= 120

  return cfg
}

function loadConfig() {
  const configPath = getConfigPath()
  let raw
  try {
    raw = readFileSync(configPath, 'utf-8')
  } catch {
    try {
      raw = readFileSync(join(__dirname, '..', 'config', 'config.example.json'), 'utf-8')
    } catch {
      throw new Error(
        `config.json not found at ${configPath}. Copy config/config.example.json to config/config.json and fill in values.`
      )
    }
  }
  return normalizeConfig(JSON.parse(raw))
}

export const config = loadConfig()

function setByPath(obj, dottedKey, value) {
  const parts = dottedKey.split('.')
  let node = obj
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) {
      node[parts[i]] = {}
    }
    node = node[parts[i]]
  }
  node[parts[parts.length - 1]] = value
}

export function applyConfigChanges(changes) {
  for (const [key, value] of Object.entries(changes)) {
    setByPath(config, key, value)
  }
  return config
}

export const ROUTING_STRATEGIES = ['order', 'least-used']
const NODE_ENVS = ['development', 'production']
export const READ_ONLY_KEYS = [
  'security.encryptionKey',
  'db.path',
  'server.port',
  'server.host',
  'server.trustedProxy',
  'rateLimit.proxyPerMinute',
  'rateLimit.dashboardPerMinute',
]

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0
}

const validators = {
  'server.nodeEnv': (v) => NODE_ENVS.includes(v),
  'cache.ttlSeconds': (v) => isPositiveInt(v),
  'security.allowedPrivateHosts': (v) =>
    Array.isArray(v) &&
    v.every(host => typeof host === 'string' && host.trim().length > 0),
  'relay.exposeProvider': (v) => typeof v === 'boolean',
  'relay.debugProviderRequests': (v) => typeof v === 'boolean',
  'relay.streamTimeoutSeconds': (v) => isPositiveInt(v),
  'relay.streamIdleTimeoutMs': (v) => isPositiveInt(v),
  'relay.streamKeepAliveMs': (v) => Number.isInteger(v) && v >= 0,
  'relay.requestTimeoutMs': (v) => isPositiveInt(v),
  'relay.routingStrategy': (v) => ROUTING_STRATEGIES.includes(v),
  'relay.failoverOnQuota': (v) => typeof v === 'boolean',
  'relay.quotaCooldownSeconds': (v) => isPositiveInt(v),
  'relay.rateLimitCooldownSeconds': (v) => isPositiveInt(v),
  'relay.retryAfterMaxSeconds': (v) => isPositiveInt(v),
  'relay.writeBuffer.flushIntervalMs': (v) => isPositiveInt(v),
  'relay.writeBuffer.maxBufferSize': (v) => isPositiveInt(v),
  'relay.tokenOptimization.enabled': (v) => typeof v === 'boolean',
  'relay.tokenOptimization.logSavings': (v) => typeof v === 'boolean',
  'relay.tokenOptimization.aggressiveNormalization': (v) => typeof v === 'boolean',
  'healthCheck.enabled': (v) => typeof v === 'boolean',
  'healthCheck.intervalMinutes': (v) => isPositiveInt(v),
  'healthCheck.timeoutMs': (v) => isPositiveInt(v),
  'healthCheck.pauseAfterConsecutiveFailures': (v) => isPositiveInt(v),
}

export function getEditableConfigKeys() {
  return Object.keys(validators)
}

export function validateConfigChanges(changes) {
  const errors = []
  for (const key of Object.keys(changes)) {
    if (READ_ONLY_KEYS.includes(key)) {
      errors.push(`${key} is read-only and cannot be changed via the settings API`)
      continue
    }
    const validator = validators[key]
    if (!validator) {
      errors.push(`Unknown configuration key "${key}"`)
      continue
    }
    if (!validator(changes[key])) {
      errors.push(`Invalid value for "${key}": ${JSON.stringify(changes[key])}`)
    }
  }
  return errors
}

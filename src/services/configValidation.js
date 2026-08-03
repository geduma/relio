export const ROUTING_STRATEGIES = ['order', 'least-used']
export const NODE_ENVS = ['development', 'production']
export const READ_ONLY_KEYS = ['security.encryptionKey', 'db.path']

function isIntInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0
}

const validators = {
  'server.port': (v) => isIntInRange(v, 1, 65535),
  'server.host': (v) => typeof v === 'string' && v.trim().length > 0,
  'server.nodeEnv': (v) => NODE_ENVS.includes(v),
  'server.trustedProxy': (v) => typeof v === 'boolean',
  'cache.ttlSeconds': (v) => isPositiveInt(v),
  'relay.exposeProvider': (v) => typeof v === 'boolean',
  'relay.streamTimeoutSeconds': (v) => isPositiveInt(v),
  'relay.streamIdleTimeoutMs': (v) => isPositiveInt(v),
  'relay.requestTimeoutMs': (v) => isPositiveInt(v),
  'relay.routingStrategy': (v) => ROUTING_STRATEGIES.includes(v),
  'rateLimit.proxyPerMinute': (v) => isPositiveInt(v),
  'rateLimit.dashboardPerMinute': (v) => isPositiveInt(v),
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

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
  'relay.exposeProvider': (v) => typeof v === 'boolean',
  'relay.streamTimeoutSeconds': (v) => isPositiveInt(v),
  'relay.streamIdleTimeoutMs': (v) => isPositiveInt(v),
  'relay.requestTimeoutMs': (v) => isPositiveInt(v),
  'relay.routingStrategy': (v) => ROUTING_STRATEGIES.includes(v),
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

import { describe, it, expect } from 'vitest'
import { validateConfigChanges, getEditableConfigKeys, READ_ONLY_KEYS, ROUTING_STRATEGIES } from '../src/services/configValidation.js'

describe('configValidation', () => {
  it('accepts valid values for every editable key', () => {
    const valid = {
      'server.port': 3000,
      'server.host': '0.0.0.0',
      'server.nodeEnv': 'production',
      'server.trustedProxy': true,
      'cache.ttlSeconds': 60,
      'relay.exposeProvider': false,
      'relay.streamTimeoutSeconds': 300,
      'relay.streamIdleTimeoutMs': 30000,
      'relay.requestTimeoutMs': 30000,
      'relay.routingStrategy': 'least-used',
      'rateLimit.proxyPerMinute': 120,
      'rateLimit.dashboardPerMinute': 120,
    }
    expect(validateConfigChanges(valid)).toEqual([])
  })

  it('rejects invalid values', () => {
    const errors = validateConfigChanges({
      'server.port': 70000,
      'server.nodeEnv': 'staging',
      'cache.ttlSeconds': -1,
      'relay.routingStrategy': 'round-robin',
      'rateLimit.proxyPerMinute': 0,
    })
    expect(errors.some(e => e.includes('server.port'))).toBe(true)
    expect(errors.some(e => e.includes('server.nodeEnv'))).toBe(true)
    expect(errors.some(e => e.includes('cache.ttlSeconds'))).toBe(true)
    expect(errors.some(e => e.includes('relay.routingStrategy'))).toBe(true)
    expect(errors.some(e => e.includes('rateLimit.proxyPerMinute'))).toBe(true)
  })

  it('rejects read-only keys', () => {
    const errors = validateConfigChanges({ 'security.encryptionKey': 'x', 'db.path': '/tmp/db' })
    expect(errors.length).toBe(2)
    expect(errors.every(e => e.includes('read-only'))).toBe(true)
  })

  it('rejects unknown keys', () => {
    const errors = validateConfigChanges({ 'bogus.key': 1 })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/Unknown configuration key "bogus.key"/)
  })

  it('exposes the editable key set and constants', () => {
    expect(getEditableConfigKeys()).toContain('server.port')
    expect(getEditableConfigKeys()).toContain('relay.routingStrategy')
    expect(READ_ONLY_KEYS).toEqual(['security.encryptionKey', 'db.path'])
    expect(ROUTING_STRATEGIES).toEqual(['order', 'least-used'])
  })
})

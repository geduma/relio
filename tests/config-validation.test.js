import { describe, it, expect } from 'vitest'
import { validateConfigChanges, getEditableConfigKeys, READ_ONLY_KEYS, ROUTING_STRATEGIES } from '../src/services/configValidation.js'

describe('configValidation', () => {
  it('accepts valid values for every editable key', () => {
    const valid = {
      'server.nodeEnv': 'production',
      'cache.ttlSeconds': 60,
      'security.allowedPrivateHosts': ['ollama.home', '192.168.10.10'],
      'relay.exposeProvider': false,
      'relay.debugProviderRequests': true,
      'relay.streamTimeoutSeconds': 300,
      'relay.streamIdleTimeoutMs': 30000,
      'relay.requestTimeoutMs': 30000,
      'relay.routingStrategy': 'least-used',
    }
    expect(validateConfigChanges(valid)).toEqual([])
  })

  it('rejects invalid values', () => {
    const errors = validateConfigChanges({
      'server.nodeEnv': 'staging',
      'cache.ttlSeconds': -1,
      'relay.routingStrategy': 'round-robin',
      'security.allowedPrivateHosts': 'ollama.home',
    })
    expect(errors.some(e => e.includes('server.nodeEnv'))).toBe(true)
    expect(errors.some(e => e.includes('cache.ttlSeconds'))).toBe(true)
    expect(errors.some(e => e.includes('relay.routingStrategy'))).toBe(true)
    expect(errors.some(e => e.includes('security.allowedPrivateHosts'))).toBe(true)
  })

  it('rejects read-only keys', () => {
    const errors = validateConfigChanges({
      'security.encryptionKey': 'x',
      'db.path': '/tmp/db',
      'server.port': 4000,
      'server.host': '127.0.0.1',
      'server.trustedProxy': true,
      'rateLimit.proxyPerMinute': 120,
      'rateLimit.dashboardPerMinute': 120,
    })
    expect(errors.length).toBe(7)
    expect(errors.every(e => e.includes('read-only'))).toBe(true)
  })

  it('rejects unknown keys', () => {
    const errors = validateConfigChanges({ 'bogus.key': 1 })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/Unknown configuration key "bogus.key"/)
  })

  it('exposes the editable key set and constants', () => {
    const editable = getEditableConfigKeys()
    expect(editable).toContain('relay.routingStrategy')
    expect(editable).toContain('server.nodeEnv')
    expect(editable).not.toContain('server.port')
    expect(editable).not.toContain('rateLimit.proxyPerMinute')
    expect(READ_ONLY_KEYS).toEqual([
      'security.encryptionKey',
      'db.path',
      'server.port',
      'server.host',
      'server.trustedProxy',
      'rateLimit.proxyPerMinute',
      'rateLimit.dashboardPerMinute',
    ])
    expect(ROUTING_STRATEGIES).toEqual(['order', 'least-used'])
  })
})

import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import express from 'express'
import { writeFileSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const VALID_KEY = 'c'.repeat(64)
const ENV_KEYS = ['CONFIG_PATH', 'PORT', 'HOST', 'NODE_ENV', 'DB_PATH', 'ENCRYPTION_KEY']

let tmpFile
let savedEnv = {}
let settingsRoutes
let mergeConfigChanges

function baseConfig() {
  return {
    security: { encryptionKey: VALID_KEY },
    db: { path: ':memory:' },
    cache: { ttlSeconds: 2592000 },
    server: { port: 3000, host: '0.0.0.0', nodeEnv: 'development', trustedProxy: false },
    relay: { exposeProvider: false, requestTimeoutMs: 30000, routingStrategy: 'order' },
    rateLimit: { proxyPerMinute: 120, dashboardPerMinute: 120 },
  }
}

function writeTempConfig() {
  writeFileSync(tmpFile, JSON.stringify(baseConfig(), null, 2))
}

function readTempConfig() {
  return JSON.parse(readFileSync(tmpFile, 'utf-8'))
}

let server
let baseUrl

beforeAll(async () => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  tmpFile = join(tmpdir(), `relio-settings-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  writeTempConfig()
  process.env.CONFIG_PATH = tmpFile

  settingsRoutes = (await import('../src/routes/settings.routes.js')).default
  mergeConfigChanges = (await import('../src/services/configStore.js')).mergeConfigChanges

  const app = express()
  app.use(express.json())
  app.use('/admin/api/settings', settingsRoutes)
  server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  baseUrl = `http://localhost:${server.address().port}`
})

beforeEach(() => {
  writeTempConfig()
})

afterAll(async () => {
  if (server) await new Promise(r => server.close(r))
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  try {
    unlinkSync(tmpFile)
  } catch {
    // ignore cleanup errors
  }
})

describe('configStore', () => {
  it('deep-merges dotted changes while preserving unrelated keys', () => {
    const current = baseConfig()
    const next = mergeConfigChanges(current, { 'server.port': 4000, 'relay.routingStrategy': 'least-used' })
    expect(next.server.port).toBe(4000)
    expect(next.relay.routingStrategy).toBe('least-used')
    expect(next.cache.ttlSeconds).toBe(2592000)
    expect(next.security.encryptionKey).toBe(VALID_KEY)
  })

  it('preserves unknown keys not managed by the settings schema', () => {
    const current = { ...baseConfig(), futureFeature: { enabled: true } }
    const next = mergeConfigChanges(current, { 'server.port': 5000 })
    expect(next.futureFeature.enabled).toBe(true)
  })
})

describe('settings routes', () => {
  it('GET returns the effective config with read-only markers', async () => {
    const res = await fetch(`${baseUrl}/admin/api/settings`)
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.config.server.port).toBe(3000)
    expect(data.config.relay.routingStrategy).toBe('order')
    expect(data.config.security.encryptionKeySet).toBe(true)
    expect(data.config.security.encryptionKey).toBe('cccccc...cccc')
    expect(data.readOnlyKeys).toContain('security.encryptionKey')
    expect(data.readOnlyKeys).toContain('db.path')
    expect(data.configPath).toBe(tmpFile)
    expect(typeof data.envOverrides).toBe('object')
  })

  it('PUT persists changes to the physical config.json file', async () => {
    const res = await fetch(`${baseUrl}/admin/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { server: { port: 4000 }, relay: { routingStrategy: 'least-used' } } }),
    })
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.saved.server.port).toBe(4000)
    expect(data.saved.relay.routingStrategy).toBe('least-used')
    expect(data.config.server.port).toBe(4000)

    const file = readTempConfig()
    expect(file.server.port).toBe(4000)
    expect(file.relay.routingStrategy).toBe('least-used')
    expect(file.cache.ttlSeconds).toBe(2592000)
  })

  it('PUT rejects an invalid value without touching the file', async () => {
    const res = await fetch(`${baseUrl}/admin/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { server: { port: 99999 } } }),
    })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error.code).toBe('invalid_config')
    expect(readTempConfig().server.port).toBe(3000)
  })

  it('PUT rejects read-only keys', async () => {
    for (const patch of [
      { config: { security: { encryptionKey: 'x'.repeat(40) } } },
      { config: { db: { path: '/tmp/elsewhere.sqlite' } } },
    ]) {
      const res = await fetch(`${baseUrl}/admin/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error.code).toBe('invalid_config')
      expect(data.error.message).toMatch(/read-only/i)
    }
  })

  it('PUT rejects unknown keys', async () => {
    const res = await fetch(`${baseUrl}/admin/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { foo: 1 } }),
    })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error.code).toBe('invalid_config')
    expect(data.error.message).toMatch(/Unknown configuration key "foo"/)
  })
})

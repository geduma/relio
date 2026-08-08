import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest'
import express from 'express'

vi.mock('../src/utils/ssrf.js', () => ({
  assertPublicUrl: async () => {},
}))

let setDbPath, initDb, closeDb, dbRun, dbGet, encrypt
let authService, logQueue, circuitBreaker

beforeAll(async () => {
  const dbMod = await import('../src/db.js')
  setDbPath = dbMod.setDbPath
  initDb = dbMod.initDb
  closeDb = dbMod.closeDb
  dbRun = dbMod.dbRun
  dbGet = dbMod.dbGet
  encrypt = dbMod.encrypt

  setDbPath(':memory:')
  initDb()

  authService = await import('../src/services/authService.js')
  logQueue = await import('../src/services/logQueue.js')
  circuitBreaker = await import('../src/services/circuitBreaker.js')
})

afterAll(() => closeDb())

beforeEach(() => {
  dbRun('DELETE FROM circuit_breaker_state')
  dbRun('DELETE FROM requests_log')
  dbRun('DELETE FROM cache')
  dbRun('DELETE FROM metrics')
  dbRun('DELETE FROM api_key_providers')
  dbRun('DELETE FROM api_keys')
  dbRun('DELETE FROM providers')
})

describe('circuit breaker buffered counters', () => {
  it('persists intermediate failure counts on flush', () => {
    dbRun("INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ['cbx', 'CbX', 'https://x.example.com/v1', encrypt('sk'), 'm', 'chat', 'openai-compatible', 0, 'Main', 'active'])

    circuitBreaker.recordFailure('cbx', 5, 300)
    circuitBreaker.recordFailure('cbx', 5, 300)
    expect(dbGet("SELECT failure_count FROM circuit_breaker_state WHERE provider_id = 'cbx'")?.failure_count ?? 0).toBe(0)

    logQueue.flushAll()
    const state = dbGet("SELECT * FROM circuit_breaker_state WHERE provider_id = 'cbx'")
    expect(state.failure_count).toBe(2)
    expect(state.state).toBe('healthy')
  })

  it('triggers cooldown synchronously even without a flush between failures', () => {
    dbRun("INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ['cby', 'CbY', 'https://x.example.com/v1', encrypt('sk'), 'm', 'chat', 'openai-compatible', 0, 'Main', 'active'])

    circuitBreaker.recordFailure('cby', 3, 300)
    circuitBreaker.recordFailure('cby', 3, 300)
    circuitBreaker.recordFailure('cby', 3, 300)

    const state = dbGet("SELECT * FROM circuit_breaker_state WHERE provider_id = 'cby'")
    expect(state.state).toBe('cooldown')
    expect(state.failure_count).toBe(3)
    const provider = dbGet("SELECT status FROM providers WHERE id = 'cby'")
    expect(provider.status).toBe('cooldown')
  })

  it('buffered counters do not clobber a cooldown state transition', () => {
    dbRun("INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ['cbz', 'CbZ', 'https://x.example.com/v1', encrypt('sk'), 'm', 'chat', 'openai-compatible', 0, 'Main', 'active'])

    circuitBreaker.recordFailure('cbz', 3, 300)
    circuitBreaker.recordFailure('cbz', 3, 300)
    circuitBreaker.recordFailure('cbz', 3, 300)
    logQueue.flushAll()

    const state = dbGet("SELECT * FROM circuit_breaker_state WHERE provider_id = 'cbz'")
    expect(state.state).toBe('cooldown')
    const provider = dbGet("SELECT status FROM providers WHERE id = 'cbz'")
    expect(provider.status).toBe('cooldown')
  })

  it('recordSuccess resets buffered counts and state', () => {
    dbRun("INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ['cbs', 'CbS', 'https://x.example.com/v1', encrypt('sk'), 'm', 'chat', 'openai-compatible', 0, 'Main', 'active'])

    circuitBreaker.recordFailure('cbs', 3, 300)
    circuitBreaker.recordFailure('cbs', 3, 300)
    circuitBreaker.recordSuccess('cbs')
    logQueue.flushAll()

    const state = dbGet("SELECT * FROM circuit_breaker_state WHERE provider_id = 'cbs'")
    expect(state.state).toBe('healthy')
    expect(state.failure_count).toBe(0)
  })
})

describe('selective /v1/models cache invalidation on PATCH', () => {
  let server
  let baseUrl
  let apiKey

  function seedProvider(id, name, extra = {}) {
    dbRun(
      `INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label, status, cost_per_input_token, cost_per_output_token${extra.cooldown_until ? ', cooldown_until' : ''})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${extra.cooldown_until ? ', ?' : ''})`,
      [
        id, name, 'https://alpha.example.com/v1', encrypt('sk-test'), 'model-chat', 'chat', 'openai-compatible',
        extra.orderPosition ?? 0, extra.orderLabel ?? 'Main', extra.status ?? 'active', 0, 0,
        ...(extra.cooldown_until ? [extra.cooldown_until] : []),
      ]
    )
  }

  beforeEach(() => {
    seedProvider('sel1', 'SelectiveMain')
    seedProvider('sel2', 'SelectiveFallback', { orderPosition: 1, orderLabel: 'Fallback 1' })
    apiKey = authService.createApiKey({ name: 'selective', providerIds: ['sel1', 'sel2'] })
  })

  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.use('/v1', (await import('../src/routes/proxy.routes.js')).default)
    app.use('/admin/api/providers', (await import('../src/routes/providers.routes.js')).default)
    server = app.listen(0)
    await new Promise(r => server.once('listening', r))
    baseUrl = `http://localhost:${server.address().port}`
  })

  afterAll(async () => {
    if (server) await new Promise(r => server.close(r))
  })

  async function models() {
    const res = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    return (await res.json()).data.map(m => m.id)
  }

  function patch(id, body) {
    return fetch(`${baseUrl}/admin/api/providers/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('a cosmetic PATCH (cost) does not invalidate the cached /v1/models', async () => {
    const before = await models()
    expect(before).toContain('SelectiveMain')

    const res = await patch('sel1', { cost_per_input_token: 0.5, cost_per_output_token: 1.5 })
    expect(res.status).toBe(200)

    const row = dbGet("SELECT cost_per_input_token FROM providers WHERE id = 'sel1'")
    expect(row.cost_per_input_token).toBe(0.5)

    const after = await models()
    expect(after).toEqual(before)
    expect(after).toContain('SelectiveMain')
  })

  it('a status PATCH (paused) invalidates /v1/models immediately', async () => {
    const before = await models()
    expect(before).toContain('SelectiveMain')

    const res = await patch('sel1', { status: 'paused' })
    expect(res.status).toBe(200)

    const after = await models()
    expect(after).not.toContain('SelectiveMain')
    expect(after).toContain('SelectiveFallback')

    await patch('sel1', { status: 'active' })
  })

  it('a PATCH to the display name invalidates /v1/models', async () => {
    const res = await patch('sel1', { name: 'SelectiveRenamed' })
    expect(res.status).toBe(200)

    const after = await models()
    expect(after).toContain('SelectiveRenamed')
    expect(after).not.toContain('SelectiveMain')

    await patch('sel1', { name: 'SelectiveMain' })
  })
})

import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from 'vitest'
import express from 'express'

let dbMod
let encrypt, dbRun, dbGet, dbAll, closeDb
let classifyHealthCheckError, probeProvider, runHealthCheck, checkProviderNow

function mockResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  }
}

const realFetch = globalThis.fetch

function stubFetch(mapping) {
  vi.stubGlobal('fetch', async (url, options) => {
    if (String(url).startsWith('http://localhost')) return realFetch(url, options)
    const found = mapping.find(([base]) => String(url).includes(base))
    if (!found) return mockResponse(200, { id: 'cmpl-default' })
    return mockResponse(found[1], found[2])
  })
}

function insertProvider(id, { apiUrl, status = 'active', healthFailures = 0, capability = 'chat' }) {
  dbRun(
    `INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label, status, health_failures, cooldown_after_failures, cooldown_duration_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, id, apiUrl, encrypt('sk-test'), 'model-x', capability, 'openai-compatible', 0, 'Main', status, healthFailures, 5, 300]
  )
}

beforeAll(async () => {
  dbMod = await import('../src/db.js')
  dbMod.setDbPath(':memory:')
  encrypt = dbMod.encrypt
  dbRun = dbMod.dbRun
  dbGet = dbMod.dbGet
  dbAll = dbMod.dbAll
  closeDb = dbMod.closeDb
  dbMod.initDb()

  const hc = await import('../src/services/healthCheck.js')
  classifyHealthCheckError = hc.classifyHealthCheckError
  probeProvider = hc.probeProvider
  runHealthCheck = hc.runHealthCheck
  checkProviderNow = hc.checkProviderNow
})

afterEach(() => {
  vi.unstubAllGlobals()
  dbRun("DELETE FROM provider_health_checks")
  dbRun("DELETE FROM circuit_breaker_state")
  dbRun('DELETE FROM providers')
})

afterAll(() => {
  closeDb()
})

describe('classifyHealthCheckError', () => {
  it('treats a healthy response as no classification', () => {
    expect(classifyHealthCheckError(null)).toEqual({ kind: 'network', action: 'cooldown' })
  })

  it('pauses permanent errors (auth, quota, not-found, model)', () => {
    expect(classifyHealthCheckError({ status: 401 })).toEqual({ kind: 'auth', action: 'paused' })
    expect(classifyHealthCheckError({ status: 403 })).toEqual({ kind: 'auth', action: 'paused' })
    expect(classifyHealthCheckError({ status: 402 })).toEqual({ kind: 'quota', action: 'paused' })
    expect(classifyHealthCheckError({ status: 404 })).toEqual({ kind: 'not_found', action: 'paused' })
    expect(classifyHealthCheckError({ status: 429, data: { error: { type: 'insufficient_quota' } } })).toEqual({ kind: 'quota', action: 'paused' })
    expect(classifyHealthCheckError({ status: 400, message: 'Model does not exist', data: { error: { message: 'Model does not exist' } } })).toEqual({ kind: 'model', action: 'paused' })
  })

  it('cooldowns transient errors (rate, server, timeout, network)', () => {
    expect(classifyHealthCheckError({ status: 429, data: { error: { type: 'rate_limit_exceeded' } } })).toEqual({ kind: 'rate', action: 'cooldown' })
    expect(classifyHealthCheckError({ status: 408 })).toEqual({ kind: 'server', action: 'cooldown' })
    expect(classifyHealthCheckError({ status: 500 })).toEqual({ kind: 'server', action: 'cooldown' })
    expect(classifyHealthCheckError({ status: 503 })).toEqual({ kind: 'server', action: 'cooldown' })
    expect(classifyHealthCheckError({ name: 'AbortError' })).toEqual({ kind: 'timeout', action: 'cooldown' })
    expect(classifyHealthCheckError({})).toEqual({ kind: 'network', action: 'cooldown' })
  })
})

describe('probeProvider', () => {
  it('returns ok when the provider answers 200', async () => {
    const provider = { id: 'probe-ok', api_url: 'https://probe-ok.example.com/v1', api_key: 'sk', model: 'm', provider_type: 'openai-compatible', capability: 'chat' }
    stubFetch([['probe-ok.example.com', 200, { id: 'cmpl-1' }]])
    const result = await probeProvider(provider)
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('returns the provider error status on failure', async () => {
    const provider = { id: 'probe-err', api_url: 'https://probe-err.example.com/v1', api_key: 'sk', model: 'm', provider_type: 'openai-compatible', capability: 'chat' }
    stubFetch([['probe-err.example.com', 429, { error: { message: 'Rate limit', type: 'rate_limit_error' } }]])
    const result = await probeProvider(provider)
    expect(result.ok).toBe(false)
    expect(result.status).toBe(429)
    expect(result.errorMessage).toMatch(/Rate limit/i)
  })
})

describe('runHealthCheck', () => {
  it('keeps healthy providers active and records ok rows', async () => {
    insertProvider('h1', { apiUrl: 'https://h1.example.com/v1' })
    stubFetch([['h1.example.com', 200, { id: 'cmpl-1' }]])
    await runHealthCheck()
    const p = dbGet('SELECT status, health_failures FROM providers WHERE id = ?', ['h1'])
    expect(p.status).toBe('active')
    expect(p.health_failures).toBe(0)
    const row = dbGet('SELECT * FROM provider_health_checks WHERE provider_id = ?', ['h1'])
    expect(row.status).toBe('ok')
    expect(row.action_taken).toBe('none')
  })

  it('moves a rate-limited provider to cooldown with a future cooldown_until', async () => {
    insertProvider('r1', { apiUrl: 'https://r1.example.com/v1' })
    stubFetch([['r1.example.com', 429, { error: { message: 'Rate limit', type: 'rate_limit_exceeded' } }]])
    await runHealthCheck()
    const p = dbGet('SELECT status, cooldown_until, health_failures FROM providers WHERE id = ?', ['r1'])
    expect(p.status).toBe('cooldown')
    expect(p.health_failures).toBe(1)
    expect(new Date(p.cooldown_until).getTime()).toBeGreaterThan(Date.now())
    const cb = dbGet('SELECT state FROM circuit_breaker_state WHERE provider_id = ?', ['r1'])
    expect(cb.state).toBe('cooldown')
  })

  it('pauses a provider on a permanent quota error', async () => {
    insertProvider('q1', { apiUrl: 'https://q1.example.com/v1' })
    stubFetch([['q1.example.com', 429, { error: { type: 'insufficient_quota', message: 'Insufficient quota' } }]])
    await runHealthCheck()
    const p = dbGet('SELECT status, health_failures FROM providers WHERE id = ?', ['q1'])
    expect(p.status).toBe('paused')
    const row = dbGet('SELECT * FROM provider_health_checks WHERE provider_id = ?', ['q1'])
    expect(row.status).toBe('error')
    expect(row.new_status).toBe('paused')
    expect(row.action_taken).toBe('paused')
    expect(row.error_type).toBe('quota')
  })

  it('escalates a persistent transient failure to paused after the threshold', async () => {
    insertProvider('e1', { apiUrl: 'https://e1.example.com/v1', healthFailures: 1 })
    stubFetch([['e1.example.com', 500, { error: { message: 'boom' } }]])
    await runHealthCheck()
    const p = dbGet('SELECT status FROM providers WHERE id = ?', ['e1'])
    expect(p.status).toBe('paused')
  })

  it('skips providers that are not active', async () => {
    insertProvider('ok1', { apiUrl: 'https://ok1.example.com/v1' })
    insertProvider('pa1', { apiUrl: 'https://pa1.example.com/v1', status: 'paused' })
    stubFetch([
      ['ok1.example.com', 200, { id: 'cmpl-1' }],
      ['pa1.example.com', 200, { id: 'cmpl-1' }],
    ])
    await runHealthCheck()
    const rows = dbAll('SELECT provider_id FROM provider_health_checks')
    expect(rows.map(r => r.provider_id).sort()).toEqual(['ok1'])
  })

  it('truncates the table on each run (no history)', async () => {
    insertProvider('t1', { apiUrl: 'https://t1.example.com/v1' })
    insertProvider('t2', { apiUrl: 'https://t2.example.com/v1' })
    stubFetch([
      ['t1.example.com', 200, { id: 'cmpl-1' }],
      ['t2.example.com', 200, { id: 'cmpl-1' }],
    ])
    await runHealthCheck()
    await runHealthCheck()
    const rows = dbAll('SELECT provider_id FROM provider_health_checks')
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.provider_id).sort()).toEqual(['t1', 't2'])
  })
})

describe('checkProviderNow', () => {
  it('reactivates a paused provider when it answers correctly', async () => {
    insertProvider('re1', { apiUrl: 'https://re1.example.com/v1', status: 'paused' })
    stubFetch([['re1.example.com', 200, { id: 'cmpl-1' }]])
    const result = await checkProviderNow('re1')
    expect(result.new_status).toBe('active')
    expect(result.action_taken).toBe('reactivated')
    const p = dbGet('SELECT status, health_failures FROM providers WHERE id = ?', ['re1'])
    expect(p.status).toBe('active')
    expect(p.health_failures).toBe(0)
  })

  it('upserts a single row without keeping history', async () => {
    insertProvider('up1', { apiUrl: 'https://up1.example.com/v1', status: 'paused' })
    stubFetch([['up1.example.com', 200, { id: 'cmpl-1' }]])
    await checkProviderNow('up1')
    await checkProviderNow('up1')
    const rows = dbAll('SELECT provider_id FROM provider_health_checks')
    expect(rows).toHaveLength(1)
  })

  it('throws for an unknown provider', async () => {
    await expect(checkProviderNow('missing')).rejects.toThrow('Provider not found')
  })
})

describe('health routes', () => {
  let server
  let baseUrl

  beforeAll(async () => {
    const { default: healthRoutes } = await import('../src/routes/health.routes.js')
    const app = express()
    app.use(express.json())
    app.use('/admin/api/health', healthRoutes)
    server = app.listen(0)
    await new Promise(r => server.once('listening', r))
    baseUrl = `http://localhost:${server.address().port}`
  })

  afterAll(async () => {
    if (server) await new Promise(r => server.close(r))
  })

  it('GET returns the current provider health state', async () => {
    insertProvider('rt1', { apiUrl: 'https://rt1.example.com/v1' })
    stubFetch([
      ['rt1.example.com', 200, { id: 'cmpl-1' }],
    ])
    await runHealthCheck()

    const res = await fetch(`${baseUrl}/admin/api/health`)
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.summary.total).toBe(1)
    expect(data.summary.ok).toBe(1)
    expect(data.providers[0].provider_name).toBe('rt1')
    expect(data.providers[0].check_status).toBe('ok')
  })

  it('POST /check runs a single provider and returns results', async () => {
    insertProvider('rt2', { apiUrl: 'https://rt2.example.com/v1' })
    stubFetch([['rt2.example.com', 429, { error: { message: 'Rate limit', type: 'rate_limit_exceeded' } }]])
    const res = await fetch(`${baseUrl}/admin/api/health/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider_id: 'rt2' }),
    })
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.results).toHaveLength(1)
    expect(data.results[0].provider_id).toBe('rt2')
    expect(data.results[0].new_status).toBe('cooldown')
  })
})

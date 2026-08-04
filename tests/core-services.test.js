import { beforeAll, afterAll, describe, it, expect } from 'vitest'

let setDbPath, initDb, closeDb, dbRun, dbGet, dbAll, encrypt, hashApiKey
let recordSuccess, recordFailure
let enqueueLog, enqueueMetric, enqueueApiKeyTouch, flushAll
let getLogs, getMetrics
let assertPublicUrl

beforeAll(async () => {
  const dbMod = await import('../src/db.js')
  setDbPath = dbMod.setDbPath
  initDb = dbMod.initDb
  closeDb = dbMod.closeDb
  dbRun = dbMod.dbRun
  dbGet = dbMod.dbGet
  dbAll = dbMod.dbAll
  encrypt = dbMod.encrypt
  hashApiKey = dbMod.hashApiKey

  setDbPath(':memory:')
  initDb()

  dbRun(
    `INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label,
     rate_limit_req_per_min, tokens_per_day, cooldown_after_failures, cooldown_duration_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['cb1', 'Circuit', 'https://cb.example.com/v1', encrypt('sk-cb'), 'gpt-4o', 'chat', 'openai-compatible', 0, 'Main', 60, 0, 3, 300]
  )

  const cb = await import('../src/services/circuitBreaker.js')
  recordSuccess = cb.recordSuccess
  recordFailure = cb.recordFailure

  const lq = await import('../src/services/logQueue.js')
  enqueueLog = lq.enqueueLog
  enqueueMetric = lq.enqueueMetric
  enqueueApiKeyTouch = lq.enqueueApiKeyTouch
  flushAll = lq.flushAll

  const ml = await import('../src/services/metricsLogger.js')
  getLogs = ml.getLogs
  getMetrics = ml.getMetrics

  const ssrf = await import('../src/utils/ssrf.js')
  assertPublicUrl = ssrf.assertPublicUrl
})

afterAll(() => closeDb())

describe('circuitBreaker', () => {
  it('opens the circuit (cooldown) after the failure threshold', () => {
    dbRun("UPDATE providers SET status = 'active' WHERE id = 'cb1'")
    recordFailure('cb1', 3, 300)
    recordFailure('cb1', 3, 300)
    recordFailure('cb1', 3, 300)

    const state = dbGet("SELECT * FROM circuit_breaker_state WHERE provider_id = 'cb1'")
    expect(state.state).toBe('cooldown')
    expect(state.failure_count).toBe(3)
    expect(state.cooldown_until).toBeTruthy()

    const provider = dbGet("SELECT status, cooldown_until FROM providers WHERE id = 'cb1'")
    expect(provider.status).toBe('cooldown')
    expect(provider.cooldown_until).toBeTruthy()
  })

  it('closes the circuit and reactivates the provider on success', () => {
    recordSuccess('cb1')

    const state = dbGet("SELECT * FROM circuit_breaker_state WHERE provider_id = 'cb1'")
    expect(state.state).toBe('healthy')
    expect(state.failure_count).toBe(0)

    const provider = dbGet("SELECT status, cooldown_until FROM providers WHERE id = 'cb1'")
    expect(provider.status).toBe('active')
    expect(provider.cooldown_until).toBeNull()
  })

  it('recordSuccess on an already-healthy provider is a no-op', () => {
    const beforeState = dbGet("SELECT * FROM circuit_breaker_state WHERE provider_id = 'cb1'")
    const beforeProvider = dbGet("SELECT status, cooldown_until FROM providers WHERE id = 'cb1'")

    recordSuccess('cb1')

    const afterState = dbGet("SELECT * FROM circuit_breaker_state WHERE provider_id = 'cb1'")
    const afterProvider = dbGet("SELECT status, cooldown_until FROM providers WHERE id = 'cb1'")
    expect(afterState.state).toBe('healthy')
    expect(afterState.failure_count).toBe(0)
    expect(afterState.updated_at).toBe(beforeState.updated_at)
    expect(afterProvider.status).toBe(beforeProvider.status)
    expect(afterProvider.cooldown_until).toBe(beforeProvider.cooldown_until)
  })
})

describe('logQueue', () => {
  it('flushes logs, metrics and api key touches to sqlite', () => {
    dbRun("INSERT INTO api_keys (id, key_hash, key_prefix, name) VALUES (?, ?, ?, ?)", ['lk1', hashApiKey('llm_pk_log_key'), 'llm_pk_lo', 'log test'])

    enqueueLog({
      providerId: 'cb1', endpoint: '/v1/chat/completions', requestBody: { messages: [] },
      originIp: '127.0.0.1', statusCode: 200, inputTokens: 10, outputTokens: 5,
      responseTimeMs: 42, authenticatedVia: 'api_key', cacheHit: false,
    })
    enqueueMetric('cb1', { inputTokens: 10, outputTokens: 5, cost: 0.01, responseTimeMs: 42, cacheHit: false })
    enqueueApiKeyTouch('lk1')
    flushAll()

    const log = dbGet("SELECT * FROM requests_log WHERE provider_id = 'cb1'")
    expect(log).toBeTruthy()
    expect(log.total_tokens).toBe(15)
    expect(log.status_code).toBe(200)

    const metric = dbGet("SELECT * FROM metrics WHERE provider_id = 'cb1'")
    expect(metric).toBeTruthy()
    expect(metric.total_input_tokens).toBe(10)
    expect(metric.total_requests).toBe(1)

    const key = dbGet("SELECT last_used_at FROM api_keys WHERE id = 'lk1'")
    expect(key.last_used_at).toBeTruthy()
  })
})

describe('metricsLogger', () => {
  it('returns logs with pagination metadata', () => {
    const inserted = dbAll("SELECT COUNT(*) AS c FROM requests_log")[0].c
    const page1 = getLogs(2, 0)
    expect(page1.logs.length).toBe(Math.min(2, inserted))
    expect(page1.total).toBe(inserted)

    const page2 = getLogs(2, 2)
    expect(page2.logs.length).toBe(Math.max(0, Math.min(2, inserted - 2)))
    expect(page2.total).toBe(inserted)
  })

  it('returns aggregated metrics per provider', () => {
    const result = getMetrics('1970-01-01', '2999-12-31')
    const row = result.providers.find(p => p.provider_id === 'cb1')
    expect(row).toBeTruthy()
    expect(row.total_requests).toBeGreaterThanOrEqual(1)
    expect(typeof result.totals.total_requests).toBe('number')
  })
})

describe('ssrf guard', () => {
  it('rejects localhost and loopback URLs', async () => {
    await expect(assertPublicUrl('http://localhost:3000/v1')).rejects.toThrow(/localhost/i)
    await expect(assertPublicUrl('http://127.0.0.1:8080')).rejects.toThrow(/private|loopback/i)
  })

  it('rejects private and link-local addresses', async () => {
    await expect(assertPublicUrl('http://10.0.0.5')).rejects.toThrow(/private|loopback/i)
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/private|loopback/i)
  })

  it('rejects non-http(s) protocols', async () => {
    await expect(assertPublicUrl('ftp://example.com/file')).rejects.toThrow(/protocol/i)
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/protocol/i)
  })

  it('rejects malformed URLs', async () => {
    await expect(assertPublicUrl('not a url')).rejects.toThrow()
  })

  it('allows public https URLs', async () => {
    await expect(assertPublicUrl('https://api.openai.com/v1')).resolves.toBeUndefined()
  })
})

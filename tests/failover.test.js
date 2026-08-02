
let selectProviders, isProviderAvailable, isRateLimitExceeded, isDailyLimitExceeded, getCapabilityFromBody, encrypt, isRetryableError, recordProviderRequest

beforeAll(async () => {
  const dbMod = await import('../src/db.js')
  dbMod.setDbPath(':memory:')
  encrypt = dbMod.encrypt
  dbMod.initDb()

  const failMod = await import('../src/services/failoverEngine.js')
  selectProviders = failMod.selectProviders
  isProviderAvailable = failMod.isProviderAvailable
  isRateLimitExceeded = failMod.isRateLimitExceeded
  isDailyLimitExceeded = failMod.isDailyLimitExceeded
  getCapabilityFromBody = failMod.getCapabilityFromBody
  isRetryableError = failMod.isRetryableError
  recordProviderRequest = failMod.recordProviderRequest

  const { dbRun } = dbMod
  dbRun(
    `INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label, rate_limit_req_per_min, tokens_per_day)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['p1', 'Main', 'https://api.example.com/v1', encrypt('sk-test'), 'gpt-4', 'chat', 'openai-compatible', 0, 'Main', 60, 10000]
  )
  dbRun(
    `INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label, rate_limit_req_per_min, tokens_per_day)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['p2', 'Fallback', 'https://api.example.com/v1', encrypt('sk-test2'), 'claude-3', 'chat', 'openai-compatible', 1, 'Fallback 1', 60, 10000]
  )
  dbRun(
    `INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label, status, cooldown_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['p3', 'Cooldown', 'https://api.example.com/v1', encrypt('sk-test3'), 'mixtral', 'chat', 'openai-compatible', 2, 'Fallback 2', 'cooldown', new Date(Date.now() + 3600000).toISOString()]
  )
})

afterAll(async () => {
  const dbMod = await import('../src/db.js')
  dbMod.closeDb()
})

describe('FailoverEngine', () => {
  it('selects active providers ordered by position, excluding cooldown', () => {
    const providers = selectProviders('chat')
    expect(providers).toHaveLength(2)
    expect(providers[0].id).toBe('p1')
    expect(providers[1].id).toBe('p2')
  })

  it('selects providers by capability', () => {
    const providers = selectProviders('embeddings')
    expect(providers).toHaveLength(0)
  })

  it('detects available provider', () => {
    expect(isProviderAvailable({ status: 'active' })).toBe(true)
    expect(isProviderAvailable({ status: 'paused' })).toBe(false)
    expect(isProviderAvailable({
      status: 'active',
      cooldown_until: new Date(Date.now() + 3600000).toISOString(),
    })).toBe(false)
    expect(isProviderAvailable({
      status: 'active',
      cooldown_until: new Date(Date.now() - 3600000).toISOString(),
    })).toBe(true)
  })

  it('rate limit check returns false when below limit', () => {
    const exceeded = isRateLimitExceeded({ id: 'p1', rate_limit_req_per_min: 60 })
    expect(exceeded).toBe(false)
  })

  it('rate limit check returns false when limit is 0 (unlimited)', () => {
    const exceeded = isRateLimitExceeded({ id: 'p1', rate_limit_req_per_min: 0 })
    expect(exceeded).toBe(false)
  })

  it('daily limit check returns false when below limit', () => {
    const exceeded = isDailyLimitExceeded({ id: 'p1', tokens_per_day: 10000 })
    expect(exceeded).toBe(false)
  })

  it('daily limit check returns false when limit is 0 (unlimited)', () => {
    const exceeded = isDailyLimitExceeded({ id: 'p1', tokens_per_day: 0 })
    expect(exceeded).toBe(false)
  })

  it('detects capability from body', () => {
    expect(getCapabilityFromBody({ messages: [] })).toBe('chat')
    expect(getCapabilityFromBody({ input: 'hello' })).toBe('embeddings')
    expect(getCapabilityFromBody({})).toBe('chat')
  })

  it('includes cooldown provider when cooldown_until is in the past', async () => {
    const dbMod = await import('../src/db.js')
    dbMod.dbRun('UPDATE providers SET cooldown_until = datetime(\'now\', \'-1 hour\') WHERE id = ?', ['p3'])
    const providers = selectProviders('chat')
    const ids = providers.map(p => p.id)
    expect(ids).toContain('p3')
    dbMod.dbRun('UPDATE providers SET cooldown_until = ? WHERE id = ?', [new Date(Date.now() + 3600000).toISOString(), 'p3'])
  })

  it('isRetryableError: 4xx errors are not retryable', () => {
    expect(isRetryableError({ status: 400 })).toBe(false)
    expect(isRetryableError({ status: 401 })).toBe(false)
    expect(isRetryableError({ status: 404 })).toBe(false)
  })

  it('isRetryableError: 5xx, 408, 429, network and abort errors are retryable', () => {
    expect(isRetryableError({ status: 500 })).toBe(true)
    expect(isRetryableError({ status: 502 })).toBe(true)
    expect(isRetryableError({ status: 408 })).toBe(true)
    expect(isRetryableError({ status: 429 })).toBe(true)
    expect(isRetryableError({ name: 'AbortError' })).toBe(true)
    expect(isRetryableError({})).toBe(true)
    expect(isRetryableError(null)).toBe(false)
  })

  it('in-memory rate limit counts recorded provider requests', () => {
    const id = 'rl-test-bucket'
    recordProviderRequest(id)
    recordProviderRequest(id)
    recordProviderRequest(id)
    expect(isRateLimitExceeded({ id, rate_limit_req_per_min: 3 })).toBe(true)
    expect(isRateLimitExceeded({ id, rate_limit_req_per_min: 4 })).toBe(false)
    expect(isRateLimitExceeded({ id, rate_limit_req_per_min: 0 })).toBe(false)
  })

  it('daily limit uses metrics table aggregation', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const dbMod = await import('../src/db.js')
    dbMod.dbRun(
      `INSERT INTO metrics (id, provider_id, metric_date, total_requests, total_input_tokens, total_output_tokens, total_cost, avg_response_time_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['m-rl-1', 'p1', today, 1, 6000, 0, 0, 10]
    )
    expect(isDailyLimitExceeded({ id: 'p1', tokens_per_day: 10000 })).toBe(false)
    expect(isDailyLimitExceeded({ id: 'p1', tokens_per_day: 5000 })).toBe(true)
  })
})

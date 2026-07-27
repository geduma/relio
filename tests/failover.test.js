
let selectProviders, isProviderAvailable, isRateLimitExceeded, isDailyLimitExceeded, getModelTypeFromBody

beforeAll(async () => {
  process.env.DB_PATH = ':memory:'
  process.env.CACHE_TTL_SECONDS = '3600'

  const dbMod = await import('../src/db.js')
  dbMod.initDb()

  const failMod = await import('../src/services/failoverEngine.js')
  selectProviders = failMod.selectProviders
  isProviderAvailable = failMod.isProviderAvailable
  isRateLimitExceeded = failMod.isRateLimitExceeded
  isDailyLimitExceeded = failMod.isDailyLimitExceeded
  getModelTypeFromBody = failMod.getModelTypeFromBody

  const { dbRun } = dbMod
  dbRun(
    `INSERT INTO providers (id, name, api_url, api_key, model, type, order_position, order_label, rate_limit_req_per_min, tokens_per_day)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['p1', 'Main', 'https://api.openai.com/v1', 'sk-test', 'gpt-4', 'chat', 0, 'Main', 60, 10000]
  )
  dbRun(
    `INSERT INTO providers (id, name, api_url, api_key, model, type, order_position, order_label, rate_limit_req_per_min, tokens_per_day)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['p2', 'Fallback', 'https://api.anthropic.com/v1', 'sk-test2', 'claude-3', 'chat', 1, 'Fallback 1', 60, 10000]
  )
  dbRun(
    `INSERT INTO providers (id, name, api_url, api_key, model, type, order_position, order_label, status, cooldown_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['p3', 'Cooldown', 'https://api.groq.com/v1', 'sk-test3', 'mixtral', 'chat', 2, 'Fallback 2', 'cooldown', new Date(Date.now() + 3600000).toISOString()]
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

  it('detects model type from body', () => {
    expect(getModelTypeFromBody({ messages: [] })).toBe('chat')
    expect(getModelTypeFromBody({ input: 'hello' })).toBe('embeddings')
    expect(getModelTypeFromBody({})).toBe('chat')
  })
})

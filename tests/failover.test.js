
let selectProviders, isProviderAvailable, isRateLimitExceeded, isDailyLimitExceeded, getCapabilityFromBody, callProvider, encrypt

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
  callProvider = failMod.callProvider

  const { dbRun } = dbMod
  dbRun(
    `INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label, rate_limit_req_per_min, tokens_per_day)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['p1', 'Main', 'https://api.openai.com/v1', encrypt('sk-test'), 'gpt-4', 'chat', 'openai-compatible', 0, 'Main', 60, 10000]
  )
  dbRun(
    `INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label, rate_limit_req_per_min, tokens_per_day)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['p2', 'Fallback', 'https://api.anthropic.com/v1', encrypt('sk-test2'), 'claude-3', 'chat', 'openai-compatible', 1, 'Fallback 1', 60, 10000]
  )
  dbRun(
    `INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label, status, cooldown_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['p3', 'Cooldown', 'https://api.groq.com/v1', encrypt('sk-test3'), 'mixtral', 'chat', 'openai-compatible', 2, 'Fallback 2', 'cooldown', new Date(Date.now() + 3600000).toISOString()]
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

  it('callProvider throws with no network (no actual HTTP)', async () => {
    const provider = {
      api_url: 'https://nonexistent.invalid/api',
      api_key: 'sk-test',
      provider_type: 'openai-compatible',
    }
    await expect(callProvider(provider, { messages: [{ role: 'user', content: 'hi' }] }, null))
      .rejects.toThrow()
  })

  it('excludes providers in cooldown', () => {
    const providers = selectProviders('chat')
    const cooldownIds = providers.map(p => p.id)
    expect(cooldownIds).not.toContain('p3')
  })

  it('includes cooldown provider when cooldown_until is in the past', async () => {
    const dbMod = await import('../src/db.js')
    dbMod.dbRun('UPDATE providers SET cooldown_until = datetime(\'now\', \'-1 hour\') WHERE id = ?', ['p3'])
    const providers = selectProviders('chat')
    const ids = providers.map(p => p.id)
    expect(ids).toContain('p3')
    dbMod.dbRun('UPDATE providers SET cooldown_until = ? WHERE id = ?', [new Date(Date.now() + 3600000).toISOString(), 'p3'])
  })
})

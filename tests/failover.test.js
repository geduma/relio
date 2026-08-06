
let selectProviders, isProviderAvailable, isRateLimitExceeded, isDailyLimitExceeded, getCapabilityFromBody, encrypt, isRetryableError, recordProviderRequest, clearDailyLimitCache, classifyProviderError, isQuotaError, extractRetryAfter

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
  clearDailyLimitCache = failMod.clearDailyLimitCache
  classifyProviderError = failMod.classifyProviderError
  isQuotaError = failMod.isQuotaError
  extractRetryAfter = failMod.extractRetryAfter

  const { dbRun } = dbMod
  dbRun(
    `INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label, rate_limit_req_per_min, tokens_per_day)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['p1', 'Main', 'https://api.example.com/v1', encrypt('sk-test'), 'model-chat', 'chat', 'openai-compatible', 0, 'Main', 60, 10000]
  )
  dbRun(
    `INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label, rate_limit_req_per_min, tokens_per_day)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['p2', 'Fallback', 'https://api.example.com/v1', encrypt('sk-test2'), 'model-claude', 'chat', 'openai-compatible', 1, 'Fallback 1', 60, 10000]
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
    const dbMod = await import('../src/db.js')
    dbMod.dbRun(
      `INSERT INTO metrics (id, provider_id, metric_date, total_requests, total_input_tokens, total_output_tokens, total_cost, avg_response_time_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['m-rl-1', 'p1', new Date().toISOString().slice(0, 10), 1, 6000, 0, 0, 10]
    )
    clearDailyLimitCache()
    expect(isDailyLimitExceeded({ id: 'p1', tokens_per_day: 10000 })).toBe(false)
    expect(isDailyLimitExceeded({ id: 'p1', tokens_per_day: 5000 })).toBe(true)
  })
})

describe('classifyProviderError', () => {
  const openAiProvider = { provider_type: 'openai-compatible' }
  const anthropicProvider = { provider_type: 'anthropic' }

  it('maps 402 to quota cooldown for non-anthropic providers', () => {
    const err = { status: 402, data: { error: { message: 'Insufficient credits', type: 'billing_error' } } }
    expect(classifyProviderError(err, openAiProvider)).toEqual({ retryable: true, immediateCooldown: 'quota' })
  })

  it('maps 402 from anthropic to rate cooldown (Max plan rate limit)', () => {
    const err = { status: 402, data: { error: { message: 'Rate limit reached', type: 'rate_limit_error' } } }
    expect(classifyProviderError(err, anthropicProvider)).toEqual({ retryable: true, immediateCooldown: 'rate' })
  })

  it('maps 429 quota billing bodies to quota cooldown', () => {
    const quotaErr = { status: 429, data: { error: { message: 'billing not active', type: 'insufficient_quota' } } }
    expect(classifyProviderError(quotaErr, openAiProvider)).toEqual({ retryable: true, immediateCooldown: 'quota' })
  })

  it('maps 429 with OpenAI spend-limit codes to quota cooldown', () => {
    const spendErr = { status: 429, data: { error: { code: 'organization_spend_limit_exceeded' } } }
    expect(classifyProviderError(spendErr, openAiProvider)).toEqual({ retryable: true, immediateCooldown: 'quota' })
  })

  it('maps 429 rate-limit bodies to rate cooldown', () => {
    const rateErr = { status: 429, data: { error: { message: 'Rate limit reached', type: 'rate_limit_exceeded' } } }
    expect(classifyProviderError(rateErr, openAiProvider)).toEqual({ retryable: true, immediateCooldown: 'rate' })
  })

  it('maps 429 with "retry in Ns" message to rate cooldown even if quota words appear', () => {
    const err = { status: 429, data: { error: { message: 'Please retry in 15.00s', type: 'RESOURCE_EXHAUSTED' } } }
    expect(classifyProviderError(err, openAiProvider)).toEqual({ retryable: true, immediateCooldown: 'rate' })
  })

  it('maps 413 to retryable with no immediate cooldown', () => {
    const err = { status: 413, data: { error: { message: 'Request too large' } } }
    expect(classifyProviderError(err, openAiProvider)).toEqual({ retryable: true, immediateCooldown: 'none' })
  })

  it('maps 400 provider render errors (groq Harmony) to retryable with no cooldown', () => {
    const err = { status: 400, message: 'Tools should have a name!', data: { error: { message: 'Tools should have a name!' } } }
    expect(classifyProviderError(err, openAiProvider)).toEqual({ retryable: true, immediateCooldown: 'none' })
  })

  it('keeps plain 400 errors non-retryable', () => {
    const err = { status: 400, data: { error: { message: 'Invalid parameters' } } }
    expect(classifyProviderError(err, openAiProvider)).toEqual({ retryable: false, immediateCooldown: null })
  })

  it('maps 529 overloaded and generic 5xx to the circuit breaker', () => {
    expect(classifyProviderError({ status: 529, data: { error: { type: 'overloaded_error' } } }, anthropicProvider)).toEqual({ retryable: true, immediateCooldown: 'circuit' })
    expect(classifyProviderError({ status: 503 }, openAiProvider)).toEqual({ retryable: true, immediateCooldown: 'circuit' })
    expect(classifyProviderError({ status: 408 }, openAiProvider)).toEqual({ retryable: true, immediateCooldown: 'circuit' })
    expect(classifyProviderError({ name: 'AbortError' }, openAiProvider)).toEqual({ retryable: true, immediateCooldown: 'circuit' })
    expect(classifyProviderError({}, openAiProvider)).toEqual({ retryable: true, immediateCooldown: 'circuit' })
  })

  it('keeps 401/403/404 non-retryable', () => {
    for (const status of [401, 403, 404]) {
      expect(classifyProviderError({ status }, openAiProvider).retryable).toBe(false)
    }
  })
})

describe('isQuotaError', () => {
  it('detects quota/billing markers in the error body', () => {
    expect(isQuotaError({ error: { message: 'Insufficient quota' } })).toBe(true)
    expect(isQuotaError({ error: { code: 'credit_balance_exhausted' } })).toBe(true)
    expect(isQuotaError({ error: { type: 'quota_exceeded', message: 'billing' } })).toBe(true)
  })

  it('does not tag rate-limit bodies as quota', () => {
    expect(isQuotaError({ error: { type: 'rate_limit_exceeded' } })).toBe(false)
    expect(isQuotaError({ error: { message: 'Please try again in 25.62s' } })).toBe(false)
    expect(isQuotaError({ error: { retry_after_seconds: 30, message: 'billing' } })).toBe(false)
    expect(isQuotaError(null)).toBe(false)
    expect(isQuotaError('text')).toBe(false)
  })
})

describe('extractRetryAfter', () => {
  it('prefers err.retryAfter set from headers', () => {
    expect(extractRetryAfter({ retryAfter: 27 })).toBe(27)
    expect(extractRetryAfter({ retryAfter: 0 })).toBe(null)
  })

  it('parses retry_after_seconds from the provider body', () => {
    expect(extractRetryAfter({ data: { error: { retry_after_seconds: 8.5 } } })).toBe(9)
  })

  it('parses "retry in Ns" from the provider body', () => {
    expect(extractRetryAfter({ data: { error: { message: 'Please retry in 15.00s' } } })).toBe(15)
  })

  it('returns null when nothing indicates a retry time', () => {
    expect(extractRetryAfter({ status: 402 })).toBe(null)
    expect(extractRetryAfter(null)).toBe(null)
  })
})

describe('recordProviderFailure', () => {
  let recordProviderFailure
  let dbMod

  beforeAll(async () => {
    const cb = await import('../src/services/circuitBreaker.js')
    recordProviderFailure = cb.recordProviderFailure
    dbMod = await import('../src/db.js')
  })

  afterEach(() => {
    dbMod.dbRun("UPDATE providers SET status = 'active', cooldown_until = NULL WHERE id = 'pQ'")
    dbMod.dbRun("DELETE FROM circuit_breaker_state WHERE provider_id = 'pQ'")
  })

  it('puts the provider in an immediate quota cooldown', async () => {
    dbMod.dbRun(
      `INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['pQ', 'QuotaProbe', 'https://api.example.com/v1', encrypt('sk-q'), 'model-q', 'chat', 'openai-compatible', 9, 'Quota Probe']
    )
    recordProviderFailure({ id: 'pQ' }, 'quota')

    const row = dbMod.dbGet('SELECT status, cooldown_until FROM providers WHERE id = ?', ['pQ'])
    expect(row.status).toBe('cooldown')
    const remaining = new Date(row.cooldown_until).getTime() - Date.now()
    expect(remaining).toBeGreaterThan(3000 * 1000 - 60000)
    expect(remaining).toBeLessThanOrEqual(3600 * 1000)
  })

  it('uses retryAfter for rate cooldowns and caps it', async () => {
    recordProviderFailure({ id: 'pQ' }, 'rate', 30)
    const row = dbMod.dbGet('SELECT cooldown_until FROM providers WHERE id = ?', ['pQ'])
    const remaining = new Date(row.cooldown_until).getTime() - Date.now()
    expect(remaining).toBeGreaterThan(28 * 1000)
    expect(remaining).toBeLessThanOrEqual(30 * 1000)
  })

  it('does nothing for non-cooldown kinds', async () => {
    recordProviderFailure({ id: 'pQ' }, 'none')
    recordProviderFailure({ id: 'pQ' }, 'circuit')
    recordProviderFailure({ id: 'pQ' }, null)
    const row = dbMod.dbGet('SELECT status FROM providers WHERE id = ?', ['pQ'])
    expect(row.status).toBe('active')
  })
})

import { beforeAll, afterAll, describe, it, expect } from 'vitest'

let setDbPath, initDb, closeDb, dbRun, encrypt
let FAILOVER_MODEL, parseModelSelector, resolveProvider, stripModel
let processRequest

const calls = []

beforeAll(async () => {
  const dbMod = await import('../src/db.js')
  setDbPath = dbMod.setDbPath
  initDb = dbMod.initDb
  closeDb = dbMod.closeDb
  dbRun = dbMod.dbRun
  encrypt = dbMod.encrypt

  setDbPath(':memory:')
  initDb()

  const fail = await import('../src/services/failoverEngine.js')
  FAILOVER_MODEL = fail.FAILOVER_MODEL
  parseModelSelector = fail.parseModelSelector
  resolveProvider = fail.resolveProvider
  stripModel = fail.stripModel

  const req = await import('../src/handlers/requestHandler.js')
  processRequest = req.processRequest

  const seed = [
    ['pA', 'AlphaChat', 'https://alpha.example.com/v1', 'sk-a', 'gpt-4o', 'chat', 'openai-compatible', 0, 'Main'],
    ['pB', 'BetaClaude', 'https://beta.example.com/v1', 'sk-b', 'claude-3-haiku', 'chat', 'anthropic', 1, 'Fallback 1'],
    ['pC', 'GammaGemini', 'https://gamma.example.com/v1', 'sk-c', 'gemini-pro', 'chat', 'gemini-native', 2, 'Fallback 2'],
    ['pE', 'EpsilonEmb', 'https://epsilon.example.com/v1', 'sk-e', 'text-embedding-3-small', 'embeddings', 'openai-compatible', 0, 'Main'],
  ]
  for (const [id, name, url, key, model, cap, type, pos, label] of seed) {
    dbRun(
      `INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name, url, encrypt(key), model, cap, type, pos, label]
    )
  }

  globalThis.fetch = async (url, opts) => {
    const u = String(url)
    const body = opts?.body ? JSON.parse(opts.body) : null
    calls.push({ url: u, body })

    if (u.includes('beta.example.com')) {
      return {
        ok: true, status: 200,
        json: async () => ({ id: 'msg_1', content: [{ type: 'text', text: 'hi' }], model: body?.model, usage: { input_tokens: 1, output_tokens: 1 } }),
      }
    }
    if (u.includes('gamma.example.com')) {
      return {
        ok: true, status: 200,
        json: async () => ({ model: u.match(/models\/([^:]+)/)?.[1], candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }),
      }
    }
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    }
  }
})

afterAll(async () => {
  closeDb()
})

describe('parseModelSelector', () => {
  it('maps "auto" to failover mode', () => {
    expect(parseModelSelector(FAILOVER_MODEL, 'chat')).toEqual({ mode: 'failover' })
    expect(parseModelSelector('AUTO', 'chat')).toEqual({ mode: 'failover' })
  })

  it('maps a provider id to provider mode', () => {
    const r = parseModelSelector('pA', 'chat')
    expect(r.mode).toBe('provider')
    expect(r.provider.id).toBe('pA')
  })

  it('maps a provider name case-insensitively to provider mode', () => {
    const r = parseModelSelector('alphaChat', 'chat')
    expect(r.mode).toBe('provider')
    expect(r.provider.name).toBe('AlphaChat')
  })

  it('rejects a provider from another capability', () => {
    expect(parseModelSelector('AlphaChat', 'embeddings')).toEqual({ error: 'unknown' })
    expect(parseModelSelector('EpsilonEmb', 'chat')).toEqual({ error: 'unknown' })
  })

  it('rejects missing and unknown models', () => {
    expect(parseModelSelector(undefined, 'chat')).toEqual({ error: 'missing' })
    expect(parseModelSelector('not-a-provider', 'chat')).toEqual({ error: 'unknown' })
  })

  it('resolves by id regardless of name casing', () => {
    const byId = resolveProvider('pB', 'chat')
    expect(byId.name).toBe('BetaClaude')
    const byName = resolveProvider('betaClaude', 'chat')
    expect(byName.id).toBe('pB')
    expect(resolveProvider('nope', 'chat')).toBeNull()
  })

  it('strips the model selector from the forwarded body', () => {
    expect(stripModel({ model: 'AlphaChat', messages: [] })).toEqual({ messages: [] })
    expect(stripModel({ model: 'auto', messages: [], temperature: 0.4 })).toEqual({ messages: [], temperature: 0.4 })
    expect(stripModel({ messages: [] })).toEqual({ messages: [] })
    expect(stripModel(undefined)).toBeUndefined()
  })
})

describe('provider-routed requests', () => {
  it('uses the provider configured model (openai-compatible, no selector forwarded)', async () => {
    const before = calls.length
    await processRequest({
      endpoint: '/v1/chat/completions',
      requestBody: { messages: [{ role: 'user', content: 'route-openai-1' }], temperature: 0.5 },
      authenticatedVia: 'api_key',
      providerId: 'pA',
    })
    const last = calls[calls.length - 1]
    expect(calls.length).toBe(before + 1)
    expect(last.url).toContain('alpha.example.com')
    expect(last.body.model).toBe('gpt-4o')
    expect(last.body.messages).toBeDefined()
    expect(last.body.temperature).toBe(0.5)
  })

  it('uses the provider configured model (anthropic)', async () => {
    await processRequest({
      endpoint: '/v1/chat/completions',
      requestBody: { messages: [{ role: 'user', content: 'route-anthropic-1' }] },
      authenticatedVia: 'api_key',
      providerId: 'pB',
    })
    const last = calls[calls.length - 1]
    expect(last.url).toContain('beta.example.com')
    expect(last.body.model).toBe('claude-3-haiku')
  })

  it('uses the provider configured model (gemini-native, model in URL)', async () => {
    await processRequest({
      endpoint: '/v1/chat/completions',
      requestBody: { messages: [{ role: 'user', content: 'route-gemini-1' }] },
      authenticatedVia: 'api_key',
      providerId: 'pC',
    })
    const last = calls[calls.length - 1]
    expect(last.url).toContain('gamma.example.com')
    expect(last.url).toContain('/models/gemini-pro:generateContent')
  })

  it('isolates cache between routed providers with identical bodies', async () => {
    const body = { messages: [{ role: 'user', content: 'shared-cache-key-1' }] }
    await processRequest({ endpoint: '/v1/chat/completions', requestBody: body, authenticatedVia: 'api_key', providerId: 'pA' })
    const callsForB = calls.filter(c => c.url.includes('beta.example.com')).length
    await processRequest({ endpoint: '/v1/chat/completions', requestBody: body, authenticatedVia: 'api_key', providerId: 'pB' })
    expect(calls.filter(c => c.url.includes('beta.example.com')).length).toBe(callsForB + 1)
  })
})

describe('explicit provider errors', () => {
  it('returns a clear error when the provider is paused', async () => {
    dbRun("UPDATE providers SET status = 'paused' WHERE id = 'pA'")
    await expect(processRequest({
      endpoint: '/v1/chat/completions',
      requestBody: { messages: [{ role: 'user', content: 'paused-provider-1' }] },
      authenticatedVia: 'api_key',
      providerId: 'pA',
    })).rejects.toThrow(/paused or in cooldown/)
    dbRun("UPDATE providers SET status = 'active' WHERE id = 'pA'")
  })

  it('returns a clear error when the provider does not exist', async () => {
    await expect(processRequest({
      endpoint: '/v1/chat/completions',
      requestBody: { messages: [{ role: 'user', content: 'missing-provider-1' }] },
      authenticatedVia: 'api_key',
      providerId: 'does-not-exist',
    })).rejects.toThrow('Provider not found')
  })
})

describe('cache bypass for tool requests', () => {
  it('does not cache or reuse cached responses when tools/tool_choice are present', async () => {
    const cacheMod = await import('../src/services/cacheManager.js')
    const body = {
      messages: [{ role: 'user', content: 'tool-cache-bypass-1' }],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }],
      tool_choice: 'auto',
    }
    const countCalls = () => calls.filter(c => c.body?.messages?.[0]?.content === 'tool-cache-bypass-1').length

    const before = countCalls()
    await processRequest({ endpoint: '/v1/chat/completions', requestBody: body, authenticatedVia: 'api_key', providerId: 'pA' })
    await processRequest({ endpoint: '/v1/chat/completions', requestBody: body, authenticatedVia: 'api_key', providerId: 'pA' })
    expect(countCalls() - before).toBe(2)

    const hash = cacheMod.generateHash({ _provider: 'pA', ...body })
    expect(cacheMod.getCache('/v1/chat/completions', hash)).toBeNull()
  })
})

describe('cached response labeling', () => {
  it('records the provider on cache hits (failover mode)', async () => {
    const dbMod = await import('../src/db.js')
    const { flushAll } = await import('../src/services/logQueue.js')
    const body = { messages: [{ role: 'user', content: 'cache-hit-provider-log-1' }] }
    const cacheHitsBefore = dbMod.dbGet('SELECT COUNT(*) AS c FROM requests_log WHERE cache_hit = 1').c

    await processRequest({ endpoint: '/v1/chat/completions', requestBody: body, authenticatedVia: 'api_key', requester: { name: 'Agent A', keyPrefix: 'llm_pk_xx' } })
    flushAll()
    await processRequest({ endpoint: '/v1/chat/completions', requestBody: body, authenticatedVia: 'api_key', requester: { name: 'Agent A', keyPrefix: 'llm_pk_xx' } })
    flushAll()

    const log = dbMod.dbGet(
      'SELECT provider_id, provider_name, requester_name, requester_key, cache_hit FROM requests_log WHERE cache_hit = 1 ORDER BY request_at DESC LIMIT 1'
    )
    expect(dbMod.dbGet('SELECT COUNT(*) AS c FROM requests_log WHERE cache_hit = 1').c).toBe(cacheHitsBefore + 1)
    expect(log.provider_id).toBeTruthy()
    expect(log.provider_name).toBeTruthy()
    expect(log.requester_name).toBe('Agent A')
    expect(log.requester_key).toBe('llm_pk_xx')
  })

  it('marks cached responses with _cache_hit when provider metadata is exposed', async () => {
    const body = { messages: [{ role: 'user', content: 'cache-label-1' }] }
    await processRequest({
      endpoint: '/v1/chat/completions',
      requestBody: body,
      authenticatedVia: 'api_key',
      providerId: 'pA',
      forceExposeProvider: true,
    })
    const cached = await processRequest({
      endpoint: '/v1/chat/completions',
      requestBody: body,
      authenticatedVia: 'api_key',
      providerId: 'pA',
      forceExposeProvider: true,
    })
    expect(cached.statusCode).toBe(200)
    expect(cached.body._cache_hit).toBe(true)
  })

  it('does not leak _cache_hit when provider metadata is hidden', async () => {
    const body = { messages: [{ role: 'user', content: 'cache-label-2' }] }
    await processRequest({
      endpoint: '/v1/chat/completions',
      requestBody: body,
      authenticatedVia: 'api_key',
      providerId: 'pA',
    })
    const cached = await processRequest({
      endpoint: '/v1/chat/completions',
      requestBody: body,
      authenticatedVia: 'api_key',
      providerId: 'pA',
    })
    expect(cached.statusCode).toBe(200)
    expect(cached.body._cache_hit).toBeUndefined()
  })
})

describe('failover mode', () => {
  it('uses each provider configured model and falls back when the first fails', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, opts) => {
      const u = String(url)
      const body = opts?.body ? JSON.parse(opts.body) : null
      calls.push({ url: u, body })
      if (u.includes('alpha.example.com')) {
        const err = new Error('upstream 500')
        err.status = 500
        throw err
      }
      return originalFetch(url, opts)
    }

    const before = calls.length
    const result = await processRequest({
      endpoint: '/v1/chat/completions',
      requestBody: { messages: [{ role: 'user', content: 'failover-chain-1' }] },
      authenticatedVia: 'api_key',
    })
    const callsMade = calls.slice(before)
    expect(result.statusCode).toBe(200)
    expect(callsMade.some(c => c.url.includes('alpha.example.com'))).toBe(true)
    const beta = callsMade.find(c => c.url.includes('beta.example.com'))
    expect(beta).toBeDefined()
    expect(beta.body.model).toBe('claude-3-haiku')
    expect(callsMade.some(c => c.url.includes('gamma.example.com'))).toBe(false)

    globalThis.fetch = originalFetch
  })
})

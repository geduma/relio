import { beforeAll, afterAll, describe, it, expect } from 'vitest'

let setDbPath, initDb, closeDb, dbRun, encrypt
let selectProviders, orderProvidersForRouting, getRoutingStrategy, clearDailyLimitCache
let processRequest
let config

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

  config = (await import('../src/config.js')).config

  const fail = await import('../src/services/failoverEngine.js')
  selectProviders = fail.selectProviders
  orderProvidersForRouting = fail.orderProvidersForRouting
  getRoutingStrategy = fail.getRoutingStrategy
  clearDailyLimitCache = fail.clearDailyLimitCache

  processRequest = (await import('../src/handlers/requestHandler.js')).processRequest

  const seed = [
    ['p1', 'Alpha', 'https://alpha.example.com/v1', 'sk-a', 'gpt-4o', 0],
    ['p2', 'Beta', 'https://beta.example.com/v1', 'sk-b', 'claude-3', 1],
    ['p3', 'Gamma', 'https://gamma.example.com/v1', 'sk-c', 'gemini-pro', 2],
  ]
  for (const [id, name, url, key, model, pos] of seed) {
    dbRun(
      `INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name, url, encrypt(key), model, 'chat', 'openai-compatible', pos, `Fallback ${pos}`]
    )
  }

  dbRun(
    `INSERT INTO metrics (id, provider_id, metric_date, total_requests, total_input_tokens, total_output_tokens, total_cost, avg_response_time_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ['m1', 'p1', new Date().toISOString().slice(0, 10), 1, 1000, 0, 0, 10]
  )
  dbRun(
    `INSERT INTO metrics (id, provider_id, metric_date, total_requests, total_input_tokens, total_output_tokens, total_cost, avg_response_time_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ['m3', 'p3', new Date().toISOString().slice(0, 10), 1, 500, 0, 0, 10]
  )

  globalThis.fetch = async (url) => {
    const u = String(url)
    calls.push(u)
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    }
  }
})

afterAll(async () => {
  config.relay.routingStrategy = 'order'
  closeDb()
})

describe('getRoutingStrategy', () => {
  it('defaults to config value (order)', () => {
    config.relay.routingStrategy = 'order'
    expect(getRoutingStrategy()).toBe('order')
  })

  it('reads the strategy from config.json (least-used)', () => {
    config.relay.routingStrategy = 'least-used'
    expect(getRoutingStrategy()).toBe('least-used')
    config.relay.routingStrategy = 'order'
  })

  it('ignores invalid config values and falls back to order', () => {
    config.relay.routingStrategy = 'bogus'
    expect(getRoutingStrategy()).toBe('order')
    config.relay.routingStrategy = 'order'
  })
})

describe('orderProvidersForRouting', () => {
  it('returns the list unchanged in order strategy', () => {
    config.relay.routingStrategy = 'order'
    clearDailyLimitCache()
    const providers = orderProvidersForRouting(selectProviders('chat'))
    expect(providers.map(p => p.id)).toEqual(['p1', 'p2', 'p3'])
  })

  it('sorts by least tokens used today in least-used strategy', () => {
    config.relay.routingStrategy = 'least-used'
    clearDailyLimitCache()
    const providers = orderProvidersForRouting(selectProviders('chat'))
    expect(providers.map(p => p.id)).toEqual(['p2', 'p3', 'p1'])
    config.relay.routingStrategy = 'order'
  })

  it('breaks ties by order_position', () => {
    config.relay.routingStrategy = 'least-used'
    clearDailyLimitCache()
    const providers = orderProvidersForRouting([{ id: 'a', order_position: 1 }, { id: 'b', order_position: 0 }])
    expect(providers.map(p => p.id)).toEqual(['b', 'a'])
    config.relay.routingStrategy = 'order'
  })
})

describe('processRequest with least-used routing', () => {
  it('routes to the provider with the fewest tokens used today', async () => {
    config.relay.routingStrategy = 'least-used'
    clearDailyLimitCache()
    const before = calls.length
    const result = await processRequest({
      endpoint: '/v1/chat/completions',
      requestBody: { messages: [{ role: 'user', content: 'least-used-route-1' }] },
      authenticatedVia: 'api_key',
      apiKey: 'k',
    })
    const made = calls.slice(before)
    expect(result.statusCode).toBe(200)
    expect(made.some(c => c.includes('beta.example.com'))).toBe(true)
    expect(made.some(c => c.includes('alpha.example.com'))).toBe(false)
    expect(made.some(c => c.includes('gamma.example.com'))).toBe(false)
    config.relay.routingStrategy = 'order'
  })

  it('skips a provider in cooldown and fails over to the next least-used', async () => {
    config.relay.routingStrategy = 'least-used'
    dbRun("UPDATE providers SET status = 'cooldown', cooldown_until = ? WHERE id = 'p2'", [new Date(Date.now() + 3600000).toISOString()])
    clearDailyLimitCache()
    const before = calls.length
    const result = await processRequest({
      endpoint: '/v1/chat/completions',
      requestBody: { messages: [{ role: 'user', content: 'cooldown-skip-1' }] },
      authenticatedVia: 'api_key',
      apiKey: 'k',
    })
    const made = calls.slice(before)
    expect(result.statusCode).toBe(200)
    expect(made.some(c => c.includes('beta.example.com'))).toBe(false)
    expect(made.some(c => c.includes('gamma.example.com'))).toBe(true)
    dbRun("UPDATE providers SET status = 'active', cooldown_until = NULL WHERE id = 'p2'")
    config.relay.routingStrategy = 'order'
  })

  it('skips a provider whose daily token limit is exhausted', async () => {
    config.relay.routingStrategy = 'least-used'
    dbRun('UPDATE providers SET tokens_per_day = 100 WHERE id = ?', ['p3'])
    clearDailyLimitCache()
    const before = calls.length
    const result = await processRequest({
      endpoint: '/v1/chat/completions',
      requestBody: { messages: [{ role: 'user', content: 'daily-limit-skip-1' }] },
      authenticatedVia: 'api_key',
      apiKey: 'k',
    })
    const made = calls.slice(before)
    expect(result.statusCode).toBe(200)
    expect(made.some(c => c.includes('gamma.example.com'))).toBe(false)
    expect(made.some(c => c.includes('beta.example.com'))).toBe(true)
    dbRun('UPDATE providers SET tokens_per_day = 0 WHERE id = ?', ['p3'])
    config.relay.routingStrategy = 'order'
  })
})

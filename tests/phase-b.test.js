import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'

let setDbPath, initDb, closeDb, dbRun, dbGet, encrypt
let logQueue, metricsLogger, config, normalizeConfig
let optimizeRelayBody, processRequest

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

  logQueue = await import('../src/services/logQueue.js')
  metricsLogger = await import('../src/services/metricsLogger.js')
  const configMod = await import('../src/config.js')
  config = configMod.config
  normalizeConfig = configMod.normalizeConfig
  const handler = await import('../src/handlers/requestHandler.js')
  optimizeRelayBody = handler.optimizeRelayBody
  processRequest = handler.processRequest
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

const baseConfig = {
  security: { encryptionKey: 'a'.repeat(64) },
}

describe('config: tokenOptimization defaults and validation', () => {
  it('defaults are applied', () => {
    const cfg = normalizeConfig(baseConfig)
    expect(cfg.relay.tokenOptimization).toBeDefined()
    expect(cfg.relay.tokenOptimization.enabled).toBe(false)
    expect(cfg.relay.tokenOptimization.logSavings).toBe(true)
    expect(cfg.relay.tokenOptimization.aggressiveNormalization).toBe(false)
  })

  it('defaults are applied for writeBuffer', () => {
    const cfg = normalizeConfig(baseConfig)
    expect(cfg.relay.writeBuffer).toBeDefined()
    expect(cfg.relay.writeBuffer.flushIntervalMs).toBe(500)
    expect(cfg.relay.writeBuffer.maxBufferSize).toBe(50)
  })
})

describe('optimizeRelayBody gate', () => {
  afterEach(() => {
    config.relay.tokenOptimization.enabled = false
    config.relay.tokenOptimization.logSavings = true
    config.relay.tokenOptimization.aggressiveNormalization = false
  })

  it('is a passthrough when disabled', () => {
    config.relay.tokenOptimization.enabled = false
    const body = { messages: [{ role: 'user', content: 'lorem  ipsum' }] }
    const result = optimizeRelayBody(body)
    expect(result.body).toBe(body)
    expect(result.tokensSavedEstimate).toBe(0)
  })

  it('optimizes and reports savings when enabled', () => {
    config.relay.tokenOptimization.enabled = true
    const body = { messages: [{ role: 'user', content: '{"a":  1}\n\n\n  espacio  extra' }] }
    const result = optimizeRelayBody(body)
    expect(result.body.messages[0].content).not.toContain('  ')
    expect(result.tokensSavedEstimate).toBeGreaterThan(0)
  })

  it('keeps optimizing but reports zero savings when logSavings is false', () => {
    config.relay.tokenOptimization.enabled = true
    config.relay.tokenOptimization.logSavings = false
    const body = { messages: [{ role: 'user', content: '{"a":  1}' }] }
    const result = optimizeRelayBody(body)
    expect(result.body.messages[0].content).toBe('{"a":1}')
    expect(result.tokensSavedEstimate).toBe(0)
  })

  it('respects aggressiveNormalization flag', () => {
    config.relay.tokenOptimization.enabled = true
    config.relay.tokenOptimization.aggressiveNormalization = true
    const body = { messages: [{ role: 'user', content: 'Hola —mundo—' }] }
    const result = optimizeRelayBody(body)
    expect(result.body.messages[0].content).toBe('Hola -mundo-')
  })
})

describe('processRequest: hash on optimized body', () => {
  afterEach(() => {
    config.relay.tokenOptimization.enabled = false
  })

  it('logs the optimized request body with tokens_saved_estimate', async () => {
    config.relay.tokenOptimization.enabled = true
    dbRun(
      `INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['b1', 'BetaOne', 'https://beta.example.com/v1', encrypt('sk'), 'm', 'chat', 'openai-compatible', 0, 'Main', 'active']
    )

    const original = { messages: [{ role: 'user', content: '{"a":  1}\n\n\n  espa  cio  extra' }] }
    await expect(processRequest({
      endpoint: '/v1/chat/completions',
      requestBody: original,
      providerId: 'b1',
      authenticatedVia: 'test',
    })).rejects.toThrow()

    logQueue.flushAll()
    const log = dbGet('SELECT * FROM requests_log ORDER BY request_at DESC LIMIT 1')
    expect(log).not.toBeNull()
    const storedBody = JSON.parse(log.request_body)
    expect(storedBody.messages[0].content).toBe('{"a":1}\n\nespa cio extra')
    expect(log.tokens_saved_estimate).toBeGreaterThan(0)
  })
})

describe('metrics: tokens_saved_estimate aggregation', () => {
  it('getMetrics totals include tokens saved over the range', () => {
    dbRun(
      `INSERT INTO requests_log (id, endpoint, request_body, tokens_saved_estimate, request_at)
       VALUES (?, ?, ?, ?, ?)`,
      ['lg1', '/v1/chat/completions', '{}', 10, '2026-08-01 10:00:00']
    )
    dbRun(
      `INSERT INTO requests_log (id, endpoint, request_body, tokens_saved_estimate, request_at)
       VALUES (?, ?, ?, ?, ?)`,
      ['lg2', '/v1/chat/completions', '{}', 5, '2026-08-02 10:00:00']
    )
    const result = metricsLogger.getMetrics('2026-08-01', '2026-08-02')
    expect(result.totals.tokens_saved_estimate).toBe(15)
  })

  it('getLogs exposes tokens_saved_estimate per row', () => {
    dbRun(
      `INSERT INTO requests_log (id, endpoint, request_body, tokens_saved_estimate, request_at)
       VALUES (?, ?, ?, ?, ?)`,
      ['lg3', '/v1/chat/completions', '{}', 7, '2026-08-03 10:00:00']
    )
    const { logs } = metricsLogger.getLogs(10, 0)
    expect(logs.find(l => l.id === 'lg3').tokens_saved_estimate).toBe(7)
  })
})

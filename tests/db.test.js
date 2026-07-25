import { beforeAll, afterAll, describe, it, expect } from 'vitest'

let initDb, getDb, closeDb, dbAll, dbGet, dbRun

beforeAll(async () => {
  process.env.DB_PATH = ':memory:'
  const mod = await import('../src/db.js')
  initDb = mod.initDb
  getDb = mod.getDb
  closeDb = mod.closeDb
  dbAll = mod.dbAll
  dbGet = mod.dbGet
  dbRun = mod.dbRun
  initDb()
})

afterAll(() => {
  closeDb()
})

describe('Database', () => {
  it('creates all tables', () => {
    const tables = dbAll("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    const names = tables.map(t => t.name)
    expect(names).toContain('providers')
    expect(names).toContain('requests_log')
    expect(names).toContain('cache')
    expect(names).toContain('api_keys')
    expect(names).toContain('login_history')
    expect(names).toContain('circuit_breaker_state')
    expect(names).toContain('sessions')
    expect(names).toContain('metrics')
  })

  it('inserts and reads a provider', () => {
    dbRun(
      `INSERT INTO providers (id, name, api_url, api_key, model, type, order_position, order_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['test-1', 'Test Provider', 'https://api.test.com', 'sk-test', 'gpt-4', 'chat', 0, 'Main']
    )
    const row = dbGet('SELECT * FROM providers WHERE id = ?', ['test-1'])
    expect(row.name).toBe('Test Provider')
    expect(row.type).toBe('chat')
  })
})

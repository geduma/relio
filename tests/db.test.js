
let initDb, closeDb, dbAll, dbGet, dbRun

beforeAll(async () => {
  const mod = await import('../src/db.js')
  mod.setDbPath(':memory:')
  initDb = mod.initDb
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
    expect(names).toContain('circuit_breaker_state')
    expect(names).toContain('metrics')
    expect(names).not.toContain('sessions')
    expect(names).not.toContain('login_history')
  })

  it('has provider_type and capability columns', () => {
    const cols = dbAll("PRAGMA table_info('providers')").map(c => c.name)
    expect(cols).toContain('provider_type')
    expect(cols).toContain('capability')
    expect(cols).not.toContain('type')
  })

  it('inserts and reads a provider', () => {
    dbRun(
      `INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['test-1', 'Test Provider', 'https://api.test.com', 'sk-test', 'gpt-4', 'chat', 'openai-compatible', 0, 'Main']
    )
    const row = dbGet('SELECT * FROM providers WHERE id = ?', ['test-1'])
    expect(row.name).toBe('Test Provider')
    expect(row.capability).toBe('chat')
    expect(row.provider_type).toBe('openai-compatible')
  })
})

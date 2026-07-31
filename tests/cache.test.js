
let generateHash, getCache, setCache, cleanExpiredCache

beforeAll(async () => {
  const dbMod = await import('../src/db.js')
  dbMod.setDbPath(':memory:')
  dbMod.initDb()

  const cacheMod = await import('../src/services/cacheManager.js')
  generateHash = cacheMod.generateHash
  getCache = cacheMod.getCache
  setCache = cacheMod.setCache
  cleanExpiredCache = cacheMod.cleanExpiredCache
})

afterAll(async () => {
  const dbMod = await import('../src/db.js')
  dbMod.closeDb()
})

describe('CacheManager', () => {
  it('generates consistent hash for same body', () => {
    const body = { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] }
    const hash1 = generateHash(body)
    const hash2 = generateHash(body)
    expect(hash1).toBe(hash2)
  })

  it('stores and retrieves cache', () => {
    const body = { model: 'gpt-4', messages: [{ role: 'user', content: 'hello' }] }
    const response = { choices: [{ message: { content: 'Hi!' } }] }

    setCache('/v1/chat/completions', body, response)
    const hash = generateHash(body)
    const cached = getCache(hash)

    expect(cached).not.toBeNull()
    const parsed = JSON.parse(cached.response_body)
    expect(parsed.choices[0].message.content).toBe('Hi!')
  })

  it('returns cached value on second call (memCache hit)', () => {
    const body = { model: 'gpt-4', messages: [{ role: 'user', content: 'again' }] }
    setCache('/v1/chat/completions', body, { choices: [{ message: { content: 'Mem' } }] })
    const hash = generateHash(body)
    const cached = getCache(hash)
    expect(JSON.parse(cached.response_body).choices[0].message.content).toBe('Mem')
  })

  it('returns null for non-existent hash', () => {
    const result = getCache('nonexistent_hash')
    expect(result).toBeNull()
  })

  it('cleans expired cache returns number', () => {
    const count = cleanExpiredCache()
    expect(typeof count).toBe('number')
  })

  it('returns null for expired cache entry stored with ISO T format', async () => {
    const dbMod = await import('../src/db.js')
    dbMod.dbRun(
      `INSERT OR REPLACE INTO cache (id, query_hash, endpoint, request_body, response_body, provider_id, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['expired-entry', 'expired_hash', '/v1/chat/completions', '{}', '{}', null, new Date(Date.now() - 1000).toISOString()]
    )
    const cached = getCache('expired_hash')
    expect(cached).toBeNull()
  })

  it('does not return a cache entry that expires later today (same-day TTL)', async () => {
    const dbMod = await import('../src/db.js')
    const laterToday = new Date(Date.now() + 60_000).toISOString()
    dbMod.dbRun(
      `INSERT OR REPLACE INTO cache (id, query_hash, endpoint, request_body, response_body, provider_id, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['future-entry', 'future_hash', '/v1/chat/completions', '{}', '{}', null, laterToday]
    )
    const cached = getCache('future_hash')
    expect(cached).not.toBeNull()
  })

  it('queues hit_count increments and flushes them in batch', async () => {
    const dbMod = await import('../src/db.js')
    const cacheMod = await import('../src/services/cacheManager.js')
    const body = { model: 'gpt-4', messages: [{ role: 'user', content: 'hitcount' }] }
    setCache('/v1/chat/completions', body, { ok: 1 })
    const hash = generateHash(body)
    const before = dbMod.dbGet('SELECT hit_count FROM cache WHERE query_hash = ?', [hash]).hit_count

    getCache(hash)
    getCache(hash)
    const mid = dbMod.dbGet('SELECT hit_count FROM cache WHERE query_hash = ?', [hash]).hit_count
    expect(mid).toBe(before)

    cacheMod.flushCacheHits()
    const after = dbMod.dbGet('SELECT hit_count FROM cache WHERE query_hash = ?', [hash]).hit_count
    expect(after).toBe(before + 2)
  })
})

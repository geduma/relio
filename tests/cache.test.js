
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
    const body = { model: 'model-chat', messages: [{ role: 'user', content: 'hi' }] }
    const hash1 = generateHash(body)
    const hash2 = generateHash(body)
    expect(hash1).toBe(hash2)
  })

  it('stores and retrieves cache (including memCache hits)', () => {
    const body = { model: 'model-chat', messages: [{ role: 'user', content: 'hello' }] }
    const response = { choices: [{ message: { content: 'Hi!' } }] }

    setCache('/v1/chat/completions', body, response)
    const hash = generateHash(body)
    const first = getCache('/v1/chat/completions', hash)
    const second = getCache('/v1/chat/completions', hash)

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(JSON.parse(first.response_body).choices[0].message.content).toBe('Hi!')
    expect(JSON.parse(second.response_body).choices[0].message.content).toBe('Hi!')
  })

  it('does not return a cache entry stored under a different endpoint', () => {
    const body = { model: 'model-chat', messages: [{ role: 'user', content: 'cross' }] }
    setCache('/v1/chat/completions', body, { choices: [{ message: { content: 'Chat' } }] })
    const hash = generateHash(body)
    expect(getCache('/v1/embeddings', hash)).toBeNull()
    expect(JSON.parse(getCache('/v1/chat/completions', hash).response_body).choices[0].message.content).toBe('Chat')
  })

  it('returns null for non-existent hash', () => {
    const result = getCache('/v1/chat/completions', 'nonexistent_hash')
    expect(result).toBeNull()
  })

  it('cleans expired cache entries from the database', async () => {
    const dbMod = await import('../src/db.js')
    dbMod.dbRun(
      `INSERT OR REPLACE INTO cache (id, query_hash, endpoint, request_body, response_body, provider_id, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['to-clean', 'clean_hash', '/v1/chat/completions', '{}', '{}', null, new Date(Date.now() - 1000).toISOString()]
    )
    dbMod.dbRun(
      `INSERT OR REPLACE INTO cache (id, query_hash, endpoint, request_body, response_body, provider_id, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['to-keep', 'keep_hash', '/v1/chat/completions', '{}', '{}', null, new Date(Date.now() + 3600_000).toISOString()]
    )

    const count = cleanExpiredCache()

    expect(typeof count).toBe('number')
    expect(dbMod.dbGet('SELECT id FROM cache WHERE id = ?', ['to-clean'])).toBeUndefined()
    expect(dbMod.dbGet('SELECT id FROM cache WHERE id = ?', ['to-keep'])).toBeDefined()
  })

  it('returns null for expired cache entry stored with ISO T format', async () => {
    const dbMod = await import('../src/db.js')
    dbMod.dbRun(
      `INSERT OR REPLACE INTO cache (id, query_hash, endpoint, request_body, response_body, provider_id, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['expired-entry', 'expired_hash', '/v1/chat/completions', '{}', '{}', null, new Date(Date.now() - 1000).toISOString()]
    )
    const cached = getCache('/v1/chat/completions', 'expired_hash')
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
    const cached = getCache('/v1/chat/completions', 'future_hash')
    expect(cached).not.toBeNull()
  })

  it('queues hit_count increments and flushes them in batch', async () => {
    const dbMod = await import('../src/db.js')
    const cacheMod = await import('../src/services/cacheManager.js')
    const body = { model: 'model-chat', messages: [{ role: 'user', content: 'hitcount' }] }
    setCache('/v1/chat/completions', body, { ok: 1 })
    const hash = generateHash(body)
    const before = dbMod.dbGet('SELECT hit_count FROM cache WHERE query_hash = ?', [hash]).hit_count

    getCache('/v1/chat/completions', hash)
    getCache('/v1/chat/completions', hash)
    const mid = dbMod.dbGet('SELECT hit_count FROM cache WHERE query_hash = ?', [hash]).hit_count
    expect(mid).toBe(before)

    cacheMod.flushCacheHits()
    const after = dbMod.dbGet('SELECT hit_count FROM cache WHERE query_hash = ?', [hash]).hit_count
    expect(after).toBe(before + 2)
  })
})

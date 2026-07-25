import { beforeAll, afterAll, describe, it, expect } from 'vitest'

let generateHash, getCache, setCache, cleanExpiredCache

beforeAll(async () => {
  process.env.DB_PATH = ':memory:'
  process.env.CACHE_TTL_SECONDS = '1'
  const dbMod = await import('../src/db.js')
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

  it('returns null for non-existent hash', () => {
    const result = getCache('nonexistent_hash')
    expect(result).toBeNull()
  })

  it('cleans expired cache', () => {
    const count = cleanExpiredCache()
    expect(typeof count).toBe('number')
  })
})

import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import express from 'express'

let setDbPath, initDb, closeDb, dbGet, hashApiKey
let authService
let authMiddleware

beforeAll(async () => {
  const dbMod = await import('../src/db.js')
  setDbPath = dbMod.setDbPath
  initDb = dbMod.initDb
  closeDb = dbMod.closeDb
  dbGet = dbMod.dbGet
  hashApiKey = dbMod.hashApiKey

  setDbPath(':memory:')
  initDb()

  authService = await import('../src/services/authService.js')
  authMiddleware = (await import('../src/middleware/authMiddleware.js')).requireApiKey
})

afterAll(() => closeDb())

describe('API key hashing (S1)', () => {
  it('stores only the SHA-256 hash and a prefix, never the raw key', () => {
    const raw = authService.createApiKey('test key')
    expect(raw.startsWith('llm_pk_')).toBe(true)
    expect(raw.length).toBeGreaterThanOrEqual(48)

    const row = dbGet('SELECT * FROM api_keys WHERE key_prefix = ?', [raw.slice(0, 10)])
    expect(row).toBeTruthy()
    expect(row.key_hash).toBe(hashApiKey(raw))
    expect(row.key_hash).not.toContain(raw)
    expect(Object.keys(row)).not.toContain('key')
  })

  it('validates a raw key against its hash', () => {
    const raw = authService.createApiKey('validate me')
    const row = authService.validateApiKey(raw)
    expect(row).toBeTruthy()
    expect(row.name).toBe('validate me')

    expect(authService.validateApiKey('llm_pk_does-not-exist')).toBeNull()
  })

  it('lists keys with only the prefixed preview', () => {
    const raw = authService.createApiKey('list me')
    const list = authService.listApiKeys()
    expect(Array.isArray(list)).toBe(true)
    const entry = list.find(k => k.key_preview === `${raw.slice(0, 10)}...`)
    expect(entry).toBeTruthy()
    expect(entry.key_preview.endsWith('...')).toBe(true)
    expect(entry.key_preview).not.toContain(raw.slice(10))
  })

  it('revokes a key and rejects it afterwards', () => {
    const raw = authService.createApiKey('revoke me')
    const row = authService.validateApiKey(raw)
    expect(row).toBeTruthy()

    const revoked = authService.revokeApiKey(row.id)
    expect(revoked).toBe(true)
    expect(authService.validateApiKey(raw)).toBeNull()
  })
})

describe('authMiddleware', () => {
  let server
  let baseUrl

  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.get('/protected', authMiddleware, (req, res) => res.json({ ok: true, keyId: req.apiKey.id }))
    server = app.listen(0)
    await new Promise(r => server.once('listening', r))
    baseUrl = `http://localhost:${server.address().port}`
  })

  afterAll(async () => {
    if (server) await new Promise(r => server.close(r))
  })

  it('rejects requests without an Authorization header', async () => {
    const res = await fetch(`${baseUrl}/protected`)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.message).toMatch(/Authorization/i)
  })

  it('rejects requests with an invalid API key', async () => {
    const res = await fetch(`${baseUrl}/protected`, {
      headers: { Authorization: 'Bearer llm_pk_bad_key_that_does_not_exist' },
    })
    expect(res.status).toBe(403)
  })

  it('allows requests with a valid API key', async () => {
    const raw = authService.createApiKey('middleware ok')
    const res = await fetch(`${baseUrl}/protected`, {
      headers: { Authorization: `Bearer ${raw}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.keyId).toBeTruthy()
  })
})

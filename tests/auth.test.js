import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import express from 'express'

let setDbPath, initDb, closeDb, dbGet, hashApiKey, dbRun, encrypt
let authService
let authMiddleware

beforeAll(async () => {
  const dbMod = await import('../src/db.js')
  setDbPath = dbMod.setDbPath
  initDb = dbMod.initDb
  closeDb = dbMod.closeDb
  dbGet = dbMod.dbGet
  dbRun = dbMod.dbRun
  hashApiKey = dbMod.hashApiKey
  encrypt = dbMod.encrypt

  setDbPath(':memory:')
  initDb()

  dbRun(
    `INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['prov-1', 'Main', 'https://api.example.com/v1', encrypt('sk-test'), 'model-chat', 'chat', 'openai-compatible', 0, 'Main']
  )
  dbRun(
    `INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['prov-2', 'Emb', 'https://api.example.com/v1', encrypt('sk-test'), 'text-embedding-3-small', 'embeddings', 'openai-compatible', 1, 'Main']
  )

  authService = await import('../src/services/authService.js')
  authMiddleware = (await import('../src/middleware/authMiddleware.js')).requireApiKey
})

afterAll(() => closeDb())

describe('API key hashing (S1)', () => {
  it('stores only the SHA-256 hash and a prefix, never the raw key', () => {
    const raw = authService.createApiKey({ name: 'test key', providerIds: ['prov-1'] })
    expect(raw.startsWith('llm_pk_')).toBe(true)
    expect(raw.length).toBeGreaterThanOrEqual(48)

    const row = dbGet('SELECT * FROM api_keys WHERE key_prefix = ?', [raw.slice(0, 10)])
    expect(row).toBeTruthy()
    expect(row.key_hash).toBe(hashApiKey(raw))
    expect(row.key_hash).not.toContain(raw)
    expect(Object.keys(row)).not.toContain('key')
  })

  it('validates a raw key against its hash and returns allowed providers', () => {
    const raw = authService.createApiKey({ name: 'validate me', providerIds: ['prov-1', 'prov-2'] })
    const row = authService.validateApiKey(raw)
    expect(row).toBeTruthy()
    expect(row.name).toBe('validate me')
    expect(row.allowedProviderIds).toEqual(expect.arrayContaining(['prov-1', 'prov-2']))

    expect(authService.validateApiKey('llm_pk_does-not-exist')).toBeNull()
  })

  it('rejects creation with an empty or unknown provider list', () => {
    expect(() => authService.createApiKey({ name: 'no providers', providerIds: [] })).toThrow(/providerIds/)
    expect(() => authService.createApiKey({ name: 'bad provider', providerIds: ['nope'] })).toThrow(/do not exist/)
  })

  it('lists keys with only the prefixed preview', () => {
    const raw = authService.createApiKey({ name: 'list me', providerIds: ['prov-1'] })
    const list = authService.listApiKeys()
    expect(Array.isArray(list)).toBe(true)
    const entry = list.find(k => k.key_preview === `${raw.slice(0, 10)}...`)
    expect(entry).toBeTruthy()
    expect(entry.key_preview.endsWith('...')).toBe(true)
    expect(entry.key_preview).not.toContain(raw.slice(10))
    expect(entry.providers).toEqual([{ id: 'prov-1', name: 'Main', capability: 'chat' }])
  })

  it('updates the providers of a key and reflects it in the next validation', () => {
    const raw = authService.createApiKey({ name: 'edit me', providerIds: ['prov-1'] })
    expect(authService.validateApiKey(raw).allowedProviderIds).toEqual(['prov-1'])

    authService.updateApiKeyProviders(authService.validateApiKey(raw).id, ['prov-2'])
    expect(authService.validateApiKey(raw).allowedProviderIds).toEqual(['prov-2'])
  })

  it('revokes a key and rejects it afterwards', () => {
    const raw = authService.createApiKey({ name: 'revoke me', providerIds: ['prov-1'] })
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
    const raw = authService.createApiKey({ name: 'middleware ok', providerIds: ['prov-1'] })
    const res = await fetch(`${baseUrl}/protected`, {
      headers: { Authorization: `Bearer ${raw}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.keyId).toBeTruthy()
  })
})

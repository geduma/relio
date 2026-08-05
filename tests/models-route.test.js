import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import express from 'express'

let setDbPath, initDb, closeDb, dbRun, encrypt
let authService
let proxyRoutes

beforeAll(async () => {
  const dbMod = await import('../src/db.js')
  setDbPath = dbMod.setDbPath
  initDb = dbMod.initDb
  closeDb = dbMod.closeDb
  dbRun = dbMod.dbRun
  encrypt = dbMod.encrypt

  setDbPath(':memory:')
  initDb()

  authService = await import('../src/services/authService.js')
  proxyRoutes = (await import('../src/routes/proxy.routes.js')).default
})

afterAll(() => closeDb())

describe('GET /v1/models', () => {
  let server
  let baseUrl
  let apiKey

  function seed(id, name, capability, status, orderPosition, createdAt = '2026-01-02 03:04:05', extra = {}) {
    const cols = {
      api_url: 'https://alpha.example.com/v1',
      api_key: encrypt('sk-test'),
      model: 'model-chat',
      order_label: 'Main',
      ...extra,
    }
    dbRun(
      `INSERT INTO providers
         (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label, status, created_at${cols.cooldown_until ? ', cooldown_until' : ''})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${cols.cooldown_until ? ', ?' : ''})`,
      [
        id, name, cols.api_url, cols.api_key, cols.model, capability, 'openai-compatible',
        orderPosition, cols.order_label, status, createdAt,
        ...(cols.cooldown_until ? [cols.cooldown_until] : []),
      ]
    )
  }

  beforeAll(async () => {
    seed('mp1', 'ChatMain', 'chat', 'active', 0)
    seed('mp2', 'EmbMain', 'embeddings', 'active', 1, '2026-05-06 07:08:09')
    seed('mp3', 'ChatPaused', 'chat', 'paused', 2)
    seed('mp4', 'ChatCooldown', 'chat', 'cooldown', 3, '2026-01-02 03:04:05', {
      cooldown_until: '2099-01-01 00:00:00',
    })
    apiKey = authService.createApiKey({ name: 'models test', providerIds: ['mp1', 'mp2'] })

    const app = express()
    app.use(express.json())
    app.use('/v1', proxyRoutes)
    server = app.listen(0)
    await new Promise(r => server.once('listening', r))
    baseUrl = `http://localhost:${server.address().port}`
  })

  afterAll(async () => {
    if (server) await new Promise(r => server.close(r))
  })

  it('requires a valid API key', async () => {
    const noKey = await fetch(`${baseUrl}/v1/models`)
    expect(noKey.status).toBe(401)

    const badKey = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: 'Bearer relio_sk_invalid' },
    })
    expect(badKey.status).toBe(403)
  })

  it('returns an OpenAI-compatible list of configured providers', async () => {
    const res = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.object).toBe('list')
    const ids = body.data.map(m => m.id)
    expect(ids[0]).toBe('auto')
    expect(ids).toContain('ChatMain')
    expect(ids).toContain('EmbMain')
  })

  it('lists only available providers (excludes paused and cooldown)', async () => {
    const body = await (await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })).json()
    const ids = body.data.map(m => m.id)
    expect(ids).not.toContain('ChatPaused')
    expect(ids).not.toContain('ChatCooldown')
  })

  it('returns { id, object, created, owned_by } per entry', async () => {
    const body = await (await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })).json()
    const chat = body.data.find(m => m.id === 'ChatMain')
    const emb = body.data.find(m => m.id === 'EmbMain')
    expect(body.data[0]).toEqual({
      id: 'auto',
      object: 'model',
      created: 0,
      owned_by: 'relio',
    })
    expect(chat).toEqual({
      id: 'ChatMain',
      object: 'model',
      created: Math.floor(Date.parse('2026-01-02T03:04:05Z') / 1000),
      owned_by: 'relio',
    })
    expect(emb.created).toBe(Math.floor(Date.parse('2026-05-06T07:08:09Z') / 1000))
    expect(emb.owned_by).toBe('relio')
    expect(emb.object).toBe('model')
  })

  it('orders providers by order_position', async () => {
    const body = await (await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })).json()
    const ids = body.data.map(m => m.id)
    expect(ids[0]).toBe('auto')
    expect(ids.indexOf('ChatMain')).toBeLessThan(ids.indexOf('EmbMain'))
  })

  it('caches the response for 60s', async () => {
    const before = await (await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })).json()
    dbRun("UPDATE providers SET status = 'paused' WHERE id = 'mp1'")
    const after = await (await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })).json()
    expect(after.data.map(m => m.id)).toEqual(before.data.map(m => m.id))
    expect(after.data.map(m => m.id)).toContain('ChatMain')
    dbRun("UPDATE providers SET status = 'active' WHERE id = 'mp1'")
  })

  it('only lists providers allowed for a scoped key', async () => {
    const scoped = authService.createApiKey({ name: 'scoped', providerIds: ['mp2'] })
    const res = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${scoped}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    const ids = body.data.map(m => m.id)
    expect(ids).toContain('auto')
    expect(ids).not.toContain('ChatMain')
    expect(ids).toContain('EmbMain')
  })
})

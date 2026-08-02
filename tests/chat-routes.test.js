import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import express from 'express'

let setDbPath, initDb, closeDb, dbRun, encrypt
let chatRoutes

beforeAll(async () => {
  const dbMod = await import('../src/db.js')
  setDbPath = dbMod.setDbPath
  initDb = dbMod.initDb
  closeDb = dbMod.closeDb
  dbRun = dbMod.dbRun
  encrypt = dbMod.encrypt

  setDbPath(':memory:')
  initDb()

  chatRoutes = (await import('../src/routes/chat.routes.js')).default
})

afterAll(() => closeDb())

describe('POST /admin/api/chat/send (Bug #1)', () => {
  let server
  let baseUrl

  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.use('/admin/api/chat', chatRoutes)
    app.use((err, _req, res, _next) => {
      res.status(err.status || 500).json({ error: { message: err.message } })
    })
    server = app.listen(0)
    await new Promise(r => server.once('listening', r))
    baseUrl = `http://localhost:${server.address().port}`
  })

  afterAll(async () => {
    if (server) await new Promise(r => server.close(r))
  })

  it('rejects when messages is missing', async () => {
    const res = await fetch(`${baseUrl}/admin/api/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ use_proxy: true }),
    })
    expect(res.status).toBe(400)
  })

  it('requires provider_id when the proxy is disabled', async () => {
    const res = await fetch(`${baseUrl}/admin/api/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], use_proxy: false }),
    })
    expect(res.status).toBe(400)
  })

  it('allows proxy mode without provider_id and runs the failover pipeline', async () => {
    const res = await fetch(`${baseUrl}/admin/api/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], use_proxy: true }),
    })
    expect(res.status).not.toBe(400)
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toBeTruthy()
  })

  it('returns 404 for an unknown provider in direct mode', async () => {
    const res = await fetch(`${baseUrl}/admin/api/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        use_proxy: false,
        provider_id: 'does-not-exist',
      }),
    })
    expect(res.status).toBe(404)
  })
})

describe('GET /admin/api/chat/providers', () => {
  let server
  let baseUrl

  beforeAll(async () => {
    const app = express()
    app.use('/admin/api/chat', chatRoutes)
    server = app.listen(0)
    await new Promise(r => server.once('listening', r))
    baseUrl = `http://localhost:${server.address().port}`
  })

  afterAll(async () => {
    if (server) await new Promise(r => server.close(r))
  })

  it('does not expose api_url or api_key in the providers list (S4)', async () => {
    dbRun(
      `INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['chatp1', 'ChatP', 'https://secret.example.com/v1', encrypt('sk-secret'), 'gpt-4o', 'chat', 'openai-compatible', 0, 'Main']
    )
    const res = await fetch(`${baseUrl}/admin/api/chat/providers`)
    expect(res.status).toBe(200)
    const rows = await res.json()
    const row = rows.find(r => r.id === 'chatp1')
    expect(row).toBeTruthy()
    expect('api_url' in row).toBe(false)
    expect('api_key' in row).toBe(false)
    expect(row.name).toBe('ChatP')
    expect(row.model).toBe('gpt-4o')
  })
})

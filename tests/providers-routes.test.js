import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import express from 'express'

vi.mock('../src/utils/ssrf.js', () => ({
  assertPublicUrl: async () => {},
}))

let setDbPath, initDb, closeDb, dbRun, encrypt
let providersRoutes

beforeAll(async () => {
  const dbMod = await import('../src/db.js')
  setDbPath = dbMod.setDbPath
  initDb = dbMod.initDb
  closeDb = dbMod.closeDb
  dbRun = dbMod.dbRun
  encrypt = dbMod.encrypt

  setDbPath(':memory:')
  initDb()

  providersRoutes = (await import('../src/routes/providers.routes.js')).default
})

afterAll(() => closeDb())

describe('POST /admin/api/providers (reserved name)', () => {
  let server
  let baseUrl

  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.use('/admin/api/providers', providersRoutes)
    server = app.listen(0)
    await new Promise(r => server.once('listening', r))
    baseUrl = `http://localhost:${server.address().port}`
  })

  afterAll(async () => {
    if (server) await new Promise(r => server.close(r))
  })

  const base = {
    api_url: 'https://alpha.example.com/v1',
    api_key: 'sk-test',
    model: 'gpt-4o',
    capability: 'chat',
  }

  function post(body) {
    return fetch(`${baseUrl}/admin/api/providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('rejects a provider named "auto"', async () => {
    const res = await post({ ...base, name: 'auto' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/reserved/)
  })

  it('rejects case-insensitive and whitespace variants', async () => {
    for (const name of ['AUTO', 'Auto', '  auto  ']) {
      const res = await post({ ...base, name })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/reserved/)
    }
  })

  it('rejects renaming an existing provider to "auto"', async () => {
    dbRun(
      `INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['ren1', 'RenameMe', 'https://alpha.example.com/v1', encrypt('sk-test'), 'gpt-4o', 'chat', 'openai-compatible', 0, 'Main', 'active']
    )
    const res = await fetch(`${baseUrl}/admin/api/providers/ren1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'auto' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/reserved/)
  })

  it('accepts a non-reserved name', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes('alpha.example.com')) {
        return { status: 200, ok: true, json: async () => ({ data: [] }) }
      }
      return realFetch(url, opts)
    }
    const res = await post({ ...base, name: 'relio-test' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    globalThis.fetch = realFetch
  })
})

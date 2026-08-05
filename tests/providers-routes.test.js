import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest'
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

beforeEach(() => {
  dbRun('DELETE FROM providers')
  dbRun('DELETE FROM circuit_breaker_state')
  dbRun('DELETE FROM requests_log')
  dbRun('DELETE FROM cache')
  dbRun('DELETE FROM metrics')
})

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
    model: 'model-chat',
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
      ['ren1', 'RenameMe', 'https://alpha.example.com/v1', encrypt('sk-test'), 'model-chat', 'chat', 'openai-compatible', 0, 'Main', 'active']
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

describe('PATCH /admin/api/providers/:id (status-only updates)', () => {
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

  function seedPair() {
    dbRun(
      `INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['pst1', 'StatusProvider', 'https://alpha.example.com/v1', encrypt('sk-test'), 'model-chat', 'chat', 'openai-compatible', 0, 'Main', 'active']
    )
    dbRun(
      `INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['pst2', 'StatusFallback', 'https://beta.example.com/v1', encrypt('sk-test'), 'model-chat', 'chat', 'openai-compatible', 1, 'Fallback 1', 'active']
    )
  }

  it('pausing the Main promotes the fallback and moves it to the end as Paused', async () => {
    seedPair()
    const res = await fetch(`${baseUrl}/admin/api/providers/pst1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'paused' }),
    })
    expect(res.status).toBe(200)
    const list = await fetch(`${baseUrl}/admin/api/providers`).then(r => r.json())
    const main = list.find(p => p.id === 'pst2')
    const paused = list.find(p => p.id === 'pst1')
    expect(main.order_label).toBe('Main')
    expect(main.order_position).toBe(0)
    expect(paused.order_label).toBe('Paused')
    expect(paused.order_position).toBe(1)
  })

  it('does not run the connection test when the URL is unchanged', async () => {
    seedPair()
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url, opts) => {
      if (String(url).startsWith(baseUrl)) return realFetch(url, opts)
      throw new Error('connection test should not run')
    }
    try {
      const res = await fetch(`${baseUrl}/admin/api/providers/pst2`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rate_limit_req_per_min: 100 }),
      })
      expect(res.status).toBe(200)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('allows deleting the Main provider', async () => {
    seedPair()
    const res = await fetch(`${baseUrl}/admin/api/providers/pst2`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    const list = await fetch(`${baseUrl}/admin/api/providers`).then(r => r.json())
    expect(list.find(p => p.id === 'pst2')).toBeUndefined()
  })
})

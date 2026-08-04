import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import express from 'express'

let setDbPath, initDb, closeDb, dbRun, encrypt
let providersRoutes
let server
let baseUrl

beforeAll(async () => {
  process.env.DB_PATH = ':memory:'
  const dbMod = await import('../src/db.js')
  setDbPath = dbMod.setDbPath
  initDb = dbMod.initDb
  closeDb = dbMod.closeDb
  dbRun = dbMod.dbRun
  encrypt = dbMod.encrypt

  setDbPath(':memory:')
  initDb()

  providersRoutes = (await import('../src/routes/providers.routes.js')).default

  const app = express()
  app.use(express.json())
  app.use('/admin/api/providers', providersRoutes)
  server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  baseUrl = `http://localhost:${server.address().port}`
})

afterAll(async () => {
  if (server) await new Promise(r => server.close(r))
  closeDb()
})

beforeEach(() => {
  dbRun('DELETE FROM providers')
  dbRun('DELETE FROM circuit_breaker_state')
  dbRun('DELETE FROM requests_log')
  dbRun('DELETE FROM cache')
  dbRun('DELETE FROM metrics')
})

function seed(id, name, apiUrl, position, label, status = 'active') {
  dbRun(
    `INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, apiUrl, encrypt('sk-test'), 'gpt-4o', 'chat', 'openai-compatible', position, label, status]
  )
}

function patch(id, body) {
  return fetch(`${baseUrl}/admin/api/providers/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function getProviders() {
  return fetch(`${baseUrl}/admin/api/providers`).then(r => r.json())
}

describe('PATCH on providers with private URLs (real SSRF guard)', () => {
  it('allows pausing a provider whose URL is unchanged and private', async () => {
    seed('ssrf1', 'Internal Main', 'http://192.168.10.10/v1', 0, 'Main')
    const res = await patch('ssrf1', { status: 'paused' })
    expect(res.status).toBe(200)
  })

  it('allows updating other fields while the private URL stays unchanged', async () => {
    seed('ssrf2', 'Internal Two', 'http://192.168.10.11/v1', 0, 'Main')
    const res = await patch('ssrf2', {
      name: 'Internal Two',
      api_url: 'http://192.168.10.11/v1',
      api_key: '***',
      rate_limit_req_per_min: 120,
      status: 'paused',
    })
    expect(res.status).toBe(200)
  })

  it('still rejects a change to another private URL', async () => {
    seed('ssrf3', 'Internal Three', 'http://192.168.10.12/v1', 0, 'Main')
    const res = await patch('ssrf3', { api_url: 'http://10.0.0.5/v1' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/private\/loopback/)
  })

  it('accepts a change to a public URL and runs the connection test', async () => {
    seed('ssrf4', 'Internal Four', 'http://192.168.10.13/v1', 0, 'Main')
    const realFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 200 })
    try {
      const res = await patch('ssrf4', { api_url: 'https://alpha.example.com/v1' })
      expect(res.status).toBe(200)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('pausing the Main promotes the next active provider to Main', async () => {
    seed('ssrf-m1', 'MainProv', 'http://192.168.10.20/v1', 0, 'Main')
    seed('ssrf-m2', 'FallbackProv', 'http://192.168.10.21/v1', 1, 'Fallback 1')
    const res = await patch('ssrf-m1', { status: 'paused' })
    expect(res.status).toBe(200)
    const providers = await getProviders()
    const fallback = providers.find(p => p.id === 'ssrf-m2')
    const main = providers.find(p => p.id === 'ssrf-m1')
    expect(fallback.order_label).toBe('Main')
    expect(fallback.order_position).toBe(0)
    expect(main.order_label).toBe('Paused')
    expect(main.order_position).toBe(1)
  })

  it('reactivating moves the provider to the end of the active list', async () => {
    seed('ssrf-r1', 'ReactMain', 'http://192.168.10.30/v1', 1, 'Paused', 'paused')
    seed('ssrf-r2', 'ActiveProv', 'http://192.168.10.31/v1', 0, 'Main')
    const res = await patch('ssrf-r1', { status: 'active' })
    expect(res.status).toBe(200)
    const providers = await getProviders()
    const r1 = providers.find(p => p.id === 'ssrf-r1')
    const r2 = providers.find(p => p.id === 'ssrf-r2')
    expect(r2.order_label).toBe('Main')
    expect(r2.order_position).toBe(0)
    expect(r1.order_label).toBe('Fallback 1')
    expect(r1.order_position).toBe(1)
  })

  it('allows deleting the Main provider and promotes the fallback', async () => {
    seed('ssrf-d1', 'DelMain', 'http://192.168.10.40/v1', 0, 'Main')
    seed('ssrf-d2', 'DelFallback', 'http://192.168.10.41/v1', 1, 'Fallback 1')
    const res = await fetch(`${baseUrl}/admin/api/providers/ssrf-d1`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    const providers = await getProviders()
    const fallback = providers.find(p => p.id === 'ssrf-d2')
    expect(fallback.order_label).toBe('Main')
    expect(fallback.order_position).toBe(0)
    expect(providers.find(p => p.id === 'ssrf-d1')).toBeUndefined()
  })
})

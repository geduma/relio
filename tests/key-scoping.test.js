import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import express from 'express'

let setDbPath, initDb, closeDb, dbRun, encrypt
let authService
let proxyRoutes
let keysRoutes
let server
let baseUrl
let realFetch

const calls = []

function seedProvider(id, name, capability, position, key = 'sk-test') {
  dbRun(
    `INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, `https://${name.toLowerCase()}.example.com/v1`, encrypt(key), 'model-chat', capability, 'openai-compatible', position, position === 0 ? 'Main' : `Fallback ${position}`]
  )
}

function request(path, { apiKey, body, method = 'POST', headers = {} } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
}

beforeAll(async () => {
  const dbMod = await import('../src/db.js')
  setDbPath = dbMod.setDbPath
  initDb = dbMod.initDb
  closeDb = dbMod.closeDb
  dbRun = dbMod.dbRun
  encrypt = dbMod.encrypt

  setDbPath(':memory:')
  initDb()

  seedProvider('p1', 'Alpha', 'chat', 0)
  seedProvider('p2', 'Beta', 'chat', 1)
  seedProvider('p3', 'Gamma', 'chat', 2)
  seedProvider('e1', 'Emb', 'embeddings', 0)

  authService = await import('../src/services/authService.js')
  proxyRoutes = (await import('../src/routes/proxy.routes.js')).default
  keysRoutes = (await import('../src/routes/keys.routes.js')).default

  realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    const u = String(url)
    if (u.startsWith(baseUrl || 'http://localhost')) {
      return realFetch(url, opts)
    }
    const body = opts?.body ? JSON.parse(opts.body) : null
    calls.push({ url: u, body })
    if (u.includes('alpha.example.com')) {
      const err = new Error('upstream 500')
      err.status = 500
      throw err
    }
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { role: 'assistant', content: `hi from ${u}` } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    }
  }

  const app = express()
  app.use(express.json())
  app.use('/v1', proxyRoutes)
  app.use('/admin/api/keys', keysRoutes)
  server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  baseUrl = `http://localhost:${server.address().port}`
})

afterAll(async () => {
  if (server) await new Promise(r => server.close(r))
  globalThis.fetch = realFetch
  closeDb()
})

describe('key creation validation', () => {
  it('rejects a key without providerIds', async () => {
    const res = await fetch(`${baseUrl}/admin/api/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'no providers' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/providerIds/)
  })

  it('rejects a key with an empty providerIds array', async () => {
    const res = await fetch(`${baseUrl}/admin/api/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'empty providers', providerIds: [] }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects a key referencing a nonexistent provider', async () => {
    const res = await fetch(`${baseUrl}/admin/api/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bad provider', providerIds: ['does-not-exist'] }),
    })
    expect(res.status).toBe(400)
  })
})

describe('auto (failover) mode respects provider scope', () => {
  it('fails over only over allowed providers', async () => {
    const key = authService.createApiKey({ name: 'scoped auto', providerIds: ['p1', 'p3'] })
    calls.length = 0

    const res = await request('/v1/chat/completions', {
      apiKey: key,
      body: { model: 'auto', messages: [{ role: 'user', content: 'failover-scope-1' }] },
    })

    expect(res.status).toBe(200)
    const attempted = calls.map(c => c.url)
    expect(attempted.some(u => u.includes('alpha.example.com'))).toBe(true)
    expect(attempted.some(u => u.includes('beta.example.com'))).toBe(false)
    expect(attempted.some(u => u.includes('gamma.example.com'))).toBe(true)
  })
})

describe('specific provider mode respects provider scope', () => {
  it('returns 403 provider_access_denied for an unauthorized provider', async () => {
    const key = authService.createApiKey({ name: 'narrow', providerIds: ['p1'] })
    const res = await request('/v1/chat/completions', {
      apiKey: key,
      body: { model: 'Beta', messages: [{ role: 'user', content: 'denied-1' }] },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      error: { message: 'API key does not have access to this provider', type: 'invalid_request_error', code: 'provider_access_denied' },
    })
  })

  it('returns 403 for an unauthorized provider in streaming mode', async () => {
    const key = authService.createApiKey({ name: 'narrow stream', providerIds: ['p1'] })
    const res = await request('/v1/chat/completions', {
      apiKey: key,
      body: { model: 'p2', messages: [{ role: 'user', content: 'denied-stream-1' }], stream: true },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      error: { message: 'API key does not have access to this provider', type: 'invalid_request_error', code: 'provider_access_denied' },
    })
  })

  it('allows an authorized provider', async () => {
    const key = authService.createApiKey({ name: 'authorized', providerIds: ['p2'] })
    const res = await request('/v1/chat/completions', {
      apiKey: key,
      body: { model: 'Beta', messages: [{ role: 'user', content: 'allowed-1' }] },
    })
    expect(res.status).toBe(200)
  })
})

describe('GET /v1/models respects provider scope', () => {
  it('only lists allowed providers for a scoped key', async () => {
    const key = authService.createApiKey({ name: 'models scope', providerIds: ['p1', 'e1'] })
    const res = await request('/v1/models', { apiKey: key, method: 'GET' })
    expect(res.status).toBe(200)
    const body = await res.json()
    const ids = body.data.map(m => m.id)
    expect(ids).toContain('auto')
    expect(ids).toContain('Alpha')
    expect(ids).toContain('Emb')
    expect(ids).not.toContain('Beta')
    expect(ids).not.toContain('Gamma')
  })
})

describe('PATCH provider scope', () => {
  it('reflects provider changes immediately in the next request', async () => {
    const key = authService.createApiKey({ name: 'patch me', providerIds: ['p1'] })

    const denied = await request('/v1/chat/completions', {
      apiKey: key,
      body: { model: 'Beta', messages: [{ role: 'user', content: 'patch-before-1' }] },
    })
    expect(denied.status).toBe(403)

    const keyId = authService.validateApiKey(key).id
    const patch = await fetch(`${baseUrl}/admin/api/keys/${keyId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerIds: ['p1', 'p2'] }),
    })
    expect(patch.status).toBe(200)
    const patched = await patch.json()
    expect(patched.providers.map(p => p.id)).toEqual(expect.arrayContaining(['p1', 'p2']))

    const allowed = await request('/v1/chat/completions', {
      apiKey: key,
      body: { model: 'Beta', messages: [{ role: 'user', content: 'patch-after-1' }] },
    })
    expect(allowed.status).toBe(200)
  })

  it('rejects an empty providerIds array on PATCH', async () => {
    const key = authService.createApiKey({ name: 'patch empty', providerIds: ['p1'] })
    const keyId = authService.validateApiKey(key).id
    const res = await fetch(`${baseUrl}/admin/api/keys/${keyId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerIds: [] }),
    })
    expect(res.status).toBe(400)
  })
})

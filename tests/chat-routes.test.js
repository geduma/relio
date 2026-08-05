import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import express from 'express'

let setDbPath, initDb, closeDb, dbRun, encrypt
let chatRoutes
let setCache

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
  setCache = (await import('../src/services/cacheManager.js')).setCache
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

describe('POST /admin/api/chat/send streaming', () => {
  const encoder = new TextEncoder()
  let server
  let baseUrl
  let realFetch

  function streamingMock(chunks, delayMs = 5) {
    const stream = new ReadableStream({
      start(controller) {
        chunks.forEach((chunk, i) => {
          setTimeout(() => {
            try {
              controller.enqueue(encoder.encode(chunk))
              if (i === chunks.length - 1) controller.close()
            } catch { /* stream already closed */ }
          }, delayMs * (i + 1))
        })
      },
    })
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }

  function sseEvents(text) {
    return text.split('\n\n').map(b => b.trim()).filter(Boolean)
  }

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
    realFetch = globalThis.fetch
  })

  afterAll(async () => {
    globalThis.fetch = realFetch
    if (server) await new Promise(r => server.close(r))
  })

  it('streams a _provider meta chunk, delta content and [DONE] in direct mode', async () => {
    globalThis.fetch = async () => streamingMock([
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n',
    ])

    const res = await realFetch(`${baseUrl}/admin/api/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        use_proxy: false,
        provider_id: 'chatp1',
        stream: true,
      }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const events = sseEvents(await res.text())
    const providerEvent = events.find(e => e.includes('_provider'))
    expect(providerEvent).toBeTruthy()
    expect(providerEvent).toContain('"id":"chatp1"')
    expect(providerEvent).toContain('"name":"ChatP"')

    const content = events
      .filter(e => e.startsWith('data:') && e.includes('delta'))
      .map(e => {
        try { return JSON.parse(e.slice(5)).choices?.[0]?.delta?.content || '' } catch { return '' }
      })
      .join('')
    expect(content).toBe('Hello world')
    expect(events.at(-1)).toBe('data: [DONE]')
  })

  it('returns cached content with _cache_hit when the proxy cache hits', async () => {
    const cachedMessages = [{ role: 'user', content: 'cache me' }]
    setCache('/v1/chat/completions', { messages: cachedMessages }, {
      choices: [{ message: { role: 'assistant', content: 'CACHED CONTENT' } }],
    }, 'chatp1')

    const res = await realFetch(`${baseUrl}/admin/api/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: cachedMessages, use_proxy: true, stream: true }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    expect(text).toContain('"_cache_hit":true')
    expect(text).toContain('CACHED CONTENT')
    expect(text).toContain('data: [DONE]')
  })

  it('returns a JSON error for an unknown provider in streaming direct mode', async () => {
    const res = await realFetch(`${baseUrl}/admin/api/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        use_proxy: false,
        provider_id: 'does-not-exist',
        stream: true,
      }),
    })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('Provider not found')
  })
})

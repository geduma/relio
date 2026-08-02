import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import express from 'express'

let setDbPath, initDb, closeDb, dbRun, encrypt, hashApiKey
let proxyRoutes
let server
let baseUrl
let realFetch
let upstreamSignal = null
let upstreamCancelled = false

const encoder = new TextEncoder()

function streamingMockResponse(chunks, delayMs = 15) {
  upstreamCancelled = false
  const stream = new ReadableStream({
    start(controller) {
      chunks.forEach((chunk, i) => {
        setTimeout(() => {
          if (upstreamCancelled) return
          try {
            controller.enqueue(encoder.encode(chunk))
            if (i === chunks.length - 1) controller.close()
          } catch {
            // stream already closed (cancelled upstream)
          }
        }, delayMs * (i + 1))
      })
    },
    cancel() {
      upstreamCancelled = true
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

function installUpstreamMock(responseFn) {
  upstreamSignal = null
  upstreamCancelled = false
  globalThis.fetch = async (url, opts) => {
    upstreamSignal = opts?.signal || null
    return responseFn(url, opts)
  }
}

async function waitFor(cond, timeout = 3000, interval = 20) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (cond()) return
    await new Promise(r => setTimeout(r, interval))
  }
  throw new Error('waitFor timed out')
}

async function postStream(path, body, opts = {}) {
  const { headers, ...fetchOpts } = opts
  return realFetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer llm_pk_test_stream_key', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    ...fetchOpts,
  })
}

beforeAll(async () => {
  realFetch = globalThis.fetch
  process.env.DB_PATH = ':memory:'
  const dbMod = await import('../src/db.js')
  setDbPath = dbMod.setDbPath
  initDb = dbMod.initDb
  closeDb = dbMod.closeDb
  dbRun = dbMod.dbRun
  encrypt = dbMod.encrypt
  hashApiKey = dbMod.hashApiKey

  setDbPath(':memory:')
  initDb()

  dbRun(
    `INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['pA', 'AlphaChat', 'https://alpha.example.com/v1', encrypt('sk-a'), 'gpt-4o', 'chat', 'openai-compatible', 0, 'Main']
  )
  dbRun("INSERT INTO api_keys (id, key_hash, key_prefix, name) VALUES (?, ?, ?, ?)", ['k1', hashApiKey('llm_pk_test_stream_key'), 'llm_pk_te', 'test'])

  proxyRoutes = (await import('../src/routes/proxy.routes.js')).default

  const app = express()
  app.use(express.json())
  app.use('/v1', proxyRoutes)
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: { message: err.message, type: 'error', code: 'error' } })
  })

  server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  baseUrl = `http://localhost:${server.address().port}`

    installUpstreamMock((_url, _opts) => streamingMockResponse([
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n',
    ]))
  })

afterAll(async () => {
  globalThis.fetch = undefined
  if (server) {
    server.closeAllConnections?.()
    await new Promise(r => server.close(r))
  }
  closeDb()
})

describe('POST /v1/chat/completions streaming', () => {
  it('returns SSE headers, streams chunks progressively and ends with [DONE]', async () => {
    const res = await postStream('/v1/chat/completions', {
      model: 'pA',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.headers.get('cache-control')).toBe('no-cache')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const parts = []
    const t0 = Date.now()
    let firstChunkAt = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (firstChunkAt === 0) firstChunkAt = Date.now() - t0
      parts.push(decoder.decode(value, { stream: true }))
    }
    const totalMs = Date.now() - t0
    const text = parts.join('')

    expect(firstChunkAt).toBeLessThan(1000)
    expect(firstChunkAt).toBeLessThanOrEqual(totalMs)
    expect(text).toContain('Hello')
    expect(text).toContain('world')
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
    expect(text.indexOf('Hello')).toBeLessThan(text.indexOf('world'))
    expect(text.indexOf('world')).toBeLessThan(text.indexOf('[DONE]'))
    expect(upstreamSignal?.aborted).toBe(false)
  })

  it('relays OpenAI chunks verbatim (varied id/created, usage, tool_calls + content)', async () => {
    const chunkBodies = [
      { id: 'chatcmpl-A', created: 1000, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
      { id: 'chatcmpl-B', created: 2000, choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] },
      {
        id: 'chatcmpl-C',
        created: 3000,
        choices: [{
          index: 0,
          delta: {
            content: '!',
            tool_calls: [{
              index: 0,
              id: 'call_x',
              type: 'function',
              function: { name: 'get_weather', arguments: JSON.stringify({ city: 'Paris' }) },
            }],
          },
          finish_reason: null,
        }],
      },
      { id: 'chatcmpl-D', created: 4000, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 12, total_tokens: 21 } },
    ]
    const sse = chunkBodies
      .map(c => `data: ${JSON.stringify({ object: 'chat.completion.chunk', model: 'gpt-4o', ...c })}\n\n`)
      .join('') + 'data: [DONE]\n\n'

    installUpstreamMock((_url, _opts) => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sse))
          controller.close()
        },
      })
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    })

    const res = await postStream('/v1/chat/completions', {
      model: 'pA',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    expect(res.status).toBe(200)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }

    expect(text).toBe(sse)

    const events = text
      .split('\n\n')
      .filter(l => l.startsWith('data: ') && l !== 'data: [DONE]')
      .map(l => JSON.parse(l.slice(6)))

    expect(events.length).toBe(4)
    expect(events.map(e => e.id)).toEqual(['chatcmpl-A', 'chatcmpl-B', 'chatcmpl-C', 'chatcmpl-D'])
    expect(events.map(e => e.created)).toEqual([1000, 2000, 3000, 4000])
    expect(events[0].choices[0].delta).toEqual({ role: 'assistant' })
    expect(events[1].choices[0].delta.content).toBe('Hello')
    expect(events[2].choices[0].delta.content).toBe('!')
    expect(events[2].choices[0].delta.tool_calls).toEqual([{
      index: 0,
      id: 'call_x',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
    }])
    expect(events[3].usage).toEqual({ prompt_tokens: 9, completion_tokens: 12, total_tokens: 21 })
    expect(events[3].choices[0].finish_reason).toBe('stop')
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
  })

  it('does not wait for the full response (chunks arrive before completion)', async () => {
    installUpstreamMock((_url, _opts) => streamingMockResponse([
      'data: {"choices":[{"index":0,"delta":{"content":"chunk-a"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"chunk-b"},"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n',
    ], 60))

    const res = await postStream('/v1/chat/completions', {
      model: 'pA',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    const reader = res.body.getReader()
    const first = await reader.read()
    const firstText = new TextDecoder().decode(first.value)
    expect(firstText).toContain('chunk-a')

    const rest = await reader.read()
    expect(new TextDecoder().decode(rest.value)).toContain('chunk-b')
    reader.cancel()

    installUpstreamMock((_url, _opts) => streamingMockResponse([
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n',
    ]))
  })

  it('aborts the upstream request when the client disconnects mid-stream', async () => {
    let cancelledFlag = false
    let intervalId = null
    upstreamSignal = null

    globalThis.fetch = async (url, opts) => {
      upstreamSignal = opts?.signal || null
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'))
          intervalId = setInterval(() => {
            if (cancelledFlag) return
            controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"tick"},"finish_reason":null}]}\n\n'))
          }, 20)
        },
        cancel() {
          cancelledFlag = true
          if (intervalId) clearInterval(intervalId)
        },
      })
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }

    const ac = new AbortController()
    const res = await postStream('/v1/chat/completions', {
      model: 'pA',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }, { signal: ac.signal })

    expect(res.status).toBe(200)
    const reader = res.body.getReader()
    await reader.read()
    await waitFor(() => !cancelledFlag && upstreamSignal !== null)

    ac.abort()

    await waitFor(() => upstreamSignal?.aborted === true)
    expect(upstreamSignal.aborted).toBe(true)
    await waitFor(() => cancelledFlag === true, 2000)
    expect(cancelledFlag).toBe(true)

    installUpstreamMock((_url, _opts) => streamingMockResponse([
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n',
    ]))
  })

  it('returns a 502 OpenAI-formatted error when the upstream responds JSON with status 200', async () => {
    installUpstreamMock((_url, _opts) => new Response(
      JSON.stringify({ error: { message: 'streaming unavailable' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ))

    const res = await postStream('/v1/chat/completions', {
      model: 'pA',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })

    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error.message).toBe('streaming unavailable')
    expect(typeof body.error.type).toBe('string')
    expect(typeof body.error.code).toBe('string')
  })
})

describe('auth error format', () => {
  it('returns OpenAI-formatted 401 for missing auth', async () => {
    const res = await realFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'pA', messages: [] }),
    })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBeTypeOf('object')
    expect(typeof body.error.message).toBe('string')
    expect(body.error.type).toBe('authentication_error')
    expect(body.error.code).toBe('authentication')
  })

  it('returns OpenAI-formatted 403 for an invalid key', async () => {
    const res = await postStream('/v1/chat/completions', {
      model: 'pA',
      messages: [{ role: 'user', content: 'hi' }],
    }, { headers: { Authorization: 'Bearer not-a-real-key' } })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBeTypeOf('object')
    expect(body.error.type).toBe('authentication_error')
    expect(body.error.code).toBe('authentication')
  })
})

describe('GeminiNativeAdapter streaming (incremental chunks)', () => {
  it('converts incremental text + tool call chunks to OpenAI deltas ending in [DONE]', async () => {
    const mod = await import('../src/adapters/gemini-native.js')
    const adapter = new mod.default()

    const lines = [
      { candidates: [{ content: { role: 'model', parts: [{ text: 'Hello' }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ text: ' world' }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] } }] },
      { candidates: [{ finishReason: 'TOOL_CALL' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } },
    ]

    globalThis.fetch = async () => {
      const payload = lines.map(l => JSON.stringify(l)).join('\n')
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(payload))
          controller.close()
        },
      })
      return new Response(stream, { status: 200 })
    }

    const provider = { api_url: 'https://gamma.example.com', api_key: 'sk-g', model: 'gemini-pro' }
    const body = { messages: [{ role: 'user', content: 'What is the weather in Paris?' }], stream: true }
    const nodeStream = await adapter.stream(provider, body, new AbortController().signal)

    const chunks = []
    for await (const buf of nodeStream) chunks.push(buf.toString())
    const sse = chunks.join('')

    const events = sse
      .split('\n\n')
      .filter(l => l.startsWith('data: ') && l !== 'data: [DONE]')
      .map(l => JSON.parse(l.slice(6)))

    expect(events.length).toBe(4)
    expect(events[0].choices[0].delta.role).toBe('assistant')
    expect(events[0].choices[0].delta.content).toBe('Hello')
    expect(events[1].choices[0].delta.content).toBe(' world')
    expect(events[1].choices[0].delta.content).not.toBe(' world'.slice(5))

    const tc = events[2].choices[0].delta.tool_calls[0]
    expect(tc.index).toBe(0)
    expect(tc.id).toBe('call_0')
    expect(tc.type).toBe('function')
    expect(tc.function.name).toBe('get_weather')
    expect(JSON.parse(tc.function.arguments)).toEqual({ city: 'Paris' })

    expect(events[3].choices[0].finish_reason).toBe('tool_calls')
    expect(events[3].usage).toEqual({ prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 })
    expect(sse.trimEnd().endsWith('data: [DONE]')).toBe(true)
  })

  it('preserves role and content across a plain-text incremental stream', async () => {
    const mod = await import('../src/adapters/gemini-native.js')
    const adapter = new mod.default()

    globalThis.fetch = async () => {
      const payload = [
        { candidates: [{ content: { role: 'model', parts: [{ text: 'The' }] } }] },
        { candidates: [{ content: { role: 'model', parts: [{ text: ' quick' }] } }] },
        { candidates: [{ content: { role: 'model', parts: [{ text: ' fox' }] } }] },
        { candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 3 } },
      ].map(l => JSON.stringify(l)).join('\n')
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(payload))
          controller.close()
        },
      })
      return new Response(stream, { status: 200 })
    }

    const provider = { api_url: 'https://gamma.example.com', api_key: 'sk-g', model: 'gemini-pro' }
    const nodeStream = await adapter.stream(provider, { messages: [{ role: 'user', content: 'x' }] }, new AbortController().signal)
    const sse = (await (async () => {
      const chunks = []
      for await (const buf of nodeStream) chunks.push(buf.toString())
      return chunks.join('')
    })())

    const content = sse
      .split('\n\n')
      .filter(l => l.startsWith('data: ') && l !== 'data: [DONE]')
      .map(l => JSON.parse(l.slice(6)).choices[0].delta.content)
      .join('')
    expect(content).toBe('The quick fox')
  })
})

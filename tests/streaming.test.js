import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import express from 'express'
import { Readable } from 'stream'

let setDbPath, initDb, closeDb, dbRun, encrypt, hashApiKey
let proxyRoutes
let server
let baseUrl
let realFetch
let upstreamSignal = null
let upstreamCancelled = false

const encoder = new TextEncoder()

const TEST_KEY = `relio_sk_${'a'.repeat(64)}`
const TEST_KEY_PREFIX = TEST_KEY.slice(0, 10)

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
    headers: { 'Authorization': `Bearer ${TEST_KEY}`, 'Content-Type': 'application/json', ...headers },
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
    ['pA', 'AlphaOne', 'https://alpha.example.com/v1', encrypt('sk-a'), 'model-chat', 'chat', 'openai-compatible', 0, 'Main']
  )
  dbRun("INSERT INTO api_keys (id, key_hash, key_prefix, name) VALUES (?, ?, ?, ?)", ['k1', hashApiKey(TEST_KEY), TEST_KEY_PREFIX, 'test'])
  dbRun("INSERT INTO api_key_providers (api_key_id, provider_id) VALUES (?, ?)", ['k1', 'pA'])

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

  it('strips non-standard fields (e.g. signal) from the body forwarded upstream', async () => {
    let sentBody = null
    installUpstreamMock((_url, opts) => {
      sentBody = JSON.parse(opts.body)
      return streamingMockResponse([
        'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
        'data: [DONE]\n\n',
      ])
    })

    const res = await postStream('/v1/chat/completions', {
      model: 'pA',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      signal: { aborted: false },
    })
    expect(res.status).toBe(200)
    const reader = res.body.getReader()
    while (!(await reader.read()).done) { /* drain */ }

    expect(sentBody.signal).toBeUndefined()
    expect(sentBody.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(sentBody.stream).toBe(true)
    expect(sentBody.stream_options).toEqual({ include_usage: true })

    installUpstreamMock((_url, _opts) => streamingMockResponse([
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n',
    ]))
  })

  it('retries upstream once without stream_options when the provider rejects the injected field', async () => {
    const sentBodies = []
    installUpstreamMock((_url, opts) => {
      const parsed = JSON.parse(opts.body)
      sentBodies.push(parsed)
      if (sentBodies.length === 1) {
        return new Response(JSON.stringify({ error: { message: "property 'stream_options' is unsupported, did you mean 'stream'?" } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return streamingMockResponse([
        'data: {"choices":[{"index":0,"delta":{"content":"recovered"},"finish_reason":null}]}\n\n',
        'data: [DONE]\n\n',
      ])
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

    expect(text).toContain('recovered')
    expect(sentBodies).toHaveLength(2)
    expect(sentBodies[0].stream_options).toEqual({ include_usage: true })
    expect(sentBodies[1].stream_options).toBeUndefined()

    installUpstreamMock((_url, _opts) => streamingMockResponse([
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n',
    ]))
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
      .map(c => `data: ${JSON.stringify({ object: 'chat.completion.chunk', model: 'model-chat', ...c })}\n\n`)
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

  it('emits SSE keep-alive comments while the upstream is slow to produce data', async () => {
    const cfg = (await import('../src/config.js')).config
    cfg.relay.streamKeepAliveMs = 200

    globalThis.fetch = async () => {
      upstreamSignal = null
      upstreamCancelled = false
      const stream = new ReadableStream({
        start(controller) {
          setTimeout(() => {
            if (upstreamCancelled) return
            controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"late"},"finish_reason":null}]}\n\n'))
          }, 800)
          setTimeout(() => {
            if (upstreamCancelled) return
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          }, 850)
        },
        cancel() {
          upstreamCancelled = true
        },
      })
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }

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

    expect(text).toContain(': keep-alive')
    expect(text).toContain('late')
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)

    cfg.relay.streamKeepAliveMs = 0
    installUpstreamMock((_url, _opts) => streamingMockResponse([
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n',
    ]))
  })

  it('logs a 503 interruption entry when the client disconnects mid-stream', async () => {
    const dbMod = await import('../src/db.js')
    const { flushAll } = await import('../src/services/logQueue.js')
    const cfg = (await import('../src/config.js')).config
    cfg.relay.streamKeepAliveMs = 0
    dbMod.dbRun("DELETE FROM requests_log WHERE status_code = 503")

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
    await waitFor(() => upstreamSignal !== null)

    ac.abort()

    await waitFor(() => cancelledFlag === true, 2000)
    expect(cancelledFlag).toBe(true)

    await waitFor(() => {
      flushAll()
      return dbMod.dbGet("SELECT status_code, error_message FROM requests_log WHERE status_code = 503 ORDER BY request_at DESC LIMIT 1")
    }, 3000)
    const log = dbMod.dbGet("SELECT status_code, error_message FROM requests_log WHERE status_code = 503 ORDER BY request_at DESC LIMIT 1")
    expect(log.status_code).toBe(503)
    expect(log.error_message).toMatch(/client disconnected/i)

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

  it('rejects a direct-provider stream request when the provider is rate limited', async () => {
    const fe = await import('../src/services/failoverEngine.js')
    dbRun("UPDATE providers SET rate_limit_req_per_min = 1 WHERE id = 'pA'")
    fe.recordProviderRequest('pA')

    const res = await postStream('/v1/chat/completions', {
      model: 'pA',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })

    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error.message).toMatch(/rate or daily limit/i)

    dbRun("UPDATE providers SET rate_limit_req_per_min = 60 WHERE id = 'pA'")
  })
})

describe('StreamUsageTracker', () => {
  it('captures usage across split chunks and passes bytes through unchanged', async () => {
    const { StreamUsageTracker } = await import('../src/services/streamUsageTracker.js')
    const tracker = new StreamUsageTracker()
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ].join('')

    const fromWeb = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sse.slice(0, 20)))
        controller.enqueue(encoder.encode(sse.slice(20)))
        controller.close()
      },
    })
    const nodeStream = Readable.fromWeb(fromWeb)
    const out = []
    for await (const buf of nodeStream.pipe(tracker.createTransform())) {
      out.push(Buffer.isBuffer(buf) ? buf.toString() : String(buf))
    }

    expect(out.join('')).toBe(sse)
    expect(tracker.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 })
  })

  it('leaves usage null when no usage chunk is present', async () => {
    const { StreamUsageTracker } = await import('../src/services/streamUsageTracker.js')
    const tracker = new StreamUsageTracker()
    const fromWeb = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":null}]}\n\ndata: [DONE]\n\n'))
        controller.close()
      },
    })
    for await (const _buf of Readable.fromWeb(fromWeb).pipe(tracker.createTransform())) { /* drain */ }
    expect(tracker.usage).toBeNull()
  })
})

describe('streaming request logging', () => {
  it('logs the provider and the authenticated api key as requester', async () => {
    const dbMod = await import('../src/db.js')
    const { flushAll } = await import('../src/services/logQueue.js')

    installUpstreamMock((_url, _opts) => streamingMockResponse([
      'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n',
    ]))

    const res = await postStream('/v1/chat/completions', {
      model: 'pA',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    expect(res.status).toBe(200)
    const reader = res.body.getReader()
    while (!(await reader.read()).done) { /* drain */ }

    flushAll()
    const log = dbMod.dbGet("SELECT provider_id, provider_name, requester_name, requester_key FROM requests_log WHERE endpoint = '/v1/chat/completions' ORDER BY request_at DESC LIMIT 1")
    expect(log).toBeTruthy()
    expect(log.provider_id).toBe('pA')
    expect(log.provider_name).toBe('AlphaOne')
    expect(log.requester_name).toBe('test')
    expect(log.requester_key).toBe(TEST_KEY_PREFIX)
  })

  it('captures input/output tokens from the final streaming usage chunk and relays it verbatim', async () => {
    const dbMod = await import('../src/db.js')
    const { flushAll } = await import('../src/services/logQueue.js')

    const usageChunk = 'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":5,"total_tokens":12}}\n\n'
    installUpstreamMock((_url, _opts) => streamingMockResponse([
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
      usageChunk,
      'data: [DONE]\n\n',
    ]))

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
    expect(text).toContain(usageChunk)

    flushAll()
    const log = dbMod.dbGet("SELECT input_tokens, output_tokens, total_tokens, ttft_ms FROM requests_log WHERE endpoint = '/v1/chat/completions' AND status_code = 200 ORDER BY request_at DESC LIMIT 1")
    expect(log.input_tokens).toBe(7)
    expect(log.output_tokens).toBe(5)
    expect(log.total_tokens).toBe(12)
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

    const provider = { api_url: 'https://gamma.example.com', api_key: 'sk-g', model: 'model-native' }
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

    const provider = { api_url: 'https://gamma.example.com', api_key: 'sk-g', model: 'model-native' }
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

describe('streaming failover', () => {
  let dbMod

  beforeAll(async () => {
    dbMod = await import('../src/db.js')
  })

  afterEach(() => {
    dbMod.dbRun("UPDATE providers SET status = 'active', cooldown_until = NULL WHERE id = 'pA'")
    dbMod.dbRun("DELETE FROM circuit_breaker_state WHERE provider_id = 'pA'")
  })

  it('falls back to the next provider when the first returns 429 and applies a rate cooldown', async () => {
    dbRun(
      `INSERT INTO providers (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['pB', 'BetaTwo', 'https://beta.example.com/v1', encrypt('sk-b'), 'model-beta', 'chat', 'openai-compatible', 1, 'Fallback']
    )
    const authMod = await import('../src/services/authService.js')
    authMod.updateApiKeyProviders('k1', ['pA', 'pB'])

    installUpstreamMock(async (url) => {
      if (String(url).includes('alpha.example.com')) {
        return new Response(JSON.stringify({ error: { message: 'Rate limit reached', type: 'rate_limit_exceeded' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return streamingMockResponse([
        'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"content":"Hello from beta"},"finish_reason":null}]}\n\n',
        'data: [DONE]\n\n',
      ])
    })

    const res = await postStream('/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }

    expect(text).toContain('Hello from beta')
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)

    const alpha = dbMod.dbGet("SELECT status, cooldown_until FROM providers WHERE id = 'pA'")
    expect(alpha.status).toBe('cooldown')
    const remaining = new Date(alpha.cooldown_until).getTime() - Date.now()
    expect(remaining).toBeGreaterThan(58 * 1000)
    expect(remaining).toBeLessThanOrEqual(60 * 1000)
  })

  it('applies a quota cooldown and returns the error for a direct-provider 402 stream (no empty SSE)', async () => {
    installUpstreamMock(async () => new Response(
      JSON.stringify({ error: { message: 'Insufficient credits', type: 'billing_error' } }),
      { status: 402, headers: { 'Content-Type': 'application/json' } }
    ))

    const res = await postStream('/v1/chat/completions', {
      model: 'pA',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })

    expect(res.status).toBe(402)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json()
    expect(body.error.message).toMatch(/insufficient credits/i)

    const alpha = dbMod.dbGet("SELECT status, cooldown_until FROM providers WHERE id = 'pA'")
    expect(alpha.status).toBe('cooldown')
    expect(new Date(alpha.cooldown_until).getTime() - Date.now()).toBeGreaterThan(3000 * 1000 - 60000)
  })

  it('returns 503 when no provider is available for streaming (all in cooldown)', async () => {
    const authMod = await import('../src/services/authService.js')
    authMod.updateApiKeyProviders('k1', ['pA'])
    dbMod.dbRun(
      "UPDATE providers SET status = 'cooldown', cooldown_until = ? WHERE id = 'pA'",
      [new Date(Date.now() + 3600000).toISOString()]
    )

    const res = await postStream('/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })

    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error.message).toMatch(/No available provider for streaming/i)
  })
})

describe('streaming timeout and abort semantics', () => {
  let dbMod
  let authMod
  let flushAll
  let cfg
  let resetRunningCounts

  const DEFAULT_CHUNKS = [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n',
    'data: [DONE]\n\n',
  ]

  beforeAll(async () => {
    dbMod = await import('../src/db.js')
    authMod = await import('../src/services/authService.js')
    ;({ flushAll } = await import('../src/services/logQueue.js'))
    ;({ resetRunningCounts } = await import('../src/services/circuitBreaker.js'))
    cfg = (await import('../src/config.js')).config
  })

  afterEach(() => {
    dbMod.dbRun("UPDATE providers SET status = 'active', cooldown_until = NULL WHERE id = 'pA'")
    dbMod.dbRun("DELETE FROM circuit_breaker_state WHERE provider_id = 'pA'")
    resetRunningCounts('pA')
    authMod.updateApiKeyProviders('k1', ['pA'])
    cfg.relay.streamIdleTimeoutMs = 120000
    cfg.relay.streamKeepAliveMs = 0
    cfg.relay.streamTimeoutSeconds = 300
    installUpstreamMock((_url, _opts) => streamingMockResponse(DEFAULT_CHUNKS))
  })

  async function readAll(res) {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const t0 = Date.now()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
      }
    } catch {
      // server destroyed the response socket (expected on abort)
    }
    return { text, totalMs: Date.now() - t0 }
  }

  function latestLog() {
    flushAll()
    return dbMod.dbGet("SELECT error_message, ttft_ms FROM requests_log WHERE endpoint = '/v1/chat/completions' ORDER BY rowid DESC LIMIT 1")
  }

  function latest503() {
    flushAll()
    return dbMod.dbGet("SELECT error_message, ttft_ms FROM requests_log WHERE endpoint = '/v1/chat/completions' AND status_code = 503 ORDER BY rowid DESC LIMIT 1")
  }

  async function waitFor503(messageRe) {
    await waitFor(() => {
      flushAll()
      const row = latest503()
      return row && messageRe.test(row.error_message)
    }, 3000)
    flushAll()
    return latest503()
  }

  it('records TTFT from the first upstream chunk, not from heartbeats', async () => {
    cfg.relay.streamKeepAliveMs = 100
    dbMod.dbRun("DELETE FROM requests_log WHERE status_code = 200")
    const upstreamCancelledRef = { cancelled: false }

    globalThis.fetch = async () => {
      const stream = new ReadableStream({
        start(controller) {
          setTimeout(() => {
            if (upstreamCancelledRef.cancelled) return
            controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"late"},"finish_reason":null}]}\n\n'))
          }, 700)
          setTimeout(() => {
            if (upstreamCancelledRef.cancelled) return
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          }, 750)
        },
        cancel() { upstreamCancelledRef.cancelled = true },
      })
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }

    const res = await postStream('/v1/chat/completions', {
      model: 'pA',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    expect(res.status).toBe(200)

    const { text } = await readAll(res)
    expect(text).toContain(': keep-alive')
    const keepAliveIndex = text.indexOf(': keep-alive')
    const firstContentIndex = text.indexOf('"content":"late"')
    expect(keepAliveIndex).toBeGreaterThan(-1)
    expect(firstContentIndex).toBeGreaterThan(-1)
    expect(keepAliveIndex).toBeLessThan(firstContentIndex)

    const log = latestLog()
    expect(log.ttft_ms).toBeGreaterThan(600)
    expect(log.ttft_ms).toBeLessThan(2000)
  })

  it('leaves TTFT null when the upstream never sends any content', async () => {
    dbMod.dbRun("DELETE FROM requests_log WHERE status_code = 200")
    globalThis.fetch = async () => {
      const stream = new ReadableStream({
        start(controller) { controller.close() },
      })
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }

    const res = await postStream('/v1/chat/completions', {
      model: 'pA',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    expect(res.status).toBe(200)

    const { text } = await readAll(res)
    expect(text).toBe('')

    const log = latestLog()
    expect(log.ttft_ms).toBeNull()
  })

  it('does not penalize the provider when the client disconnects before the stream starts', async () => {
    dbMod.dbRun("UPDATE providers SET status = 'active', cooldown_until = NULL WHERE id = 'pA'")
    dbMod.dbRun("DELETE FROM circuit_breaker_state WHERE provider_id = 'pA'")
    resetRunningCounts('pA')

    upstreamSignal = null
    globalThis.fetch = async (_url, opts) => {
      upstreamSignal = opts?.signal || null
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('This operation was aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    }

    const ac = new AbortController()
    const fetchPromise = postStream('/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }, { signal: ac.signal })
    fetchPromise.catch(() => {})

    await waitFor(() => upstreamSignal !== null)
    ac.abort()

    await waitFor(() => upstreamSignal.aborted === true)
    await expect(fetchPromise).rejects.toThrow()
    await new Promise(r => setTimeout(r, 100))
    flushAll()

    const alpha = dbMod.dbGet("SELECT status FROM providers WHERE id = 'pA'")
    expect(alpha.status).toBe('active')
    const circuit = dbMod.dbGet("SELECT failure_count FROM circuit_breaker_state WHERE provider_id = 'pA'")
    expect(circuit?.failure_count || 0).toBe(0)

    installUpstreamMock((_url, _opts) => streamingMockResponse([
      'data: {"choices":[{"index":0,"delta":{"content":"still alive"},"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n',
    ]))
    const res = await postStream('/v1/chat/completions', {
      model: 'pA',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    expect(res.status).toBe(200)
    const { text } = await readAll(res)
    expect(text).toContain('still alive')
  })

  it('cuts the stream on idle timeout and counts exactly one circuit failure', async () => {
    cfg.relay.streamIdleTimeoutMs = 150
    dbMod.dbRun("DELETE FROM requests_log WHERE status_code = 503")

    globalThis.fetch = async (_url, opts) => {
      const stream = new ReadableStream({
        start(controller) {
          opts.signal.addEventListener('abort', () => {
            try { controller.error(new Error('aborted')) } catch { /* already closed */ }
          })
          setTimeout(() => {
            try {
              controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"first"},"finish_reason":null}]}\n\n'))
            } catch { /* already closed */ }
          }, 20)
        },
      })
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }

    const res = await postStream('/v1/chat/completions', {
      model: 'pA',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    expect(res.status).toBe(200)

    const { text, totalMs } = await readAll(res)
    expect(text).toContain('first')
    expect(totalMs).toBeLessThan(1500)

    const log = await waitFor503(/idle timeout/i)
    expect(log.error_message).toMatch(/idle timeout/i)

    flushAll()
    const circuit = dbMod.dbGet("SELECT state, failure_count FROM circuit_breaker_state WHERE provider_id = 'pA'")
    expect(circuit.failure_count).toBe(1)
    const alpha = dbMod.dbGet("SELECT status FROM providers WHERE id = 'pA'")
    expect(alpha.status).toBe('active')
  })

  it('cuts the stream on max duration and does not penalize the provider', async () => {
    cfg.relay.streamTimeoutSeconds = 1
    dbMod.dbRun("DELETE FROM requests_log WHERE status_code = 503")

    let intervalId = null
    globalThis.fetch = async (_url, opts) => {
      const stream = new ReadableStream({
        start(controller) {
          opts.signal.addEventListener('abort', () => {
            if (intervalId) clearInterval(intervalId)
            try { controller.error(new Error('aborted')) } catch { /* already closed */ }
          })
          intervalId = setInterval(() => {
            try {
              controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"tick"},"finish_reason":null}]}\n\n'))
            } catch { /* already closed */ }
          }, 20)
        },
        cancel() {
          if (intervalId) clearInterval(intervalId)
        },
      })
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }

    const res = await postStream('/v1/chat/completions', {
      model: 'pA',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    expect(res.status).toBe(200)

    const { text, totalMs } = await readAll(res)
    expect(text).toContain('tick')
    expect(totalMs).toBeGreaterThan(800)
    expect(totalMs).toBeLessThan(3000)

    const log = await waitFor503(/max duration/i)
    expect(log.error_message).toMatch(/max duration/i)

    flushAll()
    const circuit = dbMod.dbGet("SELECT failure_count FROM circuit_breaker_state WHERE provider_id = 'pA'")
    expect(circuit?.failure_count || 0).toBe(0)
    const alpha = dbMod.dbGet("SELECT status FROM providers WHERE id = 'pA'")
    expect(alpha.status).toBe('active')
  })

  it('idle timeout still fires while heartbeats flow (heartbeat does not reset idle)', async () => {
    cfg.relay.streamIdleTimeoutMs = 200
    cfg.relay.streamKeepAliveMs = 50
    dbMod.dbRun("DELETE FROM requests_log WHERE status_code = 503")

    globalThis.fetch = async (_url, opts) => {
      const stream = new ReadableStream({
        start(controller) {
          opts.signal.addEventListener('abort', () => {
            try { controller.error(new Error('aborted')) } catch { /* already closed */ }
          })
        },
      })
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }

    const res = await postStream('/v1/chat/completions', {
      model: 'pA',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    expect(res.status).toBe(200)

    const { text, totalMs } = await readAll(res)
    expect(text).toContain(': keep-alive')
    expect(totalMs).toBeGreaterThan(50)
    expect(totalMs).toBeLessThan(1500)

    const log = await waitFor503(/idle timeout/i)
    expect(log.error_message).toMatch(/idle timeout/i)
  })

  it('records a circuit failure for a pre-headers upstream error and still falls back', async () => {
    authMod.updateApiKeyProviders('k1', ['pA', 'pB'])
    dbMod.dbRun("UPDATE providers SET status = 'active', cooldown_until = NULL WHERE id = 'pA'")
    dbMod.dbRun("DELETE FROM circuit_breaker_state WHERE provider_id = 'pA'")
    resetRunningCounts('pA')

    globalThis.fetch = async (url) => {
      if (String(url).includes('alpha.example.com')) {
        return new Response(
          JSON.stringify({ error: { message: 'Server exploded', type: 'server_error' } }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return streamingMockResponse([
        'data: {"choices":[{"index":0,"delta":{"content":"beta ok"},"finish_reason":null}]}\n\n',
        'data: [DONE]\n\n',
      ])
    }

    const res = await postStream('/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    expect(res.status).toBe(200)

    const { text } = await readAll(res)
    expect(text).toContain('beta ok')

    flushAll()
    const circuit = dbMod.dbGet("SELECT failure_count FROM circuit_breaker_state WHERE provider_id = 'pA'")
    expect(circuit.failure_count).toBe(1)
    const alpha = dbMod.dbGet("SELECT status FROM providers WHERE id = 'pA'")
    expect(alpha.status).toBe('active')
  })

  it('does not fail over after headers are sent (no duplicated content)', async () => {
    authMod.updateApiKeyProviders('k1', ['pA', 'pB'])
    const calls = { alpha: 0, beta: 0 }

    globalThis.fetch = async (url) => {
      if (String(url).includes('alpha.example.com')) {
        calls.alpha++
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n'))
            setTimeout(() => {
              try { controller.error(new Error('upstream exploded')) } catch { /* already closed */ }
            }, 50)
          },
        })
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      calls.beta++
      return streamingMockResponse([
        'data: {"choices":[{"index":0,"delta":{"content":"BETA"},"finish_reason":null}]}\n\n',
        'data: [DONE]\n\n',
      ])
    }

    const res = await postStream('/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    expect(res.status).toBe(200)

    const { text } = await readAll(res)
    expect(calls.alpha).toBe(1)
    expect(calls.beta).toBe(0)
    expect(text).toContain('partial')
    expect(text).not.toContain('BETA')
  })
})

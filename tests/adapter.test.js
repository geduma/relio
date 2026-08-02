
import { describe, it, expect } from 'vitest'
import { getAdapter } from '../src/adapters/index.js'
import ProviderAdapter from '../src/adapters/base.js'
import OpenAICompatibleAdapter from '../src/adapters/openai-compatible.js'
import AnthropicAdapter from '../src/adapters/anthropic.js'
import GeminiNativeAdapter from '../src/adapters/gemini-native.js'
import AzureOpenAIAdapter from '../src/adapters/azure-openai.js'

describe('Adapter Factory', () => {
  it('returns OpenAICompatibleAdapter for openai-compatible', () => {
    const adapter = getAdapter('openai-compatible')
    expect(adapter).toBeInstanceOf(OpenAICompatibleAdapter)
  })

  it('returns AnthropicAdapter for anthropic', () => {
    const adapter = getAdapter('anthropic')
    expect(adapter).toBeInstanceOf(AnthropicAdapter)
  })

  it('returns GeminiNativeAdapter for gemini-native', () => {
    const adapter = getAdapter('gemini-native')
    expect(adapter).toBeInstanceOf(GeminiNativeAdapter)
  })

  it('returns AzureOpenAIAdapter for azure-openai', () => {
    const adapter = getAdapter('azure-openai')
    expect(adapter).toBeInstanceOf(AzureOpenAIAdapter)
  })

  it('defaults to openai-compatible for null/undefined', () => {
    expect(getAdapter(null)).toBeInstanceOf(OpenAICompatibleAdapter)
    expect(getAdapter(undefined)).toBeInstanceOf(OpenAICompatibleAdapter)
  })

  it('defaults to openai-compatible for unknown type', () => {
    const adapter = getAdapter('nonexistent-provider')
    expect(adapter).toBeInstanceOf(OpenAICompatibleAdapter)
  })

  it('is case-insensitive', () => {
    expect(getAdapter('OpenAI-Compatible')).toBeInstanceOf(OpenAICompatibleAdapter)
    expect(getAdapter('ANTHROPIC')).toBeInstanceOf(AnthropicAdapter)
  })
})

describe('ProviderAdapter (base)', () => {
  it('throws when instantiated directly', () => {
    expect(() => ProviderAdapter.type).toThrow()
  })

  it('requires subclasses to implement methods', async () => {
    class TestAdapter extends ProviderAdapter {
      static get type() { return 'test' }
    }
    const adapter = new TestAdapter()
    await expect(adapter.chat()).rejects.toThrow('test must implement chat()')
    await expect(adapter.stream()).rejects.toThrow('test must implement stream()')
    await expect(adapter.embeddings()).rejects.toThrow('test must implement embeddings()')
    await expect(adapter.models()).rejects.toThrow('test must implement models()')
    await expect(adapter.testConnection()).rejects.toThrow('test must implement testConnection()')
    expect(() => adapter.buildUrl()).toThrow('test must implement buildUrl()')
    expect(() => adapter.buildHeaders()).toThrow('test must implement buildHeaders()')
  })
})

describe('OpenAICompatibleAdapter', () => {
  const adapter = new OpenAICompatibleAdapter()

  it('builds correct URL', () => {
    expect(adapter.buildUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1/chat/completions')
    expect(adapter.buildUrl('https://api.example.com')).toBe('https://api.example.com/v1/chat/completions')
    expect(adapter.buildUrl('https://example.com/v1/')).toBe('https://example.com/v1/chat/completions')
    expect(adapter.buildUrl('https://example.com/v1/chat/completions')).toBe('https://example.com/v1/chat/completions')
  })

  it('builds correct embeddings URL', () => {
    expect(adapter.buildUrlForEmbeddings('https://api.example.com/v1')).toBe('https://api.example.com/v1/embeddings')
    expect(adapter.buildUrlForEmbeddings('https://api.example.com')).toBe('https://api.example.com/v1/embeddings')
  })

  it('builds correct headers', () => {
    const headers = adapter.buildHeaders('sk-test')
    expect(headers['Authorization']).toBe('Bearer sk-test')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('has correct type', () => {
    expect(OpenAICompatibleAdapter.type).toBe('openai-compatible')
  })

  it('embeddings() rejects with no network', async () => {
    await expect(adapter.embeddings(
      { api_url: 'https://nonexistent.invalid', api_key: 'sk-test' },
      { input: 'text' },
      null
    )).rejects.toThrow()
  })
})

describe('AnthropicAdapter', () => {
  const adapter = new AnthropicAdapter()

  it('builds correct URL', () => {
    expect(adapter.buildUrl('https://api.example.com')).toBe('https://api.example.com/v1/messages')
    expect(adapter.buildUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1/messages')
    expect(adapter.buildUrl('https://api.example.com/v1/messages')).toBe('https://api.example.com/v1/messages')
  })

  it('builds correct headers', () => {
    const headers = adapter.buildHeaders('sk-ant-test')
    expect(headers['x-api-key']).toBe('sk-ant-test')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['Authorization']).toBeUndefined()
  })

  it('transforms OpenAI request to Anthropic format', () => {
    const result = adapter.transformRequest({
      model: 'claude-3-opus',
      messages: [
        { role: 'system', content: 'Be helpful' },
        { role: 'user', content: 'Hello' },
      ],
      temperature: 0.5,
      max_tokens: 1000,
    })

    expect(result.model).toBe('claude-3-opus')
    expect(Array.isArray(result.system)).toBe(true)
    expect(result.system[0].type).toBe('text')
    expect(result.system[0].text).toBe('Be helpful')
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].role).toBe('user')
    expect(result.messages[0].content).toBe('Hello')
    expect(result.temperature).toBe(0.5)
    expect(result.max_tokens).toBe(1000)
  })

  it('transforms Anthropic response to OpenAI format', () => {
    const result = adapter.transformResponse({
      id: 'msg_123',
      model: 'claude-3-opus',
      content: [{ type: 'text', text: 'Hello!' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    })

    expect(result.id).toBe('msg_123')
    expect(result.object).toBe('chat.completion')
    expect(result.choices[0].message.content).toBe('Hello!')
    expect(result.choices[0].finish_reason).toBe('stop')
    expect(result.usage.prompt_tokens).toBe(10)
    expect(result.usage.completion_tokens).toBe(5)
    expect(result.usage.total_tokens).toBe(15)
  })

  it('transforms tool_use response correctly', () => {
    const result = adapter.transformResponse({
      id: 'msg_456',
      model: 'claude-3-opus',
      content: [
        { type: 'text', text: 'Let me check...' },
        {
          type: 'tool_use',
          id: 'toolu_123',
          name: 'get_weather',
          input: { city: 'Paris' },
        },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 20, output_tokens: 15 },
    })

    expect(result.choices[0].message.content).toBe('Let me check...')
    expect(result.choices[0].finish_reason).toBe('tool_calls')
    expect(result.choices[0].message.tool_calls).toHaveLength(1)
    expect(result.choices[0].message.tool_calls[0].function.name).toBe('get_weather')
    expect(result.choices[0].message.tool_calls[0].function.arguments).toBe('{"city":"Paris"}')
  })

  it('transforms tool_choice correctly', () => {
    const result = adapter.transformRequest({
      messages: [{ role: 'user', content: 'Use tool' }],
      tools: [{ function: { name: 'get_weather', description: 'Get weather', parameters: {} } }],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
    })
    expect(result.tool_choice).toEqual({ type: 'tool', name: 'get_weather' })
  })

  it('transforms tool_choice auto correctly', () => {
    const result = adapter.transformRequest({
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [{ function: { name: 'get_weather' } }],
      tool_choice: 'auto',
    })
    expect(result.tool_choice).toEqual({ type: 'auto' })
  })

  it('transforms tool_choice none correctly', () => {
    const result = adapter.transformRequest({
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [{ function: { name: 'get_weather' } }],
      tool_choice: 'none',
    })
    expect(result.tool_choice).toEqual({ type: 'none' })
  })

  it('maps max_tokens stop_reason to length', () => {
    const result = adapter.transformResponse({
      id: 'msg_1',
      model: 'claude-3-opus',
      content: [{ type: 'text', text: 'cut off' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    expect(result.choices[0].finish_reason).toBe('length')
  })

  it('maps stop_sequence stop_reason to stop', () => {
    const result = adapter.transformResponse({
      id: 'msg_1',
      model: 'claude-3-opus',
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'stop_sequence',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    expect(result.choices[0].finish_reason).toBe('stop')
  })

  it('has correct type', () => {
    expect(AnthropicAdapter.type).toBe('anthropic')
  })
})

describe('GeminiNativeAdapter', () => {
  const adapter = new GeminiNativeAdapter()

  it('builds correct URL', () => {
    const url = adapter.buildUrl('https://api.example.com', 'gemini-pro')
    expect(url).toBe('https://api.example.com/v1/models/gemini-pro:generateContent')
  })

  it('builds correct headers', () => {
    const headers = adapter.buildHeaders('AIza-test')
    expect(headers['X-Goog-Api-Key']).toBe('AIza-test')
    expect(headers['Authorization']).toBeUndefined()
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('transforms OpenAI request to Gemini format', () => {
    const result = adapter.transformRequest({
      messages: [
        { role: 'system', content: 'Be concise' },
        { role: 'user', content: 'Hi!' },
        { role: 'assistant', content: 'Hello!' },
      ],
      temperature: 0.7,
    })

    expect(result.contents).toHaveLength(2)
    expect(result.contents[0].role).toBe('user')
    expect(result.contents[0].parts[0].text).toBe('Hi!')
    expect(result.contents[1].role).toBe('model')
    expect(result.contents[1].parts[0].text).toBe('Hello!')
    expect(result.systemInstruction.parts[0].text).toBe('Be concise')
    expect(result.generationConfig.temperature).toBe(0.7)
  })

  it('transforms Gemini response to OpenAI format', () => {
    const result = adapter.transformResponse({
      candidates: [{
        content: {
          parts: [{ text: 'Hello there!' }],
          role: 'model',
        },
        finishReason: 'STOP',
      }],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
      },
      model: 'gemini-pro',
    })

    expect(result.choices[0].message.content).toBe('Hello there!')
    expect(result.choices[0].finish_reason).toBe('stop')
    expect(result.usage.prompt_tokens).toBe(10)
    expect(result.usage.completion_tokens).toBe(5)
    expect(result.usage.total_tokens).toBe(15)
  })

  it('handles empty candidates', () => {
    const result = adapter.transformResponse({ candidates: [], model: 'gemini-pro' })
    expect(result.choices[0].message.content).toBe('')
    expect(result.choices[0].finish_reason).toBe('stop')
  })

  it('transforms role:tool messages into functionResponse parts', () => {
    const result = adapter.transformRequest({
      messages: [
        { role: 'user', content: 'What is the weather?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
        { role: 'tool', content: 'Sunny', tool_call_id: 'get_weather' },
      ],
    })
    expect(result.contents[0].role).toBe('user')
    expect(result.contents[0].parts[0].text).toBe('What is the weather?')
    expect(result.contents[1].role).toBe('model')
    expect(result.contents[1].parts[0].functionCall.name).toBe('get_weather')
    expect(result.contents[2].role).toBe('user')
    expect(result.contents[2].parts[0].functionResponse.name).toBe('get_weather')
    expect(result.contents[2].parts[0].functionResponse.response.result).toBe('Sunny')
  })

  it('transforms response_format json_object', () => {
    const result = adapter.transformRequest({
      messages: [{ role: 'user', content: 'JSON please' }],
      response_format: { type: 'json_object' },
    })
    expect(result.generationConfig.responseMimeType).toBe('application/json')
  })

  it('transforms tool_choice correctly', () => {
    const result = adapter.transformRequest({
      messages: [{ role: 'user', content: 'Use tool' }],
      tools: [{ function: { name: 'get_weather', description: 'Get weather', parameters: {} } }],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
    })
    expect(result.toolConfig.functionCallingConfig.mode).toBe('ANY')
    expect(result.toolConfig.functionCallingConfig.allowedFunctionNames).toEqual(['get_weather'])
  })

  it('transforms tool_choice none to mode NONE', () => {
    const result = adapter.transformRequest({
      messages: [{ role: 'user', content: 'No tools' }],
      tools: [{ function: { name: 'get_weather' } }],
      tool_choice: 'none',
    })
    expect(result.toolConfig.functionCallingConfig.mode).toBe('NONE')
  })

  it('transforms Gemini response with functionCall to OpenAI tool_calls', () => {
    const result = adapter.transformResponse({
      candidates: [{
        content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }], role: 'model' },
        finishReason: 'TOOL_CALL',
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      model: 'gemini-pro',
    })
    expect(result.choices[0].message.content).toBeNull()
    expect(result.choices[0].finish_reason).toBe('tool_calls')
    expect(result.choices[0].message.tool_calls).toHaveLength(1)
    expect(result.choices[0].message.tool_calls[0].function.name).toBe('get_weather')
  })

  it('has correct type', () => {
    expect(GeminiNativeAdapter.type).toBe('gemini-native')
  })
})

describe('AzureOpenAIAdapter', () => {
  const adapter = new AzureOpenAIAdapter()

  it('builds correct URL with api-version', () => {
    const url = adapter.buildUrl('https://api.example.com/azure/openai/deployments/gpt-4')
    expect(url).toContain('api-version=2024-02-15-preview')
    expect(url).toContain('/chat/completions')
  })

  it('builds correct headers', () => {
    const headers = adapter.buildHeaders('azure-key-123')
    expect(headers['api-key']).toBe('azure-key-123')
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['Authorization']).toBeUndefined()
  })

  it('has correct type', () => {
    expect(AzureOpenAIAdapter.type).toBe('azure-openai')
  })
})

describe('Adapter streaming', () => {
  it('OpenAICompatibleAdapter.stream() rejects with no network', async () => {
    const adapter = new OpenAICompatibleAdapter()
    await expect(adapter.stream(
      { api_url: 'https://nonexistent.invalid', api_key: 'sk-test' },
      { messages: [{ role: 'user', content: 'hi' }] },
      null
    )).rejects.toThrow()
  })

  it('AnthropicAdapter.stream() rejects with no network', async () => {
    const adapter = new AnthropicAdapter()
    await expect(adapter.stream(
      { api_url: 'https://nonexistent.invalid', api_key: 'sk-test' },
      { messages: [{ role: 'user', content: 'hi' }] },
      null
    )).rejects.toThrow()
  })

  it('GeminiNativeAdapter.stream() rejects with no network', async () => {
    const adapter = new GeminiNativeAdapter()
    await expect(adapter.stream(
      { api_url: 'https://nonexistent.invalid', api_key: 'sk-test' },
      { messages: [{ role: 'user', content: 'hi' }] },
      null
    )).rejects.toThrow()
  })

  it('AzureOpenAIAdapter.stream() rejects with no network', async () => {
    const adapter = new AzureOpenAIAdapter()
    await expect(adapter.stream(
      { api_url: 'https://nonexistent.invalid', api_key: 'sk-test' },
      { messages: [{ role: 'user', content: 'hi' }] },
      null
    )).rejects.toThrow()
  })
})

describe('OpenAI-compatible streaming passthrough', () => {
  it('relays the upstream SSE byte-for-byte (varied id/created, usage, tool_calls + content)', async () => {
    const adapter = new OpenAICompatibleAdapter()
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

    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse))
          controller.close()
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
    )

    try {
      const nodeStream = await adapter.stream(
        { api_url: 'https://alpha.example.com/v1', api_key: 'sk-x' },
        { messages: [{ role: 'user', content: 'hi' }] },
        new AbortController().signal
      )
      const chunks = []
      for await (const buf of nodeStream) chunks.push(buf.toString())
      const text = chunks.join('')
      expect(text).toBe(sse)

      const events = text
        .split('\n\n')
        .filter(l => l.startsWith('data: ') && l !== 'data: [DONE]')
        .map(l => JSON.parse(l.slice(6)))
      expect(events.map(e => e.id)).toEqual(['chatcmpl-A', 'chatcmpl-B', 'chatcmpl-C', 'chatcmpl-D'])
      expect(events.map(e => e.created)).toEqual([1000, 2000, 3000, 4000])
      expect(events[2].choices[0].delta.tool_calls[0].function.arguments).toBe('{"city":"Paris"}')
      expect(events[3].usage).toEqual({ prompt_tokens: 9, completion_tokens: 12, total_tokens: 21 })
      expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('passes through an empty-delta chunk without dropping usage or finish_reason', async () => {
    const adapter = new OpenAICompatibleAdapter()
    const sse = [
      'data: {"id":"chatcmpl-Z","object":"chat.completion.chunk","created":5000,"model":"deepseek-r1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n',
      'data: [DONE]\n\n',
    ].join('')

    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse))
          controller.close()
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
    )

    try {
      const nodeStream = await adapter.stream(
        { api_url: 'https://alpha.example.com/v1', api_key: 'sk-x' },
        { messages: [{ role: 'user', content: 'hi' }] },
        new AbortController().signal
      )
      const chunks = []
      for await (const buf of nodeStream) chunks.push(buf.toString())
      const text = chunks.join('')
      expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
      expect(text).toContain('"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}')
      expect(text).toContain('"finish_reason":"stop"')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('Streaming content-type guard', () => {
  async function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  it('rejects a JSON error body with status 200 for openai-compatible', async () => {
    const adapter = new OpenAICompatibleAdapter()
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => jsonResponse({ error: { message: 'upstream exploded' } })
    try {
      await expect(adapter.stream(
        { api_url: 'https://alpha.example.com/v1', api_key: 'sk-x' },
        { messages: [{ role: 'user', content: 'hi' }] },
        new AbortController().signal
      )).rejects.toThrow('upstream exploded')
      await expect(adapter.stream(
        { api_url: 'https://alpha.example.com/v1', api_key: 'sk-x' },
        { messages: [{ role: 'user', content: 'hi' }] },
        new AbortController().signal
      )).rejects.toMatchObject({ status: 502 })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rejects a non-streaming JSON completion with status 200 for openai-compatible', async () => {
    const adapter = new OpenAICompatibleAdapter()
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => jsonResponse({ choices: [{ message: { role: 'assistant', content: 'not a stream' } }] })
    try {
      await expect(adapter.stream(
        { api_url: 'https://alpha.example.com/v1', api_key: 'sk-x' },
        { messages: [{ role: 'user', content: 'hi' }] },
        new AbortController().signal
      )).rejects.toThrow(/non-streaming JSON response/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rejects a JSON error body with status 200 for azure-openai', async () => {
    const adapter = new AzureOpenAIAdapter()
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => jsonResponse({ error: { message: 'azure exploded' } })
    try {
      await expect(adapter.stream(
        { api_url: 'https://azure.example.com/openai/deployments/gpt-4o', api_key: 'sk-x' },
        { messages: [{ role: 'user', content: 'hi' }] },
        new AbortController().signal
      )).rejects.toThrow('azure exploded')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rejects a JSON error body with status 200 for anthropic', async () => {
    const adapter = new AnthropicAdapter()
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => jsonResponse({ type: 'error', error: { message: 'anthropic exploded' } })
    try {
      await expect(adapter.stream(
        { api_url: 'https://api.anthropic.com/v1', api_key: 'sk-x' },
        { messages: [{ role: 'user', content: 'hi' }] },
        new AbortController().signal
      )).rejects.toThrow('anthropic exploded')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('does not affect gemini-native JSON streaming', async () => {
    const adapter = new GeminiNativeAdapter()
    const originalFetch = globalThis.fetch
    const payload = [
      { candidates: [{ content: { role: 'model', parts: [{ text: 'Hi' }] } }] },
      { candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
    ].map(l => JSON.stringify(l)).join('\n')
    globalThis.fetch = async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload))
          controller.close()
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
    try {
      const nodeStream = await adapter.stream(
        { api_url: 'https://gamma.example.com', api_key: 'sk-x', model: 'gemini-pro' },
        { messages: [{ role: 'user', content: 'hi' }] },
        new AbortController().signal
      )
      const chunks = []
      for await (const buf of nodeStream) chunks.push(buf.toString())
      const text = chunks.join('')
      expect(text).toContain('Hi')
      expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
  it('normalizes rate limit errors', async () => {
    const { normalizeError } = await import('../src/utils/logger.js')
    const err = new Error('Rate limit exceeded')
    err.status = 429
    const result = normalizeError(err)
    expect(result.error.type).toBe('rate_limit_error')
    expect(result.error.code).toBe('rate_limit')
  })

  it('normalizes authentication errors', async () => {
    const { normalizeError } = await import('../src/utils/logger.js')
    const err = new Error('Invalid API key')
    err.status = 401
    const result = normalizeError(err)
    expect(result.error.type).toBe('authentication_error')
    expect(result.error.code).toBe('authentication')
  })

  it('normalizes context length errors', async () => {
    const { normalizeError } = await import('../src/utils/logger.js')
    const err = new Error('maximum context length exceeded')
    const result = normalizeError(err)
    expect(result.error.type).toBe('invalid_request_error')
    expect(result.error.code).toBe('context_length_exceeded')
  })

  it('normalizes safety errors', async () => {
    const { normalizeError } = await import('../src/utils/logger.js')
    const err = new Error('safety blocked')
    const result = normalizeError(err)
    expect(result.error.type).toBe('content_filter_error')
    expect(result.error.code).toBe('content_filter')
  })
})

describe('Adapter testConnection', () => {
  it('OpenAICompatibleAdapter.testConnection() returns error with no network', async () => {
    const adapter = new OpenAICompatibleAdapter()
    const result = await adapter.testConnection('https://nonexistent.invalid', 'sk-test')
    expect(result.valid).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('AnthropicAdapter.testConnection() returns error with no network', async () => {
    const adapter = new AnthropicAdapter()
    const result = await adapter.testConnection('https://nonexistent.invalid', 'sk-test')
    expect(result.valid).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('GeminiNativeAdapter.testConnection() returns error with no network', async () => {
    const adapter = new GeminiNativeAdapter()
    const result = await adapter.testConnection('https://nonexistent.invalid', 'sk-test')
    expect(result.valid).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('AzureOpenAIAdapter.testConnection() returns error with no network', async () => {
    const adapter = new AzureOpenAIAdapter()
    const result = await adapter.testConnection('https://nonexistent.invalid', 'sk-test')
    expect(result.valid).toBe(false)
    expect(result.error).toBeTruthy()
  })
})

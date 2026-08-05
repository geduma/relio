
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

  it('builds correct URL for OpenAI-compatible provider bases', () => {
    expect(adapter.buildUrl('https://api.cerebras.ai/v1')).toBe('https://api.cerebras.ai/v1/chat/completions')
    expect(adapter.buildUrl('https://api.cohere.com/compatibility/v1')).toBe('https://api.cohere.com/compatibility/v1/chat/completions')
    expect(adapter.buildUrl('https://api.groq.com/openai/v1')).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect(adapter.buildUrl('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(adapter.buildUrl('https://ollama.com/v1')).toBe('https://ollama.com/v1/chat/completions')
    expect(adapter.buildUrl('https://router.huggingface.co/v1')).toBe('https://router.huggingface.co/v1/chat/completions')
    expect(adapter.buildUrl('https://integrate.api.nvidia.com/v1')).toBe('https://integrate.api.nvidia.com/v1/chat/completions')
    expect(adapter.buildUrl('https://api.together.xyz/v1')).toBe('https://api.together.xyz/v1/chat/completions')
  })

  it('never produces double slashes and strips query strings', () => {
    expect(adapter.buildUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1/chat/completions')
    expect(adapter.buildUrl('https://api.example.com/v1/?x=1')).toBe('https://api.example.com/v1/chat/completions')
    expect(adapter.buildUrl('https://api.example.com/v1/chat/completions/')).toBe('https://api.example.com/v1/chat/completions')
    expect(adapter.buildUrl('https://api.example.com/v1/chat/completions?api-version=1')).toBe('https://api.example.com/v1/chat/completions')
  })

  it('builds correct embeddings URL', () => {
    expect(adapter.buildUrlForEmbeddings('https://api.example.com/v1')).toBe('https://api.example.com/v1/embeddings')
    expect(adapter.buildUrlForEmbeddings('https://api.example.com')).toBe('https://api.example.com/v1/embeddings')
  })

  it('builds correct models URL', () => {
    expect(adapter.buildUrlForModels('https://api.example.com/v1')).toBe('https://api.example.com/v1/models')
    expect(adapter.buildUrlForModels('https://api.example.com')).toBe('https://api.example.com/v1/models')
    expect(adapter.buildUrlForModels('https://api.example.com/v1/chat/completions')).toBe('https://api.example.com/v1/models')
  })

  it('builds correct headers', () => {
    const headers = adapter.buildHeaders('sk-test')
    expect(headers['Authorization']).toBe('Bearer sk-test')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('has correct type', () => {
    expect(OpenAICompatibleAdapter.type).toBe('openai-compatible')
  })
})

describe('OpenAICompatibleAdapter testConnection', () => {
  const adapter = new OpenAICompatibleAdapter()

  function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  function mockFetch(handler) {
    const originalFetch = globalThis.fetch
    const calls = []
    globalThis.fetch = async (url, opts) => {
      calls.push({ url: String(url), opts })
      return handler(String(url), opts)
    }
    return { calls, restore: () => { globalThis.fetch = originalFetch } }
  }

  it('validates via GET /models and skips the chat probe on 200 (Cerebras case)', async () => {
    const { calls, restore } = mockFetch(() => jsonResponse({ data: [{ id: 'gpt-oss-120b' }] }))
    try {
      const result = await adapter.testConnection('https://api.cerebras.ai/v1', 'sk-valid')
      expect(result.valid).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe('https://api.cerebras.ai/v1/models')
      expect((calls[0].opts.method || 'GET').toUpperCase()).toBe('GET')
      expect(calls[0].opts.headers.Authorization).toBe('Bearer sk-valid')
    } finally {
      restore()
    }
  })

  it('rejects an invalid key reported by GET /models', async () => {
    const { restore } = mockFetch(() => jsonResponse({ error: { message: 'invalid api key' } }, 401))
    try {
      const result = await adapter.testConnection('https://api.example.com/v1', 'sk-bad')
      expect(result.valid).toBe(false)
      expect(result.error).toMatch(/API key is invalid/)
    } finally {
      restore()
    }
  })

  it('falls back to a chat probe when GET /models is unsupported and accepts a 400 model error (Cohere case)', async () => {
    const { calls, restore } = mockFetch((url) => {
      if (url.endsWith('/models')) return jsonResponse({ error: { message: 'not found' } }, 404)
      return jsonResponse({ error: { message: 'Invalid model relio-test-connection' } }, 400)
    })
    try {
      const result = await adapter.testConnection('https://api.cohere.com/compatibility/v1', 'sk-valid')
      expect(result.valid).toBe(true)
      expect(calls).toHaveLength(2)
      expect(calls[1].url).toBe('https://api.cohere.com/compatibility/v1/chat/completions')
      expect(calls[1].opts.method).toBe('POST')
    } finally {
      restore()
    }
  })

  it('passes the configured model through to the chat probe', async () => {
    const { calls, restore } = mockFetch((url) => {
      if (url.endsWith('/models')) return jsonResponse({ error: { message: 'not found' } }, 404)
      return jsonResponse({ error: { message: 'model unknown' } }, 404)
    })
    try {
      const result = await adapter.testConnection('https://api.example.com/v1', 'sk-valid', { model: 'command-r-plus' })
      expect(result.valid).toBe(true)
      const probeBody = JSON.parse(calls[1].opts.body)
      expect(probeBody.model).toBe('command-r-plus')
    } finally {
      restore()
    }
  })

  it('treats an authenticated chat probe 404 with a JSON error as valid', async () => {
    const { restore } = mockFetch((url) => {
      if (url.endsWith('/models')) return jsonResponse({ error: { message: 'not found' } }, 404)
      return jsonResponse({ error: { message: 'The model does not exist' } }, 404)
    })
    try {
      const result = await adapter.testConnection('https://api.example.com/v1', 'sk-valid')
      expect(result.valid).toBe(true)
    } finally {
      restore()
    }
  })

  it('treats a chat probe 200 as valid', async () => {
    const { restore } = mockFetch((url) => {
      if (url.endsWith('/models')) return jsonResponse({ error: { message: 'not found' } }, 404)
      return jsonResponse({ choices: [{ message: { content: 'hi' } }] })
    })
    try {
      const result = await adapter.testConnection('https://api.example.com/v1', 'sk-valid')
      expect(result.valid).toBe(true)
    } finally {
      restore()
    }
  })

  it('rejects an invalid key discovered by the chat probe', async () => {
    const { restore } = mockFetch((url) => {
      if (url.endsWith('/models')) return jsonResponse({ error: { message: 'not found' } }, 404)
      return jsonResponse({ error: { message: 'unauthorized' } }, 401)
    })
    try {
      const result = await adapter.testConnection('https://api.example.com/v1', 'sk-bad')
      expect(result.valid).toBe(false)
      expect(result.error).toMatch(/API key is invalid/)
    } finally {
      restore()
    }
  })

  it('reports a non-JSON 404 from the chat probe as endpoint not found', async () => {
    const { restore } = mockFetch(() => new Response('Not Found', { status: 404 }))
    try {
      const result = await adapter.testConnection('https://api.example.com/v1', 'sk-valid')
      expect(result.valid).toBe(false)
      expect(result.error).toMatch(/Endpoint not found/)
    } finally {
      restore()
    }
  })

  it('reports network failures', async () => {
    const { restore } = mockFetch(() => { throw new Error('fetch failed') })
    try {
      const result = await adapter.testConnection('https://api.example.com/v1', 'sk-valid')
      expect(result.valid).toBe(false)
      expect(result.error).toMatch(/Cannot reach server/)
    } finally {
      restore()
    }
  })

  it('reports connection timeouts', async () => {
    const { restore } = mockFetch((url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('This operation was aborted')
        err.name = 'AbortError'
        reject(err)
      })
    }))
    try {
      const result = await adapter.testConnection('https://api.example.com/v1', 'sk-valid')
      expect(result.valid).toBe(false)
      expect(result.error).toMatch(/timed out/)
    } finally {
      restore()
    }
  })
})

describe('OpenAICompatibleAdapter payload normalization', () => {
  const adapter = new OpenAICompatibleAdapter()

  function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  it('passes the request body through unchanged, only injecting model when missing', async () => {
    let sentBody = null
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, opts) => {
      sentBody = JSON.parse(opts.body)
      return jsonResponse({ id: 'x', choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: {} })
    }
    try {
      await adapter.chat(
        { api_url: 'https://api.example.com/v1', api_key: 'sk-x', model: 'gpt-4o' },
        { messages: [{ role: 'user', content: 'hi' }], temperature: 0.5 },
        new AbortController().signal
      )
      expect(sentBody).toEqual({
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.5,
        model: 'gpt-4o',
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('does not override an explicit model in the request body', async () => {
    let sentBody = null
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, opts) => {
      sentBody = JSON.parse(opts.body)
      return jsonResponse({ id: 'x', choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: {} })
    }
    try {
      await adapter.chat(
        { api_url: 'https://api.example.com/v1', api_key: 'sk-x', model: 'gpt-4o' },
        { model: 'custom-model', messages: [{ role: 'user', content: 'hi' }] },
        new AbortController().signal
      )
      expect(sentBody.model).toBe('custom-model')
    } finally {
      globalThis.fetch = originalFetch
    }
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

  it('builds correct URL when base URL already has a version segment', () => {
    expect(adapter.buildUrl('https://api.example.com/v1beta', 'gemini-pro'))
      .toBe('https://api.example.com/v1beta/models/gemini-pro:generateContent')
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
    expect(url).toBe('https://api.example.com/azure/openai/deployments/gpt-4/chat/completions?api-version=2024-02-15-preview')
  })

  it('preserves an existing api-version query parameter', () => {
    const url = adapter.buildUrl('https://api.example.com/azure/openai/deployments/gpt-4?api-version=2025-01-01')
    expect(url).toBe('https://api.example.com/azure/openai/deployments/gpt-4/chat/completions?api-version=2025-01-01')
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

describe('OpenAI-compatible streaming passthrough', () => {
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

describe('Error normalization', () => {
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

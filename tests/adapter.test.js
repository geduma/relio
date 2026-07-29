
import { describe, it, expect } from 'vitest'
import { getAdapter, registerAdapter } from '../src/adapters/index.js'
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
    await expect(adapter.testConnection()).rejects.toThrow('test must implement testConnection()')
    expect(() => adapter.buildUrl()).toThrow('test must implement buildUrl()')
    expect(() => adapter.buildHeaders()).toThrow('test must implement buildHeaders()')
  })
})

describe('OpenAICompatibleAdapter', () => {
  const adapter = new OpenAICompatibleAdapter()

  it('builds correct URL', () => {
    expect(adapter.buildUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/chat/completions')
    expect(adapter.buildUrl('https://api.openai.com')).toBe('https://api.openai.com/v1/chat/completions')
    expect(adapter.buildUrl('https://example.com/v1/')).toBe('https://example.com/v1/chat/completions')
    expect(adapter.buildUrl('https://example.com/v1/chat/completions')).toBe('https://example.com/v1/chat/completions')
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

describe('AnthropicAdapter', () => {
  const adapter = new AnthropicAdapter()

  it('builds correct URL', () => {
    expect(adapter.buildUrl('https://api.anthropic.com')).toBe('https://api.anthropic.com/v1/messages')
    expect(adapter.buildUrl('https://api.anthropic.com/v1')).toBe('https://api.anthropic.com/v1/messages')
    expect(adapter.buildUrl('https://api.anthropic.com/v1/messages')).toBe('https://api.anthropic.com/v1/messages')
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
    expect(result.system).toBe('Be helpful')
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

  it('has correct type', () => {
    expect(AnthropicAdapter.type).toBe('anthropic')
  })
})

describe('GeminiNativeAdapter', () => {
  const adapter = new GeminiNativeAdapter()

  it('builds correct URL', () => {
    const url = adapter.buildUrl('https://generativelanguage.googleapis.com', 'gemini-pro')
    expect(url).toBe('https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent')
  })

  it('builds correct headers', () => {
    const headers = adapter.buildHeaders('AIza-test')
    expect(headers['Authorization']).toBe('Bearer AIza-test')
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

  it('has correct type', () => {
    expect(GeminiNativeAdapter.type).toBe('gemini-native')
  })
})

describe('AzureOpenAIAdapter', () => {
  const adapter = new AzureOpenAIAdapter()

  it('builds correct URL with api-version', () => {
    const url = adapter.buildUrl('https://my-resource.openai.azure.com/openai/deployments/gpt-4')
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

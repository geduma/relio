import ProviderAdapter from './base.js'
import { Readable } from 'stream'

const ANTHROPIC_VERSION = '2023-06-01'

export default class AnthropicAdapter extends ProviderAdapter {
  static get type() { return 'anthropic' }

  buildUrl(baseUrl) {
    let url = baseUrl.replace(/\/+$/, '')
    if (!url.endsWith('/messages')) {
      url += url.endsWith('/v1') ? '/messages' : '/v1/messages'
    }
    return url
  }

  buildUrlForModels(baseUrl) {
    let url = baseUrl.replace(/\/+$/, '')
    if (!url.endsWith('/v1')) url += '/v1'
    return `${url}/models`
  }

  buildHeaders(apiKey) {
    return {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type': 'application/json',
    }
  }

  transformRequest(body, provider) {
    const messages = []
    let systemPrompt = null

    for (const msg of body.messages || []) {
      if (msg.role === 'system') {
        systemPrompt = msg.content
        continue
      }
      messages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content,
      })
    }

    const result = {
      model: body.model || provider?.model,
      max_tokens: body.max_tokens || 4096,
      messages,
    }

    if (systemPrompt) {
      result.system = systemPrompt
    }

    if (body.temperature != null) result.temperature = body.temperature
    if (body.top_p != null) result.top_p = body.top_p
    if (body.stop) result.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop]

    if (body.tools && body.tools.length > 0) {
      result.tools = body.tools.map(t => ({
        name: t.function?.name || t.name,
        description: t.function?.description || t.description || '',
        input_schema: t.function?.parameters || t.input_schema || {},
      }))
    }

    return result
  }

  transformResponse(data) {
    const content = data.content?.[0]?.text || ''
    const toolCalls = []

    for (const block of data.content || []) {
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        })
      }
    }

    const choice = {
      index: 0,
      message: {
        role: 'assistant',
        content: content || null,
      },
      finish_reason: data.stop_reason === 'end_turn' ? 'stop' :
                     data.stop_reason === 'tool_use' ? 'tool_calls' :
                     data.stop_reason || 'stop',
    }

    if (toolCalls.length > 0) {
      choice.message.tool_calls = toolCalls
    }

    return {
      id: data.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: data.model,
      choices: [choice],
      usage: {
        prompt_tokens: data.usage?.input_tokens || 0,
        completion_tokens: data.usage?.output_tokens || 0,
        total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
      },
    }
  }

  transformStreamChunk(line) {
    if (!line || line.startsWith('event:') || line.startsWith(':')) return null
    if (!line.startsWith('data: ')) return null

    const jsonStr = line.slice(6)
    if (jsonStr === '[DONE]') return { done: true }

    let data
    try {
      data = JSON.parse(jsonStr)
    } catch {
      return null
    }

    if (data.type === 'message_start') {
      return {
        id: data.message?.id,
        model: data.message?.model,
      }
    }

    if (data.type === 'content_block_delta') {
      const delta = data.delta
      const result = {
        choices: [{
          index: 0,
          delta: {},
          finish_reason: null,
        }],
      }

      if (delta?.type === 'text_delta') {
        result.choices[0].delta.content = delta.text
      }

      if (delta?.type === 'input_json_delta') {
        result.choices[0].delta.tool_calls = [{
          index: 0,
          function: {
            arguments: delta.partial_json || '',
          },
        }]
      }

      return result
    }

    if (data.type === 'content_block_start') {
      if (data.content_block?.type === 'tool_use') {
        return {
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: data.content_block.id,
                type: 'function',
                function: {
                  name: data.content_block.name,
                  arguments: '',
                },
              }],
            },
          }],
        }
      }
      return null
    }

    if (data.type === 'message_delta') {
      const stopReason = data.delta?.stop_reason === 'end_turn' ? 'stop' :
                         data.delta?.stop_reason === 'tool_use' ? 'tool_calls' :
                         data.delta?.stop_reason || null

      const result = {
        choices: [{
          index: 0,
          delta: {},
          finish_reason: stopReason,
        }],
      }

      if (data.usage) {
        result.usage = {
          prompt_tokens: data.usage.input_tokens,
          completion_tokens: data.usage.output_tokens,
          total_tokens: data.usage.input_tokens + data.usage.output_tokens,
        }
      }

      return result
    }

    return null
  }

  async chat(provider, requestBody, signal) {
    const url = this.buildUrl(provider.api_url)
    const headers = this.buildHeaders(provider.api_key)
    const transformedBody = this.transformRequest(requestBody, provider)

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(transformedBody),
      signal,
    })

    let data
    try {
      data = await response.json()
    } catch {
      const err = new Error(`Anthropic returned non-JSON response (status ${response.status})`)
      err.status = response.status
      err.data = null
      throw err
    }

    if (!response.ok) {
      const err = new Error(data.error?.message || `Anthropic returned ${response.status}`)
      err.status = response.status
      err.data = data
      throw err
    }

    return this.transformResponse(data)
  }

  async stream(provider, requestBody, signal) {
    const url = this.buildUrl(provider.api_url)
    const headers = this.buildHeaders(provider.api_key)
    const transformedBody = this.transformRequest(requestBody, provider)
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'anthropic-beta': 'messages-2023-12-15' },
      body: JSON.stringify({ ...transformedBody, stream: true }),
      signal,
    })

    if (!response.ok) {
      let data
      try { data = await response.json() } catch { data = null }
      const err = new Error(data?.error?.message || `Anthropic stream request failed (status ${response.status})`)
      err.status = response.status
      err.data = data
      throw err
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    return new Readable({
      async read() {
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) {
              this.push(null)
              break
            }

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
              const chunk = this.transformStreamChunk(line)
              if (!chunk) continue
              if (chunk.done) {
                this.push(null)
                return
              }
              this.push(`data: ${JSON.stringify(chunk)}\n\n`)
            }
          }
        } catch (err) {
          this.destroy(err)
        }
      },
    })
  }

  async testConnection(apiUrl, apiKey) {
    const base = apiUrl.replace(/\/+$/, '')
    const chatUrl = this.buildUrl(base)

    async function tryFetch(url, options, timeoutMs = 5000) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      try {
        return await fetch(url, { ...options, signal: controller.signal })
      } finally {
        clearTimeout(timeout)
      }
    }

    try {
      const res = await tryFetch(chatUrl, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-3-haiku-20240307',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      })

      if (res.status === 401 || res.status === 403) {
        return { valid: false, error: 'API key is invalid' }
      }

      if (res.status === 400) {
        return { valid: true }
      }

      if (res.ok) {
        return { valid: true }
      }

      return { valid: false, error: `Anthropic returned status ${res.status}` }
    } catch (err) {
      const msg = err.name === 'AbortError' ? 'Connection timed out' : `Cannot reach server: ${err.message}`
      return { valid: false, error: msg }
    }
  }
}

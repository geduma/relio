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

  _mapStopReason(stopReason) {
    if (stopReason === 'end_turn') return 'stop'
    if (stopReason === 'tool_use') return 'tool_calls'
    if (stopReason === 'max_tokens') return 'length'
    if (stopReason === 'stop_sequence') return 'stop'
    return stopReason || null
  }

  transformRequest(body, provider) {
    const messages = []
    let systemPrompt = null

    for (const msg of body.messages || []) {
      if (msg.role === 'system') {
        if (typeof msg.content === 'string') {
          systemPrompt = msg.content
        } else if (Array.isArray(msg.content)) {
          const texts = msg.content.filter(p => p.type === 'text').map(p => p.text).join('\n')
          systemPrompt = texts
        }
        continue
      }

      if (msg.role === 'tool') {
        const tcId = msg.tool_call_id || ''
        const fnCall = body.messages
          ?.flatMap(m => m.tool_calls || [])
          ?.find(tc => tc.id === tcId)
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        messages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: tcId, content }],
        })
        continue
      }

      const content = msg.role === 'assistant' && msg.tool_calls
        ? [{ type: 'text', text: msg.content || '' }, ...msg.tool_calls.map(tc => ({
            type: 'tool_use',
            id: tc.id,
            name: tc.function?.name || '',
            input: JSON.parse(tc.function?.arguments || '{}'),
          }))]
        : msg.content

      messages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content,
      })
    }

    const result = {
      model: body.model || provider?.model,
      max_tokens: body.max_tokens || 4096,
      messages,
    }

    if (systemPrompt) {
      result.system = [{ type: 'text', text: systemPrompt }]
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

      if (body.tool_choice) {
        if (body.tool_choice === 'auto') {
          result.tool_choice = { type: 'auto' }
        } else if (body.tool_choice === 'none') {
          result.tool_choice = { type: 'none' }
        } else if (body.tool_choice === 'required' || body.tool_choice === 'any') {
          result.tool_choice = { type: 'any' }
        } else if (typeof body.tool_choice === 'object') {
          const fn = body.tool_choice.function
          if (fn?.name) {
            result.tool_choice = { type: 'tool', name: fn.name }
          }
        }
      }
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
      finish_reason: this._mapStopReason(data.stop_reason) || 'stop',
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
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: data.message?.model,
        choices: [{
          index: 0,
          delta: { role: 'assistant' },
          finish_reason: null,
        }],
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
          index: data.index || 0,
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
                index: data.index || 0,
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
      const stopReason = this._mapStopReason(data.delta?.stop_reason)

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
      const detail = JSON.stringify(data).slice(0, 500)
      const errMsg = ProviderAdapter.extractErrorMsg(data)
      const err = new Error(errMsg || `Anthropic returned ${response.status} — body: ${detail}`)
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
      const detail = data ? JSON.stringify(data).slice(0, 500) : 'no body'
      const errMsg = ProviderAdapter.extractErrorMsg(data)
      const err = new Error(errMsg || `Anthropic stream request failed (status ${response.status}) — body: ${detail}`)
      err.status = response.status
      err.data = data
      throw err
    }

    await this.assertSseResponse(response)

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    return new Readable({
      async read() {
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) {
              this.push('data: [DONE]\n\n')
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

  async models(apiUrl, apiKey) {
    const url = this.buildUrlForModels(apiUrl)
    const headers = this.buildHeaders(apiKey)

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) return []
      const data = await response.json()
      return data.data || data.models || []
    } catch {
      return []
    }
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

      if (res.status === 404) {
        let body
        try { body = await res.json() } catch { body = null }
        if (ProviderAdapter.extractErrorMsg(body)) return { valid: true }
        return { valid: false, error: `Chat endpoint not found at ${base}. Check the API URL.` }
      }

      return { valid: false, error: `Anthropic returned status ${res.status}` }
    } catch (err) {
      const msg = err.name === 'AbortError' ? 'Connection timed out' : `Cannot reach server: ${err.message}`
      return { valid: false, error: msg }
    }
  }
}

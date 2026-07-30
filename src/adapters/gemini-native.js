import ProviderAdapter from './base.js'
import { Readable } from 'stream'

export default class GeminiNativeAdapter extends ProviderAdapter {
  static get type() { return 'gemini-native' }

  buildUrl(baseUrl, model) {
    let url = baseUrl.replace(/\/+$/, '')
    const modelPath = model || 'gemini-pro'
    if (!url.includes('/models/')) {
      url += url.endsWith('/v1') ? '' : '/v1'
      url += `/models/${modelPath}:generateContent`
    }
    return url
  }

  buildStreamUrl(baseUrl, model) {
    let url = baseUrl.replace(/\/+$/, '')
    const modelPath = model || 'gemini-pro'
    if (!url.includes('/models/')) {
      url += url.endsWith('/v1') ? '' : '/v1'
      url += `/models/${modelPath}:streamGenerateContent`
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
      'X-Goog-Api-Key': apiKey,
      'Content-Type': 'application/json',
    }
  }

  transformRequest(body) {
    const contents = []
    let systemInstruction = null

    const safeJsonParse = (str) => {
      if (typeof str === 'object') return str
      try { return JSON.parse(str || '{}') } catch { return {} }
    }

    for (const msg of body.messages || []) {
      if (msg.role === 'system') {
        if (typeof msg.content === 'string') {
          systemInstruction = { parts: [{ text: msg.content }] }
        } else if (Array.isArray(msg.content)) {
          const texts = msg.content.filter(p => p.type === 'text').map(p => ({ text: p.text }))
          systemInstruction = { parts: texts }
        }
        continue
      }

      if (msg.role === 'tool') {
        const tcId = msg.tool_call_id || ''
        const fnCall = body.messages
          ?.flatMap(m => m.tool_calls || [])
          ?.find(tc => tc.id === tcId)
        const fnName = fnCall?.function?.name || tcId
        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: fnName,
              response: { result: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) },
            },
          }],
        })
        continue
      }

      const parts = []

      if (typeof msg.content === 'string') {
        if (msg.content) parts.push({ text: msg.content })
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') {
            if (part.text) parts.push({ text: part.text })
          } else if (part.type === 'image_url') {
            let imageData = part.image_url?.url || ''
            if (imageData.startsWith('data:')) {
              const mimeMatch = imageData.match(/^data:([^;]+);/)
              const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg'
              const base64Data = imageData.split(',')[1]
              parts.push({
                inlineData: { mimeType, data: base64Data },
              })
            }
          }
        }
      }

      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          parts.push({
            functionCall: {
              name: tc.function?.name || '',
              args: safeJsonParse(tc.function?.arguments),
            },
          })
        }
      }

      const role = msg.role === 'assistant' ? 'model' : 'user'
      contents.push({ role, parts })
    }

    const result = { contents }

    if (systemInstruction) {
      result.systemInstruction = systemInstruction
    }

    if (body.temperature != null || body.max_tokens != null || body.top_p != null || body.stop || body.response_format) {
      result.generationConfig = {}

      if (body.temperature != null) result.generationConfig.temperature = body.temperature
      if (body.max_tokens != null) result.generationConfig.maxOutputTokens = body.max_tokens
      if (body.top_p != null) result.generationConfig.topP = body.top_p
      if (body.stop) {
        result.generationConfig.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop]
      }
      if (body.response_format?.type === 'json_object') {
        result.generationConfig.responseMimeType = 'application/json'
      }
    }

    if (body.tools && body.tools.length > 0) {
      result.tools = [{
        functionDeclarations: body.tools.map(t => ({
          name: t.function?.name || t.name,
          description: t.function?.description || t.description || '',
          parameters: t.function?.parameters || t.input_schema || {},
        })),
      }]

      if (body.tool_choice) {
        let mode = 'AUTO'
        if (body.tool_choice === 'any' || body.tool_choice === 'required') {
          mode = 'ANY'
        } else if (typeof body.tool_choice === 'object' && body.tool_choice.function?.name) {
          mode = 'ANY'
          result.toolConfig = {
            functionCallingConfig: {
              mode,
              allowedFunctionNames: [body.tool_choice.function.name],
            },
          }
        }
        if (!result.toolConfig) {
          result.toolConfig = { functionCallingConfig: { mode } }
        }
      }
    }

    return result
  }

  transformResponse(data) {
    if (!data.candidates || data.candidates.length === 0) {
      return {
        id: 'gemini-empty',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: data.model || 'gemini',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }
    }

    this._callCounter = this._callCounter || 0

    const candidate = data.candidates[0]
    const parts = candidate.content?.parts || []
    let text = ''
    const toolCalls = []

    for (const part of parts) {
      if (part.text) {
        text += part.text
      }
      if (part.functionCall) {
        this._callCounter++
        toolCalls.push({
          id: `call_${this._callCounter}`,
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args || {}),
          },
        })
      }
    }

    const finishReasonMap = {
      STOP: 'stop',
      MAX_TOKENS: 'length',
      SAFETY: 'content_filter',
      RECITATION: 'content_filter',
      TOOL_CALL: 'tool_calls',
      FINISH_REASON_UNSPECIFIED: null,
    }

    const choice = {
      index: 0,
      message: {
        role: 'assistant',
        content: text || null,
      },
      finish_reason: finishReasonMap[candidate.finishReason] || candidate.finishReason || 'stop',
    }

    if (toolCalls.length > 0) {
      choice.message.tool_calls = toolCalls
    }

    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: data.model || 'gemini',
      choices: [choice],
      usage: {
        prompt_tokens: data.usageMetadata?.promptTokenCount || 0,
        completion_tokens: data.usageMetadata?.candidatesTokenCount || 0,
        total_tokens: (data.usageMetadata?.promptTokenCount || 0) + (data.usageMetadata?.candidatesTokenCount || 0),
      },
    }
  }

  async chat(provider, requestBody, signal) {
    const url = this.buildUrl(provider.api_url, requestBody.model || provider.model)
    const headers = this.buildHeaders(provider.api_key)
    const transformedBody = this.transformRequest(requestBody)

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
      const err = new Error(`Gemini returned non-JSON response (status ${response.status})`)
      err.status = response.status
      err.data = null
      throw err
    }

    if (!response.ok) {
      const err = new Error(data.error?.message || data.error?.status || `Gemini returned ${response.status}`)
      err.status = response.status
      err.data = data
      throw err
    }

    return this.transformResponse(data)
  }

  async stream(provider, requestBody, signal) {
    const url = this.buildStreamUrl(provider.api_url, requestBody.model || provider.model)
    const headers = this.buildHeaders(provider.api_key)
    const transformedBody = this.transformRequest(requestBody)

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(transformedBody),
      signal,
    })

    if (!response.ok) {
      let data
      try { data = await response.json() } catch { data = null }
      const err = new Error(data?.error?.message || `Gemini stream request failed (status ${response.status})`)
      err.status = response.status
      err.data = data
      throw err
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let isFirstChunk = true
    let previousContent = ''

    const extractDelta = (canonical) => {
      const msg = canonical.choices[0]?.message || {}
      const delta = {}
      if (isFirstChunk) {
        delta.role = 'assistant'
        isFirstChunk = false
      }
      const newContent = msg.content || ''
      if (newContent.length > previousContent.length) {
        delta.content = newContent.slice(previousContent.length)
      }
      previousContent = newContent
      if (msg.tool_calls) delta.tool_calls = msg.tool_calls
      return delta
    }

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
              const trimmed = line.trim()
              if (!trimmed) continue
              if (trimmed === '[DONE]') {
                this.push('data: [DONE]\n\n')
                this.push(null)
                return
              }

              let geminiData
              try {
                geminiData = JSON.parse(trimmed)
              } catch {
                continue
              }

              if (geminiData.error) {
                this.destroy(new Error(geminiData.error.message || 'Gemini stream error'))
                return
              }

              const canonical = this.transformResponse(geminiData)
              const delta = extractDelta(canonical)

              if (!delta.content && !delta.tool_calls && !delta.role) continue

              const streamChunk = {
                id: canonical.id,
                object: 'chat.completion.chunk',
                created: canonical.created,
                model: canonical.model,
                choices: [{
                  index: 0,
                  delta,
                  finish_reason: canonical.choices[0]?.finish_reason || null,
                }],
              }

              if (canonical.usage) {
                streamChunk.usage = canonical.usage
              }

              this.push(`data: ${JSON.stringify(streamChunk)}\n\n`)
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
      return data.models || []
    } catch {
      return []
    }
  }

  async testConnection(apiUrl, apiKey) {
    const base = apiUrl.replace(/\/+$/, '')

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
      const modelsUrl = `${base}${base.endsWith('/v1') ? '' : '/v1'}/models`
      const res = await tryFetch(modelsUrl, {
        headers: { 'X-Goog-Api-Key': apiKey },
      })

      if (res.status === 401 || res.status === 403) {
        return { valid: false, error: 'API key is invalid' }
      }

      if (res.ok) {
        return { valid: true }
      }

      return { valid: false, error: `Gemini returned status ${res.status}` }
    } catch (err) {
      const msg = err.name === 'AbortError' ? 'Connection timed out' : `Cannot reach server: ${err.message}`
      return { valid: false, error: msg }
    }
  }
}

import ProviderAdapter from './base.js'
import { Readable } from 'stream'

export default class GeminiNativeAdapter extends ProviderAdapter {
  static get type() { return 'gemini-native' }

  buildUrl(baseUrl, model) {
    let url = baseUrl.replace(/\/+$/, '')
    const modelPath = model || 'gemini-pro'
    if (!url.includes('/models/')) {
      if (!/\/v\d[\w.]*(\/|$)/.test(url)) url += '/v1'
      url += `/models/${modelPath}:generateContent`
    }
    return url
  }

  buildStreamUrl(baseUrl, model) {
    let url = baseUrl.replace(/\/+$/, '')
    const modelPath = model || 'gemini-pro'
    if (!url.includes('/models/')) {
      if (!/\/v\d[\w.]*(\/|$)/.test(url)) url += '/v1'
      url += `/models/${modelPath}:streamGenerateContent`
    }
    return url
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
        } else if (body.tool_choice === 'none') {
          mode = 'NONE'
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

  _mapFinishReason(finishReason) {
    const map = {
      STOP: 'stop',
      MAX_TOKENS: 'length',
      SAFETY: 'content_filter',
      RECITATION: 'content_filter',
      TOOL_CALL: 'tool_calls',
      FINISH_REASON_UNSPECIFIED: null,
    }
    return map[finishReason] || finishReason || null
  }

  _mapUsage(usageMetadata) {
    if (!usageMetadata) return null
    return {
      prompt_tokens: usageMetadata.promptTokenCount || 0,
      completion_tokens: usageMetadata.candidatesTokenCount || 0,
      total_tokens: (usageMetadata.promptTokenCount || 0) + (usageMetadata.candidatesTokenCount || 0),
    }
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

    const choice = {
      index: 0,
      message: {
        role: 'assistant',
        content: text || null,
      },
      finish_reason: this._mapFinishReason(candidate.finishReason) || 'stop',
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
      usage: this._mapUsage(data.usageMetadata),
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
      const detail = JSON.stringify(data).slice(0, 500)
      const errMsg = ProviderAdapter.extractErrorMsg(data) || data?.error?.status
      const err = new Error(errMsg || `Gemini returned ${response.status} — body: ${detail}`)
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
      const detail = data ? JSON.stringify(data).slice(0, 500) : 'no body'
      const errMsg = ProviderAdapter.extractErrorMsg(data)
      const err = new Error(errMsg || `Gemini stream request failed (status ${response.status}) — body: ${detail}`)
      err.status = response.status
      err.data = data
      throw err
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let isFirstChunk = true
    let callIndex = 0
    const streamId = `chatcmpl-${Date.now()}`
    const streamCreated = Math.floor(Date.now() / 1000)
    const mapFinishReason = this._mapFinishReason.bind(this)
    const mapUsage = this._mapUsage.bind(this)

    return new Readable({
      async read() {
        try {
          const emitLine = (rawLine) => {
            const trimmed = rawLine.trim()
            if (!trimmed) return true
            if (trimmed === '[DONE]') {
              this.push('data: [DONE]\n\n')
              this.push(null)
              return false
            }

            let geminiData
            try {
              geminiData = JSON.parse(trimmed)
            } catch {
              return true
            }

            if (geminiData.error) {
              this.destroy(new Error(geminiData.error.message || 'Gemini stream error'))
              return false
            }

            const delta = {}
            if (isFirstChunk) {
              delta.role = 'assistant'
              isFirstChunk = false
            }

            const candidate = geminiData.candidates?.[0]
            for (const part of candidate?.content?.parts || []) {
              if (part.text) {
                delta.content = (delta.content || '') + part.text
              }
              if (part.functionCall) {
                if (!delta.tool_calls) delta.tool_calls = []
                delta.tool_calls.push({
                  index: callIndex,
                  id: `call_${callIndex}`,
                  type: 'function',
                  function: {
                    name: part.functionCall.name || '',
                    arguments: JSON.stringify(part.functionCall.args || {}),
                  },
                })
                callIndex++
              }
            }

            const finishReason = candidate?.finishReason ? mapFinishReason(candidate.finishReason) : null
            if (!delta.content && !delta.tool_calls && !delta.role && !finishReason) return true

            const streamChunk = {
              id: streamId,
              object: 'chat.completion.chunk',
              created: streamCreated,
              model: geminiData.model || provider.model || 'gemini',
              choices: [{
                index: 0,
                delta,
                finish_reason: finishReason,
              }],
            }

            const usage = mapUsage(geminiData.usageMetadata)
            if (usage) {
              streamChunk.usage = usage
            }

            this.push(`data: ${JSON.stringify(streamChunk)}\n\n`)
            return true
          }

          while (true) {
            const { done, value } = await reader.read()
            if (done) {
              if (buffer.trim()) emitLine(buffer)
              this.push('data: [DONE]\n\n')
              this.push(null)
              break
            }

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
              if (!emitLine(line)) return
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
      const modelsUrl = `${base}${/\/v\d[\w.]*(\/|$)/.test(base) ? '' : '/v1'}/models`
      const res = await tryFetch(modelsUrl, {
        headers: { 'X-Goog-Api-Key': apiKey },
      })

      if (res.status === 401 || res.status === 403) {
        return { valid: false, error: 'API key is invalid' }
      }

      if (res.ok) {
        return { valid: true }
      }

      if (res.status === 404) {
        let body
        try { body = await res.json() } catch { body = null }
        if (ProviderAdapter.extractErrorMsg(body)) return { valid: true }
        return { valid: false, error: `Endpoint not found at ${base}. Check the API URL.` }
      }

      return { valid: false, error: `Gemini returned status ${res.status}` }
    } catch (err) {
      const msg = err.name === 'AbortError' ? 'Connection timed out' : `Cannot reach server: ${err.message}`
      return { valid: false, error: msg }
    }
  }
}

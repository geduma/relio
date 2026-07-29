import ProviderAdapter from './base.js'

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
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }
  }

  transformRequest(body) {
    const contents = []
    let systemInstruction = null

    for (const msg of body.messages || []) {
      if (msg.role === 'system') {
        systemInstruction = { parts: [{ text: msg.content }] }
        continue
      }

      const parts = []

      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content })
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') {
            parts.push({ text: part.text })
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

      const role = msg.role === 'assistant' ? 'model' : 'user'
      contents.push({ role, parts })
    }

    const result = { contents }

    if (systemInstruction) {
      result.systemInstruction = systemInstruction
    }

    if (body.temperature != null) result.generationConfig = { temperature: body.temperature }
    if (body.max_tokens != null) {
      result.generationConfig = { ...result.generationConfig, maxOutputTokens: body.max_tokens }
    }
    if (body.top_p != null) {
      result.generationConfig = { ...result.generationConfig, topP: body.top_p }
    }
    if (body.stop) {
      result.generationConfig = { ...result.generationConfig, stopSequences: Array.isArray(body.stop) ? body.stop : [body.stop] }
    }

    if (body.tools && body.tools.length > 0) {
      result.tools = body.tools.map(t => ({
        functionDeclarations: [{
          name: t.function?.name || t.name,
          description: t.function?.description || t.description || '',
          parameters: t.function?.parameters || t.input_schema || {},
        }],
      }))
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

    const candidate = data.candidates[0]
    const parts = candidate.content?.parts || []
    let text = ''
    const toolCalls = []

    for (const part of parts) {
      if (part.text) {
        text += part.text
      }
      if (part.functionCall) {
        toolCalls.push({
          id: `call_${Date.now()}`,
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

    const { Readable } = await import('stream')

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
              const streamChunk = {
                id: canonical.id,
                object: 'chat.completion.chunk',
                created: canonical.created,
                model: canonical.model,
                choices: [{
                  index: 0,
                  delta: {
                    content: canonical.choices[0]?.message?.content || '',
                  },
                  finish_reason: null,
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
        headers: { 'Authorization': `Bearer ${apiKey}` },
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

export function estimateTokens(text) {
  return Math.floor(String(text).length / 4)
}

function minifyJsonLossless(raw) {
  try {
    JSON.parse(raw)
  } catch {
    return null
  }
  let out = ''
  let inString = false
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += raw[i + 1] || ''
        i += 1
      } else if (ch === '"') {
        inString = false
      }
    } else if (ch === '"') {
      inString = true
      out += ch
    } else if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') {
      // insignificant whitespace outside strings
    } else {
      out += ch
    }
  }
  return out === raw ? null : out
}

function findJsonBlockEnd(text, start) {
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') {
        i += 1
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === open) {
      depth += 1
    } else if (ch === close) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function minifyEmbeddedJsonInText(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '{' || ch === '[') {
      const end = findJsonBlockEnd(text, i)
      if (end !== -1) {
        const candidate = text.slice(i, end + 1)
        const minified = minifyJsonLossless(candidate)
        if (minified !== null) {
          out += minified
          i = end + 1
          continue
        }
      }
    }
    out += ch
    i += 1
  }
  return out
}

function splitOnFences(text) {
  const segments = []
  let buf = []
  let inFence = false
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('```')) {
      if (buf.length) {
        segments.push({ code: false, text: buf.join('\n') })
        buf = []
      }
      segments.push({ code: true, text: line })
      inFence = !inFence
      continue
    }
    if (inFence) {
      segments.push({ code: true, text: line })
      continue
    }
    buf.push(line)
  }
  if (buf.length) segments.push({ code: false, text: buf.join('\n') })
  return segments
}

function isInvisibleChar(code) {
  return code === 0xFEFF
    || (code >= 0x200B && code <= 0x200D)
    || (code >= 0x0000 && code <= 0x0008)
    || code === 0x000B
    || code === 0x000C
    || (code >= 0x000E && code <= 0x001F)
    || code === 0x007F
}

function stripInvisibleChars(text) {
  let out = ''
  for (const ch of text) {
    if (!isInvisibleChar(ch.charCodeAt(0))) out += ch
  }
  return out
}

function normalizeTypography(text) {
  return text
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\u2013/g, '-')
    .replace(/\u2014/g, '-')
    .replace(/\u2026/g, '...')
}

function normalizeWhitespace(text) {
  const normalized = splitOnFences(text).map((segment) => {
    if (segment.code) return segment
    return {
      code: false,
      text: segment.text
        .split('\n')
        .map(line => line.trim().replace(/[ \t]+/g, ' '))
        .join('\n'),
    }
  })

  let result = ''
  let blankRun = 0
  for (const segment of normalized) {
    if (segment.code) {
      blankRun = 0
      result += segment.text + '\n'
      continue
    }
    for (const line of segment.text.split('\n')) {
      if (line.trim() === '') {
        blankRun += 1
        if (blankRun > 1) continue
      } else {
        blankRun = 0
      }
      result += line + '\n'
    }
  }
  return result.replace(/\n$/, '')
}

function minifyJsonOutsideFences(text) {
  return splitOnFences(text)
    .map(segment => segment.code ? segment.text : minifyEmbeddedJsonInText(segment.text))
    .join('\n')
}

function normalizeContentString(content, options) {
  let out = content
  out = stripInvisibleChars(out)
  if (options.aggressiveNormalization) out = normalizeTypography(out)
  out = normalizeWhitespace(out)
  out = minifyJsonOutsideFences(out)
  return out
}

function minifyStringFields(value) {
  if (typeof value === 'string') {
    const stripped = stripInvisibleChars(value)
    return minifyEmbeddedJsonInText(stripped)
  }
  if (Array.isArray(value)) {
    return value.map(minifyStringFields)
  }
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = minifyStringFields(v)
    }
    return out
  }
  return value
}

function optimizeContentParts(parts, options) {
  if (!Array.isArray(parts)) return parts
  let changed = false
  const out = parts.map((part) => {
    if (!part || typeof part !== 'object') return part
    if (part.type === 'text' && typeof part.text === 'string') {
      const text = normalizeContentString(part.text, options)
      if (text !== part.text) {
        changed = true
        return { ...part, text }
      }
    }
    return part
  })
  return changed ? out : parts
}

function optimizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return toolCalls
  let changed = false
  const out = toolCalls.map((tc) => {
    if (!tc || typeof tc !== 'object' || !tc.function || typeof tc.function !== 'object') return tc
    const args = tc.function.arguments
    if (typeof args === 'string') {
      const minified = minifyEmbeddedJsonInText(stripInvisibleChars(args))
      if (minified !== args) {
        changed = true
        return { ...tc, function: { ...tc.function, arguments: minified } }
      }
    }
    return tc
  })
  return changed ? out : toolCalls
}

function optimizeMessage(message, options) {
  if (!message || typeof message !== 'object') return message
  const next = { ...message }

  if (typeof next.content === 'string') {
    const content = normalizeContentString(next.content, options)
    if (content !== next.content) next.content = content
  } else if (Array.isArray(next.content)) {
    next.content = optimizeContentParts(next.content, options)
  }

  const toolCalls = optimizeToolCalls(next.tool_calls)
  if (toolCalls !== next.tool_calls) next.tool_calls = toolCalls

  return next
}

function dedupeSystemMessages(messages) {
  const seen = new Set()
  const out = []
  for (const m of messages) {
    if (m && m.role === 'system') {
      const key = `${m.content}\u0000${m.name || ''}`
      if (seen.has(key)) continue
      seen.add(key)
    }
    out.push(m)
  }
  return out
}

function dedupeConsecutiveMessages(messages) {
  const out = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (last && m && last.role === m.role && last.content === m.content) continue
    out.push(m)
  }
  return out
}

function optimizeMessages(messages, options) {
  if (!Array.isArray(messages)) return messages
  const optimized = messages.map(m => optimizeMessage(m, options))
  const deduped = dedupeSystemMessages(optimized)
  return dedupeConsecutiveMessages(deduped)
}

export function optimizeRequestBody(body, options = { aggressiveNormalization: false }) {
  if (!body || typeof body !== 'object') {
    return { body, tokensSavedEstimate: 0 }
  }

  const originalJson = JSON.stringify(body)

  const optimized = { ...body }
  if (Array.isArray(body.messages)) {
    optimized.messages = optimizeMessages(body.messages, options)
  }
  if (Array.isArray(body.tools)) {
    optimized.tools = body.tools.map(t => minifyStringFields(t))
  }
  if (Array.isArray(body.functions)) {
    optimized.functions = body.functions.map(f => minifyStringFields(f))
  }

  const optimizedJson = JSON.stringify(optimized)
  const tokensSavedEstimate = Math.max(0, estimateTokens(originalJson) - estimateTokens(optimizedJson))

  return { body: optimized, tokensSavedEstimate }
}

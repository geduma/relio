const COMMON_FIELDS = ['role', 'content', 'name']
const ASSISTANT_FIELDS = [...COMMON_FIELDS, 'tool_calls', 'reasoning', 'refusal']
const TOOL_FIELDS = ['role', 'content', 'tool_call_id', 'name']

const CHAT_COMPLETIONS_FIELDS = [
  'model', 'messages', 'store', 'reasoning_effort', 'metadata',
  'frequency_penalty', 'logit_bias', 'logprobs', 'top_logprobs',
  'max_tokens', 'max_completion_tokens', 'n', 'modalities',
  'prediction', 'audio', 'presence_penalty', 'response_format',
  'seed', 'service_tier', 'stop', 'stream', 'stream_options',
  'temperature', 'top_p', 'tools', 'tool_choice',
  'parallel_tool_calls', 'user', 'function_call', 'functions',
]

const EMBEDDINGS_FIELDS = ['model', 'input', 'encoding_format', 'dimensions', 'user']

const ALLOWED_FIELDS_BY_ROLE = {
  system: COMMON_FIELDS,
  user: COMMON_FIELDS,
  developer: COMMON_FIELDS,
  assistant: ASSISTANT_FIELDS,
  tool: TOOL_FIELDS,
}

function pick(source, keys) {
  const out = {}
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key]
  }
  return out
}

export function toOpenAIMessage(msg) {
  if (!msg || typeof msg !== 'object') return msg
  const allowed = ALLOWED_FIELDS_BY_ROLE[msg.role] || COMMON_FIELDS
  const cleaned = pick(msg, allowed)

  if (Array.isArray(cleaned.tool_calls)) {
    cleaned.tool_calls = cleaned.tool_calls.map(toolCall => {
      if (!toolCall || typeof toolCall !== 'object') return toolCall
      const result = {}
      if (toolCall.id !== undefined) result.id = toolCall.id
      if (toolCall.type !== undefined) result.type = toolCall.type
      const fn = toolCall.function
      if (fn && typeof fn === 'object') {
        const f = {}
        if (fn.name !== undefined) f.name = fn.name
        if (fn.arguments !== undefined) f.arguments = fn.arguments
        result.function = f
      }
      return result
    })
  }

  return cleaned
}

export function sanitizeChatBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  const clone = pick(body, CHAT_COMPLETIONS_FIELDS)

  if (clone.user && typeof clone.user === 'object') {
    clone.user = typeof clone.user.id === 'string' ? clone.user.id : undefined
    if (clone.user === undefined) delete clone.user
  }

  if (Array.isArray(clone.messages)) {
    if (clone.user == null) {
      const userMsg = clone.messages.find(m => m && typeof m === 'object' && m.user && typeof m.user === 'object' && typeof m.user.id === 'string')
      if (userMsg) clone.user = userMsg.user.id
    }
    clone.messages = clone.messages.map(toOpenAIMessage)
  }

  return clone
}

export function sanitizeEmbeddingsBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  return pick(body, EMBEDDINGS_FIELDS)
}

export function redactAuthHeaders(headers) {
  if (!headers) return headers
  const clone = { ...headers }
  if (clone.Authorization) {
    const key = clone.Authorization
    clone.Authorization = key.length > 12
      ? `${key.slice(0, 11)}…${key.slice(-4)}`
      : '***'
  }
  if (clone['api-key']) {
    clone['api-key'] = '***'
  }
  return clone
}

export function truncate(value, limit = 4000) {
  const str = typeof value === 'string' ? value : JSON.stringify(value)
  if (!str) return null
  return str.length > limit ? `${str.slice(0, limit)}…[truncated ${str.length - limit} chars]` : str
}

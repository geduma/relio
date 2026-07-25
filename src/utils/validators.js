export function isValidUrl(str) {
  try {
    new URL(str)
    return true
  } catch {
    return false
  }
}

export function isValidProviderType(type) {
  return ['chat', 'embeddings', 'vision'].includes(type)
}

export function isValidStatus(status) {
  return ['active', 'paused', 'cooldown'].includes(status)
}

export function sanitizeString(str, maxLength = 255) {
  if (typeof str !== 'string') return ''
  return str.trim().slice(0, maxLength)
}

export function sanitizeNumber(val, fallback = 0) {
  const n = parseFloat(val)
  return isNaN(n) ? fallback : n
}

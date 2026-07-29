import OpenAICompatibleAdapter from './openai-compatible.js'
import AnthropicAdapter from './anthropic.js'
import GeminiNativeAdapter from './gemini-native.js'
import AzureOpenAIAdapter from './azure-openai.js'

const registry = new Map()
const instances = new Map()

export function registerAdapter(type, AdapterClass) {
  registry.set(type, AdapterClass)
}

registerAdapter('openai-compatible', OpenAICompatibleAdapter)
registerAdapter('anthropic', AnthropicAdapter)
registerAdapter('gemini-native', GeminiNativeAdapter)
registerAdapter('azure-openai', AzureOpenAIAdapter)

export function getAdapter(providerType) {
  const normalized = (providerType || 'openai-compatible').toLowerCase()
  const cached = instances.get(normalized)
  if (cached) return cached

  const AdapterClass = registry.get(normalized)

  if (!AdapterClass) {
    const Fallback = registry.get('openai-compatible')
    const instance = new Fallback()
    instances.set('openai-compatible', instance)
    return instance
  }

  const instance = new AdapterClass()
  instances.set(normalized, instance)
  return instance
}

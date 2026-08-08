import { describe, it, expect } from 'vitest'
import { optimizeRequestBody, estimateTokens } from '../src/services/tokenOptimizer.js'

const BODY = (overrides = {}) => ({
  model: 'gpt-4o',
  messages: [
    { role: 'system', content: 'Eres un asistente útil.' },
    { role: 'user', content: 'Hola mundo' },
  ],
  temperature: 0.7,
  ...overrides,
})

describe('tokenOptimizer: core normalization', () => {
  it('returns the body unchanged when there is nothing to optimize', () => {
    const { body, tokensSavedEstimate } = optimizeRequestBody(BODY())
    expect(body).toEqual(BODY())
    expect(tokensSavedEstimate).toBe(0)
  })

  it('minifies embedded JSON in message content without changing string values', () => {
    const original = '{\n  "precio": 1.50,\n  "id": 123456789012345678901\n}'
    const { body, tokensSavedEstimate } = optimizeRequestBody({
      messages: [{ role: 'user', content: original }],
    })
    expect(body.messages[0].content).toBe('{"precio":1.50,"id":123456789012345678901}')
    expect(tokensSavedEstimate).toBeGreaterThan(0)
  })

  it('preserves code blocks (fences) exactly, including intentional spacing', () => {
    const content = '```js\nconst   x = 1;  // keep  spaces\n```\n\n\n\nTraduce esto. "Hola" mundo'
    const { body, tokensSavedEstimate } = optimizeRequestBody({
      messages: [{ role: 'user', content }],
    })
    const optimized = body.messages[0].content
    expect(optimized).toContain('```js\nconst   x = 1;  // keep  spaces\n```')
    expect(optimized).toContain('Traduce esto.')
    expect(optimized).not.toContain('\n\n\n\n')
    expect(tokensSavedEstimate).toBeGreaterThan(0)
  })

  it('keeps typographic characters unless aggressiveNormalization is enabled', () => {
    const content = 'Hola —mundo— y "comillas" y 3…2…1'
    const mild = optimizeRequestBody({ messages: [{ role: 'user', content }] })
    expect(mild.body.messages[0].content).toBe(content)

    const aggressive = optimizeRequestBody(
      { messages: [{ role: 'user', content }] },
      { aggressiveNormalization: true }
    )
    expect(aggressive.body.messages[0].content).toBe('Hola -mundo- y "comillas" y 3...2...1')
  })

  it('strips invisible/control characters', () => {
    const content = 'hola\u200Bmundo\uFEFF\n\n\n  espacio extra   '
    const { body } = optimizeRequestBody({ messages: [{ role: 'user', content }] })
    expect(body.messages[0].content).not.toContain('\u200B')
    expect(body.messages[0].content).not.toContain('\uFEFF')
  })

  it('collapses duplicate blank lines and trims line whitespace outside fences', () => {
    const content = 'primera línea\n\n\n\n  segunda  con  espacios  \n\n\ntercera'
    const { body } = optimizeRequestBody({ messages: [{ role: 'user', content }] })
    const optimized = body.messages[0].content
    expect(optimized).not.toContain('\n\n\n\n')
    expect(optimized).toContain('primera línea\n\nsegunda con espacios\n\ntercera')
  })

  it('deduplicates repeated identical system messages', () => {
    const { body } = optimizeRequestBody({
      messages: [
        { role: 'system', content: 'You are a bot.' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'You are a bot.' },
      ],
    })
    expect(body.messages).toHaveLength(2)
    expect(body.messages.filter(m => m.role === 'system')).toHaveLength(1)
  })

  it('deduplicates consecutive identical messages of the same role', () => {
    const { body } = optimizeRequestBody({
      messages: [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
      ],
    })
    expect(body.messages.map(m => m.content)).toEqual(['a', 'b'])
  })

  it('minifies tool_calls arguments losslessly (big int + decimal preserved)', () => {
    const args = '{ "n": 9223372036854775807, "f": 1.1 }'
    const { body } = optimizeRequestBody({
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: args } }],
        },
      ],
    })
    const argumentsStr = body.messages[0].tool_calls[0].function.arguments
    expect(argumentsStr).toBe('{"n":9223372036854775807,"f":1.1}')
  })

  it('minifies embedded JSON inside tool descriptions', () => {
    const { body } = optimizeRequestBody({
      tools: [{ type: 'function', function: { name: 'lookup', description: 'Busca.\nUn id:\n{\n  "k": 1\n}', parameters: {} } }],
    })
    const description = body.tools[0].function.description
    expect(description).toContain('{"k":1}')
    expect(description).toContain('Busca.')
  })
})

describe('tokenOptimizer: properties', () => {
  it('does not mutate the input body', () => {
    const original = BODY({
      messages: [
        { role: 'user', content: 'lorem  ipsum   dolor' },
        { role: 'user', content: 'lorem  ipsum   dolor' },
      ],
    })
    const snapshot = JSON.parse(JSON.stringify(original))
    optimizeRequestBody(original)
    expect(original).toEqual(snapshot)
  })

  it('is idempotent: a second pass yields no further savings', () => {
    const input = {
      messages: [
        { role: 'user', content: '{"a":  1}\n\n\n  texto  con  espacios   ' },
        { role: 'system', content: 'sistema' },
        { role: 'system', content: 'sistema' },
      ],
    }
    const first = optimizeRequestBody(input)
    expect(first.tokensSavedEstimate).toBeGreaterThan(0)
    const second = optimizeRequestBody(first.body)
    expect(second.body).toEqual(first.body)
    expect(second.tokensSavedEstimate).toBe(0)
  })

  it('reports a positive estimate proportional to actual byte savings', () => {
    const content = '{\n  "a":  1,\n  "b":  2\n}\n\n\nlínea con    espacios   extra'
    const { body, tokensSavedEstimate } = optimizeRequestBody({ messages: [{ role: 'user', content }] })
    const savedTokens = estimateTokens(content) - estimateTokens(body.messages[0].content)
    expect(tokensSavedEstimate).toBe(Math.max(0, savedTokens))
  })
})

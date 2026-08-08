import { performance } from 'perf_hooks'
import { optimizeRequestBody, estimateTokens } from '../src/services/tokenOptimizer.js'

const SAMPLE_MESSAGES = [
  { role: 'system', content: 'Eres un asistente útil.\n\nResponde bien.' },
  { role: 'system', content: 'Eres un asistente útil.\n\nResponde bien.' },
  {
    role: 'user',
    content: '```js\nconst   x = 1;  // keep  spaces\n```\n\nTraduce esto. "Hola" —mundo—',
  },
  { role: 'user', content: '{"id":123456789012345678901,"precio":1.50}' },
  {
    role: 'user',
    content: '  línea  con   espacios    extra  \n\n\n\notra línea\n',
  },
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 't1',
        type: 'function',
        function: { name: 'lookup', arguments: '{ "n": 9223372036854775807, "f": 1.10 }' },
      },
    ],
  },
]

const sample = {
  model: 'gpt-4o',
  messages: SAMPLE_MESSAGES,
  temperature: 0.7,
  tools: [
    {
      type: 'function',
      function: {
        name: 'lookup',
        description: 'Busca.\nUn id:\n{\n  "k": 1\n}',
        parameters: { type: 'object', properties: { k: { type: 'number' } } },
      },
    },
  ],
}

const originalTokens = estimateTokens(JSON.stringify(sample))
const { body: optimized, tokensSavedEstimate } = optimizeRequestBody(sample, { aggressiveNormalization: true })
const optimizedTokens = estimateTokens(JSON.stringify(optimized))

const N = 200_000
const start = performance.now()
for (let i = 0; i < N; i += 1) {
  optimizeRequestBody(sample)
}
const elapsed = performance.now() - start

const out = [
  `original JSON bytes : ${JSON.stringify(sample).length}`,
  `optimized JSON bytes: ${JSON.stringify(optimized).length}`,
  `tokens before       : ${originalTokens}`,
  `tokens after        : ${optimizedTokens}`,
  `tokens saved        : ${tokensSavedEstimate}`,
  `relative saving     : ${((1 - optimizedTokens / originalTokens) * 100).toFixed(1)}%`,
  `throughput          : ${Math.round(N / (elapsed / 1000))} req/s`,
  `avg per request     : ${(elapsed / N).toFixed(2)} ms`,
]
process.stdout.write(out.join('\n') + '\n')

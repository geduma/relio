import { Transform } from 'stream'

export class StreamUsageTracker {
  constructor() {
    this.usage = null
    this._buffer = ''
  }

  createTransform() {
    return new Transform({
      transform: (chunk, _enc, cb) => {
        this._process(chunk.toString())
        cb(null, chunk)
      },
      flush: (cb) => {
        this._process('')
        cb()
      },
    })
  }

  _process(text) {
    this._buffer += text
    let idx
    while ((idx = this._buffer.indexOf('\n\n')) !== -1) {
      const event = this._buffer.slice(0, idx)
      this._buffer = this._buffer.slice(idx + 2)
      this._parseEvent(event)
    }
  }

  _parseEvent(event) {
    let dataLine = null
    for (const line of event.split('\n')) {
      if (line.startsWith('data: ')) {
        dataLine = line.slice(6)
        break
      }
    }
    if (dataLine === null || dataLine === '[DONE]') return

    let payload
    try {
      payload = JSON.parse(dataLine)
    } catch {
      return
    }

    const usage = payload?.usage
    if (!usage || typeof usage !== 'object') return
    if (!Number.isInteger(usage.prompt_tokens) || !Number.isInteger(usage.completion_tokens)) return

    this.usage = {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: Number.isInteger(usage.total_tokens) ? usage.total_tokens : usage.prompt_tokens + usage.completion_tokens,
    }
  }
}

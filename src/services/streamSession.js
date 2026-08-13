import { pipeline } from 'stream/promises'
import { StreamUsageTracker } from './streamUsageTracker.js'
import { ABORT_REASONS } from '../utils/streamErrors.js'

export { ABORT_REASONS }

export function createStreamSession(res, { idleMs, maxDurationMs, keepAliveMs = 0, startTime = Date.now(), sseHeaders }) {
  const controller = new AbortController()
  let abortReason = null
  let firstChunkAt = null
  let lastDataAt = 0
  let idleTimer = null
  let durationTimer = null
  let keepAliveTimer = null
  let disposed = false

  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
  }
  const clearKeepAlive = () => {
    if (keepAliveTimer) clearInterval(keepAliveTimer)
    keepAliveTimer = null
  }

  const abortWith = (reason) => {
    if (disposed || controller.signal.aborted) return
    abortReason = abortReason || reason
    controller.abort()
  }

  const onClientClose = () => {
    if (!res.writableEnded) abortWith(ABORT_REASONS.CLIENT_DISCONNECT)
  }
  res.on('close', onClientClose)

  const resetIdle = () => {
    clearIdle()
    idleTimer = setTimeout(() => abortWith(ABORT_REASONS.IDLE_TIMEOUT), idleMs)
    if (idleTimer.unref) idleTimer.unref()
  }

  durationTimer = setTimeout(() => abortWith(ABORT_REASONS.MAX_DURATION), maxDurationMs)
  if (durationTimer.unref) durationTimer.unref()

  const startHeartbeat = () => {
    if (keepAliveMs <= 0) return
    keepAliveTimer = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        clearKeepAlive()
        return
      }
      if (Date.now() - lastDataAt >= keepAliveMs) {
        res.write(': keep-alive\n\n')
      }
    }, keepAliveMs)
    if (keepAliveTimer.unref) keepAliveTimer.unref()
  }

  const onUpstreamData = () => {
    lastDataAt = Date.now()
    if (firstChunkAt === null) firstChunkAt = Date.now() - startTime
    resetIdle()
  }

  function start() {
    res.writeHead(200, sseHeaders)
    lastDataAt = Date.now()
    startHeartbeat()
    resetIdle()
  }

  async function run(stream) {
    stream.on('data', onUpstreamData)
    const usageTracker = new StreamUsageTracker()
    try {
      await pipeline(stream, usageTracker.createTransform(), res)
      return { ttftMs: firstChunkAt, usage: usageTracker.usage || {} }
    } finally {
      stream.off?.('data', onUpstreamData)
    }
  }

  function dispose() {
    disposed = true
    clearIdle()
    clearKeepAlive()
    clearTimeout(durationTimer)
    res.off('close', onClientClose)
  }

  return {
    signal: controller.signal,
    start,
    run,
    dispose,
    isAborted: () => controller.signal.aborted,
    reason: () => abortReason,
    ttftMs: () => firstChunkAt,
    markUpstreamData: onUpstreamData,
  }
}

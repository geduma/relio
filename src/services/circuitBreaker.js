import { dbGet, dbRun, getDb } from '../db.js'
import { config } from '../config.js'
import { enqueueCircuitCounter, dropCircuitCounters } from './logQueue.js'

const runningCounts = new Map()

function getProviderState(providerId) {
  const state = dbGet(
    'SELECT * FROM circuit_breaker_state WHERE provider_id = ?',
    [providerId]
  )
  return state || { provider_id: providerId, state: 'healthy', failure_count: 0 }
}

function getRunningCount(providerId) {
  if (!runningCounts.has(providerId)) {
    runningCounts.set(providerId, getProviderState(providerId).failure_count || 0)
  }
  return runningCounts.get(providerId)
}

export function resetRunningCounts(providerId) {
  if (providerId) {
    runningCounts.delete(providerId)
  } else {
    runningCounts.clear()
  }
}


export function recordSuccess(providerId) {
  const state = dbGet(
    `SELECT COALESCE((SELECT failure_count FROM circuit_breaker_state WHERE provider_id = ?), 0) AS failure_count,
            (SELECT status FROM providers WHERE id = ?) AS provider_status`,
    [providerId, providerId]
  )
  const pending = runningCounts.get(providerId) || 0
  if (state.failure_count === 0 && pending === 0 && state.provider_status === 'active') return

  dropCircuitCounters(providerId)
  runningCounts.delete(providerId)

  const db = getDb()
  const tx = db.transaction(() => {
    dbRun(
      `INSERT INTO circuit_breaker_state (provider_id, state, failure_count, updated_at)
       VALUES (?, 'healthy', 0, datetime('now'))
       ON CONFLICT(provider_id) DO UPDATE SET
         state = 'healthy',
         failure_count = 0,
         updated_at = datetime('now')`,
      [providerId]
    )
    dbRun(
      "UPDATE providers SET status = 'active', cooldown_until = NULL WHERE id = ?",
      [providerId]
    )
  })
  tx()
}

export function recordFailure(providerId, cooldownAfter, cooldownDuration) {
  const newCount = getRunningCount(providerId) + 1
  runningCounts.set(providerId, newCount)

  if (newCount >= cooldownAfter) {
    dropCircuitCounters(providerId)
    runningCounts.delete(providerId)
    const cooldownUntil = new Date(Date.now() + cooldownDuration * 1000).toISOString()
    const db = getDb()
    const tx = db.transaction(() => {
      dbRun(
        `INSERT INTO circuit_breaker_state (provider_id, state, failure_count, last_failure_at, cooldown_until, updated_at)
         VALUES (?, 'cooldown', ?, datetime('now'), ?, datetime('now'))
         ON CONFLICT(provider_id) DO UPDATE SET
           state = 'cooldown',
           failure_count = ?,
           last_failure_at = datetime('now'),
           cooldown_until = ?,
           updated_at = datetime('now')`,
        [providerId, newCount, cooldownUntil, newCount, cooldownUntil]
      )
      dbRun(
        'UPDATE providers SET status = \'cooldown\', cooldown_until = ? WHERE id = ?',
        [cooldownUntil, providerId]
      )
    })
    tx()
  } else {
    enqueueCircuitCounter(providerId, newCount)
  }
}

function applyImmediateCooldown(providerId, durationSeconds) {
  const cooldownUntil = new Date(Date.now() + durationSeconds * 1000).toISOString()
  const db = getDb()
  const tx = db.transaction(() => {
    dbRun(
      `INSERT INTO circuit_breaker_state (provider_id, state, failure_count, last_failure_at, cooldown_until, updated_at)
       VALUES (?, 'cooldown', 1, datetime('now'), ?, datetime('now'))
       ON CONFLICT(provider_id) DO UPDATE SET
         state = 'cooldown',
         last_failure_at = datetime('now'),
         cooldown_until = ?,
         updated_at = datetime('now')`,
      [providerId, cooldownUntil, cooldownUntil]
    )
    dbRun(
      'UPDATE providers SET status = \'cooldown\', cooldown_until = ? WHERE id = ?',
      [cooldownUntil, providerId]
    )
  })
  tx()
  dropCircuitCounters(providerId)
  resetRunningCounts(providerId)
}

export function recordProviderFailure(provider, kind, retryAfterSec = null) {
  if (!provider || !provider.id) return
  if (kind !== 'quota' && kind !== 'rate') return

  let durationSeconds = kind === 'quota'
    ? config.relay.quotaCooldownSeconds
    : config.relay.rateLimitCooldownSeconds

  if (retryAfterSec && retryAfterSec > 0) {
    durationSeconds = Math.min(retryAfterSec, config.relay.retryAfterMaxSeconds)
  }

  applyImmediateCooldown(provider.id, durationSeconds)
}

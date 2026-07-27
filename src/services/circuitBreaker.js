import { dbGet, dbRun } from '../db.js'

function getProviderState(providerId) {
  const state = dbGet(
    'SELECT * FROM circuit_breaker_state WHERE provider_id = ?',
    [providerId]
  )
  return state || { provider_id: providerId, state: 'healthy', failure_count: 0 }
}

export function recordSuccess(providerId) {
  dbRun(
    `INSERT INTO circuit_breaker_state (provider_id, state, failure_count, updated_at)
     VALUES (?, 'healthy', 0, datetime('now'))
     ON CONFLICT(provider_id) DO UPDATE SET
       state = 'healthy',
       failure_count = 0,
       updated_at = datetime('now')`,
    [providerId]
  )
}

export function recordFailure(providerId, cooldownAfter, cooldownDuration) {
  const state = getProviderState(providerId)
  const newCount = state.failure_count + 1

  if (newCount >= cooldownAfter) {
    const cooldownUntil = new Date(Date.now() + cooldownDuration * 1000).toISOString()
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
  } else {
    dbRun(
      `INSERT INTO circuit_breaker_state (provider_id, state, failure_count, last_failure_at, updated_at)
       VALUES (?, 'healthy', ?, datetime('now'), datetime('now'))
       ON CONFLICT(provider_id) DO UPDATE SET
         state = 'healthy',
         failure_count = ?,
         last_failure_at = datetime('now'),
         updated_at = datetime('now')`,
      [providerId, newCount, newCount]
    )
  }
}

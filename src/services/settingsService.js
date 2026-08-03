import { dbGet, dbRun } from '../db.js'

export function getSetting(key) {
  const row = dbGet('SELECT value FROM settings WHERE key = ?', [key])
  return row ? row.value : null
}

export function setSetting(key, value) {
  dbRun(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    [key, value]
  )
}

export function deleteSetting(key) {
  dbRun('DELETE FROM settings WHERE key = ?', [key])
}

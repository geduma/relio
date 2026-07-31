import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { dbRun, getDb } from './db.js'
import { config } from './config.js'
import { cleanExpiredCache } from './services/cacheManager.js'
import { logger } from './utils/logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const BACKUP_DIR = path.resolve(__dirname, '../db/backups')
const LOG_DIR = path.resolve(__dirname, '../logs')
const ARCHIVE_DIR = path.join(LOG_DIR, 'archive')
const DB_PATH = path.resolve(__dirname, '..', config.db.path)

const RETENTION = {
  requestsLog: 90,
  cache: 30,
  metrics: 365,
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function backupDb() {
  ensureDir(BACKUP_DIR)
  const date = new Date().toISOString().slice(0, 10)
  const backupPath = path.join(BACKUP_DIR, `db-${date}.sqlite`)

  if (fs.existsSync(backupPath)) {
    logger.info(`Backup already exists for ${date}`)
    return
  }

  getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)')

  fs.copyFileSync(DB_PATH, backupPath)
  logger.info(`Database backed up to ${backupPath}`)
}

function cleanOldData() {
  const db = getDb()
  const tx = db.transaction(() => {
    const deletedRequests = dbRun(
      `DELETE FROM requests_log WHERE request_at < datetime('now', ?)`,
      [`-${RETENTION.requestsLog} days`]
    ).changes

    const deletedCache = cleanExpiredCache()

    const deletedMetrics = dbRun(
      `DELETE FROM metrics WHERE metric_date < date('now', ?)`,
      [`-${RETENTION.metrics} days`]
    ).changes

    logger.info('Cleanup complete', {
      requestsLog: deletedRequests,
      cache: deletedCache,
      metrics: deletedMetrics,
    })
  })
  tx()
}

function cleanOldBackups(maxBackups = 10) {
  ensureDir(BACKUP_DIR)
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.sqlite'))
    .sort()
    .reverse()

  if (files.length > maxBackups) {
    const toDelete = files.slice(maxBackups)
    for (const file of toDelete) {
      fs.unlinkSync(path.join(BACKUP_DIR, file))
      logger.info(`Removed old backup: ${file}`)
    }
  }
}

function archiveOldLogs() {
  ensureDir(ARCHIVE_DIR)
  const appLog = path.join(LOG_DIR, 'app.log')

  if (fs.existsSync(appLog) && fs.statSync(appLog).size > 10 * 1024 * 1024) {
    const date = new Date().toISOString().slice(0, 10)
    const archivePath = path.join(ARCHIVE_DIR, `app-${date}.log`)
    fs.renameSync(appLog, archivePath)
    logger.info(`Log archived to ${archivePath}`)
  }
}

export function recoverCooldowns() {
  const now = new Date().toISOString()
  const recovered = dbRun(
    `UPDATE providers SET status = 'active', cooldown_until = NULL
     WHERE status = 'cooldown' AND cooldown_until IS NOT NULL AND cooldown_until <= ?`,
    [now]
  ).changes

  if (recovered > 0) {
    dbRun(
      `UPDATE circuit_breaker_state SET state = 'healthy', failure_count = 0, cooldown_until = NULL, updated_at = datetime('now')
       WHERE state = 'cooldown' AND cooldown_until <= ?`,
      [now]
    )
    logger.info('Cooldowns recovered', { count: recovered })
  }
}

export function runMaintenance() {
  logger.info('Starting maintenance')
  try {
    backupDb()
    cleanOldData()
    cleanOldBackups()
    archiveOldLogs()
    logger.info('Maintenance complete')
  } catch (err) {
    logger.error('Maintenance failed', { error: err.message })
  }
}

import Database from 'better-sqlite3'
import crypto from 'crypto'
import path from 'path'
import { fileURLToPath } from 'url'
import { config } from './config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ALGORITHM = 'aes-256-gcm'
const RAW_KEY = config.security?.encryptionKey
if (!RAW_KEY || typeof RAW_KEY !== 'string') {
  throw new Error('config.security.encryptionKey is required. Set it in config.json or ENCRYPTION_KEY.')
}
const KEY = crypto.createHash('sha256').update(RAW_KEY).digest()

export function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex')
}

export function encrypt(text) {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv)
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  const authTag = cipher.getAuthTag().toString('hex')
  return iv.toString('hex') + ':' + authTag + ':' + encrypted
}

export function decrypt(ciphertext) {
  const parts = ciphertext.split(':')
  if (parts.length !== 3) throw new Error('Invalid ciphertext format')
  const iv = Buffer.from(parts[0], 'hex')
  const authTag = Buffer.from(parts[1], 'hex')
  const encrypted = parts[2]
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv)
  decipher.setAuthTag(authTag)
  let decrypted = decipher.update(encrypted, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}

let db
let _overrideDbPath

export function setDbPath(path) {
  _overrideDbPath = path
}

function resolveDbPath() {
  if (_overrideDbPath) return _overrideDbPath
  const raw = config.db.path
  if (raw === ':memory:') return ':memory:'
  return path.resolve(__dirname, '..', raw)
}

export function getDb() {
  if (!db) {
    db = new Database(resolveDbPath())
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
  }
  return db
}

export function dbAll(sql, params = []) {
  return getDb().prepare(sql).all(...params)
}

export function dbGet(sql, params = []) {
  return getDb().prepare(sql).get(...params)
}

export function dbRun(sql, params = []) {
  return getDb().prepare(sql).run(...params)
}

export function initDb() {
  const d = getDb()

  d.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      api_url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      model TEXT NOT NULL,
      capability TEXT NOT NULL DEFAULT 'chat' CHECK(capability IN ('chat', 'embeddings')),
      provider_type TEXT NOT NULL DEFAULT 'openai-compatible' CHECK(provider_type IN ('openai-compatible', 'anthropic', 'gemini-native', 'azure-openai')),
      order_position INT NOT NULL DEFAULT 0,
      order_label TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'cooldown')),
      cost_per_input_token REAL DEFAULT 0,
      cost_per_output_token REAL DEFAULT 0,
      rate_limit_req_per_min INT DEFAULT 60,
      tokens_per_day INT DEFAULT 0,
      cooldown_after_failures INT DEFAULT 5,
      cooldown_duration_seconds INT DEFAULT 300,
      cooldown_until DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS requests_log (
      id TEXT PRIMARY KEY,
      provider_id TEXT REFERENCES providers(id),
      endpoint TEXT NOT NULL,
      request_body TEXT NOT NULL,
      origin_ip TEXT,
      origin_header TEXT,
      status_code INT,
      response_body TEXT,
      error_message TEXT,
      input_tokens INT DEFAULT 0,
      output_tokens INT DEFAULT 0,
      total_tokens INT DEFAULT 0,
      estimated_cost REAL DEFAULT 0,
      request_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      response_time_ms INT,
      authenticated_via TEXT,
      cache_hit BOOLEAN DEFAULT FALSE,
      was_retry BOOLEAN DEFAULT FALSE,
      retry_count INT DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS cache (
      id TEXT PRIMARY KEY,
      query_hash TEXT UNIQUE NOT NULL,
      endpoint TEXT NOT NULL,
      request_body TEXT NOT NULL,
      response_body TEXT NOT NULL,
      provider_id TEXT REFERENCES providers(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME,
      hit_count INT DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS circuit_breaker_state (
      provider_id TEXT PRIMARY KEY REFERENCES providers(id),
      state TEXT DEFAULT 'healthy',
      failure_count INT DEFAULT 0,
      last_failure_at DATETIME,
      cooldown_until DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS metrics (
      id TEXT PRIMARY KEY,
      provider_id TEXT REFERENCES providers(id),
      metric_date DATE NOT NULL,
      total_requests INT DEFAULT 0,
      total_input_tokens INT DEFAULT 0,
      total_output_tokens INT DEFAULT 0,
      total_cost REAL DEFAULT 0,
      error_count INT DEFAULT 0,
      cache_hits INT DEFAULT 0,
      avg_response_time_ms REAL DEFAULT 0,
      UNIQUE(provider_id, metric_date)
    );
  `)

  runMigrations(d)
  createIndexes(d)
}

function runMigrations(d) {
  let columns = d.prepare("PRAGMA table_info('providers')").all().map(c => c.name)

  if (columns.includes('type') && !columns.includes('capability')) {
    d.exec('ALTER TABLE providers RENAME COLUMN type TO capability')
    columns = d.prepare("PRAGMA table_info('providers')").all().map(c => c.name)
  }

  if (!columns.includes('provider_type')) {
    d.exec("ALTER TABLE providers ADD COLUMN provider_type TEXT NOT NULL DEFAULT 'openai-compatible' CHECK(provider_type IN ('openai-compatible', 'anthropic', 'gemini-native', 'azure-openai'))")
    columns = d.prepare("PRAGMA table_info('providers')").all().map(c => c.name)
  }

  const cacheColumns = d.prepare("PRAGMA table_info('cache')").all().map(c => c.name)
  if (!cacheColumns.includes('provider_id')) {
    d.exec("ALTER TABLE cache ADD COLUMN provider_id TEXT REFERENCES providers(id)")
  }

  const legacyProviderColumns = ['cost_per_day', 'current_failure_count', 'last_failure_at']
  for (const column of legacyProviderColumns) {
    if (columns.includes(column)) {
      d.exec(`ALTER TABLE providers DROP COLUMN ${column}`)
    }
  }

  migrateApiKeys(d)
}

function migrateApiKeys(d) {
  const columns = d.prepare("PRAGMA table_info('api_keys')").all().map(c => c.name)
  if (!columns.includes('key')) return

  const rows = d.prepare('SELECT id, key, name, created_at, last_used_at FROM api_keys').all()
  d.exec(`
    ALTER TABLE api_keys RENAME TO api_keys_legacy;
    CREATE TABLE api_keys (
      id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME
    );
  `)
  const insert = d.prepare('INSERT INTO api_keys (id, key_hash, key_prefix, name, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)')
  const tx = d.transaction(() => {
    for (const r of rows) {
      insert.run(r.id, hashApiKey(r.key), r.key.slice(0, 10), r.name, r.created_at, r.last_used_at)
    }
  })
  tx()
  d.exec('DROP TABLE api_keys_legacy')
}

function createIndexes(d) {
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_providers_order ON providers(order_position, status);',
    'CREATE INDEX IF NOT EXISTS idx_providers_capability ON providers(capability, order_position);',
    'CREATE INDEX IF NOT EXISTS idx_providers_status ON providers(status);',
    'CREATE INDEX IF NOT EXISTS idx_requests_provider ON requests_log(provider_id, request_at);',
    'CREATE INDEX IF NOT EXISTS idx_requests_at ON requests_log(request_at);',
    'CREATE INDEX IF NOT EXISTS idx_requests_endpoint ON requests_log(endpoint, request_at);',
    'CREATE INDEX IF NOT EXISTS idx_requests_cache ON requests_log(cache_hit);',
    'CREATE INDEX IF NOT EXISTS idx_cache_hash ON cache(query_hash);',
    'CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(endpoint, expires_at);',
    'CREATE INDEX IF NOT EXISTS idx_keys_hash ON api_keys(key_hash);',
    'CREATE INDEX IF NOT EXISTS idx_cb_state ON circuit_breaker_state(state, cooldown_until);',
    'CREATE INDEX IF NOT EXISTS idx_metrics_date ON metrics(metric_date);',
  ]

  const tx = d.transaction(() => {
    for (const sql of indexes) {
      d.exec(sql)
    }
  })
  tx()
}

export function closeDb() {
  if (db) {
    db.close()
    db = null
  }
}

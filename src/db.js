import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import { config } from './config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let db

function resolveDbPath() {
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
      type TEXT NOT NULL CHECK(type IN ('chat', 'embeddings', 'vision')),
      order_position INT NOT NULL DEFAULT 0,
      order_label TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'cooldown')),
      cost_per_input_token REAL DEFAULT 0,
      cost_per_output_token REAL DEFAULT 0,
      rate_limit_req_per_min INT DEFAULT 60,
      tokens_per_day INT DEFAULT 0,
      cost_per_day REAL DEFAULT 0,
      cooldown_after_failures INT DEFAULT 5,
      cooldown_duration_seconds INT DEFAULT 300,
      current_failure_count INT DEFAULT 0,
      last_failure_at DATETIME,
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
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS login_history (
      id TEXT PRIMARY KEY,
      email TEXT,
      method TEXT NOT NULL,
      provider TEXT,
      status TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      error_message TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS circuit_breaker_state (
      provider_id TEXT PRIMARY KEY REFERENCES providers(id),
      state TEXT DEFAULT 'healthy',
      failure_count INT DEFAULT 0,
      last_failure_at DATETIME,
      cooldown_until DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      user_email TEXT,
      user_name TEXT,
      user_avatar TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME
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

  createIndexes(d)
}

function createIndexes(d) {
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_providers_order ON providers(order_position, status);',
    'CREATE INDEX IF NOT EXISTS idx_providers_type ON providers(type, order_position);',
    'CREATE INDEX IF NOT EXISTS idx_providers_status ON providers(status);',
    'CREATE INDEX IF NOT EXISTS idx_requests_provider ON requests_log(provider_id, request_at);',
    'CREATE INDEX IF NOT EXISTS idx_requests_at ON requests_log(request_at);',
    'CREATE INDEX IF NOT EXISTS idx_requests_endpoint ON requests_log(endpoint, request_at);',
    'CREATE INDEX IF NOT EXISTS idx_requests_cache ON requests_log(cache_hit);',
    'CREATE INDEX IF NOT EXISTS idx_cache_hash ON cache(query_hash);',
    'CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(endpoint, expires_at);',
    'CREATE INDEX IF NOT EXISTS idx_keys_key ON api_keys(key);',
    'CREATE INDEX IF NOT EXISTS idx_login_email ON login_history(email, timestamp);',
    'CREATE INDEX IF NOT EXISTS idx_login_ts ON login_history(timestamp);',
    'CREATE INDEX IF NOT EXISTS idx_cb_state ON circuit_breaker_state(state, cooldown_until);',
    'CREATE INDEX IF NOT EXISTS idx_sessions_hash ON sessions(token_hash);',
    'CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);',
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

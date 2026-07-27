import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

let cfg

function loadConfig() {
  if (cfg) return cfg
  const configPath = process.env.CONFIG_PATH || join(__dirname, '..', 'config.json')
  let raw
  try {
    raw = readFileSync(configPath, 'utf-8')
  } catch {
    throw new Error(
      `config.json not found at ${configPath}. Copy config.example.json to config.json and fill in values.`
    )
  }
  cfg = JSON.parse(raw)

  if (process.env.DB_PATH) cfg.db.path = process.env.DB_PATH
  if (process.env.PORT) cfg.server.port = parseInt(process.env.PORT, 10)
  if (process.env.HOST) cfg.server.host = process.env.HOST
  if (process.env.NODE_ENV) cfg.server.nodeEnv = process.env.NODE_ENV

  return cfg
}

export const config = new Proxy({}, {
  get(_, prop) {
    return loadConfig()[prop]
  }
})

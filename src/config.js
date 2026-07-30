import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadConfig() {
  const configPath = process.env.CONFIG_PATH || join(__dirname, '..', 'config.json')
  let raw
  try {
    raw = readFileSync(configPath, 'utf-8')
  } catch {
    throw new Error(
      `config.json not found at ${configPath}. Copy config.example.json to config.json and fill in values.`
    )
  }
  const cfg = JSON.parse(raw)

  cfg.server ??= {}
  cfg.db ??= {}
  cfg.security ??= {}

  cfg.relay ??= {}
  cfg.relay.exposeProvider ??= false

  return cfg
}

export const config = loadConfig()

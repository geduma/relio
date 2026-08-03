import { Router } from 'express'
import { normalizeConfig, getConfigPath, getEnvOverrides, applyConfigChanges } from '../config.js'
import { validateConfigChanges, READ_ONLY_KEYS } from '../services/configValidation.js'
import { readConfigFile, saveConfigChanges } from '../services/configStore.js'

const router = Router()

function flatten(obj, prefix = '') {
  const out = {}
  for (const [key, value] of Object.entries(obj || {})) {
    const dotted = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flatten(value, dotted))
    } else {
      out[dotted] = value
    }
  }
  return out
}

function maskKey(key) {
  if (!key) return ''
  if (key.length <= 10) return '*'.repeat(key.length)
  return `${key.slice(0, 6)}...${key.slice(-4)}`
}

function buildResponse() {
  const cfg = normalizeConfig(readConfigFile())
  if (cfg.security && cfg.security.encryptionKey) {
    cfg.security.encryptionKeySet = true
    cfg.security.encryptionKey = maskKey(cfg.security.encryptionKey)
  }
  return {
    config: cfg,
    envOverrides: getEnvOverrides(),
    readOnlyKeys: READ_ONLY_KEYS,
    configPath: getConfigPath(),
  }
}

router.get('/', (_req, res) => {
  res.json(buildResponse())
})

router.put('/', (req, res) => {
  const body = req.body || {}
  const patch = body.config || body
  const changes = flatten(patch)
  const errors = validateConfigChanges(changes)
  if (errors.length > 0) {
    return res.status(400).json({
      error: {
        message: errors.join('; '),
        type: 'invalid_request_error',
        code: 'invalid_config',
      },
    })
  }

  let saved
  try {
    saved = saveConfigChanges(changes)
    applyConfigChanges(changes)
  } catch (err) {
    return res.status(500).json({
      error: { message: err.message, type: 'server_error', code: 'config_write_failed' },
    })
  }

  res.json({ ...buildResponse(), saved })
})

export default router

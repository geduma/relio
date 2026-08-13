import { Router } from 'express'
import crypto from 'crypto'
import { dbAll, dbGet, dbRun, getDb, encrypt } from '../db.js'
import { getProvider, invalidateProviderCache, FAILOVER_MODEL } from '../services/failoverEngine.js'
import { getAdapter } from '../adapters/index.js'
import { assertPublicUrl } from '../utils/ssrf.js'
import { invalidateModelsCache } from './proxy.routes.js'
import { logger } from '../utils/logger.js'

const ORDER_LABELS = ['Main', 'Fallback 1', 'Fallback 2', 'Fallback 3', 'Fallback 4', 'Fallback 5']

const MODELS_VISIBLE_FIELDS = ['name', 'capability', 'status', 'order_position', 'cooldown_until']

function affectsModelsResponse(provider, body) {
  return MODELS_VISIBLE_FIELDS.some(field =>
    field in body && body[field] !== provider[field]
  )
}

async function testProviderConnection(apiUrl, apiKey, providerType, model) {
  const adapter = getAdapter(providerType)
  return adapter.testConnection(apiUrl, apiKey, { model })
}

const router = Router()

function wrap(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

router.get('/', (req, res) => {
  const { capability } = req.query
  let rows
  if (capability) {
    rows = dbAll(
      'SELECT * FROM providers WHERE capability = ? ORDER BY order_position ASC',
      [capability]
    )
  } else {
    rows = dbAll('SELECT * FROM providers ORDER BY order_position ASC')
  }

  res.json(rows.map(r => ({ ...r, api_key: r.api_key ? '***' : null })))
})

router.post('/test-connection', wrap(async (req, res) => {
  let { api_url, api_key, provider_type, provider_id, model } = req.body

  if (api_key === '***' && provider_id) {
    const provider = getProvider(provider_id)
    if (provider) api_key = provider.api_key
  }

  if (!api_url || !api_key) {
    const missing = []
    if (!api_url) missing.push('api_url')
    if (!api_key) missing.push('api_key')
    return res.status(400).json({ valid: false, error: `Missing required fields: ${missing.join(', ')}` })
  }

  try {
    await assertPublicUrl(api_url)
  } catch (err) {
    return res.status(400).json({ valid: false, error: err.message })
  }

  const result = await testProviderConnection(api_url, api_key, provider_type || 'openai-compatible', model)
  if (!result.valid) {
    logger.warn('Provider connection test from dashboard failed', { api_url, provider_type, error: result.error })
  }
  res.json(result)
}))

router.post('/', wrap(async (req, res) => {
  const {
    name, api_url, api_key, model, capability, provider_type,
    rate_limit_req_per_min, tokens_per_day,
    cost_per_input_token, cost_per_output_token,
    cooldown_after_failures, cooldown_duration_seconds, status,
  } = req.body

  const missing = []
  if (!name) missing.push('name')
  if (!api_url) missing.push('api_url')
  if (!api_key) missing.push('api_key')
  if (!model) missing.push('model')
  if (!capability) missing.push('capability')

  if (missing.length) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` })
  }

  if (String(name).trim().toLowerCase() === FAILOVER_MODEL) {
    return res.status(400).json({ error: `Provider name "${FAILOVER_MODEL}" is reserved for proxy/failover mode. Choose a different name.` })
  }

  try {
    await assertPublicUrl(api_url)
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }

  const validation = await testProviderConnection(api_url, api_key, provider_type || 'openai-compatible', model)
  if (!validation.valid) {
    logger.warn('Provider creation rejected — connection test failed', { name, api_url, error: validation.error })
    return res.status(400).json({ error: `Connection test failed: ${validation.error}` })
  }

  const maxPos = dbGet(
    `SELECT MAX(order_position) AS max FROM providers WHERE capability = ? AND status != 'paused'`,
    [capability]
  )
  const nextPos = (maxPos?.max ?? -1) + 1

  const id = crypto.randomUUID()
  const label = ORDER_LABELS[nextPos] || `Fallback ${nextPos}`

  dbRun(
    `INSERT INTO providers
     (id, name, api_url, api_key, model, capability, provider_type, order_position, order_label,
      rate_limit_req_per_min, tokens_per_day,
      cost_per_input_token, cost_per_output_token,
      cooldown_after_failures, cooldown_duration_seconds, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, name, api_url, encrypt(api_key), model, capability, provider_type || 'openai-compatible', nextPos, label,
      rate_limit_req_per_min ?? 60, tokens_per_day ?? 0,
      cost_per_input_token ?? 0, cost_per_output_token ?? 0,
      cooldown_after_failures ?? 5, cooldown_duration_seconds ?? 300, status ?? 'active',
    ]
  )

  invalidateProviderCache(id)
  invalidateModelsCache()
  res.json({ success: true, provider_id: id })
}))

router.get('/:id', (req, res) => {
  const provider = dbGet('SELECT * FROM providers WHERE id = ?', [req.params.id])
  if (!provider) {
    return res.status(404).json({ error: 'Provider not found' })
  }
  res.json({ ...provider, api_key: provider.api_key ? '***' : null })
})

router.patch('/reorder', (req, res) => {
  const db = getDb()
  const { provider_ids, capability } = req.body

  if (!Array.isArray(provider_ids)) {
    return res.status(400).json({ error: 'provider_ids array is required' })
  }

  if (!capability) {
    return res.status(400).json({ error: 'capability is required' })
  }

  const tx = db.transaction(() => {
    provider_ids.forEach((id, index) => {
      const label = ORDER_LABELS[index] || `Fallback ${index}`
      dbRun(
        'UPDATE providers SET order_position = ?, order_label = ? WHERE id = ? AND capability = ?',
        [index, label, id, capability]
      )
    })
  })
  tx()

  invalidateModelsCache()
  res.json({ success: true })
})

router.patch('/:id', wrap(async (req, res) => {
  const db = getDb()
  const { id } = req.params

  const provider = getProvider(id)
  if (!provider) return res.status(404).json({ error: 'Provider not found' })

  if ('name' in req.body && String(req.body.name).trim().toLowerCase() === FAILOVER_MODEL) {
    return res.status(400).json({ error: `Provider name "${FAILOVER_MODEL}" is reserved for proxy/failover mode. Choose a different name.` })
  }

  const allowed = [
    'name', 'api_url', 'api_key', 'model', 'capability', 'provider_type',
    'status', 'rate_limit_req_per_min', 'tokens_per_day',
    'cost_per_input_token', 'cost_per_output_token',
    'cooldown_after_failures', 'cooldown_duration_seconds',
  ]

  const updates = []
  const values = []

  for (const [key, value] of Object.entries(req.body)) {
    if (allowed.includes(key)) {
      if (key === 'api_key' && value === '***') continue
      updates.push(`${key} = ?`)
      values.push(key === 'api_key' ? encrypt(value) : value)
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' })
  }

  const keyChanged = 'api_key' in req.body && req.body.api_key !== '***'
  const urlChanged = ('api_url' in req.body && req.body.api_url !== provider.api_url) || keyChanged

  if (urlChanged) {
    const testUrl = req.body.api_url || provider.api_url
    const testKey = keyChanged ? req.body.api_key : provider.api_key
    const testProviderType = req.body.provider_type || provider.provider_type
    const testModel = req.body.model || provider.model
    try {
      await assertPublicUrl(testUrl)
    } catch (err) {
      return res.status(400).json({ error: err.message })
    }
    const validation = await testProviderConnection(testUrl, testKey, testProviderType, testModel)
    if (!validation.valid) {
      logger.warn('Provider update rejected — connection test failed', { id: provider.id, name: provider.name, api_url: testUrl, error: validation.error })
      return res.status(400).json({ error: `Connection test failed: ${validation.error}` })
    }
  }

  const finalStatus = req.body.status ?? provider.status
  const finalCapability = req.body.capability ?? provider.capability

  const doUpdate = () => {
    if (finalStatus === 'active') {
      updates.push('health_failures = 0')
      updates.push('cooldown_until = NULL')
    }
    updates.push("updated_at = datetime('now')")
    values.push(id)
    dbRun(`UPDATE providers SET ${updates.join(', ')} WHERE id = ?`, values)
  }

  const tx = db.transaction(() => {
    doUpdate()

    if (finalStatus === 'active') {
      dbRun(
        `INSERT INTO circuit_breaker_state (provider_id, state, failure_count, updated_at)
         VALUES (?, 'healthy', 0, datetime('now'))
         ON CONFLICT(provider_id) DO UPDATE SET
           state = 'healthy',
           failure_count = 0,
           cooldown_until = NULL,
           updated_at = datetime('now')`,
        [id]
      )
    }

    const activeOnes = dbAll(
      `SELECT id FROM providers WHERE capability = ? AND status = 'active' ORDER BY order_position ASC`,
      [finalCapability]
    )

    activeOnes.forEach((p, index) => {
      const label = ORDER_LABELS[index] || `Fallback ${index}`
      dbRun(
        'UPDATE providers SET order_position = ?, order_label = ? WHERE id = ?',
        [index, label, p.id]
      )
    })

    if (finalStatus === 'paused') {
      const lastPos = activeOnes.length
      dbRun(
        "UPDATE providers SET order_position = ?, order_label = 'Paused' WHERE id = ?",
        [lastPos, id]
      )
    }
  })
  tx()

  invalidateProviderCache(id)
  if (affectsModelsResponse(provider, req.body)) invalidateModelsCache()
  res.json({ success: true })
}))

router.delete('/:id', (req, res) => {
  const db = getDb()
  const { id } = req.params

  const provider = dbGet('SELECT * FROM providers WHERE id = ?', [id])
  if (!provider) {
    return res.status(404).json({ error: 'Provider not found' })
  }

  const tx = db.transaction(() => {
    dbRun('DELETE FROM circuit_breaker_state WHERE provider_id = ?', [id])
    dbRun('DELETE FROM requests_log WHERE provider_id = ?', [id])
    dbRun('DELETE FROM cache WHERE provider_id = ?', [id])
    dbRun('DELETE FROM metrics WHERE provider_id = ?', [id])
    dbRun('DELETE FROM provider_health_checks WHERE provider_id = ?', [id])
    dbRun('DELETE FROM providers WHERE id = ?', [id])

    const activeOnes = dbAll(
      `SELECT id FROM providers WHERE capability = ? AND status = 'active' ORDER BY order_position ASC`,
      [provider.capability]
    )
    activeOnes.forEach((r, index) => {
      const label = ORDER_LABELS[index] || `Fallback ${index}`
      dbRun(
        'UPDATE providers SET order_position = ?, order_label = ? WHERE id = ?',
        [index, label, r.id]
      )
    })
  })
  tx()

  invalidateProviderCache(id)
  invalidateModelsCache()
  res.json({ success: true })
})

export default router

import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { dbAll, dbGet, dbRun, getDb, encrypt } from '../db.js'
import { getProvider, invalidateProviderCache } from '../services/failoverEngine.js'
import { getAdapter } from '../adapters/index.js'
import { logger } from '../utils/logger.js'

const ORDER_LABELS = ['Main', 'Fallback 1', 'Fallback 2', 'Fallback 3', 'Fallback 4', 'Fallback 5']

async function testProviderConnection(apiUrl, apiKey, providerType) {
  const adapter = getAdapter(providerType)
  return adapter.testConnection(apiUrl, apiKey)
}

const router = Router()

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

router.post('/test-connection', async (req, res) => {
  let { api_url, api_key, provider_type, provider_id } = req.body

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

  const result = await testProviderConnection(api_url, api_key, provider_type || 'openai-compatible')
  if (!result.valid) {
    logger.warn('Provider connection test from dashboard failed', { api_url, provider_type, error: result.error })
  }
  res.json(result)
})

router.post('/', async (req, res) => {
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

  const validation = await testProviderConnection(api_url, api_key, provider_type || 'openai-compatible')
  if (!validation.valid) {
    logger.warn('Provider creation rejected — connection test failed', { name, api_url, error: validation.error })
    return res.status(400).json({ error: `Connection test failed: ${validation.error}` })
  }

  const maxPos = dbGet(
    `SELECT MAX(order_position) AS max FROM providers WHERE capability = ? AND status != 'paused'`,
    [capability]
  )
  const nextPos = (maxPos?.max ?? -1) + 1

  const id = uuidv4()
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
  res.json({ success: true, provider_id: id })
})

router.patch('/reorder', (req, res) => {
  const db = getDb()
  const { provider_ids } = req.body

  if (!Array.isArray(provider_ids)) {
    return res.status(400).json({ error: 'provider_ids array is required' })
  }

  const tx = db.transaction(() => {
    provider_ids.forEach((id, index) => {
      const label = ORDER_LABELS[index] || `Fallback ${index}`
      dbRun(
        'UPDATE providers SET order_position = ?, order_label = ? WHERE id = ?',
        [index, label, id]
      )
    })
  })
  tx()

  res.json({ success: true })
})

router.patch('/:id', async (req, res) => {
  const db = getDb()
  const { id } = req.params

  const provider = getProvider(id)
  if (!provider) return res.status(404).json({ error: 'Provider not found' })

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
  const urlChanged = 'api_url' in req.body || keyChanged

  if (urlChanged) {
    const testUrl = req.body.api_url || provider.api_url
    const testKey = keyChanged ? req.body.api_key : provider.api_key
    const testProviderType = req.body.provider_type || provider.provider_type
    const validation = await testProviderConnection(testUrl, testKey, testProviderType)
    if (!validation.valid) {
      logger.warn('Provider update rejected — connection test failed', { id: provider.id, name: provider.name, api_url: testUrl, error: validation.error })
      return res.status(400).json({ error: `Connection test failed: ${validation.error}` })
    }
  }

  const isPausing = req.body.status === 'paused' && provider.status !== 'paused'

  const doUpdate = () => {
    updates.push("updated_at = datetime('now')")
    values.push(id)
    dbRun(`UPDATE providers SET ${updates.join(', ')} WHERE id = ?`, values)
  }

  const isReactivating = req.body.status === 'active' && provider.status === 'paused'

  if (isPausing || isReactivating) {
    const tx = db.transaction(() => {
      doUpdate()

      const activeOnes = dbAll(
        `SELECT id FROM providers WHERE capability = ? AND status = 'active' AND id != ? ORDER BY order_position ASC`,
        [provider.capability, id]
      )

      activeOnes.forEach((p, index) => {
        const label = ORDER_LABELS[index] || `Fallback ${index}`
        dbRun(
          'UPDATE providers SET order_position = ?, order_label = ? WHERE id = ?',
          [index, label, p.id]
        )
      })

      const lastPos = activeOnes.length
      const label = isPausing ? 'Paused' : ORDER_LABELS[lastPos] || `Fallback ${lastPos}`
      dbRun(
        'UPDATE providers SET order_position = ?, order_label = ? WHERE id = ?',
        [lastPos, label, id]
      )
    })
    tx()
  } else {
    doUpdate()
  }

  invalidateProviderCache(id)
  res.json({ success: true })
})

router.delete('/:id', (req, res) => {
  const db = getDb()
  const { id } = req.params

  const provider = dbGet('SELECT * FROM providers WHERE id = ?', [id])
  if (!provider) {
    return res.status(404).json({ error: 'Provider not found' })
  }

  if (provider.order_label === 'Main' && provider.status !== 'paused') {
    return res.status(400).json({ error: 'Cannot delete a Main provider. Move it to a fallback position first.' })
  }

  const tx = db.transaction(() => {
    dbRun('DELETE FROM circuit_breaker_state WHERE provider_id = ?', [id])
    dbRun('DELETE FROM requests_log WHERE provider_id = ?', [id])
    dbRun('DELETE FROM cache WHERE provider_id = ?', [id])
    dbRun('DELETE FROM metrics WHERE provider_id = ?', [id])
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
  res.json({ success: true })
})

export default router

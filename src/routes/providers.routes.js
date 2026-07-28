import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { dbAll, dbGet, dbRun, getDb } from '../db.js'
import { requireDashboardSession } from '../middleware/authMiddleware.js'
import { logger } from '../utils/logger.js'

const ORDER_LABELS = ['Main', 'Fallback 1', 'Fallback 2', 'Fallback 3', 'Fallback 4', 'Fallback 5']

async function testProviderConnection(apiUrl, apiKey) {
  let base = apiUrl.replace(/\/+$/, '')
  if (!base.endsWith('/v1')) base += '/v1'
  const modelsUrl = `${base}/models`
  const chatUrl = `${base}/chat/completions`

  async function tryFetch(url, options) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch(url, { ...options, signal: controller.signal })
      return res
    } finally {
      clearTimeout(timeout)
    }
  }

  try {
    const res = await tryFetch(modelsUrl, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    })

    if (res.status === 200) {
      logger.info('Connection test succeeded', { url: modelsUrl, status: res.status })
      return { valid: true, status: res.status }
    }

    if (res.status === 401) {
      return { valid: false, error: 'API key is invalid (received 401)' }
    }

    if (res.status === 404) {
      const chatRes = await tryFetch(chatUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      })
      if (chatRes.status === 401) {
        return { valid: false, error: 'API key is invalid (received 401)' }
      }
      if (chatRes.status === 404) {
        return { valid: false, error: `Endpoint not found at ${base}. Check the API URL.` }
      }
      logger.info('Connection test succeeded via chat completions fallback', { url: chatUrl, status: chatRes.status })
      return { valid: true, status: chatRes.status }
    }

    logger.warn('Connection test failed', { url: modelsUrl, status: res.status })
    return { valid: false, error: `Provider returned status ${res.status}` }
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Connection timed out' : `Cannot reach server: ${err.message}`
    logger.warn('Connection test failed', { url: modelsUrl, error: err.message, code: err.code })
    return { valid: false, error: msg }
  }
}

const router = Router()

router.use(requireDashboardSession)

router.get('/', (req, res) => {
  const { type } = req.query
  let rows
  if (type) {
    rows = dbAll(
      'SELECT * FROM providers WHERE type = ? ORDER BY order_position ASC',
      [type]
    )
  } else {
    rows = dbAll('SELECT * FROM providers ORDER BY order_position ASC')
  }

  res.json(rows.map(r => ({ ...r, api_key: r.api_key ? '***' : null })))
})

router.post('/test-connection', async (req, res) => {
  const { api_url, api_key } = req.body
  if (!api_url || !api_key) {
    return res.status(400).json({ valid: false, error: 'api_url and api_key are required' })
  }
  const result = await testProviderConnection(api_url, api_key)
  if (!result.valid) {
    logger.warn('Provider connection test from dashboard failed', { api_url, error: result.error })
  }
  res.json(result)
})

router.post('/', async (req, res) => {
  const {
    name, api_url, api_key, model, type,
    rate_limit_req_per_min, tokens_per_day,
    cost_per_input_token, cost_per_output_token,
    cooldown_after_failures, cooldown_duration_seconds, status,
  } = req.body

  if (!name || !api_url || !api_key || !model || !type) {
    return res.status(400).json({ error: 'name, api_url, api_key, model, and type are required' })
  }

  const validation = await testProviderConnection(api_url, api_key)
  if (!validation.valid) {
    logger.warn('Provider creation rejected — connection test failed', { name, api_url, error: validation.error })
    return res.status(400).json({ error: `Connection test failed: ${validation.error}` })
  }

  const maxPos = dbGet('SELECT MAX(order_position) AS max FROM providers WHERE type = ?', [type])
  const nextPos = (maxPos?.max ?? -1) + 1

  const id = uuidv4()
  const label = ORDER_LABELS[nextPos] || `Fallback ${nextPos}`

  dbRun(
    `INSERT INTO providers
     (id, name, api_url, api_key, model, type, order_position, order_label,
      rate_limit_req_per_min, tokens_per_day,
      cost_per_input_token, cost_per_output_token,
      cooldown_after_failures, cooldown_duration_seconds, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, name, api_url, api_key, model, type, nextPos, label,
      rate_limit_req_per_min ?? 60, tokens_per_day ?? 0,
      cost_per_input_token ?? 0, cost_per_output_token ?? 0,
      cooldown_after_failures ?? 5, cooldown_duration_seconds ?? 300, status ?? 'active',
    ]
  )

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

  const provider = dbGet('SELECT * FROM providers WHERE id = ?', [id])
  if (!provider) return res.status(404).json({ error: 'Provider not found' })

  const allowed = [
    'name', 'api_url', 'api_key', 'model', 'type',
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
      values.push(value)
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
    const validation = await testProviderConnection(testUrl, testKey)
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
        `SELECT id FROM providers WHERE type = ? AND status = 'active' AND id != ? ORDER BY order_position ASC`,
        [provider.type, id]
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
    dbRun('DELETE FROM providers WHERE id = ?', [id])
    dbRun('DELETE FROM circuit_breaker_state WHERE provider_id = ?', [id])

    const activeOnes = dbAll(
      `SELECT id FROM providers WHERE type = ? AND status = 'active' ORDER BY order_position ASC`,
      [provider.type]
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

  res.json({ success: true })
})

export default router

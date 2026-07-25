import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { dbAll, dbGet, dbRun, getDb } from '../db.js'
import { requireDashboardSession } from '../middleware/authMiddleware.js'

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

router.post('/', (req, res) => {
  const {
    name, api_url, api_key, model, type,
    rate_limit_req_per_min, tokens_per_day,
    cost_per_input_token, cost_per_output_token,
    cooldown_after_failures, cooldown_duration_seconds, notes,
  } = req.body

  if (!name || !api_url || !api_key || !model || !type) {
    return res.status(400).json({ error: 'name, api_url, api_key, model, and type are required' })
  }

  const maxPos = dbGet('SELECT MAX(order_position) AS max FROM providers WHERE type = ?', [type])
  const nextPos = (maxPos?.max ?? -1) + 1

  const id = uuidv4()
  const labels = ['Main', 'Fallback 1', 'Fallback 2', 'Fallback 3', 'Fallback 4', 'Fallback 5']
  const label = labels[nextPos] || `Fallback ${nextPos}`

  dbRun(
    `INSERT INTO providers
     (id, name, api_url, api_key, model, type, order_position, order_label,
      rate_limit_req_per_min, tokens_per_day,
      cost_per_input_token, cost_per_output_token,
      cooldown_after_failures, cooldown_duration_seconds, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, name, api_url, api_key, model, type, nextPos, label,
      rate_limit_req_per_min ?? 60, tokens_per_day ?? 0,
      cost_per_input_token ?? 0, cost_per_output_token ?? 0,
      cooldown_after_failures ?? 5, cooldown_duration_seconds ?? 300, notes ?? null,
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
      const labels = ['Main', 'Fallback 1', 'Fallback 2', 'Fallback 3', 'Fallback 4', 'Fallback 5']
      const label = labels[index] || `Fallback ${index}`
      dbRun(
        'UPDATE providers SET order_position = ?, order_label = ? WHERE id = ?',
        [index, label, id]
      )
    })
  })
  tx()

  res.json({ success: true })
})

router.patch('/:id', (req, res) => {
  const { id } = req.params
  const allowed = [
    'name', 'api_url', 'api_key', 'model', 'type',
    'status', 'rate_limit_req_per_min', 'tokens_per_day',
    'cost_per_input_token', 'cost_per_output_token',
    'cooldown_after_failures', 'cooldown_duration_seconds', 'notes',
  ]

  const updates = []
  const values = []

  for (const [key, value] of Object.entries(req.body)) {
    if (allowed.includes(key)) {
      updates.push(`${key} = ?`)
      values.push(value)
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' })
  }

  updates.push("updated_at = datetime('now')")
  values.push(id)

  dbRun(`UPDATE providers SET ${updates.join(', ')} WHERE id = ?`, values)
  res.json({ success: true })
})

router.delete('/:id', (req, res) => {
  const db = getDb()
  const { id } = req.params

  const provider = dbGet('SELECT * FROM providers WHERE id = ?', [id])
  if (!provider) {
    return res.status(404).json({ error: 'Provider not found' })
  }

  const tx = db.transaction(() => {
    dbRun('DELETE FROM providers WHERE id = ?', [id])
    dbRun('DELETE FROM circuit_breaker_state WHERE provider_id = ?', [id])

    const remaining = dbAll(
      'SELECT id FROM providers WHERE type = ? ORDER BY order_position ASC',
      [provider.type]
    )
    remaining.forEach((r, index) => {
      const labels = ['Main', 'Fallback 1', 'Fallback 2', 'Fallback 3', 'Fallback 4', 'Fallback 5']
      const label = labels[index] || `Fallback ${index}`
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

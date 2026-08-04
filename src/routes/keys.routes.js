import { Router } from 'express'
import { createApiKey, listApiKeys, revokeApiKey } from '../services/authService.js'
import { dbGet, hashApiKey } from '../db.js'

const router = Router()

router.post('/', (req, res) => {
  const { name } = req.body
  if (!name) {
    return res.status(400).json({ error: 'name is required' })
  }

  const apiKey = createApiKey(name)
  const row = dbGet(
    'SELECT id, key_prefix, name, created_at, last_used_at FROM api_keys WHERE key_hash = ?',
    [hashApiKey(apiKey)]
  )
  res.json({
    apiKey,
    key: row
      ? { id: row.id, key_preview: `${row.key_prefix}...`, name: row.name, created_at: row.created_at, last_used_at: row.last_used_at }
      : null,
    message: 'Save this key now. You won\'t be able to see it again.',
  })
})

router.get('/', (req, res) => {
  const keys = listApiKeys()
  res.json(keys)
})

router.delete('/:id', (req, res) => {
  const { id } = req.params
  const revoked = revokeApiKey(id)
  if (!revoked) {
    return res.status(404).json({ error: 'API key not found' })
  }
  res.json({ success: true })
})

export default router

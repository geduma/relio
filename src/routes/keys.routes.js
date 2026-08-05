import { Router } from 'express'
import { createApiKey, listApiKeys, revokeApiKey, updateApiKeyProviders } from '../services/authService.js'
import { dbGet, hashApiKey } from '../db.js'
import { invalidateModelsCache } from './proxy.routes.js'
const router = Router()

router.post('/', (req, res) => {
  const { name, providerIds } = req.body
  if (!name) {
    return res.status(400).json({ error: 'name is required' })
  }
  if (!Array.isArray(providerIds) || providerIds.length === 0) {
    return res.status(400).json({ error: 'providerIds array (non-empty) is required' })
  }

  let apiKey
  try {
    apiKey = createApiKey({ name, providerIds })
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message })
  }

  const row = dbGet(
    'SELECT id, key_prefix, name, created_at, last_used_at FROM api_keys WHERE key_hash = ?',
    [hashApiKey(apiKey)]
  )
  res.json({
    apiKey,
    key: row ? listApiKeys().find(k => k.id === row.id) : null,
    message: 'Save this key now. You won\'t be able to see it again.',
  })
})

router.get('/', (req, res) => {
  const keys = listApiKeys()
  res.json(keys)
})

router.patch('/:id', (req, res) => {
  const { providerIds } = req.body
  if (!Array.isArray(providerIds) || providerIds.length === 0) {
    return res.status(400).json({ error: 'providerIds array (non-empty) is required' })
  }

  try {
    const updated = updateApiKeyProviders(req.params.id, providerIds)
    invalidateModelsCache()
    res.json(updated)
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message })
  }
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

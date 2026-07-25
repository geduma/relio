import { Router } from 'express'
import { createApiKey, listApiKeys, revokeApiKey } from '../services/authService.js'
import { requireDashboardSession } from '../middleware/authMiddleware.js'

const router = Router()

router.use(requireDashboardSession)

router.post('/', (req, res) => {
  const { name } = req.body
  if (!name) {
    return res.status(400).json({ error: 'name is required' })
  }

  const apiKey = createApiKey(name)
  res.json({
    apiKey,
    message: 'Save this key now. You won\'t be able to see it again.',
  })
})

router.get('/', (req, res) => {
  const keys = listApiKeys()
  res.json(keys)
})

router.delete('/:keyPreview', (req, res) => {
  const { keyPreview } = req.params
  const revoked = revokeApiKey(keyPreview)
  if (!revoked) {
    return res.status(404).json({ error: 'API key not found or already revoked' })
  }
  res.json({ success: true })
})

export default router

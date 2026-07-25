import { Router } from 'express'
import { requireApiKey } from '../middleware/authMiddleware.js'
import { processRequest } from '../handlers/requestHandler.js'

const router = Router()

router.use(requireApiKey)

router.post('/chat/completions', async (req, res) => {
  try {
    const result = await processRequest({
      endpoint: '/v1/chat/completions',
      requestBody: req.body,
      originIp: req.ip,
      originHeader: req.headers['user-agent'],
      authenticatedVia: 'api_key',
      apiKey: req.apiKey,
    })
    res.status(result.statusCode).json(result.body)
  } catch (err) {
    res.status(503).json({ error: 'All providers failed', message: err.message })
  }
})

router.post('/embeddings', async (req, res) => {
  try {
    const result = await processRequest({
      endpoint: '/v1/embeddings',
      requestBody: req.body,
      originIp: req.ip,
      originHeader: req.headers['user-agent'],
      authenticatedVia: 'api_key',
      apiKey: req.apiKey,
    })
    res.status(result.statusCode).json(result.body)
  } catch (err) {
    res.status(503).json({ error: 'All providers failed', message: err.message })
  }
})

export default router

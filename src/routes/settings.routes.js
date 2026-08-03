import { Router } from 'express'
import { setSetting } from '../services/settingsService.js'
import { getRoutingStrategy, ROUTING_STRATEGIES, ROUTING_SETTING_KEY } from '../services/failoverEngine.js'

const router = Router()

router.get('/', (_req, res) => {
  res.json({ routingStrategy: getRoutingStrategy() })
})

router.put('/routing', (req, res) => {
  const { strategy } = req.body || {}
  if (!ROUTING_STRATEGIES.includes(strategy)) {
    return res.status(400).json({
      error: { message: `Invalid routing strategy "${strategy}". Allowed: ${ROUTING_STRATEGIES.join(', ')}`, type: 'invalid_request_error', code: 'invalid_routing_strategy' },
    })
  }
  setSetting(ROUTING_SETTING_KEY, strategy)
  res.json({ routingStrategy: strategy })
})

export default router

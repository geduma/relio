import { Router } from 'express'
import { getMetrics, getLogs, getHealth } from '../services/metricsLogger.js'

const router = Router()

function wrap(fn) {
  return (req, res, next) => {
    try { fn(req, res, next) } catch (err) { next(err) }
  }
}

router.get('/', wrap((req, res) => {
  const { from, to } = req.query
  const fromDate = from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const toDate = to || new Date().toISOString().slice(0, 10)

  const data = getMetrics(fromDate, toDate)
  res.json(data)
}))

router.get('/logs', wrap((req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 1000)
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0)

  res.json(getLogs(limit, offset))
}))

router.get('/health', wrap((req, res) => {
  const { healthy, cooldown, paused } = getHealth()
  res.json({
    status: healthy > 0 ? 'healthy' : 'unhealthy',
    providers_healthy: healthy,
    providers_cooldown: cooldown,
    providers_paused: paused,
  })
}))

export default router

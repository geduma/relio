import { Router } from 'express'
import { dbAll, dbGet } from '../db.js'
import { runHealthCheck, checkProviderNow } from '../services/healthCheck.js'

const router = Router()

function wrap(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

router.get('/', wrap((_req, res) => {
  const providers = dbAll(
    `SELECT h.provider_id, h.status AS check_status, h.http_status, h.error_code, h.error_type,
            h.error_message, h.latency_ms, h.previous_status, h.new_status, h.action_taken, h.checked_at,
            p.name AS provider_name, p.model, p.capability, p.status AS current_status,
            p.health_failures, p.cooldown_until, p.order_position
     FROM provider_health_checks h
     LEFT JOIN providers p ON p.id = h.provider_id
     ORDER BY CASE h.status WHEN 'error' THEN 0 ELSE 1 END, p.order_position ASC`
  )

  const summary = dbGet(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END), 0) AS ok,
            COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS error
     FROM provider_health_checks`
  ) || { total: 0, ok: 0, error: 0 }

  res.json({ providers, summary })
}))

router.post('/check', wrap(async (req, res) => {
  const { provider_id } = req.body || {}
  if (provider_id) {
    const result = await checkProviderNow(provider_id)
    res.json({ results: [result] })
    return
  }
  const results = await runHealthCheck()
  res.json({ results })
}))

export default router

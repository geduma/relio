import express from 'express'
import helmet from 'helmet'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import cookieParser from 'cookie-parser'
import crypto from 'crypto'
import path from 'path'
import cron from 'node-cron'
import { fileURLToPath } from 'url'
import { initDb } from './db.js'
import { runMaintenance, recoverCooldowns } from './maintenance.js'
import { requireDashboardSession } from './middleware/authMiddleware.js'
import { getSummary } from './handlers/dashboardHandler.js'
import { config } from './config.js'
import { logger, normalizeError } from './utils/logger.js'
import { startFlushTimer, flushAll } from './services/logQueue.js'
import { startCacheFlushTimer, flushCacheHits } from './services/cacheManager.js'

import authRoutes from './routes/auth.routes.js'
import providersRoutes from './routes/providers.routes.js'
import metricsRoutes from './routes/metrics.routes.js'
import keysRoutes from './routes/keys.routes.js'
import proxyRoutes from './routes/proxy.routes.js'
import chatRoutes from './routes/chat.routes.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()
const PORT = config.server.port
const HOST = config.server.host

app.set('trust proxy', config.auth?.trustedProxy ? 1 : false)
app.use(helmet({
  crossOriginOpenerPolicy: false,
  originAgentCluster: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'"],
      upgradeInsecureRequests: null,
    },
  },
}))
app.use(express.json({ limit: '10mb' }))
app.use(cookieParser())

const rateLimitError = (message) => ({
  error: { message, type: 'rate_limit_error', code: 'rate_limit' },
})

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: config.rateLimit.loginPer15Minutes,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitError('Too many attempts, try again later'),
})

const proxyKeyGenerator = (req) => {
  const auth = req.headers.authorization || ''
  const ip = ipKeyGenerator(req.ip || 'unknown')
  if (auth.startsWith('Bearer ')) {
    return crypto.createHash('sha256').update(auth.slice(7) + '|' + ip).digest('hex').slice(0, 32)
  }
  return `ip:${ip}`
}

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.rateLimit.proxyPerMinute,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: proxyKeyGenerator,
  message: rateLimitError('Too many requests, try again later'),
})

const dashboardLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.rateLimit.dashboardPerMinute,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitError('Too many requests, try again later'),
})

app.use('/admin/api/auth', authLimiter, authRoutes)
app.use('/v1', apiLimiter, proxyRoutes)

initDb()

cron.schedule('0 2 * * *', runMaintenance)
cron.schedule('0 * * * *', recoverCooldowns)

app.use('/admin/api/providers', dashboardLimiter, providersRoutes)
app.use('/admin/api/metrics', dashboardLimiter, metricsRoutes)
app.use('/admin/api/auth/api-keys', dashboardLimiter, keysRoutes)
app.use('/admin/api/chat', dashboardLimiter, chatRoutes)

app.get('/admin/api/summary', dashboardLimiter, requireDashboardSession, (req, res) => {
  const summary = getSummary()
  res.json(summary)
})

const frontendDist = path.join(__dirname, '../frontend/dist')
app.use(express.static(frontendDist))
app.get(['/admin', '/admin/*'], (_, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'))
})

app.use((err, _req, res, _next) => {
  logger.error('Unhandled error', { error: err.message })
  res.status(500).json(normalizeError(Object.assign(err, { status: 500, message: 'Internal server error' })))
})

app.use((_req, res) => {
  res.status(404).json({ error: { message: 'Not found', type: 'not_found_error', code: '404' } })
})

const server = app.listen(PORT, HOST, () => {
  startFlushTimer()
  startCacheFlushTimer()
  logger.info(`Relio running on http://${HOST}:${PORT}`)
})

function shutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully`)
  cron.getTasks().forEach(t => t.stop())
  flushCacheHits()
  flushAll()
  server.close(() => {
    logger.info('Server closed')
    process.exit(0)
  })
  setTimeout(() => process.exit(1), 5000)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack })
})
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { error: reason?.message || String(reason), stack: reason?.stack })
})

export default app

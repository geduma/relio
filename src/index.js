import express from 'express'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import cookieParser from 'cookie-parser'
import path from 'path'
import cron from 'node-cron'
import { fileURLToPath } from 'url'
import { initDb } from './db.js'
import { runMaintenance, recoverCooldowns } from './maintenance.js'
import { requireDashboardSession } from './middleware/authMiddleware.js'
import { getSummary } from './handlers/dashboardHandler.js'
import { config } from './config.js'
import { logger } from './utils/logger.js'
import { startFlushTimer, flushAll } from './services/logQueue.js'

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

app.set('trust proxy', 1)
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

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, try again later' },
})

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, try again later' },
})

const dashboardLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, try again later' },
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
  res.status(500).json({ error: 'Internal server error' })
})

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' })
})

const server = app.listen(PORT, HOST, () => {
  startFlushTimer()
  logger.info(`Relio running on http://${HOST}:${PORT}`)
})

function shutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully`)
  cron.getTasks().forEach(t => t.stop())
  flushAll()
  server.close(() => {
    logger.info('Server closed')
    process.exit(0)
  })
  setTimeout(() => process.exit(1), 5000)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

export default app

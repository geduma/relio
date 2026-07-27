import express from 'express'
import cookieParser from 'cookie-parser'
import path from 'path'
import cron from 'node-cron'
import { fileURLToPath } from 'url'
import { initDb } from './db.js'
import { runMaintenance } from './maintenance.js'
import { requireDashboardSession } from './middleware/authMiddleware.js'
import { getSummary } from './handlers/dashboardHandler.js'
import { config } from './config.js'
import { logger } from './utils/logger.js'

import authRoutes from './routes/auth.routes.js'
import providersRoutes from './routes/providers.routes.js'
import metricsRoutes from './routes/metrics.routes.js'
import keysRoutes from './routes/keys.routes.js'
import proxyRoutes from './routes/proxy.routes.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()
const PORT = config.server.port
const HOST = config.server.host

app.use(express.json())
app.use(cookieParser())

initDb()

cron.schedule('0 2 * * *', runMaintenance)

app.use('/admin/api/auth', authRoutes)
app.use('/admin/api/providers', providersRoutes)
app.use('/admin/api/metrics', metricsRoutes)
app.use('/admin/api/auth/api-keys', keysRoutes)
app.use('/v1', proxyRoutes)

app.get('/admin/api/summary', requireDashboardSession, (req, res) => {
  const summary = getSummary()
  res.json(summary)
})

const frontendDist = path.join(__dirname, '../frontend/dist')
app.use(express.static(frontendDist))
app.get('/admin/*', (_, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'))
})

app.use((err, _req, res, _next) => {
  logger.error('Unhandled error', { error: err.message })
  res.status(500).json({ error: 'Internal server error' })
})

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' })
})

app.listen(PORT, HOST, () => {
  logger.info(`Relio running on http://${HOST}:${PORT}`)
})

export default app

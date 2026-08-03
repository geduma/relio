import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import express from 'express'

let setDbPath, initDb, closeDb
let getSetting, setSetting, deleteSetting
let settingsRoutes

beforeAll(async () => {
  const dbMod = await import('../src/db.js')
  setDbPath = dbMod.setDbPath
  initDb = dbMod.initDb
  closeDb = dbMod.closeDb

  setDbPath(':memory:')
  initDb()

  const settingsMod = await import('../src/services/settingsService.js')
  getSetting = settingsMod.getSetting
  setSetting = settingsMod.setSetting
  deleteSetting = settingsMod.deleteSetting

  settingsRoutes = (await import('../src/routes/settings.routes.js')).default
})

afterAll(async () => {
  deleteSetting('routing_strategy')
  closeDb()
})

describe('settingsService', () => {
  it('returns null for an unknown key', () => {
    expect(getSetting('nope')).toBeNull()
  })

  it('persists and reads a value', () => {
    setSetting('routing_strategy', 'least-used')
    expect(getSetting('routing_strategy')).toBe('least-used')
    setSetting('routing_strategy', 'order')
    expect(getSetting('routing_strategy')).toBe('order')
  })

  it('deletes a value', () => {
    setSetting('routing_strategy', 'least-used')
    deleteSetting('routing_strategy')
    expect(getSetting('routing_strategy')).toBeNull()
  })
})

describe('settings routes', () => {
  let server
  let baseUrl

  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.use('/admin/api/settings', settingsRoutes)
    server = app.listen(0)
    await new Promise(r => server.once('listening', r))
    baseUrl = `http://localhost:${server.address().port}`
  })

  afterAll(async () => {
    if (server) await new Promise(r => server.close(r))
  })

  it('GET returns the current routing strategy (config default)', async () => {
    const res = await fetch(`${baseUrl}/admin/api/settings`)
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.routingStrategy).toBe('order')
  })

  it('PUT persists a valid strategy', async () => {
    const res = await fetch(`${baseUrl}/admin/api/settings/routing`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy: 'least-used' }),
    })
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.routingStrategy).toBe('least-used')
    expect(getSetting('routing_strategy')).toBe('least-used')

    const after = await fetch(`${baseUrl}/admin/api/settings`)
    expect((await after.json()).routingStrategy).toBe('least-used')

    setSetting('routing_strategy', 'order')
  })

  it('PUT rejects an invalid strategy', async () => {
    const res = await fetch(`${baseUrl}/admin/api/settings/routing`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy: 'round-robin' }),
    })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error.code).toBe('invalid_routing_strategy')
    expect(getSetting('routing_strategy')).not.toBe('round-robin')
  })
})

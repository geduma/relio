import { describe, it, expect } from 'vitest'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { config } from '../src/config.js'

describe('config', () => {
  it('loads with required defaults', () => {
    expect(typeof config.server.port).toBe('number')
    expect(typeof config.db.path).toBe('string')
    expect(typeof config.security.encryptionKey).toBe('string')
    expect(config.relay.requestTimeoutMs).toBeGreaterThan(0)
  })

  it('rejects the example placeholder encryption key', async () => {
    const tmpFile = join(tmpdir(), `relio-config-${Date.now()}.json`)
    writeFileSync(tmpFile, JSON.stringify({
      server: { port: 9999 },
      db: { path: ':memory:' },
      security: { encryptionKey: 'replace-with-a-random-64-char-hex-string' },
    }))
    process.env.CONFIG_PATH = tmpFile
    await expect(import('../src/config.js?case-placeholder')).rejects.toThrow(/placeholder|replace-with-a-random/i)
  })

  it('rejects a too-short encryption key', async () => {
    const tmpFile = join(tmpdir(), `relio-config-short-${Date.now()}.json`)
    writeFileSync(tmpFile, JSON.stringify({
      security: { encryptionKey: 'short' },
    }))
    process.env.CONFIG_PATH = tmpFile
    await expect(import('../src/config.js?case-short')).rejects.toThrow(/at least 32/i)
  })

  it('rejects when no config file exists and example placeholder applies', async () => {
    process.env.CONFIG_PATH = join(tmpdir(), 'does-not-exist-relio.json')
    await expect(import('../src/config.js?case-missing')).rejects.toThrow(/placeholder|replace-with-a-random/i)
  })
})

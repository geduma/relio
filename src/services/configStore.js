import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { getConfigPath } from '../config.js'

export function readConfigFile() {
  const raw = readFileSync(getConfigPath(), 'utf-8')
  return JSON.parse(raw)
}

function setByPath(obj, dottedKey, value) {
  const parts = dottedKey.split('.')
  let node = obj
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) {
      node[parts[i]] = {}
    }
    node = node[parts[i]]
  }
  node[parts[parts.length - 1]] = value
}

export function mergeConfigChanges(current, changes) {
  const next = JSON.parse(JSON.stringify(current))
  for (const [key, value] of Object.entries(changes)) {
    setByPath(next, key, value)
  }
  return next
}

export function saveConfigChanges(changes) {
  const path = getConfigPath()
  const current = readConfigFile()
  const next = mergeConfigChanges(current, changes)
  const serialized = `${JSON.stringify(next, null, 2)}\n`
  const tmpPath = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmpPath, serialized, 'utf-8')
    renameSync(tmpPath, path)
  } catch (err) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // ignore cleanup errors
    }
    throw new Error(
      `Failed to write configuration to ${path}: ${err.message}. ` +
        'Check file permissions. In Docker, config.json must live inside a writable mounted directory ' +
        '(see CONFIG_PATH) because atomic rename() fails over single-file bind mounts (EBUSY).'
    )
  }
  return next
}

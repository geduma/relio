import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const distIndex = join(root, 'frontend', 'dist', 'index.html')

if (existsSync(distIndex)) process.exit(0)

console.log('[prestart] frontend/dist missing — building frontend...')
const result = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
process.exit(result.status ?? 1)

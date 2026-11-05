#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const mainTs = join(__dirname, '..', 'src', 'cli', 'main.ts')

const res = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--no-warnings', mainTs, ...process.argv.slice(2)],
  { stdio: 'inherit' },
)

process.exit(res.status ?? 1)

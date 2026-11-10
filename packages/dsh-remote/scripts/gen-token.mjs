#!/usr/bin/env node
// Generate (or print) the dsh-remote bearer token.
// Default path: $DSH_HOME/remote/token (the path the plugin auto-creates).
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const target = resolve(process.argv[2] ?? join(home, 'remote', 'token'))

if (existsSync(target)) {
  process.stdout.write(readFileSync(target, 'utf8'))
  process.exit(0)
}

mkdirSync(dirname(target), { recursive: true })
const token = randomBytes(32).toString('hex')
writeFileSync(target, `${token}\n`, { flag: 'wx', mode: 0o600 })
process.stdout.write(`${token}\n`)

#!/usr/bin/env node
/**
 * Configure this Mac for the Cloudflare shared-memory backend.
 *
 * Writes only non-secret settings to `<memory-root>/cloud.json`. The bearer
 * token is read from the macOS Keychain and is never accepted on the command
 * line, written to a file, or printed.
 *
 * Usage:
 *   node scripts/cloud-setup.mjs --url https://<worker>.workers.dev --machine-id macbook-a
 *   node scripts/cloud-setup.mjs --check
 *   node scripts/cloud-setup.mjs --show
 */
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultMemoryRoot } from '../lib/projects.js'
import { cloudConfigPath, normalizeCloudUrl, readCloudConfig } from '../lib/config.js'
import { TokenProvider } from '../lib/backends/keychain.js'
import { CloudflareClient } from '../lib/backends/http.js'
import { createProxyFetch, normalizeProxyUrl } from '../lib/backends/proxy.js'

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    if (key === 'check' || key === 'show' || key === 'help') {
      args[key] = true
      continue
    }
    if (key === 'token') {
      throw new Error('refusing --token: never pass a secret on the command line. Use the macOS Keychain (see below).')
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for --${key}`)
    args[key] = value
    index += 1
  }
  return args
}

function usage() {
  return `dsh-project-memory cloud setup (run from the plugin root)

  node scripts/cloud-setup.mjs --url <https://worker> [--machine-id <id>]
  node scripts/cloud-setup.mjs --check     # verify Keychain token + Worker health
  node scripts/cloud-setup.mjs --show      # print the non-secret config

Optional: --root <memory-root> --keychain-service <service> --keychain-account <account>
          --backend <auto|cloudflare|local> --proxy http://127.0.0.1:15236

--proxy is for networks that block *.workers.dev: point it at a local HTTP
CONNECT proxy (Veee/Clash/Surge). It is stored per machine in cloud.json.

The token is read from the macOS Keychain:
  security add-generic-password -U -s dsh-project-memory -a cloudflare-token -w
`
}

function machineSlug(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

async function writeAtomic(file, text) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, text, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, file)
  await chmod(file, 0o600)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(usage())
    return 0
  }
  const root = args.root ? args.root : defaultMemoryRoot()
  const file = cloudConfigPath(root)
  const existing = await readCloudConfig(root)

  if (args.show) {
    const shown = { root, path: file, ...existing.value }
    if (typeof shown.proxy === 'string' && shown.proxy.includes('@')) {
      const url = new URL(shown.proxy)
      shown.proxy = `${url.protocol}//<redacted>@${url.host}`
    }
    process.stdout.write(`${JSON.stringify(shown, null, 2)}\n`)
    return 0
  }

  if (args.check) {
    const url = normalizeCloudUrl(args.url ?? existing.value.url ?? process.env.DSH_PROJECT_MEMORY_CLOUD_URL)
    if (!url) {
      process.stderr.write(`No Worker URL configured. Run: node scripts/cloud-setup.mjs --url https://<worker>\n`)
      return 2
    }
    const service = args['keychain-service'] ?? existing.value.keychainService ?? 'dsh-project-memory'
    const account = args['keychain-account'] ?? existing.value.keychainAccount ?? 'cloudflare-token'
    const provider = new TokenProvider({ service, account })
    const machineId = args['machine-id'] ?? existing.value.machineId ?? 'check'
    const proxy = normalizeProxyUrl(args.proxy) ?? normalizeProxyUrl(existing.value.proxy)
    if (args.proxy !== undefined && proxy === undefined) {
      process.stderr.write('Invalid --proxy; expected http://host:port\n')
      return 2
    }
    const client = new CloudflareClient({
      baseUrl: url,
      tokenProvider: provider,
      machineId,
      timeoutMs: 8_000,
      maxAttempts: 1,
      ...(proxy ? { fetchImpl: createProxyFetch(proxy, { timeoutMs: 15_000 }) } : {}),
    })
    const health = await client.health()
    process.stdout.write(`ok: ${url} responded ${JSON.stringify(health)}\n`)
    return 0
  }

  const url = normalizeCloudUrl(args.url)
  if (!url) {
    process.stderr.write(`A valid https Worker URL is required.\n\n${usage()}`)
    return 2
  }
  const machineId = String(
    args['machine-id'] ?? existing.value.machineId ?? `${machineSlug(hostname()) || 'mac'}-${randomUUID().slice(0, 4)}`,
  ).trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(machineId)) {
    process.stderr.write(`Invalid --machine-id "${machineId}"; use letters, digits, dot, underscore, dash (max 64).\n`)
    return 2
  }
  const backend = args.backend ?? existing.value.backend ?? 'cloudflare'
  const proxy = args.proxy !== undefined ? normalizeProxyUrl(args.proxy) : normalizeProxyUrl(existing.value.proxy)
  if (args.proxy !== undefined && proxy === undefined) {
    process.stderr.write('Invalid --proxy; expected http://host:port\n')
    return 2
  }
  const next = {
    ...existing.value,
    version: 1,
    backend,
    url,
    machineId,
    keychainService: args['keychain-service'] ?? existing.value.keychainService ?? 'dsh-project-memory',
    keychainAccount: args['keychain-account'] ?? existing.value.keychainAccount ?? 'cloudflare-token',
    ...(proxy ? { proxy } : {}),
  }
  await writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`)
  process.stdout.write(`wrote ${file}\n`)
  process.stdout.write(`backend=${backend} url=${url} machineId=${machineId}${proxy ? ` proxy=${proxy}` : ''}\n`)
  process.stdout.write(`\nNext:\n  1. security add-generic-password -U -s '${next.keychainService}' -a '${next.keychainAccount}' -w\n     (paste the same MEMORY_TOKEN that was set with: npx wrangler secret put MEMORY_TOKEN)\n  2. node scripts/cloud-setup.mjs --check\n  3. restart DSH (or reload the profile)\n`)
  return 0
}

main().then((code) => {
  process.exitCode = code
}).catch((error) => {
  process.stderr.write(`cloud setup failed: ${String(error?.message ?? error)}\n`)
  process.exitCode = 1
})

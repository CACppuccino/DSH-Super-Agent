import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cloudConfigPath, resolveBackendConfig } from '../lib/config.js'
import { tempDir } from './helpers.js'

const cleanEnv = {
  DSH_PROJECT_MEMORY_BACKEND: undefined,
  DSH_PROJECT_MEMORY_CLOUD_URL: undefined,
  DSH_PROJECT_MEMORY_MACHINE_ID: undefined,
  DSH_PROJECT_MEMORY_IDENTITY: undefined,
  DSH_PROJECT_MEMORY_TOKEN: undefined,
  DSH_PROJECT_MEMORY_KEYCHAIN_SERVICE: undefined,
  DSH_PROJECT_MEMORY_KEYCHAIN_ACCOUNT: undefined,
  DSH_PROJECT_MEMORY_CLOUD_WRITE_BUDGET_MS: undefined,
  DSH_PROJECT_MEMORY_CLOUD_PULL_BUDGET_MS: undefined,
}

function envWith(extra = {}) {
  return { ...cleanEnv, ...extra }
}

test('default config is local files with no cloud client', async () => {
  const root = join(await tempDir('pm-config-'), 'memory')
  const config = await resolveBackendConfig({}, { env: envWith(), rootDir: root })
  assert.equal(config.backend, 'local')
  assert.equal(config.requestedBackend, 'auto')
  assert.equal(config.rootDir, root)
  assert.equal(config.configError, undefined)
  assert.equal(config.cloudflare, undefined)
})

test('cloud.json selects cloudflare and env/plugin config override it', async () => {
  const root = join(await tempDir('pm-config-'), 'memory')
  await mkdir(root, { recursive: true })
  await writeFile(cloudConfigPath(root), JSON.stringify({
    version: 1,
    backend: 'cloudflare',
    url: 'https://file.example.workers.dev',
    machineId: 'file-mac',
    keychainService: 'file-service',
    keychainAccount: 'file-account',
  }))

  const fromFile = await resolveBackendConfig({}, { env: envWith(), rootDir: root })
  assert.equal(fromFile.backend, 'cloudflare')
  assert.equal(fromFile.cloudflare.url, 'https://file.example.workers.dev')
  assert.equal(fromFile.cloudflare.machineId, 'file-mac')
  assert.equal(fromFile.cloudflare.keychainService, 'file-service')
  assert.equal(fromFile.cloudflare.token, undefined, 'cloud.json cannot provide a token')

  const fromEnv = await resolveBackendConfig({}, {
    env: envWith({
      DSH_PROJECT_MEMORY_CLOUD_URL: 'https://env.example.workers.dev',
      DSH_PROJECT_MEMORY_MACHINE_ID: 'env-mac',
      DSH_PROJECT_MEMORY_TOKEN: 'env-token-value',
    }),
    rootDir: root,
  })
  assert.equal(fromEnv.cloudflare.url, 'https://env.example.workers.dev')
  assert.equal(fromEnv.cloudflare.machineId, 'env-mac')
  assert.equal(fromEnv.cloudflare.tokenSource, 'env')

  const fromPlugin = await resolveBackendConfig({
    backend: 'cloudflare',
    cloudflare: { url: 'https://plugin.example.workers.dev', machineId: 'plugin-mac', timeoutMs: 900 },
    autoSync: false,
  }, { env: envWith(), rootDir: root })
  assert.equal(fromPlugin.cloudflare.url, 'https://plugin.example.workers.dev')
  assert.equal(fromPlugin.cloudflare.machineId, 'plugin-mac')
  assert.equal(fromPlugin.cloudflare.timeoutMs, 900)
  assert.equal(fromPlugin.cloudflare.autoSync, false)

  const proxied = await resolveBackendConfig({
    backend: 'cloudflare',
    cloudflare: { url: 'https://ok.example.workers.dev', proxy: 'http://127.0.0.1:15236' },
  }, { env: envWith(), rootDir: root })
  assert.equal(proxied.cloudflare.proxy, 'http://127.0.0.1:15236')
})

test('write and pull budgets default to 6000/15000 ms and honor plugin, env and cloud.json overrides', async () => {
  const root = join(await tempDir('pm-config-'), 'memory')
  const url = 'https://ok.example.workers.dev'

  const defaults = await resolveBackendConfig(
    { backend: 'cloudflare', cloudflare: { url } },
    { env: envWith(), rootDir: root },
  )
  assert.equal(defaults.cloudflare.writeBudgetMs, 6_000, 'writes must outlast a slow-but-healthy Worker')
  assert.equal(defaults.cloudflare.pullBudgetMs, 15_000, 'pulls get an independent, longer budget')

  const fromPlugin = await resolveBackendConfig(
    { backend: 'cloudflare', cloudflare: { url, writeBudgetMs: 9_000, pullBudgetMs: 25_000 } },
    { env: envWith({ DSH_PROJECT_MEMORY_CLOUD_WRITE_BUDGET_MS: '7000', DSH_PROJECT_MEMORY_CLOUD_PULL_BUDGET_MS: '20000' }), rootDir: root },
  )
  assert.equal(fromPlugin.cloudflare.writeBudgetMs, 9_000, 'plugin config wins over env')
  assert.equal(fromPlugin.cloudflare.pullBudgetMs, 25_000)

  await mkdir(root, { recursive: true })
  await writeFile(cloudConfigPath(root), JSON.stringify({ writeBudgetMs: 8_000, pullBudgetMs: 30_000 }))
  const fromFile = await resolveBackendConfig(
    { backend: 'cloudflare', cloudflare: { url } },
    { env: envWith(), rootDir: root },
  )
  assert.equal(fromFile.cloudflare.writeBudgetMs, 8_000, 'cloud.json overrides the default')
  assert.equal(fromFile.cloudflare.pullBudgetMs, 30_000)

  const fromEnv = await resolveBackendConfig(
    { backend: 'cloudflare', cloudflare: { url } },
    {
      env: envWith({
        DSH_PROJECT_MEMORY_CLOUD_WRITE_BUDGET_MS: '11000',
        DSH_PROJECT_MEMORY_CLOUD_PULL_BUDGET_MS: '45000',
      }),
      rootDir: root,
    },
  )
  assert.equal(fromEnv.cloudflare.writeBudgetMs, 11_000, 'env overrides cloud.json')
  assert.equal(fromEnv.cloudflare.pullBudgetMs, 45_000)

  const clamped = await resolveBackendConfig(
    { backend: 'cloudflare', cloudflare: { url, writeBudgetMs: 10, pullBudgetMs: 10 } },
    { env: envWith(), rootDir: root },
  )
  assert.equal(clamped.cloudflare.writeBudgetMs, 500, 'writes stay within 500..30000 ms')
  assert.equal(clamped.cloudflare.pullBudgetMs, 1_000, 'pulls stay within 1000..120000 ms')

  const invalid = await resolveBackendConfig(
    { backend: 'cloudflare', cloudflare: { url, writeBudgetMs: 'soon', pullBudgetMs: 'later' } },
    { env: envWith(), rootDir: root },
  )
  assert.equal(invalid.cloudflare.writeBudgetMs, 6_000)
  assert.equal(invalid.cloudflare.pullBudgetMs, 15_000)
})

test('explicit local ignores a cloud.json', async () => {
  const root = join(await tempDir('pm-config-'), 'memory')
  await mkdir(root, { recursive: true })
  await writeFile(cloudConfigPath(root), JSON.stringify({ backend: 'cloudflare', url: 'https://x.example.workers.dev' }))
  const config = await resolveBackendConfig({ backend: 'local' }, { env: envWith(), rootDir: root })
  assert.equal(config.backend, 'local')
  assert.equal(config.cloudflare, undefined)
})

test('invalid URLs and incomplete cloud config produce actionable errors', async () => {
  const root = join(await tempDir('pm-config-'), 'memory')
  for (const url of ['http://example.com', 'ftp://example.com', 'https://user:pass@example.com', 'not a url']) {
    const config = await resolveBackendConfig({ backend: 'cloudflare', cloudflare: { url } }, { env: envWith(), rootDir: root })
    assert.equal(config.backend, 'cloudflare')
    assert.match(config.configError, /invalid cloud URL/)
  }
  const missing = await resolveBackendConfig({ backend: 'cloudflare' }, { env: envWith(), rootDir: root })
  assert.match(missing.configError, /no Worker URL is configured/)
  assert.match(missing.configError, /cloud-setup\.mjs/)

  const badProxy = await resolveBackendConfig({
    backend: 'cloudflare',
    cloudflare: { url: 'https://ok.example.workers.dev', proxy: 'socks5://127.0.0.1:1080' },
  }, { env: envWith(), rootDir: root })
  assert.match(badProxy.configError, /invalid proxy URL/)

  const badMachine = await resolveBackendConfig({
    backend: 'cloudflare',
    cloudflare: { url: 'https://ok.example.workers.dev', machineId: 'bad machine id!' },
  }, { env: envWith(), rootDir: root })
  assert.match(badMachine.configError, /invalid machineId/)
})

test('http is accepted only for localhost, https normalizes a trailing slash', async () => {
  const root = join(await tempDir('pm-config-'), 'memory')
  const local = await resolveBackendConfig({ backend: 'cloudflare', cloudflare: { url: 'http://127.0.0.1:8787/' } }, { env: envWith(), rootDir: root })
  assert.equal(local.cloudflare.url, 'http://127.0.0.1:8787')
  const https = await resolveBackendConfig({ backend: 'cloudflare', cloudflare: { url: 'https://memory.example.workers.dev///' } }, { env: envWith(), rootDir: root })
  assert.equal(https.cloudflare.url, 'https://memory.example.workers.dev')
})

test('a malformed cloud.json is reported but does not crash local mode', async () => {
  const root = join(await tempDir('pm-config-'), 'memory')
  await mkdir(root, { recursive: true })
  await writeFile(cloudConfigPath(root), '{oops')
  const local = await resolveBackendConfig({}, { env: envWith(), rootDir: root })
  assert.equal(local.backend, 'local')
  assert.equal(local.configFileLoaded, true)
  const cloud = await resolveBackendConfig({ backend: 'cloudflare', cloudflare: { url: 'https://ok.example.workers.dev' } }, { env: envWith(), rootDir: root })
  assert.equal(cloud.configError, undefined)
})

test('cloud.json is non-secret and written with 0600 by the setup script', async () => {
  const source = await readFile(new URL('../scripts/cloud-setup.mjs', import.meta.url), 'utf8')
  assert.match(source, /refusing --token/, 'the setup script must reject a token flag')
  assert.match(source, /chmod\(temporary, 0o600\)/)
})

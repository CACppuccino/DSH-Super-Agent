/**
 * Per-machine backend configuration.
 *
 * Precedence: plugin config > environment > `<root>/cloud.json` > defaults.
 * `cloud.json` never contains a secret; the bearer token comes from the macOS
 * Keychain (or DSH_PROJECT_MEMORY_TOKEN for headless use).
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { defaultMemoryRoot } from './projects.js'
import { normalizeProxyUrl } from './backends/proxy.js'

export const CLOUD_CONFIG_VERSION = 1
export const DEFAULT_KEYCHAIN_SERVICE = 'dsh-project-memory'
export const DEFAULT_KEYCHAIN_ACCOUNT = 'cloudflare-token'
export const BACKEND_CHOICES = Object.freeze(['auto', 'local', 'cloudflare'])

/** Path of the non-secret per-machine cloud config. */
export function cloudConfigPath(rootDir) {
  return join(rootDir, 'cloud.json')
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

function integer(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.floor(number)))
}

/** Validate and normalize the Worker base URL. */
export function normalizeCloudUrl(value) {
  const text = firstText(value)
  if (text === undefined) return undefined
  const withoutSlash = text.replace(/\/+$/, '')
  let url
  try {
    url = new URL(withoutSlash)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) return undefined
  if (url.username || url.password) return undefined
  if (url.pathname !== '/' && url.pathname.length > 1) return undefined
  return withoutSlash
}

/** Read `<root>/cloud.json`; a malformed file is reported, never fatal. */
export async function readCloudConfig(rootDir, { readFileFn = readFile, logger } = {}) {
  const path = cloudConfigPath(rootDir)
  try {
    const raw = JSON.parse(await readFileFn(path, 'utf8'))
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { path, exists: true, value: {}, error: 'cloud.json must be a JSON object' }
    }
    return { path, exists: true, value: raw }
  } catch (error) {
    if (error?.code === 'ENOENT') return { path, exists: false, value: {} }
    const message = `cloud.json is not valid JSON: ${String(error?.message ?? error)}`
    logger?.warn?.(`dsh-project-memory: ${message}`)
    return { path, exists: true, value: {}, error: message }
  }
}

/**
 * Resolve the effective backend configuration.
 * @param {Record<string, unknown>} raw plugin config from the bundle row
 * @param {{env?: NodeJS.ProcessEnv, rootDir?: string, logger?: {warn?: Function}, readFileFn?: Function}} [options]
 */
export async function resolveBackendConfig(raw = {}, { env = process.env, rootDir, logger, readFileFn } = {}) {
  const root = rootDir ?? defaultMemoryRoot(env, env.HOME ?? homedir())
  const file = await readCloudConfig(root, { readFileFn, logger })
  const value = file.value
  const rawCloud = raw && typeof raw.cloudflare === 'object' && raw.cloudflare !== null ? raw.cloudflare : {}

  const requestedBackend = firstText(
    raw.backend,
    env.DSH_PROJECT_MEMORY_BACKEND,
    value.backend,
  ) ?? 'auto'
  if (!BACKEND_CHOICES.includes(requestedBackend)) {
    return {
      backend: 'local',
      requestedBackend,
      rootDir: root,
      configFile: file.path,
      configFileLoaded: file.exists,
      configError: `invalid backend "${requestedBackend}"; expected one of ${BACKEND_CHOICES.join(', ')}`,
      cloudflare: undefined,
    }
  }

  const url = normalizeCloudUrl(firstText(
    rawCloud.url,
    env.DSH_PROJECT_MEMORY_CLOUD_URL,
    value.url,
  ))
  const rawUrl = firstText(rawCloud.url, env.DSH_PROJECT_MEMORY_CLOUD_URL, value.url)
  const machineId = firstText(
    rawCloud.machineId,
    env.DSH_PROJECT_MEMORY_MACHINE_ID,
    value.machineId,
  )
  const identity = firstText(
    rawCloud.identity,
    env.DSH_PROJECT_MEMORY_IDENTITY,
    value.identity,
  )
  const keychainService = firstText(
    rawCloud.keychainService,
    env.DSH_PROJECT_MEMORY_KEYCHAIN_SERVICE,
    value.keychainService,
    DEFAULT_KEYCHAIN_SERVICE,
  )
  const keychainAccount = firstText(
    rawCloud.keychainAccount,
    env.DSH_PROJECT_MEMORY_KEYCHAIN_ACCOUNT,
    value.keychainAccount,
    DEFAULT_KEYCHAIN_ACCOUNT,
  )
  const rawProxy = firstText(rawCloud.proxy, env.DSH_PROJECT_MEMORY_PROXY, value.proxy)
  const proxy = normalizeProxyUrl(rawProxy)
  const envToken = firstText(env.DSH_PROJECT_MEMORY_TOKEN)
  const cloudflare = {
    url,
    machineId,
    identity,
    keychainService,
    keychainAccount,
    proxy,
    token: envToken,
    tokenSource: envToken ? 'env' : 'keychain',
    timeoutMs: integer(rawCloud.timeoutMs ?? env.DSH_PROJECT_MEMORY_CLOUD_TIMEOUT_MS ?? value.timeoutMs, 2_500, { min: 500, max: 15_000 }),
    maxAttempts: integer(rawCloud.maxAttempts ?? value.maxAttempts, 3, { min: 1, max: 5 }),
    pullIntervalMs: integer(rawCloud.pullIntervalMs ?? value.pullIntervalMs, 5_000, { min: 0, max: 600_000 }),
    offlineBackoffMs: integer(rawCloud.offlineBackoffMs ?? value.offlineBackoffMs, 15_000, { min: 1_000, max: 300_000 }),
    staleAfterMs: integer(rawCloud.staleAfterMs ?? value.staleAfterMs, 60_000, { min: 5_000, max: 86_400_000 }),
    autoSync: raw.autoSync !== false && env.DSH_PROJECT_MEMORY_AUTO_SYNC !== '0' && value.autoSync !== false,
    autoSyncIntervalMs: integer(rawCloud.autoSyncIntervalMs ?? value.autoSyncIntervalMs, 30_000, { min: 5_000, max: 600_000 }),
    syncBudgetMs: integer(rawCloud.syncBudgetMs ?? value.syncBudgetMs, 4_000, { min: 500, max: 20_000 }),
    userAgent: 'dsh-project-memory/0.2 (+cloudflare)',
  }

  let backend = 'local'
  let configError
  if (requestedBackend === 'cloudflare' || (requestedBackend === 'auto' && rawUrl !== undefined)) {
    backend = 'cloudflare'
    if (machineId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(machineId)) {
      configError = `invalid machineId ${JSON.stringify(machineId)}; use letters, digits, ".", "_" or "-" (max 64)`
    } else if (rawProxy !== undefined && !proxy) {
      configError = `invalid proxy URL ${JSON.stringify(rawProxy)}; expected http://host:port (https proxies and paths are not supported)`
    } else if (!url) {
      configError = rawUrl
        ? `invalid cloud URL "${rawUrl}"; use an https:// Worker URL (http:// is allowed only for localhost)`
        : 'backend=cloudflare but no Worker URL is configured; set DSH_PROJECT_MEMORY_CLOUD_URL, add cloudflare.url to the plugin config, or run `node scripts/cloud-setup.mjs --url <url> --machine-id <id>`'
    } else if (file.error && !firstText(rawCloud.url, env.DSH_PROJECT_MEMORY_CLOUD_URL)) {
      configError = `${file.error} (${file.path}); fix it or set DSH_PROJECT_MEMORY_CLOUD_URL`
    }
  }

  return {
    backend,
    requestedBackend,
    rootDir: root,
    configFile: file.path,
    configFileLoaded: file.exists,
    ...(configError ? { configError } : {}),
    cloudflare: backend === 'cloudflare' ? cloudflare : undefined,
  }
}

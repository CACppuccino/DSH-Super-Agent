/** Backend factory: local files (default) or Cloudflare shared memory. */
import { LocalFileBackend } from './local.js'
import { CloudflareBackend } from './cloudflare.js'

/**
 * @param {{
 *   config: Awaited<ReturnType<typeof import('../config.js').resolveBackendConfig>>,
 *   logger?: {info?: Function, warn?: Function, error?: Function},
 *   clock?: () => number,
 *   fetchImpl?: typeof fetch,
 *   execFileImpl?: Function,
 *   tokenProvider?: {get: Function, invalidate?: Function},
 *   autoSync?: boolean,
 * }} options
 */
export async function createBackend({
  config,
  logger,
  clock,
  fetchImpl,
  execFileImpl,
  tokenProvider,
  autoSync,
} = {}) {
  if (!config || typeof config.rootDir !== 'string') throw new Error('backend config with rootDir is required')
  if (config.backend === 'cloudflare') {
    return new CloudflareBackend({
      rootDir: config.rootDir,
      cloud: { ...config.cloudflare, configError: config.configError },
      logger,
      clock,
      fetchImpl,
      execFileImpl,
      tokenProvider,
      autoSync,
    })
  }
  return new LocalFileBackend({ rootDir: config.rootDir, clock })
}

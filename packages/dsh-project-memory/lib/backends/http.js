/**
 * Tiny Cloudflare Worker HTTP client: short timeouts, bounded retries with
 * jittered exponential backoff, and retry-safe idempotency (callers put note
 * ids / clientOpId in the body).
 */
import { CloudError } from './errors.js'

const DEFAULT_TIMEOUT_MS = 2_500
const MAX_ATTEMPTS = 3
const BACKOFF_BASE_MS = 250
const MAX_BACKOFF_MS = 2_000
const MAX_RETRY_AFTER_MS = 5_000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isAbort(error) {
  return error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.code === 'ABORT_ERR'
}

/** Map a Worker JSON error body to an actionable code. */
function errorCodeOf(payload) {
  return typeof payload?.error?.code === 'string' ? payload.error.code : undefined
}

function messageOf(payload, fallback) {
  const message = payload?.error?.message
  return typeof message === 'string' && message.length > 0 ? message : fallback
}

function classifyStatus(status, payload) {
  const code = errorCodeOf(payload)
  if (status === 401 || status === 403) {
    return new CloudError('auth', messageOf(payload, `authentication failed (HTTP ${status})`), { status, code, retriable: false })
  }
  if (status === 404) {
    return new CloudError('not-found', messageOf(payload, 'not found'), { status, code, retriable: false })
  }
  if (status === 409) {
    return new CloudError('conflict', messageOf(payload, 'conflict'), { status, code, retriable: false })
  }
  if (status === 429) {
    return new CloudError('rate-limit', messageOf(payload, 'rate limited'), { status, code, retriable: true })
  }
  if (status >= 500) {
    return new CloudError('server', messageOf(payload, `server error (HTTP ${status})`), { status, code, retriable: true })
  }
  return new CloudError('client', messageOf(payload, `request rejected (HTTP ${status})`), { status, code, retriable: false })
}

export class CloudflareClient {
  /**
   * @param {{
   *   baseUrl: string,
   *   tokenProvider: {get: (options?: {force?: boolean}) => Promise<string>, invalidate?: () => void},
   *   machineId?: string,
   *   fetchImpl?: typeof fetch,
   *   clock?: () => number,
   *   timeoutMs?: number,
   *   maxAttempts?: number,
   *   backoffBaseMs?: number,
   *   maxBackoffMs?: number,
   *   sleepImpl?: (ms: number) => Promise<void>,
   *   random?: () => number,
   *   userAgent?: string,
   * }} options
   */
  constructor({
    baseUrl,
    tokenProvider,
    machineId,
    fetchImpl = globalThis.fetch,
    clock = Date.now,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxAttempts = MAX_ATTEMPTS,
    backoffBaseMs = BACKOFF_BASE_MS,
    maxBackoffMs = MAX_BACKOFF_MS,
    sleepImpl = sleep,
    random = Math.random,
    userAgent = 'dsh-project-memory',
  }) {
    if (typeof baseUrl !== 'string' || baseUrl.length === 0) throw new Error('baseUrl is required')
    if (typeof fetchImpl !== 'function') throw new Error('fetch is required')
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.tokenProvider = tokenProvider
    this.machineId = machineId
    this.fetchImpl = fetchImpl
    this.clock = clock
    this.timeoutMs = timeoutMs
    this.maxAttempts = Math.max(1, maxAttempts)
    this.backoffBaseMs = backoffBaseMs
    this.maxBackoffMs = maxBackoffMs
    this.sleepImpl = sleepImpl
    this.random = random
    this.userAgent = userAgent
  }

  url(path) {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
  }

  headers(token) {
    return {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': this.userAgent,
      ...(this.machineId ? { 'x-machine-id': this.machineId } : {}),
    }
  }

  /**
   * Perform one API call with retries.
   * @param {'GET'|'POST'|'PUT'} method
   * @param {string} path
   * @param {{body?: unknown, timeoutMs?: number, signal?: AbortSignal, attempts?: number}} [options]
   */
  async request(method, path, { body, timeoutMs, signal, attempts } = {}) {
    const totalAttempts = Math.max(1, attempts ?? this.maxAttempts)
    let forceToken = false
    let authRetryUsed = false
    let lastError
    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      let token
      try {
        token = await this.tokenProvider.get({ force: forceToken })
      } catch (error) {
        throw asCloudError(error, 'config')
      }
      forceToken = false
      const effectiveTimeout = Math.max(100, timeoutMs ?? this.timeoutMs)
      const timeoutSignal = AbortSignal.timeout(effectiveTimeout)
      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
      let response
      try {
        response = await this.fetchImpl(this.url(path), {
          method,
          headers: this.headers(token),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: requestSignal,
        })
      } catch (error) {
        if (isAbort(error)) {
          lastError = new CloudError('timeout', `${method} ${path} timed out after ${effectiveTimeout} ms`, {
            retriable: true,
            cause: error,
          })
          if (signal?.aborted) throw new CloudError('timeout', `${method} ${path} aborted: overall sync budget exhausted`, { retriable: true, cause: error })
        } else {
          lastError = new CloudError('network', `${method} ${path} failed: ${String(error?.message ?? error).slice(0, 300)}`, {
            retriable: true,
            cause: error,
          })
        }
        if (attempt >= totalAttempts) throw lastError
        await this.backoff(attempt, undefined, signal)
        continue
      }

      const payload = await readJson(response)
      if (response.ok) return payload

      const classified = classifyStatus(response.status, payload)
      if (response.status === 401 || response.status === 403) {
        if (!authRetryUsed) {
          authRetryUsed = true
          if (!forceToken && typeof this.tokenProvider.invalidate === 'function') this.tokenProvider.invalidate()
          forceToken = true
          lastError = classified
          continue
        }
        throw classified
      }
      if (!classified.retriable || attempt >= totalAttempts) throw classified
      lastError = classified
      await this.backoff(attempt, retryAfterMs(response), signal)
    }
    throw lastError ?? new CloudError('network', `${method} ${path} failed`)
  }

  async backoff(attempt, retryAfterMs, signal) {
    const exponential = Math.min(this.maxBackoffMs, this.backoffBaseMs * 2 ** (attempt - 1))
    const jitter = 0.5 + this.random() * 0.5
    const delay = Math.min(
      MAX_BACKOFF_MS,
      Math.max(0, Math.round(retryAfterMs ?? exponential * jitter)),
    )
    if (signal?.aborted) throw new CloudError('timeout', 'overall sync budget exhausted before retry', { retriable: true })
    await this.sleepImpl(delay)
  }

  async health() {
    return this.request('GET', '/v1/health')
  }
}

async function readJson(response) {
  const text = await response.text()
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return { error: { code: 'invalid_json', message: text.slice(0, 200) } }
  }
}

function retryAfterMs(response) {
  const header = typeof response.headers?.get === 'function' ? response.headers.get('retry-after') : undefined
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_RETRY_AFTER_MS, seconds * 1_000)
  return undefined
}

function asCloudError(error, fallbackKind) {
  if (error instanceof CloudError) return error
  const kind = typeof error?.kind === 'string' ? error.kind : fallbackKind
  return new CloudError(kind, String(error?.message ?? error).slice(0, 500), {
    retriable: error?.retriable === true,
    cause: error,
  })
}

export { classifyStatus }

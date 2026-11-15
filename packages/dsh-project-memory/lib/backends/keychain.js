/**
 * Bearer-token retrieval. The secret lives in the macOS Keychain, never in a
 * file, a command-line argument, a log line, or a tool result.
 */
import { execFile } from 'node:child_process'

/** Minimum plausible token length; shorter values are almost certainly typos. */
const MIN_TOKEN_LENGTH = 8

export class TokenProvider {
  /**
   * @param {{
   *   service: string,
   *   account: string,
   *   envToken?: string,
   *   execFileImpl?: typeof execFile,
   *   platform?: NodeJS.Platform,
   *   clock?: () => number,
   *   failureCooldownMs?: number,
   * }} options
   */
  constructor({
    service,
    account,
    envToken,
    execFileImpl = execFile,
    platform = process.platform,
    clock = Date.now,
    failureCooldownMs = 30_000,
  }) {
    this.service = service
    this.account = account
    this.envToken = typeof envToken === 'string' && envToken.trim().length > 0 ? envToken.trim() : undefined
    this.execFileImpl = execFileImpl
    this.platform = platform
    this.clock = clock
    this.failureCooldownMs = failureCooldownMs
    this.cached = undefined
    this.lastFailure = undefined
  }

  get source() {
    return this.envToken ? 'env' : 'keychain'
  }

  /** The exact command the user must run; contains no secret. */
  commandHint() {
    return `security add-generic-password -U -s '${this.service}' -a '${this.account}' -w`
  }

  /** Drop the in-memory copy (used after a 401 so a rotated token is re-read). */
  invalidate() {
    this.cached = undefined
    this.lastFailure = undefined
  }

  /**
   * Read the shared bearer token.
   * @param {{force?: boolean}} [options]
   * @returns {Promise<string>}
   */
  async get({ force = false } = {}) {
    if (this.envToken) return this.envToken
    if (!force && this.cached) return this.cached
    if (!force && this.lastFailure !== undefined && this.clock() - this.lastFailure.at < this.failureCooldownMs) {
      throw this.lastFailure.error
    }
    try {
      const token = await this.readKeychain()
      this.cached = token
      this.lastFailure = undefined
      return token
    } catch (error) {
      this.lastFailure = { at: this.clock(), error }
      throw error
    }
  }

  readKeychain() {
    return new Promise((resolve, reject) => {
      if (this.platform !== 'darwin') {
        reject(configError(
          `the macOS Keychain is not available on ${this.platform}; set DSH_PROJECT_MEMORY_TOKEN instead`,
        ))
        return
      }
      let settled = false
      const done = (fn, value) => {
        if (settled) return
        settled = true
        fn(value)
      }
      try {
        this.execFileImpl(
          'security',
          ['find-generic-password', '-s', this.service, '-a', this.account, '-w'],
          { timeout: 3_000, maxBuffer: 64 * 1024 },
          (error, stdout) => {
            if (error) {
              done(reject, configError(
                `no bearer token in the macOS Keychain (service "${this.service}", account "${this.account}"). Create it once with: ${this.commandHint()}`,
                error,
              ))
              return
            }
            const token = String(stdout ?? '').trim()
            if (token.length < MIN_TOKEN_LENGTH || /[\u0000-\u001f\u007f]/.test(token)) {
              done(reject, configError(
                `the Keychain item ${this.service}/${this.account} does not contain a usable bearer token; re-create it with: ${this.commandHint()}`,
              ))
              return
            }
            done(resolve, token)
          },
        )
      } catch (error) {
        done(reject, configError(`could not run the macOS security command: ${String(error?.message ?? error)}`, error))
      }
    })
  }
}

function configError(message, cause) {
  const error = new Error(message)
  error.name = 'CloudConfigError'
  error.kind = 'config'
  error.retriable = false
  if (cause !== undefined) error.cause = cause
  return error
}

/** Parse a `security` command output for tests. */
export function parseKeychainOutput(stdout) {
  return String(stdout ?? '').replace(/\r?\n$/, '')
}

/** Errors raised by the cloud sync boundary. */
export class CloudError extends Error {
  /**
   * @param {'config'|'auth'|'network'|'timeout'|'rate-limit'|'server'|'client'|'not-found'|'conflict'} kind
   * @param {string} message
   * @param {{status?: number, code?: string, retriable?: boolean, retryAfterMs?: number, cause?: unknown}} [options]
   */
  constructor(kind, message, { status, code, retriable = false, retryAfterMs, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'CloudError'
    this.kind = kind
    this.status = status
    this.code = code
    this.retriable = retriable
    this.retryAfterMs = retryAfterMs
  }

  toJSON() {
    return {
      kind: this.kind,
      message: this.message,
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.code === undefined ? {} : { code: this.code }),
    }
  }
}

/** A short, secret-free description for sync status and logs. */
export function describeCloudError(error) {
  if (error instanceof CloudError) {
    return { kind: error.kind, message: error.message, ...(error.status === undefined ? {} : { status: error.status }) }
  }
  return { kind: 'internal', message: String(error?.message ?? error).slice(0, 500) }
}

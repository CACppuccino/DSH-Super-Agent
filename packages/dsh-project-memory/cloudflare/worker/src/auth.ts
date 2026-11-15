import type { Env } from './types.ts'
import { errorJson } from './http.ts'

const encoder = new TextEncoder()
const BEARER_RE = /^Bearer\s+(.+)$/i

/** SHA-256 of a UTF-8 string as raw bytes. */
async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return new Uint8Array(digest)
}

/**
 * Constant-time comparison of two secrets.
 *
 * Both sides are hashed first so the loop always runs over 32 bytes and the
 * comparison does not leak the token length. The XOR accumulator never
 * short-circuits.
 */
export async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(left), sha256(right)])
  let difference = 0
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index]
  return difference === 0
}

/**
 * Authorise one request.
 *
 * Returns a ready 401/500 response when the request may not proceed, or null
 * when the bearer token matched. The configured token is never logged.
 */
export async function authorize(request: Request, env: Env): Promise<Response | null> {
  const configured = typeof env.MEMORY_TOKEN === 'string' ? env.MEMORY_TOKEN : ''
  if (configured.trim().length === 0) {
    return errorJson(500, 'config_error', 'MEMORY_TOKEN is not configured on the worker')
  }

  const header = request.headers.get('Authorization')
  const match = header === null ? null : BEARER_RE.exec(header)
  if (match === null) {
    return errorJson(401, 'unauthorized', 'missing or invalid bearer token')
  }

  const presented = match[1]
  const valid = await constantTimeEqual(presented, configured)
  if (!valid) return errorJson(401, 'unauthorized', 'missing or invalid bearer token')
  return null
}

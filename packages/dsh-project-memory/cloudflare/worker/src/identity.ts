import { HttpError } from './errors.ts'

/** Allowed project identity forms: `git:<owner>/<repo>` or `title:<slug>`. */
export const IDENTITY_RE = /^(git|title):[a-z0-9\u4e00-\u9fff][a-z0-9\u4e00-\u9fff._/-]{0,200}$/

/** Per-machine attribution id sent as `X-Machine-Id`. */
export const MACHINE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const IDENTITY_SOURCES = new Set(['git', 'title', 'config'])

export function assertIdentity(value: unknown): string {
  if (typeof value !== 'string' || !IDENTITY_RE.test(value)) {
    throw new HttpError(
      400,
      'identity_invalid',
      'identity must look like "git:github.com/owner/repo" or "title:project-name"',
    )
  }
  return value
}

/** Default identity source inferred from the identity prefix. */
export function identitySourceFor(identity: string): string {
  return identity.startsWith('git:') ? 'git' : 'title'
}

export function assertIdentitySource(value: unknown, identity: string): string {
  if (value === undefined) return identitySourceFor(identity)
  if (typeof value !== 'string' || !IDENTITY_SOURCES.has(value)) {
    throw new HttpError(400, 'identity_source_invalid', 'identitySource must be one of git, title, config')
  }
  return value
}

/**
 * Derive the stable project id from an identity:
 * `<slug>-<sha256(identity)[:10]>`.
 *
 * The slug is the tail after the last `/` or `:`, lowercased, reduced to
 * `[a-z0-9-]`, trimmed and capped at 32 characters (fallback `project`).
 */
export async function projectIdFor(identity: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity))
  const bytes = new Uint8Array(digest)
  let hash = ''
  for (const byte of bytes) hash += byte.toString(16).padStart(2, '0')
  return `${slugFor(identity)}-${hash.slice(0, 10)}`
}

export function slugFor(identity: string): string {
  const parts = identity.split(/[/:]/)
  const tail = parts.length > 0 ? parts[parts.length - 1] : ''
  const slug = tail
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : 'project'
}

/**
 * Resolve the write attribution machine id.
 *
 * The `X-Machine-Id` header wins. `machineId` in the JSON body is accepted
 * only when the header is absent (project registration). Both a missing and a
 * malformed value are rejected.
 */
export function resolveMachineId(request: Request, body?: Record<string, unknown>): string {
  const header = request.headers.get('X-Machine-Id')
  let value: unknown = header

  if ((header === null || header.length === 0) && body !== undefined && body.machineId !== undefined) {
    value = body.machineId
  }

  if (value === undefined || value === null || value === '') {
    throw new HttpError(400, 'machine_id_required', 'X-Machine-Id is required for write requests')
  }
  if (typeof value !== 'string' || !MACHINE_ID_RE.test(value)) {
    throw new HttpError(
      400,
      'machine_id_invalid',
      'X-Machine-Id must start with a letter or digit and contain only letters, digits, ".", "_" or "-" (max 64)',
    )
  }
  return value
}

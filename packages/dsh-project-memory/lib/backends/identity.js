/**
 * Project identity shared by both Macs.
 *
 * The absolute path is only a hint: the same repo may be checked out at
 * different paths. Identity prefers the git remote URL, then a normalized
 * title, with an explicit configuration override for unusual layouts.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'

/** How long a cached identity is trusted before the git remote is re-read. */
export const IDENTITY_MAX_AGE_MS = 6 * 60 * 60 * 1000

/** Valid cloud identities: `git:<host/path>` or `title:<slug>`. */
export const IDENTITY_PATTERN = /^(git|title):[a-z0-9\u4e00-\u9fff][a-z0-9\u4e00-\u9fff._/-]{0,200}$/

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Normalize a git remote URL so every spelling of one remote matches:
 * `git@github.com:Foo/Bar.git`, `ssh://git@github.com/Foo/Bar` and
 * `https://github.com/Foo/Bar.git` all become `github.com/foo/bar`.
 * @param {string} value
 * @returns {string|undefined}
 */
export function normalizeGitRemote(value) {
  const raw = textOf(value)
  if (raw.length === 0) return undefined
  let host = ''
  let path = ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const url = new URL(raw)
      host = url.hostname.toLowerCase()
      path = decodeURIComponent(url.pathname)
    } catch {
      return undefined
    }
  } else {
    // scp-like syntax: `[user@]host:path` (but not `C:\...`, never relevant on macOS).
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(raw)
    if (scp) {
      host = scp[1].toLowerCase()
      path = scp[2]
    } else {
      path = raw
    }
  }
  path = path
    .replace(/^[/\\]+/, '')
    .replace(/[/\\]+$/, '')
    .replace(/\.git$/i, '')
    .replace(/[/\\]+/g, '/')
    .toLowerCase()
  if (path.length === 0) return undefined
  return host.length > 0 ? `${host}/${path}` : path
}

/**
 * Normalize a project title into the fallback identity slug. Unicode letters
 * (for example Chinese project names) are preserved.
 * @param {string} value
 * @returns {string}
 */
export function normalizeProjectTitle(value) {
  const text = String(value ?? '').normalize('NFKC').toLowerCase().trim()
  const slug = text
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fff-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return slug.length > 0 ? slug : 'untitled'
}

/**
 * Normalize an explicitly configured identity. A bare value is treated as a
 * title slug unless it looks like a remote URL/host path.
 * @param {string} value
 * @returns {{identity: string, identitySource: 'config'}|undefined}
 */
export function normalizeConfiguredIdentity(value) {
  const raw = textOf(value)
  if (raw.length === 0) return undefined
  if (raw.startsWith('title:')) {
    return { identity: `title:${normalizeProjectTitle(raw.slice(6))}`, identitySource: 'config' }
  }
  if (raw.startsWith('git:')) {
    const normalized = normalizeGitRemote(raw.slice(4))
    return normalized ? { identity: `git:${normalized}`, identitySource: 'config' } : undefined
  }
  const looksLikeRemote = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    || /^(?:[^@/\s]+@)?[^:/\s]+:.+/.test(raw)
    || /^[a-z0-9.-]+\.[a-z]{2,}\//i.test(raw)
    || /\.git$/i.test(raw)
  if (looksLikeRemote) {
    const normalized = normalizeGitRemote(raw)
    if (normalized) return { identity: `git:${normalized}`, identitySource: 'config' }
  }
  return { identity: `title:${normalizeProjectTitle(raw)}`, identitySource: 'config' }
}

/**
 * Derive the identity metadata for one project.
 * @param {{gitRemote?: string, title?: string, path?: string, override?: string}} options
 */
export function identityForProject({ gitRemote, title, path, override } = {}) {
  const configured = normalizeConfiguredIdentity(override)
  if (configured) {
    return { identity: configured.identity, identitySource: 'config', gitRemote: textOf(gitRemote) || null }
  }
  const normalizedRemote = normalizeGitRemote(gitRemote)
  if (normalizedRemote) {
    return { identity: `git:${normalizedRemote}`, identitySource: 'git', gitRemote: textOf(gitRemote) }
  }
  const normalizedTitle = normalizeProjectTitle(title || basename(String(path ?? '')))
  return { identity: `title:${normalizedTitle}`, identitySource: 'title', gitRemote: null }
}

/** True when a project record already has a fresh, usable identity. */
export function identityIsFresh(record, { now = Date.now(), maxAgeMs = IDENTITY_MAX_AGE_MS } = {}) {
  if (!record || typeof record.identity !== 'string' || !IDENTITY_PATTERN.test(record.identity)) return false
  if (record.identitySource === 'config') return true
  if (!Number.isFinite(record.identityCheckedAt)) return false
  return now - record.identityCheckedAt < maxAgeMs
}

/**
 * Read `origin` (or the first remote) from a checkout with a short timeout.
 * Returns undefined for a non-git path, a missing git binary, or a timeout.
 * @param {string} path
 * @param {{execFileImpl?: typeof execFile, timeoutMs?: number}} [options]
 * @returns {Promise<string|undefined>}
 */
export async function readGitRemote(path, { execFileImpl = execFile, timeoutMs = 1_500 } = {}) {
  const target = String(path ?? '').trim()
  if (target.length === 0) return undefined
  const run = (args) => new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      execFileImpl('git', args, { timeout: timeoutMs, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
        done(error ? undefined : String(stdout ?? '').trim())
      })
    } catch {
      done(undefined)
    }
  })
  const origin = await run(['-C', target, 'remote', 'get-url', 'origin'])
  if (origin) return origin
  const listing = await run(['-C', target, 'remote'])
  const first = String(listing ?? '').split('\n').map((line) => line.trim()).find(Boolean)
  if (!first) return undefined
  return run(['-C', target, 'remote', 'get-url', first])
}

/**
 * Resolve (and cache) one project's identity. A cached identity is reused for
 * `maxAgeMs`, so a repo that gains a remote is picked up on the next window or
 * when `DSH_PROJECT_MEMORY_REFRESH_IDENTITY=1` is set.
 * @param {{
 *   path: string,
 *   title?: string,
 *   override?: string,
 *   record?: Record<string, unknown>,
 *   now?: number,
 *   maxAgeMs?: number,
 *   execFileImpl?: typeof execFile,
 * }} options
 */
export async function resolveProjectIdentity({
  path,
  title,
  override,
  record,
  now = Date.now(),
  maxAgeMs = IDENTITY_MAX_AGE_MS,
  execFileImpl,
} = {}) {
  const configured = normalizeConfiguredIdentity(override)
  if (configured) {
    return {
      identity: configured.identity,
      identitySource: 'config',
      gitRemote: record?.gitRemote ?? null,
      identityCheckedAt: now,
    }
  }
  if (record?.remote === true && typeof record.identity === 'string' && record.identity.length > 0) {
    return {
      identity: record.identity,
      identitySource: record.identitySource,
      gitRemote: record.gitRemote ?? null,
      identityCheckedAt: record.identityCheckedAt ?? now,
    }
  }
  if (identityIsFresh(record, { now, maxAgeMs })) {
    return {
      identity: record.identity,
      identitySource: record.identitySource,
      gitRemote: record.gitRemote ?? null,
      identityCheckedAt: record.identityCheckedAt ?? now,
    }
  }
  const gitRemote = record?.remote === true ? undefined : await readGitRemote(path, { execFileImpl })
  const derived = identityForProject({ gitRemote, title, path })
  return { ...derived, identityCheckedAt: now }
}

/** Stable short hash used by cloud keys and tests. */
export function shortHash(value, length = 10) {
  return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, length)
}

import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { homedir } from 'node:os'

/** Resolve `$DSH_HOME/state/dsh-project-memory`, with a test/override hook. */
export function defaultMemoryRoot(env = process.env, home = process.env.HOME ?? '') {
  if (typeof env.DSH_PROJECT_MEMORY_DIR === 'string' && env.DSH_PROJECT_MEMORY_DIR.trim().length > 0) {
    return resolve(env.DSH_PROJECT_MEMORY_DIR)
  }
  const dshHome = typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0
    ? env.DSH_HOME
    : join(home || homedir(), '.dsh')
  return join(dshHome, 'state', 'dsh-project-memory')
}

/** Expand a leading `~` and resolve against `base`. */
export function expandPath(value, base = process.cwd()) {
  const text = String(value ?? '').trim()
  const expanded = text === '~' || text.startsWith('~/') ? join(homedir(), text.slice(1)) : text
  return resolve(base, expanded)
}

/**
 * Canonical absolute project path. Existing paths use `realpath` so symlinked
 * workspaces share one identity; a path that does not exist yet is resolved
 * lexically. Any path is accepted because the project directory itself lives
 * under the memory root.
 * @param {string} value
 * @param {{cwd?: string, realpath?: (path: string) => Promise<string>}} [options]
 */
export async function canonicalProjectPath(value, options = {}) {
  const text = String(value ?? '').trim()
  if (text.length === 0) throw new Error('project path is required')
  const base = options.cwd ?? process.cwd()
  const absolute = expandPath(text, base)
  const realpathFn = options.realpath ?? realpath
  try {
    return await realpathFn(absolute)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'EACCES') return absolute
    throw error
  }
}

/** A filesystem-safe, human-readable project key. Stable for one canonical path. */
export function projectKeyFor(path) {
  const canonical = String(path ?? '')
  const slug = basename(canonical)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'project'
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 10)
  return `${slug}-${hash}`
}

/** Validate a key before it is used to build a directory path. */
export function isProjectKey(value) {
  return typeof value === 'string' && /^[a-z0-9\u4e00-\u9fff][a-z0-9\u4e00-\u9fff-]{0,80}$/.test(value)
}

/** Assert a key is safe to join onto the memory root. */
export function assertProjectKey(value) {
  if (!isProjectKey(value)) throw new Error(`invalid project key: ${JSON.stringify(value)}`)
  return value
}

/** Render a millisecond timestamp as an ISO string, tolerating absent values. */
export function isoTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? new Date(value).toISOString() : null
}

import { access, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { canonicalProjectPath, expandPath } from './projects.js'

/** Files/directories that reliably mark a project root without a `.git`. */
const PROJECT_MARKERS = Object.freeze([
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'Gemfile',
  'mix.exs',
  'deno.json',
  'pnpm-workspace.yaml',
])

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function hasProjectMarker(dir) {
  for (const marker of PROJECT_MARKERS) {
    if (await exists(join(dir, marker))) return true
  }
  return false
}

/** Whether `path` is exactly `root` or lives below it. */
export function isInside(path, root) {
  if (typeof path !== 'string' || typeof root !== 'string') return false
  if (path === root) return true
  return path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

/**
 * Whether one directory is a project root by the resolver's rule:
 * an explicit registry entry, a `.git` entry, or a common project marker.
 * @param {string} dir canonical absolute directory
 * @param {{registeredPaths?: Iterable<string>}} [options]
 */
export async function isProjectRoot(dir, { registeredPaths = [] } = {}) {
  for (const registered of registeredPaths) {
    if (registered === dir) return true
  }
  if (await exists(join(dir, '.git'))) return true
  return hasProjectMarker(dir)
}

/**
 * Nearest project root at or above `start`.
 *
 * The walk checks the exact directory first, then each parent. An explicit
 * registry entry wins over heuristics at the same level; otherwise the nearest
 * `.git` or project marker wins over a further ancestor. This is what makes a
 * worker assigned `.../QuantResearch/src` resolve to `.../QuantResearch`.
 *
 * @param {string} start canonical absolute path
 * @param {{registeredPaths?: Iterable<string>}} [options]
 * @returns {Promise<string|undefined>}
 */
export async function findProjectRootUp(start, { registeredPaths = [] } = {}) {
  const registered = new Set(registeredPaths)
  let current = start
  while (true) {
    if (registered.has(current)) return current
    if (await exists(join(current, '.git'))) return current
    if (await hasProjectMarker(current)) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Direct child project roots of a workspace, used to tell the model which
 * projects it can bind to when the assigned workspace is a broad parent.
 * @param {string} workspace canonical absolute path
 * @param {{registeredPaths?: Iterable<string>, extraPaths?: Iterable<string>, limit?: number}} [options]
 * @returns {Promise<string[]>}
 */
export async function findChildProjectRoots(workspace, { registeredPaths = [], extraPaths = [], limit = 200 } = {}) {
  const registered = new Set(registeredPaths)
  const found = new Set()
  const add = (path) => {
    if (typeof path === 'string' && path.length > 0 && isInside(path, workspace) && path !== workspace) {
      found.add(path)
    }
  }
  const addIfDirectChild = (path) => {
    if (!isInside(path, workspace) || path === workspace) return
    const relative = path.slice(workspace.length).replace(/^[/\\]+/, '')
    if (relative.length > 0 && !relative.includes('/') && !relative.includes('\\')) add(path)
  }
  for (const path of registered) addIfDirectChild(path)
  for (const path of extraPaths) addIfDirectChild(path)

  try {
    const entries = await readdir(workspace, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const child = join(workspace, entry.name)
      if (await isProjectRoot(child, { registeredPaths })) add(child)
    }
  } catch {
    // A missing/unreadable workspace falls back to the registry hints above.
  }

  return [...found]
    .map((path) => path.replace(/[/\\]+$/, '') || path)
    .sort()
    .slice(0, limit)
}

/**
 * Resolve the one project a worker may bind to.
 *
 * Rules, in order:
 * 1. If the assigned workspace is itself a project root, bind it.
 * 2. If the workspace is inside a project root (e.g. `QuantResearch/src`),
 *    bind that enclosing root.
 * 3. If the workspace is a plain directory with no child project roots, bind
 *    the workspace.
 * 4. If it has exactly one child project root, bind that child (unambiguous).
 * 5. If it is a broad parent with several child roots, it is unbound: the
 *    worker must name one project path once, and the session binds to that
 *    project's root. A later call cannot switch projects.
 *
 * @param {{
 *   workspacePath: string,
 *   requestedPath?: string|undefined,
 *   registeredPaths?: Iterable<string>,
 *   extraPaths?: Iterable<string>,
 *   cwd?: string,
 * }} options
 * @returns {Promise<
 *   {kind: 'bound', root: string, reason: string} |
 *   {kind: 'unbound', workspace: string, candidates: string[]} |
 *   {kind: 'outside', workspace: string, requested: string}
 * >}
 */
export async function resolveWorkerScope({
  workspacePath,
  requestedPath,
  registeredPaths = [],
  extraPaths = [],
  cwd,
} = {}) {
  const workspace = await canonicalProjectPath(workspacePath, { cwd })
  const requested = typeof requestedPath === 'string' && requestedPath.trim().length > 0
    ? await canonicalRequestedPath(workspacePath, workspace, requestedPath, cwd)
    : undefined
  const workspaceRoot = await findProjectRootUp(workspace, { registeredPaths })

  if (requested !== undefined) {
    const allowedRoot = workspaceRoot !== undefined && workspaceRoot !== workspace ? workspaceRoot : workspace
    if (!isInside(requested, allowedRoot)) {
      return { kind: 'outside', workspace, requested }
    }
  }

  if (workspaceRoot !== undefined && workspaceRoot !== workspace) {
    if (requested !== undefined && !isInside(requested, workspaceRoot)) {
      return { kind: 'outside', workspace, requested }
    }
    return { kind: 'bound', root: workspaceRoot, reason: 'workspace-inside-project' }
  }
  if (workspaceRoot === workspace) {
    return { kind: 'bound', root: workspace, reason: 'workspace-root' }
  }

  const children = await findChildProjectRoots(workspace, { registeredPaths, extraPaths })
  if (children.length === 0) {
    return { kind: 'bound', root: workspace, reason: 'plain-workspace' }
  }
  if (children.length === 1) {
    if (requested !== undefined && !isInside(requested, children[0]) && !isInside(requested, workspace)) {
      return { kind: 'outside', workspace, requested }
    }
    return { kind: 'bound', root: children[0], reason: 'single-child' }
  }

  if (requested === undefined) {
    return { kind: 'unbound', workspace, candidates: children }
  }
  if (!isInside(requested, workspace)) {
    return { kind: 'outside', workspace, requested }
  }
  if (requested === workspace) {
    return { kind: 'unbound', workspace, candidates: children }
  }
  const requestedRoot = await findProjectRootUp(requested, { registeredPaths })
  if (requestedRoot !== undefined && requestedRoot !== workspace && isInside(requestedRoot, workspace)) {
    return { kind: 'bound', root: requestedRoot, reason: 'requested-root' }
  }
  if (await isDirectory(requested)) {
    return { kind: 'bound', root: requested, reason: 'requested-directory' }
  }
  return { kind: 'unbound', workspace, candidates: children }
}

/**
 * Canonicalize a requested path while preserving the assigned workspace's
 * canonical prefix for a not-yet-existing subdirectory. Without this, a
 * symlinked temp/home prefix (or a project path that does not exist yet) can
 * look "outside" an otherwise identical realpath'd workspace.
 */
async function canonicalRequestedPath(originalWorkspace, canonicalWorkspace, requestedPath, cwd) {
  const original = expandPath(originalWorkspace, cwd)
  const requested = expandPath(requestedPath, original)
  if (isInside(requested, original)) {
    const rel = relative(original, requested)
    return canonicalProjectPath(rel.length > 0 ? join(canonicalWorkspace, rel) : canonicalWorkspace)
  }
  return canonicalProjectPath(requestedPath, { cwd: canonicalWorkspace })
}

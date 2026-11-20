/**
 * Shared runtime helpers for the DSH plugin upgrade-compat skill.
 *
 * Everything here is read-only. The only side effects are spawning a child
 * process (probes/tests) and, when the running DSH installation lives inside
 * Electron's `app.asar`, re-executing the same script under the app's own
 * Electron binary with `ELECTRON_RUN_AS_NODE=1` so ASAR reads work.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

/** Expand a leading `~` and resolve against `cwd`. */
export function expandPath(value, cwd = process.cwd()) {
  if (typeof value !== 'string' || value.length === 0) return value
  const expanded = value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded)
}

/** Read and parse a JSON file. */
export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Return whether a path exists (files and directories). */
export function exists(path) {
  return existsSync(path)
}

/** SHA-256 of a string, hex encoded. */
export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** Stable JSON stringify with sorted object keys and a trailing newline. */
export function stableJson(value) {
  return JSON.stringify(sortKeys(value), null, 2) + '\n'
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key])
  return out
}

/** Sort an array of strings deterministically. */
export function sorted(values) {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

/**
 * Return the running DSH installation root: the directory that holds the
 * `@deepseek-ai/dsh` package, i.e. `$DSH_INSTALL_DIR`.
 * @param {string} [override] explicit --core value
 */
export function findInstallDir(override) {
  const candidates = []
  if (override !== undefined) candidates.push(expandPath(override))
  if (process.env.DSH_INSTALL_DIR) candidates.push(process.env.DSH_INSTALL_DIR)
  for (const candidate of candidates) {
    const dir = isDshCliDir(candidate) ? candidate : join(candidate, 'node_modules', '@deepseek-ai', 'dsh')
    if (isDshCliDir(dir)) return dir
  }
  throw new Error(
    'Could not locate the running DSH installation. Set DSH_INSTALL_DIR (it points at the '
    + '@deepseek-ai/dsh package directory) or pass --core <path>.',
  )
}

function isDshCliDir(dir) {
  const manifest = join(dir, 'package.json')
  if (!existsSync(manifest)) return false
  try {
    return readJson(manifest).name === '@deepseek-ai/dsh'
  } catch {
    return false
  }
}

/** Describe an installation directory layout. */
export function coreLayout(installDir) {
  const allPackagesDir = dirname(installDir)
  return {
    installDir,
    /** Directory holding every @deepseek-ai package. */
    allPackagesDir,
    /** node_modules that contains @deepseek-ai. */
    nodeModules: dirname(allPackagesDir),
    /** True when the installation lives inside an Electron ASAR archive. */
    asar: installDir.includes('.asar'),
    manifest: readJson(join(installDir, 'package.json')),
  }
}

/**
 * Re-run the current script under Electron's Node mode when the DSH
 * installation is inside `app.asar` and this process cannot read it.
 * @param {string[]} argv `process.argv.slice(2)`
 * @param {{ asar: boolean, electron?: string }} layout
 */
export function ensureRuntime(argv, layout) {
  if (!layout.asar) return
  if (process.env.DSH_COMPAT_REEXEC === '1' || process.versions.electron) return
  if (typeof process.env.ELECTRON_RUN_AS_NODE === 'string' && process.env.ELECTRON_RUN_AS_NODE !== '') return
  const electron = process.env.DSH_NODE_EXECUTABLE || defaultElectronPath()
  if (!electron || !existsSync(electron)) {
    throw new Error(
      'The DSH installation lives inside app.asar, which plain Node cannot read. '
      + 'Set DSH_NODE_EXECUTABLE to the running Electron binary (or run with ELECTRON_RUN_AS_NODE=1).',
    )
  }
  const result = spawnSync(electron, [process.argv[1], ...argv], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_COMPAT_REEXEC: '1' },
  })
  process.exit(result.status === null ? 1 : result.status)
}

function defaultElectronPath() {
  return '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
}

/**
 * Import one built package module from the installation without depending on
 * the caller's module resolution.
 * @param {{ allPackagesDir: string, nodeModules: string }} layout
 * @param {string} name package name, e.g. `@deepseek-ai/dsh-app-boot`
 * @param {string} [subpath] export subpath such as `types`
 */
export async function importCorePackage(layout, name, subpath = '.') {
  // Resolve through node_modules so scoped names are not prefixed twice.
  const dir = join(layout.nodeModules, ...name.split('/'))
  const manifest = readJson(join(dir, 'package.json'))
  const exportsField = manifest.exports ?? {}
  const target = resolveExportsTarget(exportsField, subpath === '.' ? '.' : `./${subpath}`, dir)
  if (typeof target !== 'string') {
    throw new Error(`${name} has no resolvable export for "${subpath}"`)
  }
  return await import(pathToFileURL(target).href)
}

/**
 * Resolve a package export subpath against a Node-style `exports` field.
 * Supports the subset used by DSH packages: string targets, condition
 * objects, and a single trailing `*` pattern.
 * @returns {string | undefined} absolute file path
 */
export function resolveExportsTarget(exportsField, subpath, packageDir) {
  if (typeof exportsField === 'string') {
    return subpath === '.' ? resolve(packageDir, exportsField) : undefined
  }
  if (exportsField === null || typeof exportsField !== 'object') return undefined
  const keys = Object.keys(exportsField)
  const hasSubpaths = keys.some((key) => key.startsWith('.'))
  if (!hasSubpaths) {
    // Condition map for the package root.
    return subpath === '.' ? resolveCondition(exportsField, packageDir, undefined) : undefined
  }
  if (Object.hasOwn(exportsField, subpath)) {
    return resolveCondition(exportsField[subpath], packageDir, undefined)
  }
  let best
  for (const key of keys) {
    if (!key.includes('*')) continue
    const [prefix, suffix] = key.split('*')
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue
    if (best === undefined || prefix.length > best.prefix.length) {
      best = { prefix, suffix, target: exportsField[key], star: subpath.slice(prefix.length, subpath.length - suffix.length) }
    }
  }
  if (best !== undefined) return resolveCondition(best.target, packageDir, best.star)
  return undefined
}

function resolveCondition(target, packageDir, star) {
  if (typeof target === 'string') {
    const value = star === undefined ? target : target.replaceAll('*', star)
    return resolve(packageDir, value)
  }
  if (Array.isArray(target)) {
    for (const entry of target) {
      const resolved = resolveCondition(entry, packageDir, star)
      if (resolved !== undefined) return resolved
    }
    return undefined
  }
  if (target === null || typeof target !== 'object') return undefined
  // Runtime conditions first: `types` points at a declaration file that build
  // output may omit, and importing it would be wrong even when it exists.
  for (const condition of ['default', 'import', 'node', 'require', 'types']) {
    if (Object.hasOwn(target, condition)) {
      const resolved = resolveCondition(target[condition], packageDir, star)
      if (resolved !== undefined) return resolved
    }
  }
  return undefined
}

/**
 * Walk a directory and return relative file paths matching the filter.
 * Skips dependency, VCS, and generated directories.
 */
export function walkFiles(root, options = {}) {
  const skip = new Set(options.skip ?? ['node_modules', '.git', 'dist', 'coverage', '.cache', '.dsh-runtime', 'reports'])
  const match = options.match
  const maxFiles = options.maxFiles ?? 5000
  const out = []
  const visit = (dir) => {
    if (out.length >= maxFiles) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (out.length >= maxFiles) return
      if (skip.has(entry.name)) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(path)
      } else if (entry.isFile() && (match === undefined || match(path))) {
        out.push(path)
      }
    }
  }
  visit(root)
  return out
}

/** Return a path relative to root using forward slashes. */
export function relativePath(root, path) {
  return relative(root, path).split(sep).join('/')
}

/** Return `file:line` for a character offset in text. */
export function lineOf(text, index) {
  return text.slice(0, index).split('\n').length
}

/** Return the line number (1-based) of a regex match in text. */
export function matchLine(text, regex, flags = '') {
  const match = new RegExp(regex, flags).exec(text)
  return match === null ? undefined : lineOf(text, match.index)
}

/** Return whether a directory is a git work tree. */
export function isGitRepo(dir) {
  let current = resolve(dir)
  for (;;) {
    if (existsSync(join(current, '.git'))) return true
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

/** Run one command and capture its result without throwing on non-zero exit. */
export function run(command, args, options = {}) {
  const started = Date.now()
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 240_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  return {
    command: [command, ...args].join(' '),
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error === undefined ? undefined : String(result.error),
    durationMs: Date.now() - started,
  }
}

/** First meaningful error line from test/probe output. */
export function firstErrorLine(output) {
  const lines = output.split('\n').map((line) => line.trimEnd())
  for (const pattern of [/^not ok /, /^\s*error:/i, /^\w*Error: /, /^\s*at .*:\d+:\d+/, /^AssertionError/, /^FAIL /]) {
    const hit = lines.find((line) => pattern.test(line))
    if (hit !== undefined) return hit.trim().slice(0, 400)
  }
  return undefined
}

/** Current git status of a work tree, or undefined when not a repository. */
export function gitStatus(dir) {
  if (!isGitRepo(dir)) return undefined
  const result = run('git', ['status', '--porcelain'], { cwd: dir, timeoutMs: 30_000 })
  if (result.status !== 0) return undefined
  return result.stdout.split('\n').filter((line) => line.length > 0)
}

/** File size in bytes, or 0. */
export function sizeOf(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

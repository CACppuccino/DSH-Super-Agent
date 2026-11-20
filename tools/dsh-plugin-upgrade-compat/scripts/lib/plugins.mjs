/**
 * Discover every locally installed DSH plugin and bundle, without importing
 * plugin code.
 *
 * Sources:
 *   1. each profile's `package.json` dependencies, resolved through
 *      `<profile>/node_modules` (this is the live install the Host loads)
 *   2. configured source roots (the plugin repositories)
 *   3. `$DSH_HOME/plugins` for staged/tarball installs
 *
 * A candidate is a package whose manifest carries a `dsh` field, a
 * `@deepseek-ai/dsh*` peer/engine requirement, or a `dsh-*` name. Core
 * packages are filtered out: they are part of the runtime, not plugins.
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { expandPath, readJson, sha256, sorted, walkFiles } from './runtime.mjs'

const PROJECT_SKIP = /^(node_modules|\.git|test-|\.quant-sync|\.dsh-runtime|reports)$/

/**
 * @param {{ config: object, corePackages: Record<string, unknown>, dshHome: string }} options
 * @returns {{ plugins: object[], skipped: object[] }}
 */
export function discoverPlugins({ config, corePackages, dshHome }) {
  const candidates = new Map()
  const skipped = []
  const exclude = (config.discovery?.exclude ?? []).map((pattern) => new RegExp(pattern))
  const addCandidate = (path, role, detail) => {
    const root = safeRealpath(path)
    const manifestPath = join(root, 'package.json')
    if (!existsSync(manifestPath)) return
    if (exclude.some((pattern) => pattern.test(root))) {
      skipped.push({ path: root, reason: 'excluded by config.discovery.exclude' })
      return
    }
    let manifest
    try {
      manifest = readJson(manifestPath)
    } catch (error) {
      skipped.push({ path: root, reason: `unreadable package.json: ${String(error).slice(0, 160)}` })
      return
    }
    if (typeof manifest.name !== 'string') return
    if (corePackages[manifest.name] !== undefined) return
    if (!isPluginManifest(manifest)) return
    if (pluginKind(manifest) === 'unknown') {
      skipped.push({ path: root, reason: 'no dsh manifest, bundle patch, client declaration, or host entry' })
      return
    }
    const key = `${manifest.name}@${typeof manifest.version === 'string' ? manifest.version : '0.0.0'}`
    const entry = candidates.get(key) ?? { name: manifest.name, version: typeof manifest.version === 'string' ? manifest.version : '0.0.0', roots: [] }
    if (!entry.roots.some((existing) => existing.path === root)) {
      entry.roots.push({ path: root, role, ...(detail.profile === undefined ? {} : { profile: detail.profile }) })
    }
    candidates.set(key, entry)
  }

  // 1. Live profile installs.
  const profilesRoot = expandPath(config.discovery?.profilesRoot ?? '~/.dsh/profiles')
  if (existsSync(profilesRoot)) {
    for (const profile of sorted(readdirSync(profilesRoot))) {
      const profileDir = join(profilesRoot, profile)
      const manifestPath = join(profileDir, 'package.json')
      if (!existsSync(manifestPath)) continue
      let manifest
      try {
        manifest = readJson(manifestPath)
      } catch {
        skipped.push({ path: profileDir, reason: 'unreadable profile package.json' })
        continue
      }
      for (const name of sorted(Object.keys(manifest.dependencies ?? {}))) {
        const installed = join(profileDir, 'node_modules', ...name.split('/'))
        if (!existsSync(join(installed, 'package.json'))) {
          skipped.push({ path: installed, reason: `profile ${profile} dependency ${name} is not installed` })
          continue
        }
        addCandidate(installed, 'live', { profile })
      }
    }
  }

  // 2. Source roots.
  for (const rootConfig of config.discovery?.sourceRoots ?? []) {
    const root = expandPath(rootConfig.path)
    if (!existsSync(root)) {
      skipped.push({ path: root, reason: 'configured source root does not exist' })
      continue
    }
    const depth = Number.isInteger(rootConfig.depth) ? rootConfig.depth : 1
    const role = rootConfig.role ?? 'source'
    addCandidate(root, role, {})
    for (const dir of walkPackageDirs(root, depth)) addCandidate(dir, role, {})
  }

  // 3. $DSH_HOME/plugins staging area.
  const pluginsRoot = join(dshHome, 'plugins')
  if (existsSync(pluginsRoot)) {
    addCandidate(pluginsRoot, 'staged', {})
    for (const dir of walkPackageDirs(pluginsRoot, 3)) addCandidate(dir, 'staged', {})
  }

  const plugins = []
  for (const entry of [...candidates.values()].sort((left, right) => (left.name < right.name ? -1 : 1))) {
    entry.roots.sort((left, right) => roleRank(left.role) - roleRank(right.role) || (left.path < right.path ? -1 : 1))
    const primaryRoot = entry.roots[0].path
    const manifest = readJson(join(primaryRoot, 'package.json'))
    const kind = pluginKind(manifest)
    const drift = entry.roots.length > 1 ? compareRoots(entry.roots) : { identical: true, changed: [] }
    plugins.push({
      name: entry.name,
      version: entry.version,
      kind,
      manifest,
      primaryRoot,
      roots: entry.roots,
      drift,
    })
  }
  return { plugins, skipped }
}

function roleRank(role) {
  return role === 'live' ? 0 : role === 'installed' ? 1 : role === 'staged' ? 2 : 3
}

function safeRealpath(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function isPluginManifest(manifest) {
  if (manifest.dsh !== undefined) return true
  if (typeof manifest.name === 'string' && /^(@[^/]+\/)?dsh-/.test(manifest.name)) return true
  for (const field of ['peerDependencies', 'engines']) {
    const block = manifest[field]
    if (block === undefined || block === null || typeof block !== 'object') continue
    if (Object.keys(block).some((key) => key === 'dsh' || key.startsWith('@deepseek-ai/dsh'))) return true
  }
  return false
}

function pluginKind(manifest) {
  const hasBundle = typeof manifest.dsh?.bundle?.patch === 'string'
  const hasClient = manifest.dsh?.client !== undefined
  const hasHost = manifest.exports !== undefined && (manifest.exports['.'] !== undefined || typeof manifest.main === 'string')
  if (hasBundle && hasClient && hasHost) return 'bundle+host+client'
  if (hasBundle && hasClient) return 'bundle+client'
  if (hasBundle && hasHost) return 'bundle+host'
  if (hasBundle) return 'bundle'
  if (hasClient) return 'client'
  if (hasHost) return 'host'
  return 'unknown'
}

function walkPackageDirs(root, depth) {
  const out = []
  const visit = (dir, remaining) => {
    if (remaining < 0) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (PROJECT_SKIP.test(entry.name) || entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (existsSync(join(path, 'package.json'))) out.push(path)
      if (remaining > 0) visit(path, remaining - 1)
    }
  }
  visit(root, depth)
  return out
}

/** Compare production files across copies of one plugin package. */
function compareRoots(roots) {
  const digests = roots.map((root) => rootDigest(root.path))
  const changed = []
  const reference = digests[0].files
  for (let index = 1; index < digests.length; index += 1) {
    const current = digests[index].files
    for (const file of sorted(new Set([...Object.keys(reference), ...Object.keys(current)]))) {
      if (reference[file] !== current[file]) changed.push({ file, roots: [roots[0].path, roots[index].path] })
    }
  }
  return { identical: changed.length === 0, changed: changed.slice(0, 50) }
}

function rootDigest(root) {
  const files = {}
  const manifest = safeReadJson(join(root, 'package.json'))
  const allowed = Array.isArray(manifest?.files) ? manifest.files : undefined
  const candidates = walkFiles(root, {
    match: (path) => /\.(m?js|cjs|json|ya?ml)$/.test(path) && !/(^|\/)(test|tests|screenshots)\//.test(path),
    maxFiles: 300,
  })
  for (const file of candidates) {
    const relative = file.slice(root.length + 1)
    if (allowed !== undefined && !allowed.some((entry) => matchFileField(entry, relative))) continue
    try {
      files[relative] = sha256(readFileSync(file))
    } catch {
      // A file removed while scanning is drift by definition; skip it.
    }
  }
  return { files }
}

function matchFileField(field, relative) {
  if (field === relative) return true
  const base = basename(relative)
  if (field === base) return true
  if (field.endsWith('/') && relative.startsWith(field)) return true
  if (field.includes('*')) {
    const pattern = field.split('*').map(escapeRegExp).join('[^/]*')
    return new RegExp(`^${pattern}$`).test(relative) || new RegExp(`(^|/)${pattern}$`).test(relative)
  }
  return relative === field || relative.startsWith(`${field}/`)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function safeReadJson(path) {
  try {
    return readJson(path)
  } catch {
    return undefined
  }
}

/** Absolute directory of the repository that contains a plugin root (best-effort). */
export function repositoryOf(root) {
  let current = resolve(root)
  for (;;) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

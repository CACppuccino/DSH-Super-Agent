/**
 * Read-only probe of the running DSH core: package inventory, import surface,
 * and the contract catalogs a plugin can depend on.
 *
 * Catalogs are derived from the installation itself, never from memory:
 *   - host/client services and events: `declare module '@deepseek-ai/cordis'`
 *     augmentations in each package's shipped `src/`
 *   - client slots: `slots.register` / `slots.inject` / `children` keys
 *   - tool names: `defineTool({ name })` / `tools.register({ name })`
 *   - client static modules: the Web frontend's external module map
 *   - route kinds: the WebServer service declaration
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  coreLayout, findInstallDir, readJson, relativePath, resolveExportsTarget, sorted, walkFiles,
} from './runtime.mjs'

/** Cordis Context members that are part of the framework rather than a service. */
const BUILTIN_CONTEXT_MEMBERS = new Set([
  'get', 'set', 'provide', 'effect', 'on', 'once', 'emit', 'inject', 'logger', 'scope', 'root',
  'plugin', 'dispose', 'parallel', 'serial', 'bail', 'waterfall', 'emitAsync', 'config', 'name',
  'schema', 'runtime', 'registry', 'fiber', 'lifecycle', 'is', 'extend', 'mixin', 'intercept', 'off',
  // cordis-plugin-timer augments Context with the timer wrappers directly.
  'interval', 'timeout', 'throttle', 'debounce', 'setTimeout', 'setInterval',
])

/** Client services supplied by Web frontend static modules rather than an installed package. */
const STATIC_CLIENT_SERVICES = {
  slots: '@deepseek-ai/dsh-client-ui-slots (static module in the Web frontend)',
}

/** Build the complete core surface for one installation. */
export function buildCoreSurface({ core, includeSymbols = true } = {}) {
  const installDir = core ?? findInstallDir(undefined)
  const layout = coreLayout(installDir)
  const packages = {}
  for (const name of sorted(readdirSync(layout.allPackagesDir))) {
    const dir = join(layout.allPackagesDir, name)
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    let manifest
    try {
      manifest = readJson(manifestPath)
    } catch {
      continue
    }
    if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@deepseek-ai/')) continue
    const exportsField = manifest.exports ?? {}
    const entry = resolveExportsTarget(exportsField, '.', dir)
    const record = {
      version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
      dir,
      exports: exportsField,
      entry: entry === undefined ? null : relativePath(layout.allPackagesDir, entry),
      dsh: manifest.dsh,
    }
    if (includeSymbols && entry !== undefined && existsSync(entry)) {
      record.symbols = parseModuleExports(entry, 0)
      record.exportsType = record.symbols.type
      record.symbols = record.symbols.names
    }
    packages[manifest.name] = record
  }
  const sources = scanSources(layout)
  const catalogs = {
    hostServices: servicesFrom(sources.filter((source) => !source.client)),
    clientServices: servicesFrom(sources.filter((source) => source.client)),
    events: eventsFrom(sources),
    slots: slotsFrom(sources.filter((source) => source.client)),
    tools: toolsFrom(sources),
    staticModules: staticModulesFrom(packages),
    routeKinds: routeKindsFrom(sources),
    routes: routesFrom(sources),
  }
  for (const [name, source] of Object.entries(STATIC_CLIENT_SERVICES)) {
    if (!catalogs.clientServices.some((entry) => entry.name === name)) {
      catalogs.clientServices.push({ name, source, static: true })
    }
  }
  catalogs.hostServices.sort(byName)
  catalogs.clientServices.sort(byName)
  catalogs.events.sort(byName)
  catalogs.slots.sort(byName)
  catalogs.tools.sort(byName)
  return {
    version: layout.manifest.version,
    installDir,
    layout,
    packages,
    catalogs,
    sourceFiles: sources.length,
  }
}

function byName(left, right) {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

/** Scan shipped TypeScript sources in the installation (the contract declarations live there). */
function scanSources(layout) {
  const sources = []
  for (const packageName of sorted(readdirSync(layout.allPackagesDir))) {
    const src = join(layout.allPackagesDir, packageName, 'src')
    if (!existsSync(src)) continue
    for (const file of walkFiles(src, { match: (path) => path.endsWith('.ts'), maxFiles: 4000 })) {
      let text
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      if (text.length > 1_500_000) continue
      sources.push({
        package: `@deepseek-ai/${packageName}`,
        file,
        relative: `${packageName}/${relativePath(src, file)}`,
        client: /(^|\/)client\//.test(relativePath(src, file)),
        text,
      })
    }
  }
  return sources
}

/** Parse an ESM/CJS module and return its exported names. */
export function parseModuleExports(path, depth = 0) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { names: [], type: 'unreadable' }
  }
  const names = new Set()
  const starFrom = []
  for (const match of text.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const raw of match[1].split(',')) {
      const part = raw.trim()
      if (part.length === 0) continue
      const alias = part.split(/\s+as\s+/)
      const name = (alias[1] ?? alias[0]).trim()
      if (name.length > 0) names.add(name)
    }
  }
  for (const match of text.matchAll(/\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1])
  for (const match of text.matchAll(/\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1])
  for (const match of text.matchAll(/\bexport\s+class\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1])
  if (/\bexport\s+default\b/.test(text)) names.add('default')
  for (const match of text.matchAll(/\bexport\s*\*\s*from\s*['"]([^'"]+)['"]/g)) starFrom.push(match[1])
  if (depth < 2) {
    for (const specifier of starFrom) {
      const target = specifier.startsWith('.') ? join(dirname(path), specifier) : undefined
      if (target === undefined || !existsSync(target)) continue
      for (const name of parseModuleExports(target, depth + 1).names) names.add(name)
    }
  }
  if (names.size === 0) {
    for (const match of text.matchAll(/^(?:exports|module\.exports)\.([A-Za-z_$][\w$]*)\s*=/gm)) names.add(match[1])
    if (/\bmodule\.exports\s*=/.test(text)) names.add('default')
    return { names: sorted(names), type: names.size === 0 ? 'unparsed' : 'cjs' }
  }
  return { names: sorted(names), type: depth === 0 ? 'esm' : 'esm-reexport' }
}

function servicesFrom(sources) {
  const entries = new Map()
  for (const source of sources) {
    for (const block of augmentationBlocks(source.text, 'Context')) {
      for (const member of interfaceMembers(block)) {
        if (member.name.startsWith('[')) continue
        if (!entries.has(member.name)) {
          entries.set(member.name, { name: member.name, source: `${source.relative}:${member.line}`, package: source.package })
        }
      }
    }
  }
  return [...entries.values()]
}

function eventsFrom(sources) {
  const entries = new Map()
  for (const source of sources) {
    for (const block of augmentationBlocks(source.text, 'Events')) {
      for (const member of interfaceMembers(block)) {
        if (member.name.startsWith('[')) continue
        if (!entries.has(member.name)) {
          entries.set(member.name, {
            name: member.name,
            mode: member.mode,
            source: `${source.relative}:${member.line}`,
            package: source.package,
          })
        }
      }
    }
  }
  return [...entries.values()]
}

function slotsFrom(sources) {
  const entries = new Map()
  const patterns = [
    /slots\.register\(\s*\{[\s\S]{0,500}?name:\s*['"]([^'"]+)['"]/g,
    /slots\.inject\(\s*['"]([^'"]+)['"]/g,
    /children:\s*\{([\s\S]{0,1200}?)\n\s*\}/g,
  ]
  for (const source of sources) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0
      for (const match of source.text.matchAll(pattern)) {
        const line = source.text.slice(0, match.index).split('\n').length
        if (pattern === patterns[2]) {
          for (const child of match[1].matchAll(/['"]([^'"]+)['"]\s*:\s*\{/g)) {
            if (!entries.has(child[1])) {
              entries.set(child[1], { name: child[1], source: `${source.relative}:${line}`, package: source.package })
            }
          }
          continue
        }
        if (!entries.has(match[1])) {
          entries.set(match[1], { name: match[1], source: `${source.relative}:${line}`, package: source.package })
        }
      }
    }
  }
  return [...entries.values()]
}

function toolsFrom(sources) {
  const entries = new Map()
  const patterns = [
    /defineTool\(\s*\{[\s\S]{0,1600}?name:\s*['"]([a-z0-9_]+)['"]/g,
    /tools\.register\(\s*\{[\s\S]{0,800}?name:\s*['"]([a-z0-9_]+)['"]/g,
  ]
  for (const source of sources) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0
      for (const match of source.text.matchAll(pattern)) {
        if (entries.has(match[1])) continue
        const line = source.text.slice(0, match.index).split('\n').length
        entries.set(match[1], { name: match[1], source: `${source.relative}:${line}`, package: source.package })
      }
    }
  }
  return [...entries.values()]
}

/**
 * Find `interface <name> { ... }` blocks inside `declare module '@deepseek-ai/cordis'`
 * augmentations. Returns the block bodies with brace offsets.
 */
function augmentationBlocks(text, interfaceName) {
  const blocks = []
  const declaration = /declare module '@deepseek-ai\/cordis'\s*\{/g
  for (const match of text.matchAll(declaration)) {
    const open = text.indexOf('{', match.index)
    const end = matchBrace(text, open)
    if (end < 0) continue
    const body = text.slice(open + 1, end)
    const interfacePattern = new RegExp(`interface\\s+${interfaceName}\\s*(?:extends[^{]*)?\\{`, 'g')
    for (const entry of body.matchAll(interfacePattern)) {
      const innerOpen = body.indexOf('{', entry.index)
      const innerEnd = matchBrace(body, innerOpen)
      if (innerEnd < 0) continue
      const baseLine = text.slice(0, open + 1 + innerOpen).split('\n').length
      blocks.push({ body: body.slice(innerOpen + 1, innerEnd), line: baseLine })
    }
  }
  return blocks
}

/** Extract top-level members of an interface body with their line and `@mode`. */
function interfaceMembers(block) {
  const lines = block.body.split('\n')
  const candidates = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const match = line.match(/^(\s+)(?:\[[^\]]+\]|'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*[?:(]/)
    if (match === null) continue
    if (/^\s*\*/.test(line) || /^\s*\/\//.test(line)) continue
    candidates.push({
      name: match[2] ?? match[3] ?? match[4] ?? '',
      indent: match[1].length,
      line: block.line + index,
      index,
      raw: line,
    })
  }
  if (candidates.length === 0) return []
  const minIndent = Math.min(...candidates.map((candidate) => candidate.indent))
  const members = []
  for (const candidate of candidates) {
    if (candidate.indent !== minIndent) continue
    if (candidate.name.length === 0) continue
    members.push({
      name: candidate.name,
      line: candidate.line,
      mode: modeBefore(lines, candidate.index),
    })
  }
  return members
}

function modeBefore(lines, index) {
  for (let cursor = index - 1; cursor >= Math.max(0, index - 25); cursor -= 1) {
    const line = lines[cursor]
    const mode = line.match(/@mode\s+(\w+)/)
    if (mode !== null) return mode[1]
    if (/^\s*(?:'[^']+'|"[^"]+"|[A-Za-z_$][\w$]*)\s*[?:(]/.test(line) && !/^\s*\*/.test(line)) break
  }
  return undefined
}

function matchBrace(text, openIndex) {
  if (openIndex < 0) return -1
  let depth = 0
  let quote = null
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]
    if (quote !== null) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '/' && next === '/') {
      index = text.indexOf('\n', index)
      if (index < 0) return -1
      continue
    }
    if (char === '/' && next === '*') {
      index = text.indexOf('*/', index + 2)
      if (index < 0) return -1
      index += 1
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/** Extract the static module ids the Web frontend exposes to client plugins. */
function staticModulesFrom(packages) {
  const frontend = packages['@deepseek-ai/dsh-web-frontend']
  if (frontend === undefined) return []
  const dist = join(frontend.dir, 'dist', 'assets')
  if (!existsSync(dist)) return []
  const names = new Set()
  const files = sorted(readdirSync(dist)).filter((file) => file.endsWith('.js'))
  for (const file of files) {
    let text
    try {
      text = readFileSync(join(dist, file), 'utf8')
    } catch {
      continue
    }
    // The Web frontend's module map seeds the client loader. Minified output
    // may quote keys or leave identifier-like keys bare, so parse the object
    // literal that holds a known static module instead of matching one style.
    const anchor = text.indexOf('dsh-client-ui-primitives')
    if (anchor < 0) continue
    const objectStart = enclosingObject(text, anchor)
    if (objectStart < 0) continue
    for (const key of objectKeys(text, objectStart)) names.add(key)
  }
  const filtered = [...names].filter((name) => !name.includes('/') || name.startsWith('@deepseek-ai/') || name.startsWith('@tanstack/') || name.includes('react'))
  return sorted(filtered)
}

/** Extract the WebServer route kinds from the service declaration. */
function routeKindsFrom(sources) {
  const kinds = new Set()
  for (const source of sources) {
    if (!source.relative.includes('dsh-host-webserver')) continue
    const match = source.text.match(/type\s+WebRouteKind\s*=\s*([^\n]+)/)
    if (match === null) continue
    for (const kind of match[1].matchAll(/'([^']+)'/g)) kinds.add(kind[1])
  }
  return sorted(kinds)
}

/** Find the `{` that opens the object literal containing a character offset. */
function enclosingObject(text, offset) {
  let depth = 0
  for (let index = offset; index >= 0; index -= 1) {
    const char = text[index]
    if (char === '}') depth += 1
    else if (char === '{') {
      if (depth === 0) return index
      depth -= 1
    }
  }
  return -1
}

/** Read the top-level keys of an object literal starting at `objectStart`. */
function objectKeys(text, objectStart) {
  const keys = []
  let depth = 0
  let quote = null
  for (let index = objectStart; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== null) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      const valueStart = index + 1
      let end = valueStart
      while (end < text.length && text[end] !== char) {
        if (text[end] === '\\') end += 1
        end += 1
      }
      if (depth === 1 && /^\s*:/.test(text.slice(end + 1))) keys.push(text.slice(valueStart, end))
      index = end
      continue
    }
    if (char === '{') {
      depth += 1
      continue
    }
    if (char === '}') {
      depth -= 1
      if (depth === 0) break
      continue
    }
    if (depth === 1 && /[A-Za-z_$@]/.test(char) && /[{,]\s*$/.test(text.slice(Math.max(0, index - 4), index))) {
      let end = index
      while (end < text.length && /[A-Za-z0-9_$@/.-]/.test(text[end])) end += 1
      if (/^\s*:/.test(text.slice(end))) keys.push(text.slice(index, end))
      index = end - 1
    }
  }
  const moduleName = /^(@[a-z0-9-]+\/[a-z0-9-]+(\/[a-z0-9-]+)?|react(-dom)?(\/client|\/jsx-runtime)?|zod)$/
  return keys.filter((key) => moduleName.test(key))
}

/** Extract route registrations from core sources (best-effort; computed paths are skipped). */
function routesFrom(sources) {
  const routes = []
  for (const source of sources) {
    for (const match of source.text.matchAll(/\.register\(\s*\{([\s\S]{0,400}?)\}/g)) {
      const kind = match[1].match(/kind:\s*'(exact|prefix)'/)
      if (kind === null) continue
      let path = match[1].match(/path:\s*'([^']+)'/)?.[1]
      if (path === undefined) {
        const identifier = match[1].match(/path:\s*([A-Za-z_$][\w$]*)/)?.[1]
        if (identifier !== undefined) {
          const constant = source.text.match(new RegExp(`(?:const|let|var)\\s+${identifier}\\s*=\\s*'([^']+)'`))
          if (constant !== null) path = constant[1]
        }
      }
      if (path === undefined) continue
      routes.push({ kind: kind[1], path, source: source.relative })
    }
  }
  return routes.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

export { BUILTIN_CONTEXT_MEMBERS }

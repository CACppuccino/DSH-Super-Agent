/**
 * Static compatibility analysis for one installed DSH plugin.
 *
 * Every check is deterministic and evidence-bearing: a finding always points
 * at the file and line that produced it, or at the core catalog entry it
 * failed to match. Analysis never imports plugin code; the separate load
 * probe does that in a child process.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUILTIN_CONTEXT_MEMBERS } from './core-surface.mjs'
import { exists as fsExists, lineOf, readJson, relativePath, resolveExportsTarget, run, walkFiles } from './runtime.mjs'
import { matchRule } from './rules.mjs'

const SOURCE_FILE = /\.(mjs|cjs|js)$/
const CLIENT_FILE = /(^|\/)(client|client\/[^/]+)\.(mjs|cjs|js)$/

/**
 * @param {object} options
 * @param {object} options.plugin discovery record
 * @param {object} options.core core surface
 * @param {object} options.config skill config
 * @param {(name: string) => boolean} [options.isPluginName] installed plugin names
 * @param {Set<string>} [options.externalSlots] slot names declared by other plugins
 * @param {object} [options.compat] core compatibility helpers
 * @param {object} [options.rules] loaded rules table
 * @param {boolean} [options.runTests]
 */
export function analyzePlugin({ plugin, core, config, isPluginName, externalSlots = new Set(), compat, rules, runTests = true, loadProbe }) {
  const root = plugin.primaryRoot
  const manifest = plugin.manifest
  const findings = []
  const add = (finding) => {
    if (Object.hasOwn(finding, 'ruleId') || Object.hasOwn(finding, 'manualRuleId')) {
      findings.push({ ruleId: null, ...finding })
      return
    }
    const matched = matchRule(rules, finding)
    findings.push({
      ruleId: matched?.automated === true ? matched.id : null,
      ...(matched === undefined || matched.automated === true ? {} : { manualRuleId: matched.id }),
      ...finding,
    })
  }
  const files = plugin.kind === 'bundle' ? [] : productionFiles(root)

  checkManifest({ plugin, core, compat, add })
  checkDeclaredSurfaces({ plugin, root, core, add })
  const imports = checkImports({ plugin, root, files, core, isPluginName, add, rules })
  checkInject({ plugin, files, core, add })
  checkEvents({ plugin, files, core, add })
  checkClient({ plugin, root, core, isPluginName, externalSlots, add })
  checkRoutes({ plugin, files, core, add })
  checkTools({ plugin, files, core, add })
  checkDeprecatedUsage({ plugin, files, rules, add })

  const runtime = runRuntime({ plugin, root, config, runTests, loadProbe })
  if (runtime.load?.status === 'FAIL') {
    add({
      check: 'runtime.load',
      status: 'BROKEN',
      message: `Host load contract failed: ${runtime.load.firstError ?? 'unknown error'}`,
      evidence: relativePath(root, runtime.load.entry ?? root),
    })
  }
  if (runtime.tests?.status === 'FAIL') {
    add({
      check: 'runtime.tests',
      status: 'BROKEN',
      message: `Plugin test suite failed: ${runtime.tests.firstError ?? 'unknown error'}`,
      evidence: `${runtime.tests.command}: ${runtime.tests.firstError ?? 'unknown error'}`,
    })
  }

  const status = worstStatus(findings)
  return {
    name: plugin.name,
    version: plugin.version,
    kind: plugin.kind,
    installed: plugin.roots.some((candidate) => candidate.role === 'live' || candidate.role === 'staged'),
    primaryRoot: plugin.primaryRoot,
    status,
    roots: plugin.roots,
    copy: plugin.drift,
    findings: findings.sort(findingOrder),
    checks: { imports: imports.scanned, files: files.length },
    runtime,
  }
}

function isClientFile(root, file) {
  const relative = relativePath(root, file)
  return CLIENT_FILE.test(relative) || relative.startsWith('client/')
}

function productionFiles(root) {
  return walkFiles(root, {
    match: (path) => SOURCE_FILE.test(path) && !/(^|\/)(test|tests|scripts|screenshots)\//.test(relativePath(root, path)),
    maxFiles: 1500,
  })
}

function worstStatus(findings) {
  if (findings.some((finding) => finding.status === 'BROKEN')) return 'BROKEN'
  if (findings.some((finding) => finding.status === 'DEGRADED')) return 'DEGRADED'
  if (findings.some((finding) => finding.status === 'NEEDS_MANUAL')) return 'DEGRADED'
  return 'OK'
}

function findingOrder(left, right) {
  const rank = { BROKEN: 0, NEEDS_MANUAL: 1, DEGRADED: 2, UNVERIFIED: 3, INFO: 4, OK: 5 }
  return (rank[left.status] ?? 9) - (rank[right.status] ?? 9)
    || (left.check < right.check ? -1 : left.check > right.check ? 1 : 0)
    || ((left.evidence ?? '') < (right.evidence ?? '') ? -1 : 1)
}

// ---------------------------------------------------------------- manifests

function checkManifest({ plugin, core, compat, add }) {
  const manifest = plugin.manifest
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    add({ check: 'manifest.version', status: 'BROKEN', message: 'package.json has no version', evidence: 'package.json' })
  }
  if (compat !== undefined) {
    try {
      const issue = compat.evaluate(manifest, compat.exemptions ?? {}, core.version)
      if (issue !== undefined) {
        add({
          check: 'manifest.compat',
          status: issue.exempted ? 'DEGRADED' : 'BROKEN',
          message: issue.exempted
            ? `Core ${core.version} does not satisfy requirements ${JSON.stringify(issue.requirements)}, but an exact-version exemption is active`
            : `Core ${core.version} does not satisfy ${JSON.stringify(issue.requirements)}`,
          evidence: 'package.json',
          fix: 'Widen engines.dsh or install a plugin version that supports this core.',
        })
      }
    } catch (error) {
      add({
        check: 'manifest.compat',
        status: 'BROKEN',
        message: `Core compatibility check rejected the manifest: ${String(error).split('\n')[0]}`,
        evidence: 'package.json',
      })
    }
  }
  const enginesNode = manifest.engines?.node
  if (typeof enginesNode === 'string' && compat?.satisfiesNode !== undefined) {
    if (!compat.satisfiesNode(enginesNode)) {
      add({ check: 'manifest.node', status: 'DEGRADED', message: `engines.node "${enginesNode}" excludes the running Node ${process.versions.node}`, evidence: 'package.json' })
    }
  }
  if (manifest.type !== undefined && manifest.type !== 'module' && manifest.type !== 'commonjs') {
    add({ check: 'manifest.type', status: 'DEGRADED', message: `Unsupported package type ${JSON.stringify(manifest.type)}`, evidence: 'package.json' })
  }
}

// ---------------------------------------------------------- declared surfaces

function checkDeclaredSurfaces({ plugin, root, core, add }) {
  const manifest = plugin.manifest
  const exportsField = manifest.exports
  if (exportsField !== undefined && exportsField !== null && typeof exportsField === 'object') {
    for (const [key, target] of Object.entries(exportsField)) {
      const strings = collectExportStrings(target).filter((value) => !value.endsWith('.d.ts'))
      for (const value of strings) {
        if (value.includes('*')) {
          const pattern = value.replace(/^\.\//, '')
          const prefix = pattern.split('*')[0]
          const dir = join(root, prefix.endsWith('/') ? prefix : prefix.slice(0, prefix.lastIndexOf('/') + 1))
          if (!existsSync(dir)) {
            add({ check: 'manifest.export-file', status: 'BROKEN', message: `export "${key}" points at a missing directory ${value}`, evidence: 'package.json' })
          }
          continue
        }
        if (!existsSync(join(root, value))) {
          add({ check: 'manifest.export-file', status: 'BROKEN', message: `export "${key}" points at missing file ${value}`, evidence: 'package.json' })
        }
      }
    }
  }
  const patch = manifest.dsh?.bundle?.patch
  if (patch !== undefined) {
    if (typeof patch !== 'string') {
      add({ check: 'manifest.bundle', status: 'BROKEN', message: 'dsh.bundle.patch must be a string', evidence: 'package.json' })
    } else if (!existsSync(join(root, patch))) {
      add({ check: 'manifest.bundle', status: 'BROKEN', message: `dsh.bundle.patch file ${patch} is missing`, evidence: 'package.json' })
    }
  }
  const client = manifest.dsh?.client
  if (client !== undefined) {
    if (client === null || typeof client !== 'object' || Array.isArray(client)) {
      add({ check: 'manifest.client', status: 'BROKEN', message: 'dsh.client must be an object', evidence: 'package.json' })
    } else {
      if (typeof client.platform !== 'string') {
        add({ check: 'manifest.client', status: 'BROKEN', message: 'dsh.client.platform must be a string', evidence: 'package.json' })
      }
      if (client.immediately !== undefined && typeof client.immediately !== 'boolean') {
        add({ check: 'manifest.client', status: 'BROKEN', message: 'dsh.client.immediately must be a boolean', evidence: 'package.json' })
      }
      if (client.inject !== undefined && (!Array.isArray(client.inject) || client.inject.some((entry) => typeof entry !== 'string'))) {
        add({ check: 'manifest.client', status: 'BROKEN', message: 'dsh.client.inject must be a string array', evidence: 'package.json' })
      }
    }
  }
  if (manifest.dsh?.manifestVersion !== undefined && manifest.dsh.manifestVersion !== 1) {
    add({ check: 'manifest.version', status: 'DEGRADED', message: `Unknown dsh.manifestVersion ${JSON.stringify(manifest.dsh.manifestVersion)} (this build understands 1)`, evidence: 'package.json' })
  }
  if (plugin.kind !== 'bundle' && manifest.exports?.['.'] === undefined && typeof manifest.main !== 'string') {
    add({ check: 'manifest.entry', status: 'BROKEN', message: 'No "." export and no main entry', evidence: 'package.json' })
  }
  if (core.packages[`@deepseek-ai/${manifest.name}`] !== undefined) {
    add({ check: 'manifest.identity', status: 'DEGRADED', message: 'Plugin name shadows an installed core package', evidence: 'package.json' })
  }
}

function collectExportStrings(value) {
  if (typeof value === 'string') return value.startsWith('./') ? [value] : []
  if (Array.isArray(value)) return value.flatMap(collectExportStrings)
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(collectExportStrings)
  return []
}

// ----------------------------------------------------------------- imports

function checkImports({ plugin, root, files, core, isPluginName, add, rules }) {
  let scanned = 0
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const relative = relativePath(root, file)
    for (const spec of scanSpecifiers(text)) {
      scanned += 1
      const evidence = `${relative}:${spec.line}`
      if (spec.specifier.startsWith('node:') || spec.specifier.startsWith('.')) continue
      if (spec.specifier.startsWith('@deepseek-ai/')) {
        checkCoreSpecifier({ specifier: spec.specifier, spec, evidence, core, isPluginName, manifest: plugin.manifest, add, rules })
      } else if (spec.specifier === 'dsh' || spec.specifier.startsWith('dsh/')) {
        checkDshSpecifier({ specifier: spec.specifier, spec, evidence, core, add })
      }
    }
  }
  return { scanned }
}

function checkCoreSpecifier({ specifier, spec, evidence, core, isPluginName, manifest, add, rules }) {
  const parts = specifier.split('/')
  const packageName = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  const subpath = specifier.slice(packageName.length).replace(/^\//, '')
  const corePackage = core.packages[packageName]
  if (corePackage === undefined) {
    if (core.catalogs.staticModules.includes(packageName)) return
    if (isPluginName?.(packageName)) {
      add({
        check: 'import.plugin-package',
        status: 'DEGRADED',
        message: `Imports client plugin module ${packageName}; ensure that plugin is installed in the same profile`,
        evidence,
      })
      return
    }
    const declared = manifest.peerDependencies?.[packageName] !== undefined || manifest.dependencies?.[packageName] !== undefined
    add({
      check: 'import.package',
      status: declared ? 'DEGRADED' : 'BROKEN',
      package: packageName,
      message: `Imports ${packageName}, which is not installed in the DSH core${declared ? ' (declared as a dependency but absent at runtime)' : ''}`,
      evidence,
      fix: `Replace or remove the ${packageName} import; it is not part of DSH ${core.version}.`,
    })
    return
  }
  if (subpath.length > 0) {
    const target = resolveCoreSubpath(corePackage, subpath)
    if (target === undefined) {
      add({
        check: 'import.subpath',
        status: 'BROKEN',
        package: packageName,
        subpath,
        message: `${packageName}/${subpath} is not an exported subpath of core ${corePackage.version}`,
        evidence,
      })
    }
    return
  }
  if (spec.names.length === 0) return
  const symbols = corePackage.symbols
  if (symbols === undefined || corePackage.exportsType !== 'esm') return
  const missing = spec.names.filter((name) => !symbols.includes(name))
  if (missing.length === 0) return
  add({
    check: 'import.symbol',
    status: 'BROKEN',
    package: packageName,
    symbol: missing[0],
    message: `${packageName} no longer exports ${missing.join(', ')}`,
    evidence,
    fix: 'Rename the imported symbol to its current name in the target package.',
  })
}

function resolveCoreExport(corePackage, subpath) {
  const key = `./${subpath}`
  return resolveExportsTarget(corePackage.exports ?? {}, key, corePackage.dir)
}

function resolveCoreSubpath(corePackage, subpath) {
  const target = resolveCoreExport(corePackage, subpath)
  return target === undefined ? undefined : fsExists(target) ? true : undefined
}

function checkDshSpecifier({ specifier, spec, evidence, core, add }) {
  const dsh = core.packages['@deepseek-ai/dsh']
  if (dsh === undefined) {
    add({ check: 'import.package', status: 'BROKEN', package: '@deepseek-ai/dsh', message: `Imports ${specifier} but @deepseek-ai/dsh is not installed`, evidence })
    return
  }
  if (specifier === 'dsh') return
  const subpath = specifier.slice('dsh/'.length)
  const target = resolveCoreExport(dsh, subpath)
  if (target === undefined || !fsExists(target)) {
    add({
      check: 'import.subpath',
      status: 'BROKEN',
      package: '@deepseek-ai/dsh',
      subpath,
      message: `Internal path "${specifier}" is not exported by @deepseek-ai/dsh ${dsh.version}`,
      evidence,
    })
  }
}

/**
 * Extract module specifiers with line numbers and named imports.
 * Covers static ESM imports/exports, CommonJS require, dynamic import, and
 * JSDoc `import('...')` type references.
 */
export function scanSpecifiers(text) {
  const found = []
  const add = (specifier, index, names, kind) => {
    found.push({ specifier, line: lineOf(text, index), names, kind })
  }
  for (const match of text.matchAll(/\bimport\s+(?:type\s+)?([\w$*{},\s]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    add(match[2], match.index, parseNamed(match[1]), 'esm')
  }
  for (const match of text.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) add(match[1], match.index, [], 'esm-side-effect')
  for (const match of text.matchAll(/\bexport\s+(?:type\s+)?(?:\*|\{([^}]*)\})\s*from\s*['"]([^'"]+)['"]/g)) {
    add(match[2], match.index, parseNamed(match[1] ?? ''), 'reexport')
  }
  for (const match of text.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) add(match[1], match.index, [], 'require')
  for (const match of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) add(match[1], match.index, [], 'dynamic')
  return dedupeSpecifiers(found)
}

function parseNamed(clause) {
  const trimmed = clause.trim()
  if (trimmed.length === 0) return []
  const names = []
  const braces = trimmed.match(/\{([^}]*)\}/)
  if (braces !== null) {
    for (const raw of braces[1].split(',')) {
      const part = raw.trim().replace(/^type\s+/, '')
      if (part.length === 0) continue
      const alias = part.split(/\s+as\s+/)
      const name = (alias[0] ?? '').trim()
      if (name.length > 0 && /^[A-Za-z_$][\w$]*$/.test(name)) names.push(name)
    }
  }
  const star = trimmed.match(/\*\s+as\s+([\w$]+)/)
  if (star !== null) return names
  if (braces === null && trimmed.length > 0 && /^[A-Za-z_$][\w$]*$/.test(trimmed)) names.push('default')
  return names
}

function dedupeSpecifiers(list) {
  const seen = new Set()
  return list.filter((spec) => {
    const key = `${spec.specifier}:${spec.line}:${spec.kind}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ------------------------------------------------------------------ inject

function checkInject({ plugin, files, core, add }) {
  const serviceCatalog = new Set(core.catalogs.hostServices.map((entry) => entry.name))
  const declared = new Map()
  for (const file of files) {
    if (isClientFile(plugin.primaryRoot, file)) continue
    const text = readFileSync(file, 'utf8')
    const relative = relativePath(plugin.primaryRoot, file)
    const match = text.match(/export\s+const\s+inject\s*=\s*(\[[\s\S]*?\]|\{[\s\S]*?\n\})/)
    if (match !== null) {
      const line = lineOf(text, match.index)
      for (const entry of parseInject(match[1])) declared.set(entry.name, { ...entry, evidence: `${relative}:${line}` })
    }
    for (const usage of text.matchAll(/\bctx\.get\(\s*['"]([^'"]+)['"]/g)) {
      const name = usage[1]
      if (serviceCatalog.has(name)) continue
      add({
        check: 'service.optional',
        status: 'DEGRADED',
        service: name,
        message: `Reads optional service "${name}", which is not declared by core ${core.version}`,
        evidence: `${relative}:${lineOf(text, usage.index)}`,
        fix: 'Confirm the service still exists or guard the capability behind a configured fallback.',
      })
    }
  }
  for (const entry of declared.values()) {
    if (serviceCatalog.has(entry.name)) continue
    add({
      check: 'service.inject',
      status: entry.required ? 'BROKEN' : 'DEGRADED',
      service: entry.name,
      message: `inject requires service "${entry.name}", which core ${core.version} does not provide`,
      evidence: entry.evidence,
      fix: 'Remove the dependency or move it to an optional ctx.get() lookup.',
    })
  }
  // ctx.<service> reads that the plugin never declared.
  for (const file of files) {
    if (isClientFile(plugin.primaryRoot, file)) continue
    const text = readFileSync(file, 'utf8')
    const relative = relativePath(plugin.primaryRoot, file)
    for (const usage of text.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) {
      const name = usage[1]
      if (BUILTIN_CONTEXT_MEMBERS.has(name) || serviceCatalog.has(name)) continue
      if (name === 'skills' || name === 'agents' || name === 'tools') continue
      add({
        check: 'service.usage',
        status: 'DEGRADED',
        service: name,
        message: `Uses ctx.${name}, which is not a declared core service`,
        evidence: `${relative}:${lineOf(text, usage.index)}`,
        fix: 'Verify the service name against the current core or move the dependency into inject.',
      })
    }
  }
}

function parseInject(source) {
  if (source.trim().startsWith('[')) {
    return [...source.matchAll(/['"]([^'"]+)['"]/g)].map((match) => ({ name: match[1], required: true }))
  }
  const entries = []
  for (const match of source.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:\s*(\{[^}]*\})/gm)) {
    entries.push({ name: match[1], required: !/required\s*:\s*false/.test(match[2]) })
  }
  return entries
}

// ------------------------------------------------------------------ events

function checkEvents({ plugin, files, core, add }) {
  const catalog = new Set(core.catalogs.events.map((entry) => entry.name))
  for (const file of files) {
    if (isClientFile(plugin.primaryRoot, file)) continue
    const text = readFileSync(file, 'utf8')
    const relative = relativePath(plugin.primaryRoot, file)
    for (const match of text.matchAll(/\bctx\.(on|once|emit|emitAsync)\(\s*['"]([^'"]+)['"]/g)) {
      const name = match[2]
      if (catalog.has(name)) continue
      add({
        check: 'event.unknown',
        status: 'DEGRADED',
        event: name,
        message: `${match[1] === 'on' || match[1] === 'once' ? 'Listens to' : 'Emits'} event "${name}", which core ${core.version} does not declare`,
        evidence: `${relative}:${lineOf(text, match.index)}`,
        fix: 'Confirm the event still exists; a renamed event silently disables this hook.',
      })
    }
  }
}

// ------------------------------------------------------------------ client

function checkClient({ plugin, root, core, isPluginName, externalSlots, add }) {
  const manifest = plugin.manifest
  const clientDecl = manifest.dsh?.client
  if (clientDecl === undefined) return
  const staticModules = new Set(core.catalogs.staticModules)
  const clientServices = new Set(core.catalogs.clientServices.map((entry) => entry.name))
  const corePackages = new Set(Object.keys(core.packages))
  for (const [index, moduleId] of (clientDecl.inject ?? []).entries()) {
    if (corePackages.has(moduleId) || staticModules.has(moduleId) || isPluginName?.(moduleId)) continue
    add({
      check: 'client.inject.module',
      status: 'BROKEN',
      module: moduleId,
      message: `dsh.client.inject[${index}] "${moduleId}" is neither an installed package nor a Web static module`,
      evidence: 'package.json',
    })
  }
  const clientFiles = walkFiles(root, {
    match: (path) => CLIENT_FILE.test(relativePath(root, path)),
    maxFiles: 50,
  })
  const slotCatalog = new Set(core.catalogs.slots.map((entry) => entry.name))
  const registered = new Map()
  for (const file of clientFiles) {
    const text = readFileSync(file, 'utf8')
    const relative = relativePath(root, file)
    for (const match of text.matchAll(/slots\.register\(\s*\{[\s\S]{0,500}?name:\s*['"]([^'"]+)['"]/g)) {
      registered.set(match[1], `${relative}:${lineOf(text, match.index)}`)
      for (const child of text.slice(match.index, match.index + 1200).matchAll(/children:\s*\{([\s\S]{0,800}?)\n\s*\}/g)) {
        for (const key of child[1].matchAll(/['"]([^'"]+)['"]\s*:\s*\{/g)) registered.set(key[1], `${relative}:${lineOf(text, match.index)}`)
      }
    }
    for (const match of text.matchAll(/slots\.inject\(\s*['"]([^'"]+)['"]/g)) {
      const name = match[1]
      if (slotCatalog.has(name) || registered.has(name) || externalSlots.has(name)) continue
      add({
        check: 'client.slot',
        status: 'DEGRADED',
        slot: name,
        message: `Injects into slot "${name}", which no installed plugin or core client declares`,
        evidence: `${relative}:${lineOf(text, match.index)}`,
        fix: 'Confirm the slot name still exists in the current Web client composition.',
      })
    }
    for (const match of text.matchAll(/export\s+const\s+inject\s*=\s*\[([^\]]*)\]/g)) {
      for (const entry of match[1].matchAll(/['"]([^'"]+)['"]/g)) {
        if (clientServices.has(entry[1])) continue
        add({
          check: 'client.inject.service',
          status: 'DEGRADED',
          service: entry[1],
          message: `Client plugin injects "${entry[1]}", which is not a declared client service`,
          evidence: `${relative}:${lineOf(text, match.index)}`,
        })
      }
    }
  }
}

// ------------------------------------------------------------------ routes

function checkRoutes({ plugin, files, core, add }) {
  const kinds = new Set(core.catalogs.routeKinds)
  const corePaths = new Set(core.catalogs.routes.map((route) => route.path))
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const relative = relativePath(plugin.primaryRoot, file)
    for (const match of text.matchAll(/(?:webServer|WebServer)\.register\(\s*\{([\s\S]{0,400}?)\}/g)) {
      const kind = match[1].match(/kind:\s*'([^']+)'/)?.[1]
      const path = match[1].match(/path:\s*'([^']+)'/)?.[1]
      const evidence = `${relative}:${lineOf(text, match.index)}`
      if (kind !== undefined && kinds.size > 0 && !kinds.has(kind)) {
        add({ check: 'route.kind', status: 'BROKEN', message: `Route kind "${kind}" is not supported (core accepts ${[...kinds].join(', ')})`, evidence })
      }
      if (path !== undefined) {
        if (!path.startsWith('/') || path.endsWith('/')) {
          add({ check: 'route.path', status: 'DEGRADED', message: `Route path "${path}" must start with "/" and have no trailing slash`, evidence })
        }
        if (corePaths.has(path)) {
          add({ check: 'route.collision', status: 'DEGRADED', message: `Route "${path}" collides with a core registration`, evidence })
        }
      }
    }
  }
}

// ------------------------------------------------------------------- tools

function checkTools({ plugin, files, core, add }) {
  const coreTools = new Set(core.catalogs.tools.map((entry) => entry.name))
  const registered = new Map()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const relative = relativePath(plugin.primaryRoot, file)
    for (const match of text.matchAll(/\bname:\s*'([a-z][a-z0-9_]*)',\s*\n\s*description:/g)) {
      registered.set(match[1], `${relative}:${lineOf(text, match.index)}`)
    }
    for (const match of text.matchAll(/(?:defineTool|tools\.register)\(\s*\{[\s\S]{0,1600}?\bname:\s*'([a-z][a-z0-9_]*)'/g)) {
      registered.set(match[1], `${relative}:${lineOf(text, match.index)}`)
    }
  }
  for (const [name, evidence] of registered) {
    if (coreTools.has(name)) {
      add({ check: 'tool.collision', status: 'DEGRADED', message: `Tool "${name}" collides with a core tool of the same name`, evidence })
    }
  }
}

// -------------------------------------------------------- deprecated usage

/**
 * Flag source text matched by a rule's `detect` pattern. This is how rules
 * participate in detection: every pattern is versioned and source-referenced,
 * so the scan never guesses that an API is gone.
 */
function checkDeprecatedUsage({ plugin, files, rules, add }) {
  const detectors = (rules?.rules ?? []).filter((rule) => typeof rule.detect?.pattern === 'string')
  if (detectors.length === 0) return
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const relative = relativePath(plugin.primaryRoot, file)
    for (const rule of detectors) {
      const pattern = new RegExp(rule.detect.pattern, 'g')
      const match = pattern.exec(text)
      if (match === null) continue
      add({
        check: rule.detect.check ?? 'api.deprecated',
        status: rule.detect.status ?? 'DEGRADED',
        message: rule.detect.message ?? `Matches rule ${rule.id}`,
        evidence: `${relative}:${lineOf(text, match.index)}`,
        ruleId: rule.kind === 'manual' ? null : rule.id,
        ...(rule.kind === 'manual' ? { manualRuleId: rule.id } : {}),
      })
    }
  }
}

// ----------------------------------------------------------------- runtime

function runRuntime({ plugin, root, config, runTests, loadProbe }) {
  const runtime = {}
  if (plugin.kind !== 'bundle' && loadProbe !== undefined) {
    runtime.load = loadProbe(plugin)
  } else {
    runtime.load = { status: 'SKIPPED', reason: 'bundle-only plugin has no host entry module' }
  }
  const testScript = plugin.manifest.scripts?.test
  if (!runTests) {
    runtime.tests = { status: 'SKIPPED', reason: 'disabled by --no-tests' }
  } else if (typeof testScript !== 'string' || testScript.trim().length === 0) {
    runtime.tests = { status: 'SKIPPED', reason: 'package.json declares no test script' }
  } else {
    const npm = run('npm', ['--version'], { cwd: root, timeoutMs: 15_000 })
    const command = npm.status === 0 ? ['npm', ['test', '--silent']] : [process.execPath, ['--test']]
    const result = run(command[0], command[1], {
      cwd: root,
      timeoutMs: config.checks?.testTimeoutMs ?? 300_000,
    })
    const output = `${result.stdout}\n${result.stderr}`
    const firstError = firstMeaningfulError(output)
    const unavailable = result.status === 127 || /command not found|not found: |ERR_MODULE_NOT_FOUND/i.test(output)
    runtime.tests = unavailable
      ? { status: 'SKIPPED', command: result.command, reason: 'test runner or dependency is not installed in this environment' }
      : {
          status: result.status === 0 ? 'PASS' : 'FAIL',
          command: result.command,
          ...(result.status === 0 ? {} : { firstError: firstError ?? (result.error ?? `exit ${result.status}`).slice(0, 400) }),
          ...(result.status === 0 ? {} : { exitCode: result.status }),
        }
  }
  return runtime
}

function firstMeaningfulError(output) {
  const patterns = [/^not ok /, /Error: /, /AssertionError/, /^FAIL /]
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    for (const pattern of patterns) if (pattern.test(trimmed)) return trimmed.slice(0, 400)
  }
  return undefined
}

// ------------------------------------------------------------------- rules

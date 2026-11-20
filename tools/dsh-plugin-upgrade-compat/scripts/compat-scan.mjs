#!/usr/bin/env node
/**
 * Read-only compatibility scan for every installed DSH plugin.
 *
 * Usage:
 *   node compat-scan.mjs [--core <dsh package dir>] [--json out.json] [--md out.md]
 *                        [--no-tests] [--only <substring>] [--baseline <file|none>]
 *                        [--write-baseline] [--strict] [--quiet]
 *
 * Exit codes: 0 = no BROKEN plugin, 1 = at least one BROKEN plugin,
 *             2 = the scan itself could not run (bad core, unreadable config).
 *             `--strict` makes DEGRADED also exit 1.
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCoreSurface } from './lib/core-surface.mjs'
import { analyzePlugin } from './lib/analyze.mjs'
import { discoverPlugins } from './lib/plugins.mjs'
import { probePlugin } from './lib/probe.mjs'
import { rankFindings, renderConsole, renderMarkdown } from './lib/report.mjs'
import {
  coreLayout, ensureRuntime, findInstallDir, importCorePackage, readJson, run, stableJson,
} from './lib/runtime.mjs'

const SKILL_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKILL = { name: 'dsh-plugin-upgrade-compat', version: '1.0.0' }

try {
  const options = parseArgs(process.argv.slice(2))
  const installDir = findInstallDir(options.core)
  ensureRuntime(process.argv.slice(2), coreLayout(installDir))
  const report = await scan(options, installDir)
  emit(report, options)
} catch (error) {
  process.stderr.write(`compat-scan: ${String(error && error.stack ? error.stack : error)}\n`)
  process.exitCode = 2
}

// ------------------------------------------------------------------- scan

async function scan(options, installDir) {
  const config = readJson(join(SKILL_ROOT, 'scripts', 'config.json'))
  const rules = readRules()
  const core = buildCoreSurface({ core: installDir })
  core.cli = detectCli(core)
  const compat = await loadCompat(core)
  const discovery = discoverPlugins({ config, corePackages: core.packages, dshHome: home() })
  let plugins = discovery.plugins
  if (options.only !== undefined) plugins = plugins.filter((plugin) => plugin.name.includes(options.only))

  // Pass 1: slots any installed plugin declares, so cross-plugin injection resolves.
  const externalSlots = new Set()
  for (const plugin of discovery.plugins) collectSlots(plugin, externalSlots)

  // Pass 2: analyze.
  const analyzed = []
  for (const plugin of plugins) {
    const loadProbe = (candidate) => probePlugin(candidate, core, { timeoutMs: 30_000 })
    const result = analyzePlugin({
      plugin,
      core,
      config,
      isPluginName: (name) => plugins.some((candidate) => candidate.name === name) || discovery.plugins.some((candidate) => candidate.name === name),
      externalSlots,
      compat,
      rules,
      runTests: options.noTests !== true && config.checks?.runPluginTests !== false,
      loadProbe,
    })
    if (!plugin.drift.identical) {
      result.findings.unshift({
        check: 'copy.drift',
        status: 'DEGRADED',
        message: `Copies of this plugin differ: ${plugin.drift.changed.slice(0, 3).map((change) => change.file).join(', ')}${plugin.drift.changed.length > 3 ? ` (+${plugin.drift.changed.length - 3} more)` : ''}`,
        evidence: plugin.drift.changed[0]?.roots.join(' vs '),
        ruleId: null,
        fix: 'Decide which copy is authoritative (live vs repository) and sync the other before adapting.',
      })
    }
    result.findings = result.findings.sort((left, right) => left.check < right.check ? -1 : left.check > right.check ? 1 : 0)
    result.status = summarize(result.findings)
    analyzed.push(result)
  }
  analyzed.sort((left, right) => (left.name < right.name ? -1 : 1))

  const baseline = loadBaseline(options, core)
  const report = {
    schemaVersion: 1,
    skill: {
      name: SKILL.name,
      version: SKILL.version,
      rulesVersion: rules.rulesVersion,
      ruleCount: rules.rules.length,
    },
    core: {
      version: core.version,
      installDir: core.installDir,
      cliVersion: core.cli.version,
      cliVersionSource: core.cli.source,
      pathCli: core.cli.path,
      node: process.versions.node,
      packages: Object.keys(core.packages).length,
      catalogs: Object.fromEntries(Object.entries(core.catalogs).map(([key, value]) => [key, Array.isArray(value) ? value.length : value])),
    },
    discovery: {
      profiles: profileDirs(),
      roots: config.discovery?.sourceRoots ?? [],
      skipped: discovery.skipped,
    },
    plugins: analyzed,
    summary: {
      OK: analyzed.filter((plugin) => plugin.status === 'OK').length,
      DEGRADED: analyzed.filter((plugin) => plugin.status === 'DEGRADED').length,
      BROKEN: analyzed.filter((plugin) => plugin.status === 'BROKEN').length,
      total: analyzed.length,
    },
    fixList: rankFindings(analyzed),
    diff: baseline === undefined ? null : diffBaseline(baseline, core, analyzed, options),
  }
  if (report.diff !== null) {
    // Baseline evidence upgrades review items to hard breaks when the catalog
    // entry they depend on disappeared in this core version, and marks issues
    // that already existed before this upgrade so they do not mask regressions.
    applyBaselineSeverity(report, baseline)
    for (const plugin of report.plugins) {
      if (plugin.status !== 'OK' && baseline.plugins?.[plugin.name] === plugin.status) plugin.preExisting = true
    }
    report.fixList = rankFindings(report.plugins)
    report.summary = {
      OK: report.plugins.filter((plugin) => plugin.status === 'OK').length,
      DEGRADED: report.plugins.filter((plugin) => plugin.status === 'DEGRADED').length,
      BROKEN: report.plugins.filter((plugin) => plugin.status === 'BROKEN').length,
      total: report.plugins.length,
    }
  }
  if (options.writeBaseline === true) writeBaseline(report, core)
  return report
}

function summarize(findings) {
  if (findings.some((finding) => finding.status === 'BROKEN')) return 'BROKEN'
  if (findings.some((finding) => finding.status === 'DEGRADED' || finding.status === 'NEEDS_MANUAL')) return 'DEGRADED'
  return 'OK'
}

function collectSlots(plugin, out) {
  const root = plugin.primaryRoot
  const files = [join(root, 'client.js'), join(root, 'client.mjs')]
  for (const file of files) {
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/slots\.register\(\s*\{[\s\S]{0,500}?name:\s*['"]([^'"]+)['"]/g)) out.add(match[1])
    for (const match of text.matchAll(/children:\s*\{([\s\S]{0,800}?)\n\s*\}/g)) {
      for (const child of match[1].matchAll(/['"]([^'"]+)['"]\s*:\s*\{/g)) out.add(child[1])
    }
  }
}

// ------------------------------------------------------------------ compat

async function loadCompat(core) {
  const semver = loadSemver(core.layout)
  let appBoot
  try {
    appBoot = await importCorePackage(core.layout, '@deepseek-ai/dsh-app-boot')
  } catch {
    appBoot = undefined
  }
  const exemptions = {}
  for (const profile of profileDirs()) {
    try {
      const read = appBoot?.readProfileVersionExemptions
      if (typeof read !== 'function') continue
      Object.assign(exemptions, read(profile.path))
    } catch {
      // A malformed compatibility file must not stop the scan; the host will
      // report it when it loads the profile.
    }
  }
  return {
    exemptions,
    evaluate: appBoot?.evaluatePluginCompatibility,
    satisfiesNode: semver === undefined ? undefined : (range) => semver.satisfies(process.versions.node, range, { includePrerelease: true }),
  }
}

function loadSemver(layout) {
  try {
    const require = createRequire(join(layout.nodeModules, 'noop.cjs'))
    return require('semver')
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- baseline

function baselineFile() {
  return join(SKILL_ROOT, 'baseline', 'latest.json')
}

function loadBaseline(options, core) {
  if (options.baseline === 'none') return undefined
  const file = options.baseline !== undefined ? resolve(options.baseline) : baselineFile()
  if (!existsSync(file)) return undefined
  try {
    const parsed = readJson(file)
    return { ...parsed, file, coreVersion: parsed.coreVersion ?? core.version }
  } catch {
    return undefined
  }
}

function writeBaseline(report, core) {
  const baseline = {
    schemaVersion: 1,
    coreVersion: core.version,
    packages: Object.fromEntries(Object.entries(core.packages).map(([name, entry]) => [name, entry.version])),
    catalogs: {
      hostServices: core.catalogs.hostServices.map((entry) => entry.name),
      clientServices: core.catalogs.clientServices.map((entry) => entry.name),
      events: core.catalogs.events.map((entry) => entry.name),
      slots: core.catalogs.slots.map((entry) => entry.name),
      tools: core.catalogs.tools.map((entry) => entry.name),
    },
    plugins: Object.fromEntries(report.plugins.map((plugin) => [plugin.name, plugin.status])),
  }
  const dir = join(SKILL_ROOT, 'baseline')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `core-${core.version}.json`), stableJson(baseline))
  writeFileSync(baselineFile(), stableJson(baseline))
}

function diffBaseline(baseline, core, plugins, options) {
  const current = {
    packages: Object.fromEntries(Object.entries(core.packages).map(([name, entry]) => [name, entry.version])),
    catalogs: {
      hostServices: core.catalogs.hostServices.map((entry) => entry.name),
      clientServices: core.catalogs.clientServices.map((entry) => entry.name),
      events: core.catalogs.events.map((entry) => entry.name),
      slots: core.catalogs.slots.map((entry) => entry.name),
      tools: core.catalogs.tools.map((entry) => entry.name),
    },
  }
  const removed = {}
  const added = {}
  for (const key of ['hostServices', 'clientServices', 'events', 'slots', 'tools']) {
    const before = new Set(baseline.catalogs?.[key] ?? [])
    const after = new Set(current.catalogs[key])
    removed[key] = [...before].filter((name) => !after.has(name)).sort()
    added[key] = [...after].filter((name) => !before.has(name)).sort()
  }
  removed.packages = Object.keys(baseline.packages ?? {}).filter((name) => current.packages[name] === undefined).sort()
  added.packages = Object.keys(current.packages).filter((name) => baseline.packages?.[name] === undefined).sort()
  const statusChanges = []
  for (const plugin of plugins) {
    const before = baseline.plugins?.[plugin.name]
    if (before !== undefined && before !== plugin.status) statusChanges.push({ name: plugin.name, before, after: plugin.status })
  }
  return {
    baseline: options.baseline !== undefined ? resolve(options.baseline) : baselineFile(),
    coreVersion: baseline.coreVersion,
    removed,
    added,
    statusChanges,
  }
}

function applyBaselineSeverity(report, baseline) {
  const eventSet = new Set(baseline.catalogs?.events ?? [])
  const slotSet = new Set(baseline.catalogs?.slots ?? [])
  for (const plugin of report.plugins) {
    for (const finding of plugin.findings) {
      const match = finding.message.match(/(?:event|slot) "([^"]+)"/)
      if (match === null) continue
      const known = finding.check === 'event.unknown' ? eventSet.has(match[1]) : slotSet.has(match[1])
      if (!known) continue
      finding.status = 'BROKEN'
      finding.message += ` (present in baseline core ${baseline.coreVersion}, removed in this core)`
    }
    plugin.status = summarize(plugin.findings)
  }
}

// ------------------------------------------------------------------- emit

function emit(report, options) {
  const jsonPath = options.json ?? join(SKILL_ROOT, 'reports', 'report.json')
  const mdPath = options.md ?? join(SKILL_ROOT, 'reports', 'report.md')
  mkdirSync(dirname(jsonPath), { recursive: true })
  writeFileSync(jsonPath, stableJson(report))
  writeFileSync(mdPath, renderMarkdown(report))
  if (options.quiet !== true) {
    process.stdout.write(`${renderConsole(report)}\n`)
    process.stdout.write(`report: ${jsonPath}\n        ${mdPath}\n`)
  }
  // Source-only copies that no profile loads are reported but do not gate a
  // core upgrade; only installed plugins can break the running host.
  const installedBroken = report.plugins.some((plugin) => plugin.installed && plugin.status === 'BROKEN'
    && (options.failOnPreexisting === true || plugin.preExisting !== true))
  const installedDegraded = report.plugins.some((plugin) => plugin.installed && plugin.status === 'DEGRADED')
  if (installedBroken || (options.strict === true && installedDegraded)) process.exitCode = 1
}

function readRules() {
  const path = join(SKILL_ROOT, 'scripts', 'rules.json')
  if (!existsSync(path)) return { rulesVersion: 'none', rules: [] }
  return readJson(path)
}

/**
 * Report the CLI that belongs to the running installation first. `dsh` on PATH
 * may be a different (source or npm) installation, which would mislabel the
 * core this report actually describes.
 */
function detectCli(core) {
  const own = join(core.installDir, 'lib', 'bin.js')
  if (existsSync(own)) {
    const result = run(process.execPath, [own, '--version'], {
      timeoutMs: 60_000,
      env: core.layout.asar ? { ELECTRON_RUN_AS_NODE: '1' } : {},
    })
    const version = result.status === 0 ? result.stdout.trim().split('\n').pop() : undefined
    if (version !== undefined) return { version, source: 'installation', path: pathCli(core.version) }
  }
  const fromPath = pathCli(undefined)
  return { version: fromPath?.version, source: fromPath === undefined ? undefined : 'PATH', path: fromPath }
}

function pathCli(coreVersion) {
  const probe = run('dsh', ['--version'], { timeoutMs: 20_000 })
  if (probe.status !== 0) return null
  const version = probe.stdout.trim().split('\n').pop()
  return { version, matchesCore: version === coreVersion }
}

function profileDirs() {
  const root = join(dshHome(), 'profiles')
  if (!existsSync(root)) return []
  return readdirSync(root)
    .sort()
    .map((name) => ({ name, path: join(root, name) }))
    .filter((entry) => existsSync(join(entry.path, 'package.json')))
}

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function home() {
  return dshHome()
}

// -------------------------------------------------------------------- args

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`${arg} requires a value`)
      index += 1
      return value
    }
    switch (arg) {
      case '--core': options.core = next(); break
      case '--json': options.json = resolve(next()); break
      case '--md': options.md = resolve(next()); break
      case '--only': options.only = next(); break
      case '--baseline': options.baseline = next(); break
      case '--write-baseline': options.writeBaseline = true; break
      case '--no-tests': options.noTests = true; break
      case '--strict': options.strict = true; break
      case '--fail-on-preexisting': options.failOnPreexisting = true; break
      case '--quiet': options.quiet = true; break
      case '--help':
      case '-h':
        process.stdout.write(usage())
        process.exit(0)
        break
      default:
        throw new Error(`unknown argument ${arg}\n\n${usage()}`)
    }
  }
  return options
}

function usage() {
  return [
    'Usage: node compat-scan.mjs [options]',
    '',
    '  --core <dir>       @deepseek-ai/dsh package dir (defaults to $DSH_INSTALL_DIR)',
    '  --json <file>      report JSON path (default reports/report.json)',
    '  --md <file>        report Markdown path (default reports/report.md)',
    '  --only <text>      scan only plugins whose name contains <text>',
    '  --baseline <file>  compare against a baseline (default baseline/latest.json, "none" disables)',
    '  --write-baseline   record this core surface as the new baseline',
    '  --no-tests         skip plugin test suites',
    '  --strict           exit 1 when any plugin is DEGRADED',
    '  --fail-on-preexisting  exit 1 even for a BROKEN plugin the baseline already recorded',
    '  --quiet            do not print the console summary',
    '',
  ].join('\n')
}

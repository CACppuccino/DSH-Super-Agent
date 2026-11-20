import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { analyzePlugin, scanSpecifiers } from '../scripts/lib/analyze.mjs'
import { discoverPlugins } from '../scripts/lib/plugins.mjs'
import { applyRule, matchRule } from '../scripts/lib/rules.mjs'
import { parseModuleExports } from '../scripts/lib/core-surface.mjs'
import { resolveExportsTarget, stableJson } from '../scripts/lib/runtime.mjs'

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`))
}

function writePlugin(files) {
  const root = tempDir('compat-plugin')
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  return root
}

function baseCore(overrides = {}) {
  return {
    version: '9.9.9',
    installDir: '/tmp/fake-core',
    packages: {
      '@deepseek-ai/dsh': { version: '9.9.9', dir: '/tmp/fake-core', exports: { '.': './lib/index.js' }, symbols: ['apply'] },
    },
    catalogs: {
      hostServices: [{ name: 'tools' }, { name: 'agents' }],
      clientServices: [{ name: 'slots' }, { name: 'locale' }],
      events: [{ name: 'agent/created' }],
      slots: [{ name: 'main' }],
      tools: [{ name: 'bash' }],
      staticModules: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
      routeKinds: ['exact', 'prefix'],
      routes: [{ kind: 'prefix', path: '/api' }],
    },
    ...overrides,
  }
}

const RULES = {
  rulesVersion: 'test',
  rules: [
    {
      id: 'test-web-runtime',
      kind: 'rename-service',
      match: { check: 'service.inject', service: 'webRuntime' },
      replace: { old: 'webRuntime', new: 'webStartup', scope: 'service-name' },
      source: 'docs/upgrade-guide/test.md',
    },
    {
      id: 'test-account-controller',
      kind: 'rename-service-access',
      match: { check: 'service.optional', service: 'accountController' },
      replace: { old: 'accountController', new: 'deepseekAccount', scope: 'ctx.get-argument' },
      unlessPresent: 'deepseekAccount',
      source: 'docs/upgrade-guide/test.md',
    },
  ],
}

function analyzeFixture(root, core = baseCore(), rules = RULES, loadProbe = () => ({ status: 'PASS', entry: join(root, 'index.js') })) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  return analyzePlugin({
    plugin: { name: manifest.name, version: manifest.version, kind: 'bundle+host', manifest, primaryRoot: root, roots: [{ path: root, role: 'live' }], drift: { identical: true, changed: [] } },
    core,
    config: { checks: {} },
    compat: undefined,
    rules,
    runTests: false,
    loadProbe,
  })
}

// ------------------------------------------------------------------ parsing

test('scanSpecifiers reports static, aliased, require, and dynamic imports with lines', () => {
  const source = [
    "import { A, B as C } from '@deepseek-ai/dsh-one'",
    "import def from '@deepseek-ai/dsh-two'",
    "import * as ns from '@deepseek-ai/dsh-three'",
    "import type { T } from '@deepseek-ai/dsh-four'",
    "const x = require('dsh/internal/path')",
    "const y = await import('@deepseek-ai/dsh-five')",
    "// @param {{ ctx: import('@deepseek-ai/dsh-six').Context }}",
  ].join('\n')
  const specs = scanSpecifiers(source)
  const byPackage = new Map(specs.map((spec) => [spec.specifier, spec]))
  assert.deepEqual(byPackage.get('@deepseek-ai/dsh-one').names, ['A', 'B'])
  assert.deepEqual(byPackage.get('@deepseek-ai/dsh-two').names, ['default'])
  assert.deepEqual(byPackage.get('@deepseek-ai/dsh-three').names, [])
  assert.deepEqual(byPackage.get('@deepseek-ai/dsh-four').names, ['T'])
  assert.equal(byPackage.get('@deepseek-ai/dsh-one').line, 1)
  assert.equal(byPackage.get('dsh/internal/path').kind, 'require')
  assert.equal(byPackage.get('dsh/internal/path').line, 5)
  assert.equal(byPackage.get('@deepseek-ai/dsh-five').kind, 'dynamic')
  assert.equal(byPackage.get('@deepseek-ai/dsh-six').line, 7)
})

test('parseModuleExports reads export lists, defaults, and re-exports', () => {
  const dir = tempDir('compat-exports')
  writeFileSync(join(dir, 'other.js'), 'export function helper() {}\n')
  const entry = join(dir, 'index.js')
  writeFileSync(entry, [
    'export { A, B as C, A as default }',
    'export function fn() {}',
    'export const value = 1',
    "export * from './other.js'",
  ].join('\n'))
  const parsed = parseModuleExports(entry)
  assert.deepEqual(parsed.names, ['A', 'C', 'default', 'fn', 'value', 'helper'].sort())
  assert.equal(parsed.type, 'esm')

  const cjsDir = tempDir('compat-cjs')
  const cjsEntry = join(cjsDir, 'index.js')
  writeFileSync(cjsEntry, 'exports.alpha = 1\nmodule.exports.beta = 2\n')
  const cjs = parseModuleExports(cjsEntry)
  assert.deepEqual(cjs.names, ['alpha', 'beta'])
  assert.equal(cjs.type, 'cjs')
})

test('resolveExportsTarget handles conditions, wildcards, and unknown subpaths', () => {
  const dir = '/tmp/pkg'
  const exported = { '.': { types: './lib/types/index.d.ts', default: './lib/index.js' }, './locale/*.json': './locale/*.json' }
  assert.equal(resolveExportsTarget(exported, '.', dir), join(dir, 'lib/index.js'))
  assert.equal(resolveExportsTarget(exported, './locale/en.json', dir), join(dir, 'locale/en.json'))
  assert.equal(resolveExportsTarget(exported, './nope', dir), undefined)
})

// ------------------------------------------------------------------- rules

test('applyRule rewrites only its declared scope', () => {
  const serviceRule = { replace: { old: 'webRuntime', new: 'webStartup', scope: 'service-name' } }
  assert.equal(applyRule("inject: ['webRuntime']", serviceRule), "inject: ['webStartup']")
  assert.equal(applyRule('ctx.webRuntime.trustedHosts', serviceRule), 'ctx.webStartup.trustedHosts')
  assert.equal(applyRule('const webRuntimeThing = 1', serviceRule), 'const webRuntimeThing = 1')

  const getRule = { replace: { old: 'accountController', new: 'deepseekAccount', scope: 'ctx.get-argument' } }
  assert.equal(applyRule("ctx.get('accountController')", getRule), "ctx.get('deepseekAccount')")

  const packageRule = { replace: { old: '@deepseek-ai/dsh-office-to-pdf', new: '@deepseek-ai/dsh-office-kit', scope: 'package' } }
  assert.equal(applyRule("import { x } from '@deepseek-ai/dsh-office-to-pdf'", packageRule), "import { x } from '@deepseek-ai/dsh-office-kit'")
  assert.equal(applyRule("from '@deepseek-ai/dsh-office-to-pdf/types'", packageRule), "from '@deepseek-ai/dsh-office-kit/types'")
  assert.equal(applyRule("const s = '@deepseek-ai/dsh-office-to-pdfx'", packageRule), "const s = '@deepseek-ai/dsh-office-to-pdfx'")

  const propertyRule = { replace: { old: 'updatable', new: 'update', scope: 'property' } }
  assert.equal(applyRule('bundle.updatable', propertyRule), 'bundle.update')
  assert.equal(applyRule('const updatable = 1', propertyRule), 'const updatable = 1')

  const defaultRule = { replace: { old: '@deepseek-ai/dsh-session-persistence-jsonl', new: 'Jsonl', scope: 'import-clause' } }
  assert.equal(
    applyRule("import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'", defaultRule),
    "import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'",
  )
})

test('matchRule honours structured fields and manual rules', () => {
  const finding = { check: 'service.inject', service: 'webRuntime', message: 'x' }
  assert.deepEqual(matchRule(RULES, finding), { id: 'test-web-runtime', automated: true })
  assert.deepEqual(matchRule(RULES, { check: 'service.inject', service: 'other', message: 'x' }), undefined)
  const manual = { rules: [{ id: 'm', kind: 'manual', match: { check: 'x' } }] }
  assert.deepEqual(matchRule(manual, { check: 'x' }), { id: 'm', automated: false })
})

test('a rule detect pattern flags deprecated usage with rule provenance', () => {
  const root = writePlugin({
    'package.json': JSON.stringify({ name: 'detect-fixture', version: '1.0.0', type: 'module', exports: { '.': './index.js' }, engines: { dsh: '>=9.0.0' } }, null, 2),
    'index.js': "export const name = 'd'\nexport function apply(bundle) { return bundle.updatable }\n",
  })
  const detectRules = {
    rulesVersion: 'test',
    rules: [{
      id: 'test-updatable',
      kind: 'rename-field',
      match: { check: 'api.renamed-property' },
      replace: { old: 'updatable', new: 'update', scope: 'property' },
      detect: { pattern: '\\.updatable\\b', check: 'api.renamed-property', status: 'DEGRADED', message: 'updatable is gone' },
      source: 'docs/upgrade-guide/test/guide.md',
    }, {
      id: 'test-removed-call',
      kind: 'manual',
      match: { check: 'api.removed-method' },
      replace: { old: 'gone', new: '', scope: 'method-name' },
      detect: { pattern: 'ctx\\.gone\\s*\\(', check: 'api.removed-method', status: 'BROKEN', message: 'gone() was removed' },
      source: 'docs/upgrade-guide/test/guide.md',
    }],
  }
  const root2 = writePlugin({
    'package.json': JSON.stringify({ name: 'detect-manual', version: '1.0.0', type: 'module', exports: { '.': './index.js' }, engines: { dsh: '>=9.0.0' } }, null, 2),
    'index.js': "export const name = 'd'\nexport function apply(ctx) { return ctx.gone() }\n",
  })
  const automated = analyzeFixture(root, baseCore(), detectRules)
  const finding = automated.findings.find((entry) => entry.check === 'api.renamed-property')
  assert.equal(finding.ruleId, 'test-updatable')
  assert.match(finding.evidence, /^index\.js:2$/)
  const manual = analyzeFixture(root2, baseCore(), detectRules)
  const removed = manual.findings.find((entry) => entry.check === 'api.removed-method')
  assert.equal(removed.ruleId, null)
  assert.equal(removed.manualRuleId, 'test-removed-call')
})

// --------------------------------------------------------------- analysis

test('analyzePlugin flags removed packages, services, events, client modules, and slots', () => {
  const root = writePlugin({
    'package.json': JSON.stringify({
      name: 'fixture-plugin',
      version: '1.0.0',
      type: 'module',
      exports: { '.': './index.js', './client': './client.js' },
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        client: { platform: 'web', inject: ['@deepseek-ai/dsh-gone-client'] },
      },
      engines: { dsh: '>=9.0.0' },
    }, null, 2),
    'cordis.patch.yml': '- insert: []\n',
    'index.js': [
      "import { nope } from '@deepseek-ai/dsh-removed'",
      "export const name = 'fixture'",
      "export const inject = ['tools', 'missingService']",
      "export function apply(ctx) {",
      "  ctx.on('agent/created', () => {})",
      "  ctx.on('gone/event', () => {})",
      "  const legacy = ctx.get('accountController')",
      '}',
    ].join('\n'),
    'client.js': [
      'const x = require("@deepseek-ai/dsh-gone-client")',
      "export const apply = (ctx) => { ctx.slots.inject('gone.slot', () => {}) }",
      "export const inject = ['slots', 'goneService']",
    ].join('\n'),
  })
  const result = analyzeFixture(root)
  const checks = result.findings.map((finding) => `${finding.status}:${finding.check}`)
  assert.ok(checks.includes('BROKEN:import.package'), checks.join(','))
  assert.ok(checks.includes('BROKEN:service.inject'), checks.join(','))
  assert.ok(checks.includes('DEGRADED:event.unknown'), checks.join(','))
  assert.ok(checks.includes('BROKEN:client.inject.module'), checks.join(','))
  assert.ok(checks.includes('DEGRADED:client.slot'), checks.join(','))
  assert.ok(checks.includes('DEGRADED:client.inject.service'), checks.join(','))
  assert.ok(checks.includes('DEGRADED:service.optional'), checks.join(','))
  assert.equal(result.status, 'BROKEN')
  const eventFinding = result.findings.find((finding) => finding.check === 'event.unknown')
  assert.equal(eventFinding.event, 'gone/event')
  assert.match(eventFinding.evidence, /^index\.js:\d+$/)
})

test('analyzePlugin reports a clean plugin as OK and applies no rules', () => {
  const root = writePlugin({
    'package.json': JSON.stringify({
      name: 'clean-plugin',
      version: '1.0.0',
      type: 'module',
      exports: { '.': './index.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', inject: ['react'] } },
      engines: { dsh: '>=9.0.0' },
    }, null, 2),
    'cordis.patch.yml': '- insert: []\n',
    'index.js': "export const name = 'clean'\nexport const inject = ['tools']\nexport function apply(ctx) { ctx.on('agent/created', () => {}) }\n",
  })
  const result = analyzeFixture(root)
  assert.deepEqual(result.findings, [])
  assert.equal(result.status, 'OK')
})

test('analyzePlugin flags a broken host entry when the load probe fails', () => {
  const root = writePlugin({
    'package.json': JSON.stringify({ name: 'load-broken', version: '1.0.0', type: 'module', exports: { '.': './index.js' }, engines: { dsh: '>=9.0.0' } }, null, 2),
    'index.js': 'export const name = 1\n',
  })
  const result = analyzeFixture(root, baseCore(), RULES, () => ({ status: 'FAIL', entry: join(root, 'index.js'), firstError: 'module exports `apply` as undefined' }))
  assert.ok(result.findings.some((finding) => finding.check === 'runtime.load' && finding.status === 'BROKEN'))
})

test('analysis output is deterministic', () => {
  const root = writePlugin({
    'package.json': JSON.stringify({ name: 'deterministic', version: '1.0.0', type: 'module', exports: { '.': './index.js' }, engines: { dsh: '>=9.0.0' } }, null, 2),
    'index.js': "import { x } from '@deepseek-ai/dsh-gone'\nexport const name = 'd'\nexport function apply() {}\n",
  })
  const first = stableJson(analyzeFixture(root))
  const second = stableJson(analyzeFixture(root))
  assert.equal(first, second)
})

test('discovery skips a source example marked with .dsh-compat-ignore', () => {
  const root = writePlugin({
    'package.json': JSON.stringify({ name: 'dsh-example', version: '0.0.1', exports: { '.': './index.js' } }, null, 2),
    'index.js': 'export const name = "dsh-example"\n',
  })
  const dshHome = tempDir('compat-home')
  const config = {
    discovery: {
      profilesRoot: join(dshHome, 'profiles'),
      sourceRoots: [{ path: root, depth: 0, role: 'workspace' }],
    },
  }
  const before = discoverPlugins({ config, corePackages: {}, dshHome })
  assert.equal(before.plugins.length, 1)
  assert.equal(before.plugins[0].name, 'dsh-example')

  writeFileSync(join(root, '.dsh-compat-ignore'), 'non-installable sample\n')
  const after = discoverPlugins({ config, corePackages: {}, dshHome })
  assert.equal(after.plugins.length, 0)
  assert.ok(after.skipped.some((entry) => entry.reason === 'non-installable source example (.dsh-compat-ignore)'))
})

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const SKILL_ROOT = fileURLToPath(new URL('..', import.meta.url))
const ADAPT = join(SKILL_ROOT, 'scripts', 'compat-adapt.mjs')
const SCAN = join(SKILL_ROOT, 'scripts', 'compat-scan.mjs')
const RULES = JSON.parse(readFileSync(join(SKILL_ROOT, 'scripts', 'rules.json'), 'utf8'))

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`))
}

function fixture(options = {}) {
  const { testScript = 'node -e "process.exit(0)"', source } = options
  const root = tempDir('compat-adapt')
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'adapt-fixture',
    version: '1.0.0',
    type: 'module',
    scripts: { test: testScript },
  }, null, 2))
  writeFileSync(join(root, 'index.js'), source ?? [
    "export const name = 'adapt-fixture'",
    "export const inject = ['webRuntime']",
    'export function apply(ctx) {',
    '  return ctx.webRuntime.trustedHosts',
    '}',
  ].join('\n'))
  return root
}

function reportFor(root, findings, installDir = '/nonexistent-core') {
  const report = {
    schemaVersion: 1,
    skill: { name: 'dsh-plugin-upgrade-compat', version: 'test', rulesVersion: RULES.rulesVersion, ruleCount: RULES.rules.length },
    core: { version: '0.2.2-rc.3', installDir, cliVersion: '0.2.2-rc.3', node: process.versions.node, packages: 1, catalogs: {} },
    discovery: { profiles: [], roots: [], skipped: [] },
    plugins: [{
      name: 'adapt-fixture',
      version: '1.0.0',
      kind: 'host',
      installed: true,
      primaryRoot: root,
      status: 'BROKEN',
      roots: [{ path: root, role: 'live' }],
      copy: { identical: true, changed: [] },
      findings,
      checks: { imports: 0, files: 1 },
      runtime: { load: { status: 'PASS' }, tests: { status: 'SKIPPED' } },
    }],
    summary: { OK: 0, DEGRADED: 0, BROKEN: 1, total: 1 },
    fixList: [],
    diff: null,
  }
  const path = join(root, 'report.json')
  writeFileSync(path, JSON.stringify(report, null, 2))
  return path
}

function runAdapt(args) {
  return spawnSync(process.execPath, [ADAPT, ...args], { encoding: 'utf8', timeout: 120_000 })
}

const WEB_RUNTIME_FINDING = {
  check: 'service.inject',
  status: 'BROKEN',
  service: 'webRuntime',
  message: 'inject requires service "webRuntime", which core 0.2.2-rc.3 does not provide',
  evidence: 'index.js:2',
  ruleId: 'dsh-0.2.1a1-web-runtime-service',
}

test('dry run plans an edit but leaves the file untouched', () => {
  const root = fixture()
  const before = readFileSync(join(root, 'index.js'), 'utf8')
  const report = reportFor(root, [WEB_RUNTIME_FINDING])
  const json = join(root, 'adapt.json')
  const result = runAdapt(['--report', report, '--json', json, '--md', join(root, 'adapt.md')])
  assert.equal(result.status, 0, result.stderr)
  const summary = JSON.parse(readFileSync(json, 'utf8'))
  assert.equal(summary.mode, 'dry-run')
  assert.equal(summary.applied, false)
  assert.equal(summary.edits.length, 1)
  assert.equal(summary.edits[0].ruleId, 'dsh-0.2.1a1-web-runtime-service')
  assert.ok(summary.edits[0].changes.length >= 2)
  assert.equal(readFileSync(join(root, 'index.js'), 'utf8'), before)
})

test('--apply restores every file when the plugin tests fail', () => {
  const root = fixture({ testScript: 'node -e "process.exit(3)"' })
  const before = readFileSync(join(root, 'index.js'), 'utf8')
  const report = reportFor(root, [WEB_RUNTIME_FINDING])
  const json = join(root, 'adapt.json')
  const result = runAdapt(['--report', report, '--apply', '--allow-dirty', '--json', json, '--md', join(root, 'adapt.md')])
  assert.equal(result.status, 1)
  const summary = JSON.parse(readFileSync(json, 'utf8'))
  assert.equal(summary.aborted, true)
  assert.equal(summary.restored, true)
  assert.match(summary.abortReason, /tests failed|exit 3/)
  assert.equal(readFileSync(join(root, 'index.js'), 'utf8'), before)
})

test('--apply edits the file when the plugin tests pass', () => {
  const root = fixture()
  const report = reportFor(root, [WEB_RUNTIME_FINDING])
  const json = join(root, 'adapt.json')
  const result = runAdapt(['--report', report, '--apply', '--allow-dirty', '--json', json, '--md', join(root, 'adapt.md')])
  assert.equal(result.status, 0, result.stderr)
  const summary = JSON.parse(readFileSync(json, 'utf8'))
  assert.equal(summary.applied, true)
  assert.equal(summary.aborted, false)
  assert.equal(summary.tests[0].status, 'PASS')
  const after = readFileSync(join(root, 'index.js'), 'utf8')
  assert.match(after, /ctx\.webStartup\.trustedHosts/)
  assert.match(after, /inject = \['webStartup'\]/)
  assert.doesNotMatch(after, /webRuntime/)
})

test('--apply refuses a dirty or non-git work tree without --allow-dirty', () => {
  const root = fixture()
  const before = readFileSync(join(root, 'index.js'), 'utf8')
  const report = reportFor(root, [WEB_RUNTIME_FINDING])
  const json = join(root, 'adapt.json')
  const result = runAdapt(['--report', report, '--apply', '--json', json, '--md', join(root, 'adapt.md')])
  assert.equal(result.status, 1)
  const summary = JSON.parse(readFileSync(json, 'utf8'))
  assert.equal(summary.aborted, true)
  assert.match(summary.abortReason, /allow-dirty/)
  assert.equal(readFileSync(join(root, 'index.js'), 'utf8'), before)
})

test('a rule with unlessPresent skips an already migrated file', () => {
  const root = fixture({
    source: [
      "export const name = 'adapt-fixture'",
      "const current = ctx.get('deepseekAccount')",
      "const legacy = ctx.get('accountController')",
    ].join('\n'),
  })
  const before = readFileSync(join(root, 'index.js'), 'utf8')
  const report = reportFor(root, [{
    check: 'service.optional',
    status: 'DEGRADED',
    service: 'accountController',
    message: 'Reads optional service "accountController", which is not declared by core 0.2.2-rc.3',
    evidence: 'index.js:3',
    ruleId: 'dsh-0.2.2rc1-account-controller-service',
  }])
  const json = join(root, 'adapt.json')
  const result = runAdapt(['--report', report, '--apply', '--allow-dirty', '--json', json, '--md', join(root, 'adapt.md')])
  assert.equal(result.status, 0, result.stderr)
  const summary = JSON.parse(readFileSync(json, 'utf8'))
  assert.equal(summary.edits.length, 0)
  assert.match(summary.skipped[0].reason, /already migrated/)
  assert.equal(readFileSync(join(root, 'index.js'), 'utf8'), before)
})

test('findings without a rule are reported as NEEDS_MANUAL, never edited', () => {
  const root = fixture()
  const report = reportFor(root, [{
    check: 'service.inject',
    status: 'BROKEN',
    service: 'mysteryService',
    message: 'inject requires service "mysteryService", which core 0.2.2-rc.3 does not provide',
    evidence: 'index.js:2',
    ruleId: null,
  }])
  const json = join(root, 'adapt.json')
  const result = runAdapt(['--report', report, '--apply', '--allow-dirty', '--json', json, '--md', join(root, 'adapt.md')])
  assert.equal(result.status, 0, result.stderr)
  const summary = JSON.parse(readFileSync(json, 'utf8'))
  assert.equal(summary.edits.length, 0)
  assert.equal(summary.needsManual.length, 1)
  assert.equal(summary.needsManual[0].service, undefined)
  assert.match(summary.needsManual[0].message, /mysteryService/)
})

test('every rule stays versioned, sourced, and unique', () => {
  assert.ok(RULES.rules.length >= 8)
  assert.match(RULES.rulesVersion, /^\d{4}-\d{2}-\d{2}\.\d+$/)
  const ids = new Set()
  for (const rule of RULES.rules) {
    assert.equal(typeof rule.id, 'string')
    assert.ok(!ids.has(rule.id), `duplicate rule ${rule.id}`)
    ids.add(rule.id)
    assert.equal(typeof rule.kind, 'string')
    assert.match(rule.since, /^\d+\.\d+\.\d+/)
    assert.equal(typeof rule.source, 'string')
    assert.match(rule.source, /^docs\/upgrade-guide\/v[^/]+\/.+\/guide\.md$/)
    assert.equal(typeof rule.replace?.old, 'string')
    assert.equal(typeof rule.replace?.new, 'string')
  }
})

test('rule sources exist in the running installation when its docs are readable', (t) => {
  const installDir = process.env.DSH_INSTALL_DIR
  const docs = installDir === undefined ? undefined : join(installDir, 'docs', 'upgrade-guide')
  if (docs === undefined || !existsSync(docs)) {
    t.skip('DSH_INSTALL_DIR or its docs tree is not readable from this runtime')
    return
  }
  for (const rule of RULES.rules) {
    const path = join(docs, rule.source.replace(/^docs\/upgrade-guide\//, ''))
    assert.ok(existsSync(path), `${rule.id}: ${rule.source} is missing`)
  }
})

test('scan output is byte-identical across runs', (t) => {
  const installDir = process.env.DSH_INSTALL_DIR
  if (installDir === undefined || !existsSync(join(installDir, 'package.json'))) {
    t.skip('the running DSH installation is not readable from this runtime')
    return
  }
  const dir = tempDir('compat-determinism')
  const first = join(dir, 'first.json')
  const second = join(dir, 'second.json')
  const env = { ...process.env }
  const args = ['--only', 'dsh-remote', '--no-tests', '--quiet']
  const runOnce = (json) => {
    const result = spawnSync(process.execPath, [SCAN, ...args, '--json', json, '--md', join(dir, 'out.md')], { encoding: 'utf8', env, timeout: 180_000 })
    assert.equal(result.status, 0, result.stderr)
  }
  runOnce(first)
  runOnce(second)
  assert.equal(readFileSync(first, 'utf8'), readFileSync(second, 'utf8'))
  const report = JSON.parse(readFileSync(first, 'utf8'))
  assert.equal(report.plugins.length, 1)
  assert.equal(report.plugins[0].name, 'dsh-remote')
  assert.match(JSON.stringify(report.plugins[0].findings), /accountController|OK/)
})

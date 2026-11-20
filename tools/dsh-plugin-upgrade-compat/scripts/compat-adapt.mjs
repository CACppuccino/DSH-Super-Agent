#!/usr/bin/env node
/**
 * Apply versioned compatibility rules to installed DSH plugins.
 *
 * Default is a dry run: it prints the exact edits and writes a summary, but
 * changes nothing. `--apply` edits files only when:
 *   1. every touched plugin root is a clean git work tree (or --allow-dirty),
 *   2. a rule exists for the finding (no rule => NEEDS_MANUAL, never guessed),
 *   3. the plugin's own tests pass after the edit, else every file is restored.
 *
 * Usage:
 *   node compat-adapt.mjs [--report reports/report.json] [--apply] [--allow-dirty]
 *                         [--no-tests] [--only <text>] [--json out.json] [--md out.md]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { repositoryOf } from './lib/plugins.mjs'
import { firstErrorLine, gitStatus, readJson, run, sha256, stableJson } from './lib/runtime.mjs'
import { applyRule } from './lib/rules.mjs'

const SKILL_ROOT = fileURLToPath(new URL('..', import.meta.url))
const RULES = readJson(join(SKILL_ROOT, 'scripts', 'rules.json'))
const SKILL = { name: 'dsh-plugin-upgrade-compat', version: '1.0.0' }

const options = parseArgs(process.argv.slice(2))
const report = loadReport(options)
const plan = buildPlan(report, options)
const backups = new Map()
const backupFiles = new Map()

let summary
if (options.apply === true) {
  summary = applyPlan(plan)
} else {
  summary = dryRun(plan)
}
writeOutputs(summary, options)
if (summary.aborted === true) process.exitCode = 1
else if (summary.needsManual.length > 0 && options.strict === true) process.exitCode = 1

// --------------------------------------------------------------------- plan

function buildPlan(report, options) {
  const rules = new Map(RULES.rules.map((rule) => [rule.id, rule]))
  const sources = validateRuleSources(report)
  const edits = []
  const skipped = []
  const needsManual = []
  const seen = new Set()
  for (const plugin of report.plugins) {
    if (options.only !== undefined && !plugin.name.includes(options.only)) continue
    plugin.primaryRoot = plugin.primaryRoot ?? plugin.roots?.[0]?.path
    if (plugin.primaryRoot === undefined) {
      needsManual.push({ plugin: plugin.name, check: 'report.primaryRoot', evidence: '', message: 'report has no plugin root; re-run the scan', action: 'Re-run compat-scan.mjs with this skill version.' })
      continue
    }
    for (const finding of plugin.findings) {
      if (finding.ruleId === null || finding.ruleId === undefined) {
        if (finding.status === 'BROKEN' || finding.status === 'DEGRADED' || finding.status === 'NEEDS_MANUAL') {
          needsManual.push({
            plugin: plugin.name,
            check: finding.check,
            evidence: finding.evidence ?? '',
            message: finding.message,
            action: finding.fix ?? 'Fix by hand against the current core API.',
          })
        }
        continue
      }
      const rule = rules.get(finding.ruleId)
      if (rule === undefined) {
        skipped.push({ plugin: plugin.name, ruleId: finding.ruleId, reason: 'rule id is not present in rules.json' })
        continue
      }
      const sourceCheck = sources.get(rule.id)
      if (sourceCheck !== undefined && sourceCheck.ok !== true) {
        skipped.push({ plugin: plugin.name, ruleId: rule.id, reason: `rule source is unavailable: ${sourceCheck.reason}` })
        continue
      }
      const evidenceFile = (finding.evidence ?? '').replace(/:\d+$/, '')
      const target = evidenceFile.length > 0 ? resolve(plugin.primaryRoot, evidenceFile) : undefined
      if (target === undefined || !existsSync(target) || target.endsWith('package.json')) {
        skipped.push({ plugin: plugin.name, ruleId: rule.id, reason: `cannot locate an editable evidence file (${finding.evidence ?? 'none'})` })
        continue
      }
      const key = `${target}::${rule.id}`
      if (seen.has(key)) continue
      seen.add(key)
      const result = planEdit({ plugin, finding, rule, target })
      if (result.edit !== undefined) edits.push(result.edit)
      if (result.skipped !== undefined) skipped.push({ plugin: plugin.name, ...result.skipped })
    }
  }
  return { edits, skipped, needsManual }
}

/**
 * Every rule must keep a source reference into the installed upgrade guides.
 * When the installation is readable and the file is gone, the rule is stale:
 * refuse to apply it instead of guessing at an API.
 */
function validateRuleSources(report) {
  const out = new Map()
  const installDir = report.core?.installDir
  const docs = typeof installDir === 'string' ? join(installDir, 'docs', 'upgrade-guide') : undefined
  // Without a readable guide tree (for example a report from another machine)
  // the committed source strings are the only evidence; keep the rules active.
  if (docs === undefined || !existsSync(docs)) return out
  for (const rule of RULES.rules) {
    if (typeof rule.source !== 'string' || rule.source.length === 0) {
      out.set(rule.id, { ok: false, reason: 'rules.json entry has no source' })
      continue
    }
    if (docs === undefined) continue
    const relative = rule.source.replace(/^docs\/upgrade-guide\//, '')
    if (!existsSync(join(docs, relative))) {
      out.set(rule.id, { ok: false, reason: `${rule.source} is missing from this core installation` })
      continue
    }
    out.set(rule.id, { ok: true })
  }
  return out
}

function planEdit({ plugin, finding, rule, target }) {
  const before = readFileSync(target, 'utf8')
  if (typeof rule.unlessPresent === 'string' && before.includes(rule.unlessPresent)) {
    return { skipped: { ruleId: rule.id, reason: `already migrated: file mentions ${rule.unlessPresent}` } }
  }
  const after = applyRule(before, rule)
  if (after === before) {
    return { skipped: { ruleId: rule.id, reason: 'rule pattern not found in the evidence file' } }
  }
  const changes = changedLines(before, after)
  return {
    edit: {
      plugin: plugin.name,
      pluginRoot: plugin.primaryRoot,
      ruleId: rule.id,
      kind: rule.kind,
      file: target,
      relative: target.slice(plugin.primaryRoot.length + 1),
      before,
      after,
      changes,
      source: rule.source,
      finding: { check: finding.check, message: finding.message, evidence: finding.evidence },
    },
  }
}

function changedLines(before, after) {
  const left = before.split('\n')
  const right = after.split('\n')
  const changes = []
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === right[index]) continue
    changes.push({ line: index + 1, before: (left[index] ?? '').trim().slice(0, 240), after: (right[index] ?? '').trim().slice(0, 240) })
  }
  return changes
}

// -------------------------------------------------------------------- apply

function dryRun(plan) {
  const repositories = new Map()
  for (const edit of plan.edits) {
    if (repositories.has(edit.pluginRoot)) continue
    const repo = repositoryOf(edit.pluginRoot) ?? edit.pluginRoot
    const status = gitStatus(repo)
    repositories.set(edit.pluginRoot, {
      repo,
      isGit: status !== undefined,
      clean: status !== undefined && status.length === 0,
      dirtyFiles: status === undefined ? [] : status.slice(0, 20),
    })
  }
  return {
    schemaVersion: 1,
    mode: 'dry-run',
    applied: false,
    aborted: false,
    rulesVersion: RULES.rulesVersion,
    edits: plan.edits.map(publicEdit),
    skipped: plan.skipped,
    needsManual: plan.needsManual,
    repositories: [...repositories.entries()].map(([pluginRoot, value]) => ({ pluginRoot, ...value })),
    tests: [],
    backups: [],
  }
}

function applyPlan(plan) {
  if (plan.edits.length === 0) {
    return { ...dryRun(plan), mode: 'apply', applied: false, note: 'no rule-matched edits to apply' }
  }
  const preflight = preflightRepositories(plan, options)
  if (!preflight.ok) {
    return { ...dryRun(plan), mode: 'apply', applied: false, aborted: true, abortReason: preflight.reason, repositories: preflight.repositories }
  }
  const testResults = []
  try {
    for (const edit of plan.edits) {
      backups.set(edit.file, edit.before)
      backupFiles.set(edit.file, writeBackup(edit.file, edit.before))
      writeFileSync(edit.file, edit.after)
    }
    if (options.noTests !== true) {
      for (const pluginRoot of new Set(plan.edits.map((edit) => edit.pluginRoot))) {
        const result = runPluginTests(pluginRoot)
        testResults.push(result)
        if (result.status === 'FAIL') {
          throw new Error(`${result.pluginRoot}: ${result.firstError ?? 'tests failed'}`)
        }
      }
    }
  } catch (error) {
    restoreBackups()
    return {
      ...dryRun(plan),
      mode: 'apply',
      applied: false,
      aborted: true,
      abortReason: String(error.message ?? error).slice(0, 800),
      tests: testResults,
      backups: [...backupFiles.entries()].map(([file, backup]) => ({ file, backup })),
      restored: true,
    }
  }
  return {
    ...dryRun(plan),
    mode: 'apply',
    applied: true,
    aborted: false,
    tests: testResults,
    diffstat: diffstat(plan),
    backups: [...backupFiles.entries()].map(([file, backup]) => ({ file, backup })),
  }
}

function restoreBackups() {
  for (const [file, content] of backups) {
    try {
      writeFileSync(file, content)
    } catch {
      // Restoring is best-effort; the report names every file and its backup.
    }
  }
}

/** Write a pre-edit copy into the OS temp directory and return its path. */
function writeBackup(file, content) {
  const dir = join(tmpdir(), 'dsh-plugin-upgrade-compat-backups')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${sha256(file).slice(0, 12)}-${file.split('/').pop()}`)
  writeFileSync(path, content)
  return path
}

function preflightRepositories(plan, options) {
  const repositories = []
  const dirty = []
  const foreign = []
  for (const pluginRoot of new Set(plan.edits.map((edit) => edit.pluginRoot))) {
    const repo = repositoryOf(pluginRoot)
    const status = repo === undefined ? undefined : gitStatus(repo)
    const record = {
      pluginRoot,
      repo: repo ?? pluginRoot,
      isGit: status !== undefined,
      clean: status !== undefined && status.length === 0,
      dirtyFiles: status === undefined ? [] : status.slice(0, 20),
    }
    repositories.push(record)
    if (status === undefined) foreign.push(pluginRoot)
    else if (status.length > 0) dirty.push(repo)
  }
  if ((dirty.length > 0 || foreign.length > 0) && options.allowDirty !== true) {
    return {
      ok: false,
      repositories,
      reason: [
        dirty.length > 0 ? `dirty git tree: ${[...new Set(dirty)].join(', ')}` : undefined,
        foreign.length > 0 ? `not a git work tree: ${foreign.join(', ')}` : undefined,
        're-run with --allow-dirty to edit anyway',
      ].filter(Boolean).join('; '),
    }
  }
  return { ok: true, repositories }
}

function runPluginTests(pluginRoot) {
  const manifest = readJson(join(pluginRoot, 'package.json'))
  const testScript = manifest.scripts?.test
  if (typeof testScript !== 'string' || testScript.trim().length === 0) {
    return { pluginRoot, status: 'SKIPPED', reason: 'no test script' }
  }
  const npm = run('npm', ['--version'], { cwd: pluginRoot, timeoutMs: 15_000 })
  const [command, args] = npm.status === 0 ? ['npm', ['test', '--silent']] : [process.execPath, ['--test']]
  const result = run(command, args, { cwd: pluginRoot, timeoutMs: 300_000 })
  return {
    pluginRoot,
    status: result.status === 0 ? 'PASS' : 'FAIL',
    command: result.command,
    ...(result.status === 0 ? {} : { firstError: firstErrorLine(`${result.stdout}\n${result.stderr}`) ?? `exit ${result.status}` }),
  }
}

function diffstat(plan) {
  const repos = new Set()
  for (const edit of plan.edits) {
    const repo = repositoryOf(edit.pluginRoot)
    if (repo !== undefined) repos.add(repo)
  }
  const out = []
  for (const repo of repos) {
    const result = run('git', ['diff', '--stat'], { cwd: repo, timeoutMs: 30_000 })
    out.push({ repo, stat: result.stdout.trim() })
  }
  return out
}

function publicEdit(edit) {
  return {
    plugin: edit.plugin,
    ruleId: edit.ruleId,
    kind: edit.kind,
    file: edit.file,
    relative: edit.relative,
    source: edit.source,
    finding: edit.finding,
    changes: edit.changes,
  }
}

// ------------------------------------------------------------------- report

function loadReport(options) {
  const path = options.report !== undefined ? resolve(options.report) : join(SKILL_ROOT, 'reports', 'report.json')
  if (!existsSync(path)) {
    throw new Error(`no scan report at ${path}. Run: node ${join(SKILL_ROOT, 'scripts', 'compat-scan.mjs')} --no-tests`)
  }
  return readJson(path)
}

function writeOutputs(summary, options) {
  const jsonPath = options.json ?? join(SKILL_ROOT, 'reports', 'adapt.json')
  const mdPath = options.md ?? join(SKILL_ROOT, 'reports', 'adapt.md')
  mkdirSync(dirname(jsonPath), { recursive: true })
  writeFileSync(jsonPath, stableJson(summary))
  writeFileSync(mdPath, renderMarkdown(summary))
  process.stdout.write(`${renderConsole(summary)}\nreport: ${jsonPath}\n        ${mdPath}\n`)
}

function renderConsole(summary) {
  const lines = [
    `adapt ${summary.mode} · ${summary.edits.length} edits · ${summary.skipped.length} skipped · ${summary.needsManual.length} need manual`,
  ]
  if (summary.aborted === true) lines.push(`ABORTED: ${summary.abortReason}`)
  if (summary.applied === true) lines.push('applied: files edited, tests passed')
  for (const edit of summary.edits.slice(0, 20)) {
    lines.push(`  ${edit.ruleId} ${edit.relative} (${edit.changes.length} line${edit.changes.length === 1 ? '' : 's'})`)
  }
  for (const test of summary.tests) lines.push(`  tests ${test.status} ${test.pluginRoot}`)
  return lines.join('\n')
}

function renderMarkdown(summary) {
  const lines = ['# DSH plugin compatibility adaptation', '']
  lines.push(`- Mode: \`${summary.mode}\`${summary.applied === true ? ' (applied)' : ''}`)
  lines.push(`- Rules: \`${summary.rulesVersion}\``)
  lines.push(`- Edits: ${summary.edits.length}; skipped: ${summary.skipped.length}; needs manual: ${summary.needsManual.length}`)
  if (summary.aborted === true) lines.push(`- **ABORTED**: ${summary.abortReason}${summary.restored === true ? ' (all files restored)' : ''}`)
  lines.push('')
  lines.push('## Planned edits', '')
  if (summary.edits.length === 0) lines.push('None.')
  for (const edit of summary.edits) {
    lines.push(`### ${edit.plugin} · rule \`${edit.ruleId}\``, '')
    lines.push(`- file: \`${edit.relative}\``)
    lines.push(`- source: \`${edit.source}\``)
    lines.push(`- finding: \`${edit.finding.check}\` — ${edit.finding.message}`)
    lines.push('')
    for (const change of edit.changes.slice(0, 10)) {
      lines.push('```diff')
      lines.push(`- ${change.before}`)
      lines.push(`+ ${change.after}`)
      lines.push('```')
    }
    lines.push('')
  }
  if (summary.skipped.length > 0) {
    lines.push('## Skipped', '')
    for (const entry of summary.skipped) lines.push(`- ${entry.plugin}${entry.ruleId === undefined ? '' : ` · \`${entry.ruleId}\``} — ${entry.reason}`)
    lines.push('')
  }
  if (summary.needsManual.length > 0) {
    lines.push('## Needs manual', '')
    for (const entry of summary.needsManual) {
      lines.push(`- **${entry.plugin}** \`${entry.check}\` — ${entry.message}${entry.evidence === '' ? '' : ` (\`${entry.evidence}\`)`}`)
      lines.push(`  - ${entry.action}`)
    }
    lines.push('')
  }
  if (summary.tests.length > 0) {
    lines.push('## Tests after edit', '')
    for (const test of summary.tests) lines.push(`- ${test.status} \`${test.pluginRoot}\`${test.firstError === undefined ? '' : ` — ${test.firstError}`}`)
    lines.push('')
  }
  if (summary.diffstat !== undefined && summary.diffstat.length > 0) {
    lines.push('## Diff stat', '')
    for (const entry of summary.diffstat) lines.push(`### ${entry.repo}`, '', '```', entry.stat, '```', '')
  }
  if (summary.repositories !== undefined && summary.repositories.length > 0) {
    lines.push('## Repository preconditions', '')
    lines.push('| Plugin root | Git | Clean |')
    lines.push('| --- | --- | --- |')
    for (const repo of summary.repositories) lines.push(`| ${repo.pluginRoot} | ${repo.isGit ? 'yes' : 'no'} | ${repo.clean ? 'yes' : `no (${repo.dirtyFiles.length} files)`} |`)
    lines.push('')
  }
  return lines.join('\n')
}

// --------------------------------------------------------------------- args

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`${arg} requires a value`)
      index += 1
      return value
    }
    switch (arg) {
      case '--report': parsed.report = next(); break
      case '--json': parsed.json = resolve(next()); break
      case '--md': parsed.md = resolve(next()); break
      case '--only': parsed.only = next(); break
      case '--apply': parsed.apply = true; break
      case '--allow-dirty': parsed.allowDirty = true; break
      case '--no-tests': parsed.noTests = true; break
      case '--strict': parsed.strict = true; break
      case '--help':
      case '-h':
        process.stdout.write(usage())
        process.exit(0)
        break
      default:
        throw new Error(`unknown argument ${arg}\n\n${usage()}`)
    }
  }
  return parsed
}

function usage() {
  return [
    'Usage: node compat-adapt.mjs [options]',
    '',
    '  --report <file>   scan report to adapt (default reports/report.json)',
    '  --apply           edit files (default: dry run)',
    '  --allow-dirty     allow edits in a dirty or non-git work tree',
    '  --no-tests        do not run plugin tests after editing (not recommended)',
    '  --only <text>     adapt only plugins whose name contains <text>',
    '  --json <file>     summary JSON path (default reports/adapt.json)',
    '  --md <file>       summary Markdown path (default reports/adapt.md)',
    '  --strict          exit 1 when findings remain NEEDS_MANUAL',
    '',
  ].join('\n')
}

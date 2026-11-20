/** Deterministic Markdown rendering of a compatibility report. */

const STATUS_ORDER = ['BROKEN', 'DEGRADED', 'OK']

/** Rank a finding for the fix list: automated breaks first, then manual breaks. */
export function rankFindings(plugins) {
  const rows = []
  for (const plugin of plugins) {
    for (const finding of plugin.findings) {
      if (finding.status === 'OK' || finding.status === 'SKIPPED') continue
      const automated = finding.ruleId !== null && finding.ruleId !== undefined
      const base = finding.status === 'BROKEN' ? 1 : 2
      rows.push({
        rank: base * 2 - (automated ? 1 : 0),
        plugin: plugin.name,
        status: finding.status,
        check: finding.check,
        evidence: finding.evidence ?? '',
        action: finding.fix ?? defaultFix(finding.check),
        ruleId: finding.ruleId ?? null,
        needsManual: !automated,
        message: finding.message,
      })
    }
  }
  return rows.sort((left, right) => left.rank - right.rank
    || (left.plugin < right.plugin ? -1 : left.plugin > right.plugin ? 1 : 0)
    || (left.check < right.check ? -1 : left.check > right.check ? 1 : 0)
    || (left.evidence < right.evidence ? -1 : 1))
    .map((row, index) => ({ ...row, rank: index + 1 }))
}

function defaultFix(check) {
  switch (check) {
    case 'service.inject':
      return 'Update the inject list to the current service name, or make the dependency optional.'
    case 'service.usage':
      return 'Check the service name against the current core; remove or rename the access.'
    case 'event.unknown':
      return 'Check the event against the current core event catalog; a renamed event fails silently.'
    case 'client.inject.module':
      return 'Point dsh.client.inject at an installed package or Web static module.'
    case 'client.slot':
      return 'Point the slot registration at a slot the current Web client composes.'
    case 'import.symbol':
      return 'Update the named import to the symbol the current package exports.'
    case 'import.subpath':
      return 'Update the export subpath to one the current package exposes.'
    case 'import.package':
      return 'Remove the dependency on the removed package, or install a version that provides it.'
    case 'manifest.compat':
      return 'Widen engines.dsh or install a version that supports the running core.'
    case 'runtime.tests':
      return 'Fix the plugin test failure before upgrading; the suite is the fastest regression signal.'
    case 'runtime.load':
      return 'Fix the plugin entry contract: the loader needs a string name and an apply function.'
    case 'copy.drift':
      return 'Decide which copy is authoritative (live vs repository) and sync the other.'
    default:
      return 'Review the finding against the current core API.'
  }
}

/** Render the whole report as Markdown. */
export function renderMarkdown(report) {
  const lines = []
  lines.push('# DSH plugin compatibility scan', '')
  lines.push(`- Core: \`${report.core.version}\`${report.core.cliVersion === undefined ? '' : ` (CLI \`${report.core.cliVersion}\`, ${report.core.cliVersionSource})`}`)
  if (report.core.pathCli !== null && report.core.pathCli !== undefined && report.core.pathCli.matchesCore !== true) {
    lines.push(`- PATH \`dsh\`: \`${report.core.pathCli.version}\` — a different installation; this scan uses the running core above`)
  }
  lines.push(`- Installation: \`${report.core.installDir}\``)
  lines.push(`- Plugins scanned: ${report.plugins.length} (${report.summary.OK} OK, ${report.summary.DEGRADED} DEGRADED, ${report.summary.BROKEN} BROKEN)`)
  lines.push(`- Rules: \`${report.skill.rulesVersion}\` (${report.skill.ruleCount} entries)`, '')

  lines.push('## Plugins', '')
  lines.push('| Plugin | Version | Kind | Status | Broken | Degraded | Roots |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const plugin of report.plugins) {
    const broken = plugin.findings.filter((finding) => finding.status === 'BROKEN').length
    const degraded = plugin.findings.filter((finding) => finding.status === 'DEGRADED' || finding.status === 'NEEDS_MANUAL').length
    const roots = plugin.roots.map((root) => `${root.role}:${root.path}`).join('<br>')
    const suffix = `${plugin.installed === false ? ' (source-only)' : ''}${plugin.preExisting === true ? ' (pre-existing)' : ''}`
    const label = `${plugin.name}${suffix}`
    lines.push(`| ${label} | ${plugin.version} | ${plugin.kind} | **${plugin.status}** | ${broken} | ${degraded} | ${roots} |`)
  }
  lines.push('')

  lines.push('## Findings', '')
  const withFindings = report.plugins.filter((plugin) => plugin.findings.length > 0)
  if (withFindings.length === 0) lines.push('No compatibility findings.', '')
  for (const plugin of withFindings) {
    lines.push(`### ${plugin.name}@${plugin.version} — ${plugin.status}`, '')
    for (const finding of plugin.findings) {
      const rule = finding.ruleId === null || finding.ruleId === undefined ? '' : ` · rule \`${finding.ruleId}\``
      const evidence = finding.evidence === undefined ? '' : ` · \`${finding.evidence}\``
      lines.push(`- **${finding.status}** \`${finding.check}\` — ${finding.message}${evidence}${rule}`)
      if (finding.fix !== undefined) lines.push(`  - fix: ${finding.fix}`)
    }
    lines.push('')
  }

  lines.push('## Ranked fixes', '')
  if (report.fixList.length === 0) lines.push('Nothing to fix.', '')
  for (const row of report.fixList) {
    const tag = row.ruleId === null ? 'NEEDS_MANUAL' : `rule ${row.ruleId}`
    lines.push(`${row.rank}. **${row.plugin}** · ${row.status} \`${row.check}\` · ${tag} — ${row.action}${row.evidence === '' ? '' : ` (\`${row.evidence}\`)`}`)
  }
  lines.push('')

  if (report.diff !== undefined && report.diff !== null) {
    lines.push('## Baseline diff', '')
    lines.push(`Baseline: \`${report.diff.baseline}\` (core ${report.diff.coreVersion})`, '')
    for (const key of ['packages', 'hostServices', 'clientServices', 'events', 'slots', 'tools']) {
      const removed = report.diff.removed[key] ?? []
      const added = report.diff.added[key] ?? []
      if (removed.length === 0 && added.length === 0) continue
      lines.push(`- ${key}: ${removed.length} removed, ${added.length} added`)
      if (removed.length > 0) lines.push(`  - removed: ${removed.slice(0, 20).map((name) => `\`${name}\``).join(', ')}`)
    }
    if (report.diff.statusChanges.length > 0) {
      lines.push('')
      lines.push('| Plugin | Before | After |')
      lines.push('| --- | --- | --- |')
      for (const change of report.diff.statusChanges) lines.push(`| ${change.name} | ${change.before} | ${change.after} |`)
    }
    lines.push('')
  }

  if (report.discovery.skipped.length > 0) {
    lines.push('## Discovery', '')
    lines.push(`Scanned ${report.discovery.profiles.length} profile(s); skipped ${report.discovery.skipped.length} path(s).`, '')
    for (const entry of report.discovery.skipped.slice(0, 25)) lines.push(`- \`${entry.path}\` — ${entry.reason}`)
    lines.push('')
  }

  lines.push('## Runtime smoke', '')
  lines.push('| Plugin | Load probe | Tests |')
  lines.push('| --- | --- | --- |')
  for (const plugin of report.plugins) {
    const load = plugin.runtime.load ?? { status: 'SKIPPED' }
    const tests = plugin.runtime.tests ?? { status: 'SKIPPED' }
    const loadText = load.status === 'PASS' ? 'PASS' : `${load.status}${load.firstError === undefined ? '' : `: ${escapeCell(load.firstError)}`}`
    const testText = tests.status === 'PASS' ? 'PASS' : `${tests.status}${tests.firstError === undefined ? '' : `: ${escapeCell(tests.firstError)}`}`
    lines.push(`| ${plugin.name} | ${loadText} | ${testText} |`)
  }
  lines.push('')
  lines.push('## Next command', '')
  lines.push('```sh')
  lines.push('node <skill>/scripts/compat-scan.mjs --strict   # scan; exits 1 on BROKEN')
  lines.push('node <skill>/scripts/compat-adapt.mjs           # dry-run the adaptation rules')
  lines.push('```')
  lines.push('')
  return lines.join('\n')
}

function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|').slice(0, 160)
}

/** One-line console summary used by the CLI. */
export function renderConsole(report) {
  const lines = []
  lines.push(`core ${report.core.version} · ${report.plugins.length} plugins · ${report.summary.OK} OK / ${report.summary.DEGRADED} DEGRADED / ${report.summary.BROKEN} BROKEN`)
  for (const plugin of report.plugins) {
    if (!STATUS_ORDER.includes(plugin.status)) continue
    const sourceOnly = `${plugin.installed === false ? ' (source-only)' : ''}${plugin.preExisting === true ? ' (pre-existing)' : ''}`
    const counts = plugin.findings.reduce((accumulator, finding) => {
      accumulator[finding.status] = (accumulator[finding.status] ?? 0) + 1
      return accumulator
    }, {})
    const detail = Object.entries(counts).map(([status, count]) => `${status}=${count}`).join(' ')
    lines.push(`  ${plugin.status.padEnd(8)} ${plugin.name}@${plugin.version}${sourceOnly}${detail.length === 0 ? '' : `  (${detail})`}`)
  }
  return lines.join('\n')
}

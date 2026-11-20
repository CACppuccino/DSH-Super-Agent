/**
 * Versioned rename/removal rules: matching a finding and applying its
 * replacement to source text. Both the scanner and the adapter use this
 * module so a finding and its edit always agree on the same rule.
 */

/**
 * Find the first adaptation rule that covers a finding.
 * @returns {{ id: string, automated: boolean } | undefined}
 */
export function matchRule(rules, finding) {
  if (rules === undefined) return undefined
  for (const rule of rules.rules ?? []) {
    const matcher = rule.match ?? {}
    let matched = true
    for (const [key, value] of Object.entries(matcher)) {
      if (key === 'message') {
        if (!new RegExp(value).test(finding.message)) matched = false
      } else if (finding[key] !== value) {
        matched = false
      }
      if (!matched) break
    }
    if (matched) return { id: rule.id, automated: rule.kind !== 'manual' }
  }
  return undefined
}

/**
 * Apply one rule's replacement to source text, scoped by `replace.scope`.
 * Returns the input unchanged when the scope is not a mechanical rewrite.
 */
export function applyRule(text, rule) {
  const oldValue = rule.replace?.old
  const newValue = rule.replace?.new
  if (typeof oldValue !== 'string' || oldValue.length === 0 || typeof newValue !== 'string') return text
  const escaped = oldValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  switch (rule.replace.scope) {
    case 'package':
    case 'import-package':
      return text.replace(new RegExp(`(['"])${escaped}(?=[/'"]|$)`, 'g'), `$1${newValue}`)
    case 'service-name':
      return text
        .replace(new RegExp(`\\bctx\\.${escaped}\\b`, 'g'), `ctx.${newValue}`)
        .replace(new RegExp(`(['"])${escaped}(?=['"])`, 'g'), `$1${newValue}`)
    case 'ctx.get-argument':
      return text.replace(new RegExp(`(ctx\\.get\\(\\s*)(['"])${escaped}\\2`, 'g'), `$1$2${newValue}$2`)
    case 'property':
      return text.replace(new RegExp(`\\.${escaped}\\b`, 'g'), `.${newValue}`)
    case 'provider-key':
    case 'value':
      return text.replace(new RegExp(`(['"])${escaped}\\1`, 'g'), `$1${newValue}$1`)
    case 'import-clause': {
      // default import -> namespace import, preserving the local binding.
      const defaultImport = new RegExp(`import\\s+([A-Za-z_$][\\w$]*)\\s+from\\s+(['"]${escaped}['"])`, 'g')
      if (!defaultImport.test(text)) return text
      return text.replace(defaultImport, `import * as $1 from $2`)
    }
    default:
      return text
  }
}

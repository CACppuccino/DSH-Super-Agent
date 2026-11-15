import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Stable skill name referenced by tool descriptions and the gate. */
export const SKILL_NAME = 'project-memory'
/** Super Agent's skill loader shim; `skill` is denied to that conversation. */
export const GUIDE_TOOL = 'project_memory_guide'

const DEFAULT_DESCRIPTION = 'How to read and write two-layer project memory: the Super Agent\'s per-project summary and workers\' tagged detail notes.'

const SKILL_URL = new URL('../skills/project-memory/SKILL.md', import.meta.url)

/** Parse the tiny YAML frontmatter used by a standard SKILL.md. */
export function parseSkillMarkdown(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (!match) return { attributes: {}, content: text.trim() }
  const attributes = {}
  for (const line of match[1].split('\n')) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim())
    if (!pair) continue
    attributes[pair[1]] = pair[2].replace(/^['"]|['"]$/g, '').trim()
  }
  return { attributes, content: text.slice(match[0].length).trim() }
}

/**
 * Load the shipped skill markdown and its standard registration shape.
 * @param {URL|string} [source]
 */
export function loadSkillDefinition(source = SKILL_URL) {
  const file = typeof source === 'string' ? source : fileURLToPath(source)
  const parsed = parseSkillMarkdown(readFileSync(file, 'utf8'))
  return {
    name: SKILL_NAME,
    description: parsed.attributes.description || DEFAULT_DESCRIPTION,
    content: parsed.content,
    source: 'bundled',
    provider: 'dsh-project-memory',
    path: file,
    resourceBase: { kind: 'directory', path: dirname(file) },
    invocation: { modelInvocable: true, userInvocable: true },
  }
}

/** Register the skill with the standard Harness registry. */
export function registerSkill(ctx, skill) {
  return ctx.skills.register({
    name: skill.name,
    description: skill.description,
    content: skill.content,
    path: skill.path,
    source: skill.source,
    provider: skill.provider,
    resourceBase: skill.resourceBase,
    invocation: skill.invocation,
  })
}

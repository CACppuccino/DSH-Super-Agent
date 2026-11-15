import { MemoryError } from './errors.js'

/**
 * The closed tag vocabulary required by the memory specification.
 * Order is stable so prompts and error messages agree.
 */
export const TAG_VOCABULARY = Object.freeze(['经验', '教训', '研究', '工程', '简单执行', '讨论'])

/** Maximum tags accepted on one detail note. */
export const MAX_TAGS = 6

/** Explicit English aliases keep the tag schema usable for bilingual models. */
/** Aliases accepted by the schema and normalized before storage. */
export const TAG_ALIASES = new Map([
  ['experience', '经验'],
  ['lesson', '教训'],
  ['lessons', '教训'],
  ['research', '研究'],
  ['engineering', '工程'],
  ['engineering-work', '工程'],
  ['simple-execution', '简单执行'],
  ['simple_execution', '简单执行'],
  ['execution', '简单执行'],
  ['discussion', '讨论'],
])

/** Every string value accepted by the tool JSON schema (canonical + aliases). */
export const ACCEPTED_TAG_VALUES = Object.freeze([...TAG_VOCABULARY, ...TAG_ALIASES.keys()])

/**
 * Validate and normalize a note's tag list against the closed vocabulary.
 * Unknown tags are rejected (not silently dropped) so a typo is visible.
 * @param {unknown} input
 * @returns {string[]}
 */
export function normalizeTags(input) {
  if (input === undefined || input === null) {
    throw new MemoryError('tag/missing', `tags is required; allowed tags: ${TAG_VOCABULARY.join(' / ')}`)
  }
  if (!Array.isArray(input)) {
    throw new MemoryError('tag/invalid', `tags must be an array; allowed tags: ${TAG_VOCABULARY.join(' / ')}`)
  }
  if (input.length === 0) {
    throw new MemoryError('tag/empty', `at least one tag is required; allowed tags: ${TAG_VOCABULARY.join(' / ')}`)
  }
  const tags = []
  for (const value of input) {
    if (typeof value !== 'string') {
      throw new MemoryError('tag/invalid', `tags must contain strings; allowed tags: ${TAG_VOCABULARY.join(' / ')}`)
    }
    const text = value.trim().replace(/\s+/g, ' ')
    if (text.length === 0) continue
    const direct = TAG_VOCABULARY.includes(text) ? text : undefined
    const mapped = direct ?? TAG_ALIASES.get(text.toLowerCase())
    if (mapped === undefined) {
      throw new MemoryError(
        'tag/unknown',
        `unknown tag "${text}"; allowed tags: ${TAG_VOCABULARY.join(' / ')} (English aliases: experience, lesson, research, engineering, simple-execution, discussion)`,
      )
    }
    if (!tags.includes(mapped)) tags.push(mapped)
  }
  if (tags.length === 0) {
    throw new MemoryError('tag/empty', `at least one non-empty tag is required; allowed tags: ${TAG_VOCABULARY.join(' / ')}`)
  }
  if (tags.length > MAX_TAGS) {
    throw new MemoryError('tag/too-many', `at most ${MAX_TAGS} tags are allowed, got ${tags.length}`)
  }
  return tags
}

/** True when a tag is in the closed vocabulary after normalization. */
export function isKnownTag(value) {
  try {
    normalizeTags([value])
    return true
  } catch {
    return false
  }
}

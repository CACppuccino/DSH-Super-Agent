/**
 * Compact per-project memory index injected into the system prompt.
 *
 * The index is a convenience map for the Super Agent, never an authority: it is
 * built from the local registry plus the summary files, capped in size, and
 * refreshed on a cadence (`memoryIndexRefreshMs`). Every failure degrades to
 * the previous text (or nothing) — prompt assembly must never fail because of
 * the index.
 */
import { readFile } from 'node:fs/promises'
import { isoTimestamp } from './projects.js'
import { MEMORY_INDEX_HEADER } from './guidance.js'

export const DEFAULT_MAX_CHARS = 1_500
export const DEFAULT_REFRESH_MS = 300_000
const SUMMARY_EXCERPT_CHARS = 120
const TITLE_CHARS = 80

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clip(value, max) {
  const text = String(value ?? '')
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/** First ~120 chars of a summary, with markdown heading markers stripped. */
export function summaryExcerpt(text, max = SUMMARY_EXCERPT_CHARS) {
  const stripped = String(text ?? '').replace(/^\s{0,3}#{1,6}\s+/gm, '')
  return clip(oneLine(stripped), max)
}

/** Newest of the summary timestamp and the project timestamps, in ms. */
function updatedAtOf(record) {
  for (const value of [record?.summaryUpdatedAt, record?.updatedAt, record?.createdAt]) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return 0
}

/**
 * Render the capped index block. Returns '' when there is nothing to inject.
 *
 * Each line is `- <title> / <key> / updated <ISO> / notes <n> / <excerpt>`.
 * Lines stay whole while they fit; the remaining budget goes to an explicit
 * omission notice, so the block never exceeds `maxChars`.
 *
 * @param {Array<{key: string, title?: string, noteCount?: number, updatedAt?: number, summary?: string}>} entries
 * @param {{maxChars?: number}} [options]
 */
export function renderMemoryIndex(entries, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  const cap = Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : DEFAULT_MAX_CHARS
  const list = Array.isArray(entries) ? entries.filter((entry) => isRecord(entry) && typeof entry.key === 'string' && entry.key.length > 0) : []
  if (list.length === 0) return ''
  const lines = list.map((entry) => {
    const at = isoTimestamp(entry.updatedAt) ?? 'unknown'
    const title = clip(oneLine(entry.title) || entry.key, TITLE_CHARS)
    const notes = Number.isSafeInteger(entry.noteCount) && entry.noteCount >= 0 ? entry.noteCount : 0
    const excerpt = typeof entry.summary === 'string' && entry.summary.length > 0 ? entry.summary : '(no summary yet)'
    return `- ${title} / ${entry.key} / updated ${at} / notes ${notes} / ${excerpt}`
  })

  const full = [MEMORY_INDEX_HEADER, ...lines].join('\n')
  if (full.length <= cap) return full

  const kept = []
  let used = MEMORY_INDEX_HEADER.length
  for (const line of lines) {
    if (used + 1 + line.length > cap) break
    kept.push(line)
    used += 1 + line.length
  }
  let text = [MEMORY_INDEX_HEADER, ...kept].join('\n')
  const omitted = lines.length - kept.length
  if (omitted > 0) {
    const notice = `- (${omitted} more project${omitted === 1 ? '' : 's'} omitted; memory index capped)`
    text = text.length + 1 + notice.length <= cap ? `${text}\n${notice}` : clip(text, cap)
  }
  return text.length <= cap ? text : clip(text, cap)
}

/**
 * Build the index from the local registry + summary files.
 *
 * Missing summaries render as "(no summary yet)"; unreadable or malformed ones
 * are tolerated per project. A registry read failure yields '' (no injection)
 * instead of an exception.
 *
 * @param {{store: {readRegistry: Function, summaryPath: Function}, maxChars?: number, logger?: {warn?: Function}}} options
 * @returns {Promise<string>}
 */
export async function buildMemoryIndex({ store, maxChars = DEFAULT_MAX_CHARS, logger } = {}) {
  let registry
  try {
    registry = await store.readRegistry()
  } catch (error) {
    logger?.warn?.(`dsh-project-memory: could not read the registry for the memory index: ${String(error?.message ?? error)}`)
    return ''
  }
  const records = Object.values(registry?.projects ?? {})
  const entries = []
  for (const record of records) {
    if (!isRecord(record) || typeof record.key !== 'string' || record.key.length === 0) continue
    let summary = ''
    try {
      const text = await readFile(store.summaryPath(record.key), 'utf8')
      summary = summaryExcerpt(text)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger?.warn?.(`dsh-project-memory: could not read the summary for ${record.key}; indexing the project without it: ${String(error?.message ?? error)}`)
      }
    }
    entries.push({
      key: record.key,
      title: typeof record.title === 'string' ? record.title : record.key,
      noteCount: Number.isSafeInteger(record.noteCount) ? record.noteCount : 0,
      updatedAt: updatedAtOf(record),
      summary,
    })
  }
  entries.sort((left, right) => right.updatedAt - left.updatedAt || left.key.localeCompare(right.key))
  try {
    return renderMemoryIndex(entries, { maxChars })
  } catch (error) {
    logger?.warn?.(`dsh-project-memory: could not render the memory index: ${String(error?.message ?? error)}`)
    return ''
  }
}

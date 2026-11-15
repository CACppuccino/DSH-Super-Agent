/**
 * Durable pending decisions for the Super Agent panel.
 *
 * The Super Agent registers a question, optional context, and optional answer
 * options; the browser panel renders it inline in the main conversation and
 * resolves it with the user's answer. A separate JSON file keeps this queue out
 * of the conversation catalog while still writing atomically and serializing
 * concurrent tool/API mutations.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const PENDING_VERSION = 1
export const PENDING_QUESTION_LIMIT = 4000
export const PENDING_CONTEXT_LIMIT = 16000
export const PENDING_OPTION_LIMIT = 200
export const PENDING_OPTIONS_MAX = 8
export const PENDING_ANSWER_LIMIT = 16000

/** True when `value` is a non-array object. */
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Coerce a finite timestamp; missing or invalid values become `fallback`. */
function timeOf(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** Trim and cap one string field. */
function textOf(value, limit) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  return text.length <= limit ? text : text.slice(0, limit)
}

/** Normalize one answer option; blank and duplicate values are dropped. */
export function normalizeOptions(value) {
  if (!Array.isArray(value)) return []
  const options = []
  for (const entry of value) {
    const option = textOf(entry, PENDING_OPTION_LIMIT)
    if (option.length > 0 && !options.includes(option)) options.push(option)
    if (options.length >= PENDING_OPTIONS_MAX) break
  }
  return options
}

/** An empty, valid pending document. */
export function emptyPending() {
  return { version: PENDING_VERSION, items: {}, updatedAt: null }
}

/** Keep only the fields the panel, API, and tool rely on. */
export function normalizePendingItem(value) {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0) return undefined
  const question = textOf(value.question, PENDING_QUESTION_LIMIT)
  if (question.length === 0) return undefined
  const createdAt = timeOf(value.created_at, Date.now())
  const resolvedAt = value.resolved_at === null || value.resolved_at === undefined ? null : timeOf(value.resolved_at, null)
  const answer = textOf(value.answer, PENDING_ANSWER_LIMIT)
  return {
    id: value.id,
    conversation_id: typeof value.conversation_id === 'string' ? value.conversation_id : '',
    question,
    context: textOf(value.context, PENDING_CONTEXT_LIMIT),
    options: normalizeOptions(value.options),
    created_at: createdAt,
    resolved_at: resolvedAt,
    answer: resolvedAt === null ? '' : answer,
  }
}

/** Validate an on-disk document, dropping records that cannot be trusted. */
export function normalizePending(raw) {
  if (!isRecord(raw)) return emptyPending()
  const pending = emptyPending()
  if (isRecord(raw.items)) {
    for (const value of Object.values(raw.items)) {
      const item = normalizePendingItem(value)
      if (item) pending.items[item.id] = item
    }
  }
  pending.updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : null
  return pending
}

/**
 * Owns one pending-decisions JSON file. Mutations go through {@link update},
 * which applies the callback and persists the result before resolving.
 */
export class PendingStore {
  /** @param {string} file absolute path of the JSON file */
  constructor(file, { now = () => Date.now() } = {}) {
    this.file = file
    this.now = now
    this.pending = emptyPending()
    this.queue = Promise.resolve()
    this.loaded = false
  }

  /** Read the file once; a missing or malformed file starts empty. */
  async load() {
    try {
      const text = await readFile(this.file, 'utf8')
      this.pending = normalizePending(JSON.parse(text))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // Keep the unreadable file for inspection and start empty, exactly as
        // the conversation catalog does; a corrupt queue must not stop DSH.
        try {
          await rename(this.file, `${this.file}.corrupt-${Date.now()}`)
        } catch { /* best effort */ }
      }
      this.pending = emptyPending()
    }
    this.loaded = true
    return this.pending
  }

  /** Persist the current document atomically. */
  async persist() {
    const text = JSON.stringify(this.pending, null, 2)
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, text, { mode: 0o600 })
    await rename(temporary, this.file)
  }

  /**
   * Apply a synchronous mutation and persist the result. Calls are serialized.
   * @template T
   * @param {(pending: ReturnType<typeof emptyPending>) => T} mutate
   * @returns {Promise<T>}
   */
  update(mutate) {
    const run = async () => {
      const result = mutate(this.pending)
      this.pending.updatedAt = this.now()
      await this.persist()
      return result
    }
    const next = this.queue.then(run, run)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  /** A JSON-safe copy of the current document. */
  snapshot() {
    return normalizePending(JSON.parse(JSON.stringify(this.pending)))
  }

  /** The current document, live. Callers must not mutate it outside `update`. */
  get current() {
    return this.pending
  }

  /** One item by id, if known. */
  get(id) {
    return this.pending.items[id]
  }

  /**
   * Pending items, newest first. Unresolved decisions are the default; pass
   * `includeResolved` for the durable history.
   */
  list({ conversationId, includeResolved = false } = {}) {
    return Object.values(this.pending.items)
      .filter((item) => includeResolved || item.resolved_at === null)
      .filter((item) => typeof conversationId !== 'string' || conversationId.length === 0 || item.conversation_id === conversationId)
      .sort((left, right) => right.created_at - left.created_at)
      .map((item) => ({ ...item, options: item.options.slice() }))
  }

  /** Register one unanswered decision. */
  async create({ conversationId = '', question, context = '', options = [] } = {}) {
    const text = textOf(question, PENDING_QUESTION_LIMIT)
    if (text.length === 0) throw new Error('question is required')
    const item = {
      id: `pending-${randomUUID()}`,
      conversation_id: typeof conversationId === 'string' ? conversationId : '',
      question: text,
      context: textOf(context, PENDING_CONTEXT_LIMIT),
      options: normalizeOptions(options),
      created_at: this.now(),
      resolved_at: null,
      answer: '',
    }
    await this.update((pending) => { pending.items[item.id] = item })
    return { ...item, options: item.options.slice() }
  }

  /**
   * Resolve one item with the user's answer. Resolving is idempotent: a second
   * call returns the stored answer instead of overwriting it.
   */
  async resolve({ id, answer, conversationId } = {}) {
    const key = typeof id === 'string' ? id : ''
    const existing = this.pending.items[key]
    if (!existing) throw new Error(`Unknown pending decision: ${key || '(missing id)'}`)
    if (typeof conversationId === 'string' && conversationId.length > 0 && existing.conversation_id !== conversationId) {
      throw new Error(`Unknown pending decision: ${key}`)
    }
    if (existing.resolved_at !== null) return { item: { ...existing, options: existing.options.slice() }, changed: false }
    const text = textOf(answer, PENDING_ANSWER_LIMIT)
    if (text.length === 0) throw new Error('answer is required')
    await this.update((pending) => {
      const stored = pending.items[key]
      stored.resolved_at = this.now()
      stored.answer = text
    })
    return { item: { ...this.pending.items[key], options: this.pending.items[key].options.slice() }, changed: true }
  }
}

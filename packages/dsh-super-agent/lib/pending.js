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
export const PENDING_RETRACT_REASON_LIMIT = 2000

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

/** Normalize one preserved previous version. */
function normalizeHistory(value) {
  if (!Array.isArray(value)) return []
  const history = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const question = textOf(entry.question, PENDING_QUESTION_LIMIT)
    if (question.length === 0) continue
    history.push({
      revision: Number.isSafeInteger(entry.revision) && entry.revision > 0 ? entry.revision : 1,
      question,
      context: textOf(entry.context, PENDING_CONTEXT_LIMIT),
      options: normalizeOptions(entry.options),
      updated_at: timeOf(entry.updated_at, 0),
    })
  }
  return history
}

/** Keep only the fields the panel, API, and tool rely on. */
export function normalizePendingItem(value) {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0) return undefined
  const question = textOf(value.question, PENDING_QUESTION_LIMIT)
  if (question.length === 0) return undefined
  const createdAt = timeOf(value.created_at, Date.now())
  const resolvedAt = value.resolved_at === null || value.resolved_at === undefined ? null : timeOf(value.resolved_at, null)
  const retracted = value.status === 'retracted'
  const status = retracted ? 'retracted' : resolvedAt !== null ? 'resolved' : 'open'
  const revision = Number.isSafeInteger(value.revision) && value.revision > 0 ? value.revision : 1
  const updatedAt = timeOf(value.updated_at, resolvedAt ?? createdAt)
  const history = normalizeHistory(value.history)
  const retractedAt = status === 'retracted' ? timeOf(value.retracted_at, updatedAt) : null
  return {
    id: value.id,
    conversation_id: typeof value.conversation_id === 'string' ? value.conversation_id : '',
    question,
    context: textOf(value.context, PENDING_CONTEXT_LIMIT),
    options: normalizeOptions(value.options),
    created_at: createdAt,
    resolved_at: status === 'resolved' ? resolvedAt : null,
    answer: status === 'resolved' ? textOf(value.answer, PENDING_ANSWER_LIMIT) : '',
    status,
    revision,
    updated_at: updatedAt,
    retracted_at: retractedAt,
    retract_reason: status === 'retracted' ? textOf(value.retract_reason, PENDING_RETRACT_REASON_LIMIT) : '',
    history,
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
  list({ conversationId, includeResolved = false, includeRetracted = false } = {}) {
    return Object.values(this.pending.items)
      .filter((item) => item.status === 'open'
        || (includeResolved && item.status === 'resolved')
        || (includeRetracted && item.status === 'retracted'))
      .filter((item) => typeof conversationId !== 'string' || conversationId.length === 0 || item.conversation_id === conversationId)
      .sort((left, right) => right.created_at - left.created_at)
      .map((item) => ({
        ...item,
        options: item.options.slice(),
        history: item.history.map((entry) => ({ ...entry, options: entry.options.slice() })),
      }))
  }

  /** Register one unanswered decision. */
  async create({ conversationId = '', question, context = '', options = [] } = {}) {
    const text = textOf(question, PENDING_QUESTION_LIMIT)
    if (text.length === 0) throw new Error('question is required')
    const now = this.now()
    const item = {
      id: `pending-${randomUUID()}`,
      conversation_id: typeof conversationId === 'string' ? conversationId : '',
      question: text,
      context: textOf(context, PENDING_CONTEXT_LIMIT),
      options: normalizeOptions(options),
      created_at: now,
      resolved_at: null,
      answer: '',
      status: 'open',
      revision: 1,
      updated_at: now,
      retracted_at: null,
      retract_reason: '',
      history: [],
    }
    await this.update((pending) => { pending.items[item.id] = item })
    return { ...item, options: item.options.slice(), history: [] }
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
    if (existing.status === 'retracted') throw new Error('Pending decision is retracted and cannot be answered')
    if (existing.resolved_at !== null) return { item: this.copyItem(existing), changed: false }
    const text = textOf(answer, PENDING_ANSWER_LIMIT)
    if (text.length === 0) throw new Error('answer is required')
    await this.update((pending) => {
      const stored = pending.items[key]
      stored.resolved_at = this.now()
      stored.updated_at = stored.resolved_at
      stored.answer = text
      stored.status = 'resolved'
    })
    return { item: this.copyItem(this.pending.items[key]), changed: true }
  }

  /** A defensive copy of one item, including history snapshots. */
  copyItem(item) {
    return {
      ...item,
      options: item.options.slice(),
      history: item.history.map((entry) => ({ ...entry, options: entry.options.slice() })),
    }
  }

  /**
   * Revise an open decision in place. The previous question/context/options are
   * appended to history and revision is bumped; answered and retracted cards
   * are immutable.
   */
  async revise({ id, question, context, options, conversationId } = {}) {
    const key = typeof id === 'string' ? id : ''
    const existing = this.pending.items[key]
    if (!existing) throw new Error(`Unknown pending decision: ${key || '(missing id)'}`)
    if (typeof conversationId === 'string' && conversationId.length > 0 && existing.conversation_id !== conversationId) {
      throw new Error(`Unknown pending decision: ${key}`)
    }
    if (existing.status !== 'open') throw new Error(`Pending decision is ${existing.status} and cannot be updated`)
    const hasQuestion = question !== undefined
    const hasContext = context !== undefined
    const hasOptions = options !== undefined
    if (!hasQuestion && !hasContext && !hasOptions) throw new Error('question, context, or options is required')
    let nextQuestion = existing.question
    if (hasQuestion) {
      nextQuestion = textOf(question, PENDING_QUESTION_LIMIT)
      if (nextQuestion.length === 0) throw new Error('question is required')
    }
    const previous = {
      revision: existing.revision,
      question: existing.question,
      context: existing.context,
      options: existing.options.slice(),
      updated_at: existing.updated_at,
    }
    await this.update((pending) => {
      const stored = pending.items[key]
      stored.history.push(previous)
      stored.question = nextQuestion
      if (hasContext) stored.context = textOf(context, PENDING_CONTEXT_LIMIT)
      if (hasOptions) stored.options = normalizeOptions(options)
      stored.revision += 1
      stored.updated_at = this.now()
      stored.status = 'open'
      stored.resolved_at = null
      stored.answer = ''
    })
    return { item: this.copyItem(this.pending.items[key]), changed: true }
  }

  /**
   * Withdraw an open decision because it is moot or was decided in
   * conversation. No answer is recorded and resolved_at stays null.
   */
  async retract({ id, reason, conversationId } = {}) {
    const key = typeof id === 'string' ? id : ''
    const existing = this.pending.items[key]
    if (!existing) throw new Error(`Unknown pending decision: ${key || '(missing id)'}`)
    if (typeof conversationId === 'string' && conversationId.length > 0 && existing.conversation_id !== conversationId) {
      throw new Error(`Unknown pending decision: ${key}`)
    }
    if (existing.status === 'resolved' || existing.resolved_at !== null) {
      throw new Error('Pending decision is answered and cannot be retracted')
    }
    const text = textOf(reason, PENDING_RETRACT_REASON_LIMIT)
    if (text.length === 0) throw new Error('reason is required')
    if (existing.status === 'retracted') return { item: this.copyItem(existing), changed: false }
    await this.update((pending) => {
      const stored = pending.items[key]
      stored.status = 'retracted'
      stored.retracted_at = this.now()
      stored.updated_at = stored.retracted_at
      stored.retract_reason = text
      stored.resolved_at = null
      stored.answer = ''
    })
    return { item: this.copyItem(this.pending.items[key]), changed: true }
  }
}

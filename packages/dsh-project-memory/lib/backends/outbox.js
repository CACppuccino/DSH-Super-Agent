/**
 * Write-ahead queue for cloud writes.
 *
 * Every local write is already committed to the local store before it reaches
 * this file. The file is append-only with `fsync`, records are removed by `ack`
 * lines, and compaction is atomic. A crash can at worst replay an idempotent
 * request; it cannot silently drop a write.
 */
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const VERSION = 1
const COMPACT_AFTER_ACKS = 50

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function opFromLine(line) {
  let raw
  try {
    raw = JSON.parse(line)
  } catch {
    return { corrupt: true }
  }
  if (!isRecord(raw)) return { corrupt: true }
  if (raw.type === 'ack') {
    return typeof raw.opId === 'string' ? { ack: raw.opId } : { corrupt: true }
  }
  if (typeof raw.opId !== 'string' || raw.opId.length === 0) return { corrupt: true }
  if (typeof raw.type !== 'string' || raw.type.length === 0) return { corrupt: true }
  if (!isRecord(raw.payload)) return { corrupt: true }
  return {
    op: {
      v: VERSION,
      opId: raw.opId,
      type: raw.type,
      at: Number.isFinite(raw.at) ? raw.at : 0,
      ...(typeof raw.localKey === 'string' ? { localKey: raw.localKey } : {}),
      ...(Number.isSafeInteger(raw.attempts) ? { attempts: raw.attempts } : {}),
      payload: raw.payload,
    },
  }
}

export class Outbox {
  /**
   * @param {{
   *   file: string,
   *   deadFile: string,
   *   clock?: () => number,
   *   logger?: {warn?: Function, info?: Function},
   * }} options
   */
  constructor({ file, deadFile, clock = Date.now, logger }) {
    this.file = file
    this.deadFile = deadFile
    this.clock = clock
    this.logger = logger
    this.pending = []
    this.deadCount = 0
    this.corruptLines = 0
    this.lastDead = undefined
    this.ackedSinceCompact = 0
    this.chain = Promise.resolve()
  }

  /** Load (or create) the queue. Corrupt lines are skipped, never fatal. */
  async load() {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const byId = new Map()
    let text = ''
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      const parsed = opFromLine(line)
      if (parsed.corrupt) {
        this.corruptLines += 1
        continue
      }
      if (parsed.ack !== undefined) {
        byId.delete(parsed.ack)
        this.ackedSinceCompact += 1
        continue
      }
      byId.set(parsed.op.opId, parsed.op)
    }
    if (this.corruptLines > 0) {
      this.logger?.warn?.(`dsh-project-memory: skipped ${this.corruptLines} corrupt line(s) in ${this.file}`)
    }
    this.pending = [...byId.values()].sort((a, b) => a.at - b.at)
    await this.loadDead()
    return this.pending
  }

  async loadDead() {
    try {
      const text = await readFile(this.deadFile, 'utf8')
      for (const line of text.split('\n')) {
        if (line.trim().length === 0) continue
        try {
          const raw = JSON.parse(line)
          if (isRecord(raw)) {
            this.deadCount += 1
            this.lastDead = raw
          }
        } catch {
          this.corruptLines += 1
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  size() {
    return this.pending.length
  }

  pendingOps() {
    return [...this.pending]
  }

  has(type, localKey) {
    return this.pending.some((op) => op.type === type && (localKey === undefined || op.localKey === localKey))
  }

  /** Append one new operation and return it (opId doubles as clientOpId). */
  async enqueue(type, payload, { localKey, opId } = {}) {
    const op = {
      v: VERSION,
      opId: opId ?? `op-${this.clock().toString(36)}-${randomUUID().slice(0, 8)}`,
      type,
      at: this.clock(),
      ...(localKey ? { localKey } : {}),
      payload,
    }
    return this.locked(async () => {
      await this.appendLine(this.file, op)
      this.pending.push(op)
      return op
    })
  }

  /** Mark an operation delivered. A crash after this may replay it idempotently. */
  async ack(opId) {
    return this.locked(async () => {
      await this.appendLine(this.file, { v: VERSION, type: 'ack', opId, at: this.clock() })
      this.pending = this.pending.filter((op) => op.opId !== opId)
      this.ackedSinceCompact += 1
      if (this.ackedSinceCompact >= COMPACT_AFTER_ACKS) await this.compactUnlocked()
    })
  }

  /**
   * Record a permanent failure. The op leaves the retry queue but its payload
   * is kept verbatim in the dead-letter file, so nothing is destroyed.
   */
  async deadLetter(op, error) {
    return this.locked(async () => {
      const record = {
        v: VERSION,
        op,
        error: typeof error?.toJSON === 'function'
          ? error.toJSON()
          : { kind: 'unknown', message: String(error?.message ?? error).slice(0, 500) },
        at: this.clock(),
      }
      await this.appendLine(this.deadFile, record)
      this.deadCount += 1
      this.lastDead = record
      await this.appendLine(this.file, { v: VERSION, type: 'ack', opId: op.opId, at: this.clock() })
      this.pending = this.pending.filter((candidate) => candidate.opId !== op.opId)
      this.ackedSinceCompact += 1
    })
  }

  /** Atomically rewrite the log with only pending records. */
  async compact() {
    return this.locked(() => this.compactUnlocked())
  }

  async compactUnlocked() {
    if (this.ackedSinceCompact === 0) return
    const text = this.pending.length === 0
      ? ''
      : `${this.pending.map((op) => JSON.stringify(op)).join('\n')}\n`
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    try {
      await writeFile(temporary, text, { mode: 0o600 })
      const handle = await open(temporary, 'r')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, this.file)
      this.ackedSinceCompact = 0
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }

  /** Serialize log mutations so compaction cannot race an enqueue. */
  locked(fn) {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => {})
    return run
  }

  async appendLine(file, value) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    const handle = await open(file, 'a', 0o600)
    try {
      await handle.write(`${JSON.stringify(value)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
}

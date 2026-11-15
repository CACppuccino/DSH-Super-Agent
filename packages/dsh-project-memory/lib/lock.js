import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { MemoryError } from './errors.js'

/** Locks older than this are assumed to be crash leftovers. */
const DEFAULT_STALE_MS = 120_000

/** Same-process tails make concurrent calls cheap and fair before the OS lock. */
const tails = new Map()

async function acquire(lockPath, options) {
  const timeoutMs = options.timeoutMs ?? 15_000
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  const signal = options.signal
  const token = randomUUID()
  const ownerFile = join(lockPath, 'owner')
  const started = Date.now()
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
  while (true) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    try {
      await mkdir(lockPath, { mode: 0o700 })
      try {
        await writeFile(ownerFile, token, { mode: 0o600 })
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {})
        throw error
      }
      return token
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        const info = await stat(lockPath)
        if (Date.now() - info.mtimeMs > staleMs) {
          // A crash left the directory behind. Best-effort removal; a racing
          // remover is harmless because the next mkdir picks one winner.
          await rm(lockPath, { recursive: true, force: true })
          continue
        }
      } catch {
        continue
      }
      if (Date.now() - started > timeoutMs) {
        throw new MemoryError('lock/timeout', `timed out waiting for memory lock at ${lockPath}`)
      }
      try {
        await delay(6 + Math.floor(Math.random() * 17), undefined, { signal })
      } catch (error) {
        if (error?.name === 'AbortError') throw new DOMException('Aborted', 'AbortError')
        throw error
      }
    }
  }
}

async function release(lockPath, token) {
  try {
    const owner = await readFile(join(lockPath, 'owner'), 'utf8')
    if (owner !== token) return
    await rm(lockPath, { recursive: true, force: true })
  } catch {
    // A lock removed as stale (or already released) needs no cleanup.
  }
}

/**
 * Run `fn` while holding an exclusive per-path lock that works across
 * processes. Same-process callers are queued first to avoid a retry storm.
 * @template T
 * @param {string} lockPath
 * @param {() => Promise<T>} fn
 * @param {{timeoutMs?: number, staleMs?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<T>}
 */
export function withFileLock(lockPath, fn, options = {}) {
  const previous = tails.get(lockPath) ?? Promise.resolve()
  const run = previous.then(async () => {
    const token = await acquire(lockPath, options)
    try {
      return await fn()
    } finally {
      await release(lockPath, token)
    }
  }, async () => {
    const token = await acquire(lockPath, options)
    try {
      return await fn()
    } finally {
      await release(lockPath, token)
    }
  })
  tails.set(lockPath, run.then(() => undefined, () => undefined))
  return run
}

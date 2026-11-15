/**
 * Cloudflare backend: local files stay the authoritative cache and write-ahead
 * log; the Worker + D1 database is the shared store between machines.
 *
 * Reads serve the local cache and attempt a bounded pull first. Writes commit
 * locally first, then enqueue an append-only outbox record and try to deliver
 * it; failures stay queued and are replayed later. Nothing is dropped.
 */
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { LocalFileBackend } from './local.js'
import { CloudflareClient } from './http.js'
import { Outbox } from './outbox.js'
import { TokenProvider } from './keychain.js'
import { createProxyFetch } from './proxy.js'
import { CloudError, describeCloudError } from './errors.js'
import {
  IDENTITY_PATTERN,
  identityIsFresh,
  resolveProjectIdentity,
} from './identity.js'

const STATE_VERSION = 1

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function iso(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null
}

function machineSlug(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

/** Wire shape for one local note (the Worker attributes the uploading machine). */
function noteForWire(note) {
  return {
    id: note.id,
    at: note.at,
    authorRole: note.authorRole === 'super' ? 'super' : 'worker',
    authorId: note.authorId ?? '',
    title: note.title,
    tags: note.tags,
    body: note.body,
  }
}

/** Strip the store's single trailing newline before sending a summary. */
export function summaryForCloud(text) {
  const value = String(text ?? '')
  return value.endsWith('\n') ? value.slice(0, -1) : value
}

export class CloudflareBackend {
  /**
   * @param {{
   *   rootDir: string,
   *   cloud: Record<string, any>,
   *   logger?: {info?: Function, warn?: Function, error?: Function},
   *   clock?: () => number,
   *   fetchImpl?: typeof fetch,
   *   execFileImpl?: Function,
   *   tokenProvider?: {get: Function, invalidate?: Function},
   *   autoSync?: boolean,
   * }} options
   */
  constructor({ rootDir, cloud, logger, clock = Date.now, fetchImpl, execFileImpl, tokenProvider, autoSync } = {}) {
    if (typeof rootDir !== 'string' || rootDir.length === 0) throw new Error('rootDir is required')
    this.rootDir = rootDir
    this.cloud = cloud ?? {}
    this.logger = logger
    this.clock = clock
    this.backendName = 'cloudflare'
    this.store = new LocalFileBackend({ rootDir, clock })
    this.cloudDir = join(rootDir, '.cloud')
    this.stateFile = join(this.cloudDir, 'sync-state.json')
    this.outboxFile = join(this.cloudDir, 'outbox.jsonl')
    this.deadFile = join(this.cloudDir, 'outbox-dead.jsonl')
    this.machineIdFile = join(this.cloudDir, 'machine-id')
    this.state = { version: STATE_VERSION, lastSyncAt: null, lastListAt: 0, projects: {} }
    this.machineId = undefined
    this.client = undefined
    this.tokenProvider = tokenProvider
    this.configError = this.cloud.configError
    this.outbox = new Outbox({ file: this.outboxFile, deadFile: this.deadFile, clock, logger })
    this.online = null
    this.lastSyncAt = null
    this.offlineUntil = 0
    this.consecutiveFailures = 0
    this.error = undefined
    this.lastConflict = undefined
    this.syncPromise = undefined
    this.timer = undefined
    this.closed = false
    this.autoSync = autoSync ?? this.cloud.autoSync !== false
    this.deps = { fetchImpl, execFileImpl }
  }

  get limits() {
    return this.store.limits
  }

  // ---------------------------------------------------------------- lifecycle

  async init() {
    await this.store.init()
    await mkdir(this.cloudDir, { recursive: true, mode: 0o700 })
    this.machineId = this.cloud.machineId || await this.loadOrCreateMachineId()
    await this.outbox.load()
    await this.loadState()
    if (this.configError) {
      this.logger?.error?.(`dsh-project-memory: cloud backend misconfigured: ${this.configError}`)
      return
    }
    if (typeof this.cloud.url !== 'string' || this.cloud.url.length === 0) {
      this.configError = 'cloud backend has no Worker URL'
      return
    }
    if (this.cloud.proxy && !this.deps.fetchImpl) {
      this.deps.fetchImpl = createProxyFetch(this.cloud.proxy, {
        timeoutMs: Math.max(5_000, (this.cloud.timeoutMs ?? 2_500) * 2),
      })
      this.logger?.info?.('dsh-project-memory: cloud traffic uses the configured HTTP CONNECT proxy')
    }
    if (!this.tokenProvider) {
      this.tokenProvider = new TokenProvider({
        service: this.cloud.keychainService,
        account: this.cloud.keychainAccount,
        envToken: this.cloud.token,
        execFileImpl: this.deps.execFileImpl,
        clock: this.clock,
      })
    }
    this.client = new CloudflareClient({
      baseUrl: this.cloud.url,
      tokenProvider: this.tokenProvider,
      machineId: this.machineId,
      fetchImpl: this.deps.fetchImpl,
      clock: this.clock,
      timeoutMs: this.cloud.timeoutMs,
      maxAttempts: this.cloud.maxAttempts,
      userAgent: this.cloud.userAgent,
    })
    if (this.autoSync) {
      this.timer = setInterval(() => {
        if (this.closed) return
        if (this.outbox.size() === 0 && this.online === true && !this.isStale()) return
        // Pull the registry too: another Mac may have written while this one was idle.
        void this.beforeRead({ list: true }).catch(() => {})
      }, Math.max(5_000, this.cloud.autoSyncIntervalMs ?? 30_000))
      this.timer.unref?.()
      void this.flush({ budgetMs: 1_500 }).catch(() => {})
    }
    this.logger?.info?.(
      `dsh-project-memory: cloud backend ready (worker: ${this.cloud.url}, machine: ${this.machineId}, pending: ${this.outbox.size()})`,
    )
  }

  async close() {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    try {
      await this.syncPromise
    } catch { /* flush records its own errors */ }
    await this.saveState().catch(() => {})
  }

  // --------------------------------------------------------------- delegation

  registryPath() { return this.store.registryPath() }
  lockPath(name) { return this.store.lockPath(name) }
  projectDir(key) { return this.store.projectDir(key) }
  notesPath(key) { return this.store.notesPath(key) }
  indexPath(key) { return this.store.indexPath(key) }
  summaryPath(key) { return this.store.summaryPath(key) }
  projectFilePath(key) { return this.store.projectFilePath(key) }
  bindingsPath() { return this.store.bindingsPath() }
  registeredPaths() { return this.store.registeredPaths() }
  readRegistry() { return this.store.readRegistry() }
  readBindings() { return this.store.readBindings() }
  getBinding(sessionId) { return this.store.getBinding(sessionId) }
  bindWorker(sessionId, binding) { return this.store.bindWorker(sessionId, binding) }
  clearBinding(sessionId) { return this.store.clearBinding(sessionId) }
  updateProjectMeta(key, patch) { return this.store.updateProjectMeta(key, patch) }

  // -------------------------------------------------------------------- state

  async loadState() {
    let raw
    try {
      raw = JSON.parse(await readFile(this.stateFile, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        const quarantine = `${this.stateFile}.corrupt-${this.clock()}`
        await rename(this.stateFile, quarantine).catch(() => {})
        this.logger?.warn?.(`dsh-project-memory: moved corrupt sync state to ${quarantine}; cursors reset, notes re-import idempotently`)
      }
      return
    }
    if (!isRecord(raw)) return
    this.state.version = STATE_VERSION
    this.state.lastSyncAt = Number.isFinite(raw.lastSyncAt) ? raw.lastSyncAt : null
    this.state.lastListAt = Number.isFinite(raw.lastListAt) ? raw.lastListAt : 0
    this.state.projects = {}
    if (isRecord(raw.projects)) {
      for (const [key, value] of Object.entries(raw.projects)) {
        if (!isRecord(value)) continue
        this.state.projects[key] = {
          cloudId: typeof value.cloudId === 'string' && value.cloudId.length > 0 ? value.cloudId : null,
          identity: typeof value.identity === 'string' ? value.identity : null,
          notesSeq: Number.isSafeInteger(value.notesSeq) && value.notesSeq >= 0 ? value.notesSeq : 0,
          summaryVersion: Number.isSafeInteger(value.summaryVersion) && value.summaryVersion >= 0 ? value.summaryVersion : 0,
          summaryCached: value.summaryCached === true,
          lastPulledAt: Number.isFinite(value.lastPulledAt) ? value.lastPulledAt : 0,
        }
      }
    }
    this.lastSyncAt = this.state.lastSyncAt
  }

  async saveState() {
    const text = `${JSON.stringify(this.state, null, 2)}\n`
    const temporary = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`
    await mkdir(this.cloudDir, { recursive: true, mode: 0o700 })
    await writeFile(temporary, text, { mode: 0o600 })
    await rename(temporary, this.stateFile)
  }

  async loadOrCreateMachineId() {
    try {
      const existing = (await readFile(this.machineIdFile, 'utf8')).trim()
      if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(existing)) return existing
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const base = machineSlug(hostname()) || 'mac'
    const id = `${base}-${randomUUID().slice(0, 4)}`
    await mkdir(this.cloudDir, { recursive: true, mode: 0o700 })
    await writeFile(this.machineIdFile, `${id}\n`, { mode: 0o600 })
    return id
  }

  stateEntry(localKey) {
    if (!this.state.projects[localKey]) {
      this.state.projects[localKey] = { cloudId: null, identity: null, notesSeq: 0, summaryVersion: 0, summaryCached: false, lastPulledAt: 0 }
    }
    return this.state.projects[localKey]
  }

  isStale() {
    if (!this.client || this.online !== true) return true
    if (!this.lastSyncAt) return true
    return this.clock() - this.lastSyncAt > (this.cloud.staleAfterMs ?? 60_000)
  }

  /** Synchronous status for tool results; never contains the token. */
  syncInfo() {
    const configured = Boolean(this.client) && !this.configError
    const error = this.error
      ? describeCloudError(this.error)
      : this.configError
        ? { kind: 'config', message: this.configError }
        : undefined
    return {
      backend: 'cloudflare',
      configured,
      online: this.online,
      stale: !configured || this.isStale(),
      lastSyncAt: iso(this.lastSyncAt),
      pendingWrites: this.outbox.size(),
      failedWrites: this.outbox.deadCount,
      ...(this.machineId ? { machineId: this.machineId } : {}),
      ...(this.syncPromise ? { syncing: true } : {}),
      ...(this.lastConflict ? { lastConflict: this.lastConflict } : {}),
      ...(this.outbox.lastDead
        ? {
            lastFailedWrite: {
              at: this.outbox.lastDead.at,
              type: this.outbox.lastDead.op?.type,
              localKey: this.outbox.lastDead.op?.localKey,
              error: this.outbox.lastDead.error,
            },
          }
        : {}),
      ...(error ? { error } : {}),
    }
  }

  // ------------------------------------------------------------------- sync

  markOnline() {
    this.online = true
    this.lastSyncAt = this.clock()
    this.offlineUntil = 0
    this.consecutiveFailures = 0
    this.error = undefined
    this.state.lastSyncAt = this.lastSyncAt
  }

  noteError(error) {
    this.error = error
    if (!(error instanceof CloudError) || error.kind === 'network' || error.kind === 'timeout' || error.kind === 'server' || error.kind === 'rate-limit') {
      this.online = false
      this.consecutiveFailures += 1
      const backoff = Math.min(
        60_000,
        (this.cloud.offlineBackoffMs ?? 15_000) * 2 ** Math.min(5, this.consecutiveFailures - 1),
      )
      this.offlineUntil = this.clock() + backoff
    } else if (error.kind === 'auth' || error.kind === 'config') {
      this.online = false
      this.offlineUntil = this.clock() + 60_000
    }
    if (error instanceof CloudError && error.kind === 'config') {
      this.logger?.warn?.(`dsh-project-memory: cloud sync not configured: ${error.message}`)
    }
  }

  kick({ budgetMs = 1_500 } = {}) {
    if (!this.client || !this.autoSync || this.closed) return
    if (this.clock() < this.offlineUntil) return
    void this.flush({ budgetMs }).catch(() => {})
  }

  /**
   * Deliver queued writes in order.
   * @param {{budgetMs?: number}} [options]
   */
  async flush({ budgetMs, force = false } = {}) {
    if (!this.client) {
      return { sent: 0, pending: this.outbox.size(), skipped: true, ...(this.configError ? { error: { kind: 'config', message: this.configError } } : {}) }
    }
    if (this.syncPromise) return this.syncPromise
    const budget = Math.max(200, budgetMs ?? this.cloud.syncBudgetMs ?? 4_000)
    this.syncPromise = this.runFlush(budget, force)
      .catch((error) => {
        this.noteError(error)
        return { sent: 0, pending: this.outbox.size(), error: describeCloudError(error) }
      })
      .finally(() => {
        this.syncPromise = undefined
      })
    return this.syncPromise
  }

  async runFlush(budgetMs, force = false) {
    if (!force && this.clock() < this.offlineUntil) {
      return { sent: 0, pending: this.outbox.size(), offline: true }
    }
    const deadline = this.clock() + budgetMs
    const budgetSignal = AbortSignal.timeout(budgetMs)
    let sent = 0
    let dead = 0
    for (const op of this.outbox.pendingOps()) {
      if (this.clock() >= deadline || budgetSignal.aborted) break
      try {
        await this.deliverOp(op, { signal: budgetSignal })
        sent += 1
      } catch (error) {
        if (error instanceof CloudError && !error.retriable && error.kind !== 'auth' && error.kind !== 'config') {
          await this.outbox.deadLetter(op, error)
          dead += 1
          continue
        }
        this.noteError(error)
        await this.saveState().catch(() => {})
        return { sent, dead, pending: this.outbox.size(), error: describeCloudError(error) }
      }
    }
    await this.outbox.compact().catch(() => {})
    if (sent > 0) this.markOnline()
    await this.saveState().catch(() => {})
    return { sent, dead, pending: this.outbox.size() }
  }

  async deliverOp(op, { signal } = {}) {
    switch (op.type) {
      case 'project.register': {
        const cloudId = await this.registerRemoteProject({
          localKey: op.localKey,
          identity: op.payload.identity,
          identitySource: op.payload.identitySource,
          title: op.payload.title,
          pathHint: op.payload.pathHint,
          signal,
        })
        await this.outbox.ack(op.opId)
        this.logger?.info?.(`dsh-project-memory: registered ${op.localKey} as ${cloudId}`)
        return
      }
      case 'note.append': {
        const cloudId = await this.resolveCloudId(op.localKey, { signal })
        try {
          await this.client.request('POST', `/v1/projects/${encodeURIComponent(cloudId)}/notes`, {
            body: { notes: [op.payload.note] },
            signal,
          })
        } catch (error) {
          if (error instanceof CloudError && error.kind === 'not-found') {
            const refreshed = await this.resolveCloudId(op.localKey, { signal, force: true })
            await this.client.request('POST', `/v1/projects/${encodeURIComponent(refreshed)}/notes`, {
              body: { notes: [op.payload.note] },
              signal,
            })
          } else {
            throw error
          }
        }
        await this.outbox.ack(op.opId)
        return
      }
      case 'notes.batch': {
        const cloudId = await this.resolveCloudId(op.localKey, { signal })
        try {
          await this.client.request('POST', `/v1/projects/${encodeURIComponent(cloudId)}/notes`, {
            body: { notes: op.payload.notes },
            signal,
          })
        } catch (error) {
          if (error instanceof CloudError && error.kind === 'not-found') {
            const refreshed = await this.resolveCloudId(op.localKey, { signal, force: true })
            await this.client.request('POST', `/v1/projects/${encodeURIComponent(refreshed)}/notes`, {
              body: { notes: op.payload.notes },
              signal,
            })
          } else {
            throw error
          }
        }
        await this.outbox.ack(op.opId)
        return
      }
      case 'summary.upsert': {
        const cloudId = await this.resolveCloudId(op.localKey, { signal })
        let result
        try {
          result = await this.client.request('PUT', `/v1/projects/${encodeURIComponent(cloudId)}/summary`, {
            body: {
              content: op.payload.content,
              clientOpId: op.opId,
              ...(Number.isSafeInteger(op.payload.baseVersion) ? { baseVersion: op.payload.baseVersion } : {}),
            },
            signal,
          })
        } catch (error) {
          if (error instanceof CloudError && error.kind === 'not-found') {
            const refreshed = await this.resolveCloudId(op.localKey, { signal, force: true })
            result = await this.client.request('PUT', `/v1/projects/${encodeURIComponent(refreshed)}/summary`, {
              body: {
                content: op.payload.content,
                clientOpId: op.opId,
                ...(Number.isSafeInteger(op.payload.baseVersion) ? { baseVersion: op.payload.baseVersion } : {}),
              },
              signal,
            })
          } else {
            throw error
          }
        }
        const entry = this.stateEntry(op.localKey)
        if (result?.summary && Number.isSafeInteger(result.summary.version)) {
          entry.summaryVersion = result.summary.version
          entry.summaryCached = true
          await this.store.updateProjectMeta(op.localKey, {
            cloudSummaryVersion: result.summary.version,
            summaryUpdatedAt: result.summary.updatedAt,
            summaryChars: result.summary.chars,
          }).catch(() => {})
        }
        if (result?.conflict === true) {
          this.lastConflict = {
            projectKey: op.localKey,
            baseVersion: op.payload.baseVersion ?? null,
            previousVersion: result.previousVersion ?? null,
            version: result.summary?.version ?? null,
            at: this.clock(),
          }
          this.logger?.warn?.(`dsh-project-memory: summary conflict on ${op.localKey} (base ${op.payload.baseVersion}, server ${result.previousVersion}); previous version archived as ${result.archivedVersion ?? 'n/a'}`)
        }
        await this.outbox.ack(op.opId)
        return
      }
      default:
        await this.outbox.deadLetter(op, new CloudError('client', `unknown outbox operation type ${op.type}`))
    }
  }

  async resolveCloudId(localKey, { signal, force = false } = {}) {
    const entry = this.stateEntry(localKey)
    if (entry.cloudId && !force) return entry.cloudId
    const record = await this.freshRecord(localKey)
    if (!record) throw new CloudError('client', `local project ${localKey} disappeared before sync`)
    if (record.cloudId && !force) {
      entry.cloudId = record.cloudId
      if (record.identity) entry.identity = record.identity
      return record.cloudId
    }
    return this.registerRemoteProject({
      localKey,
      identity: record.identity,
      identitySource: record.identitySource,
      title: record.title,
      pathHint: record.remote === true ? undefined : record.path,
      signal,
    })
  }

  async registerRemoteProject({ localKey, identity, identitySource, title, pathHint, signal }) {
    if (typeof identity !== 'string' || identity.length === 0) {
      throw new CloudError('client', `project ${localKey} has no stable identity; set a git remote or DSH_PROJECT_MEMORY_IDENTITY`)
    }
    if (!IDENTITY_PATTERN.test(identity)) {
      throw new CloudError('client', `project ${localKey} has an invalid cloud identity ${JSON.stringify(identity)}`)
    }
    const payload = await this.client.request('POST', '/v1/projects', {
      body: {
        identity,
        identitySource: identitySource ?? (identity.startsWith('git:') ? 'git' : 'title'),
        title: typeof title === 'string' && title.trim() ? title.trim() : identity,
        ...(typeof pathHint === 'string' && pathHint.length > 0 ? { pathHint } : {}),
      },
      signal,
    })
    const project = payload?.project
    if (!project || typeof project.id !== 'string') {
      throw new CloudError('server', 'register project response is missing project.id')
    }
    const entry = this.stateEntry(localKey)
    const previous = entry.cloudId
    entry.cloudId = project.id
    entry.identity = identity
    if (previous !== project.id) entry.notesSeq = 0
    entry.summaryVersion = Number.isSafeInteger(project.summaryVersion) ? project.summaryVersion : entry.summaryVersion
    await this.store.updateProjectMeta(localKey, {
      identity,
      identitySource: identitySource ?? (identity.startsWith('git:') ? 'git' : 'title'),
      cloudId: project.id,
      cloudSummaryVersion: entry.summaryVersion,
      cloudNoteCount: project.noteCount,
      cloudLastSeq: project.lastSeq,
      cloudUpdatedAt: project.updatedAt,
    }).catch((error) => this.logger?.warn?.(`dsh-project-memory: could not cache cloud id for ${localKey}: ${String(error?.message ?? error)}`))
    const stored = await this.freshRecord(localKey)
    if (stored) {
      await this.enqueueBackfill(stored, {
        remoteSummaryVersion: Number.isSafeInteger(project.summaryVersion) ? project.summaryVersion : 0,
        includeSummary: true,
      }).catch((error) => this.logger?.warn?.(`dsh-project-memory: could not queue backfill for ${localKey}: ${String(error?.message ?? error)}`))
    }
    return project.id
  }

  /**
   * One-time upload of a project's pre-cloud local notes (union by id, so it is
   * safe to repeat) and, only when the cloud has no summary yet, its summary.
   * Runs when a project first registers or is upgraded from local mode.
   */
  async enqueueBackfill(record, { remoteSummaryVersion = 0, includeSummary = false } = {}) {
    if (!this.client || !record || record.remote === true) return
    if (record.cloudBackfilledAt) return
    const pendingNoteIds = new Set(
      this.outbox.pending
        .filter((op) => op.type === 'note.append' && op.localKey === record.key)
        .map((op) => op.payload?.note?.id)
        .filter(Boolean),
    )
    const notes = (await this.store.readAllNotes(record))
      .filter((note) => !pendingNoteIds.has(note.id))
    for (let index = 0; index < notes.length; index += 50) {
      const chunk = notes.slice(index, index + 50).map(noteForWire)
      await this.outbox.enqueue('notes.batch', { notes: chunk }, { localKey: record.key })
    }
    if (includeSummary && !(Number.isSafeInteger(remoteSummaryVersion) && remoteSummaryVersion > 0)) {
      const summary = await this.store.readSummary(record, { full: true })
      if (summary.exists && summary.content.trim().length > 0) {
        await this.outbox.enqueue('summary.upsert', {
          content: summaryForCloud(summary.content),
          baseVersion: 0,
        }, { localKey: record.key })
      }
    }
    await this.store.updateProjectMeta(record.key, { cloudBackfilledAt: this.clock() })
  }

  // ------------------------------------------------------------------ pulls

  async listProjects(args = {}) {
    await this.beforeRead({ list: true })
    const result = await this.store.listProjects(args)
    return result
  }

  async readNotes(args = {}) {
    await this.beforeRead({ records: args.projects ?? [] })
    return this.store.readNotes(args)
  }

  async searchNotes(args = {}) {
    await this.beforeRead({ records: args.projects ?? [] })
    return this.store.searchNotes(args)
  }

  async readSummary(record, options = {}) {
    const fresh = (await this.freshRecord(record.key)) ?? record
    await this.beforeRead({ records: [fresh] })
    const latest = (await this.freshRecord(record.key)) ?? fresh
    return this.store.readSummary(latest, options)
  }

  async beforeRead({ records = [], list = false } = {}) {
    if (!this.client || this.closed) return
    if (this.clock() < this.offlineUntil) return
    try {
      const flushed = await this.flush({ budgetMs: this.cloud.syncBudgetMs ?? 3_000 })
      if (flushed?.error || flushed?.offline) return
      let sawNetwork = Number(flushed?.sent ?? 0) > 0
      const signal = AbortSignal.timeout(this.cloud.syncBudgetMs ?? 3_000)
      if (list) {
        if (this.clock() - this.state.lastListAt >= (this.cloud.pullIntervalMs ?? 5_000)) {
          await this.pullProjectList({ signal })
          sawNetwork = true
        }
      }
      const due = []
      for (const record of records) {
        if (!record || typeof record.key !== 'string') continue
        await this.ensureCloudRecord(record.key)
        const entry = this.stateEntry(record.key)
        if (this.clock() - (entry.lastPulledAt ?? 0) >= (this.cloud.pullIntervalMs ?? 5_000)) due.push(record.key)
      }
      for (const key of due) {
        if (signal.aborted) break
        const fresh = await this.freshRecord(key)
        if (fresh) {
          await this.pullProject(fresh, { signal })
          sawNetwork = true
        }
      }
      if (sawNetwork) this.markOnline()
      await this.saveState().catch(() => {})
    } catch (error) {
      this.noteError(error)
      await this.saveState().catch(() => {})
    }
  }

  async pullProjectList({ signal } = {}) {
    const payload = await this.client.request('GET', '/v1/projects?limit=200', { signal })
    const projects = Array.isArray(payload?.projects) ? payload.projects : []
    for (const remote of projects) {
      if (!remote || typeof remote.id !== 'string') continue
      const local = await this.ensureLocalProject(remote)
      if (!local) continue
      const entry = this.stateEntry(local.key)
      entry.cloudId = remote.id
      entry.identity = remote.identity
      entry.summaryVersion = Number.isSafeInteger(remote.summaryVersion) ? remote.summaryVersion : entry.summaryVersion
      entry.cloudNoteCount = remote.noteCount
      await this.store.updateProjectMeta(local.key, {
        cloudId: remote.id,
        identity: remote.identity,
        identitySource: remote.identitySource,
        cloudNoteCount: remote.noteCount,
        cloudLastSeq: remote.lastSeq,
        cloudSummaryVersion: remote.summaryVersion,
        cloudUpdatedAt: remote.updatedAt,
        ...(local.remote === true ? { title: remote.title } : {}),
      }).catch(() => {})
    }
    this.state.lastListAt = this.clock()
  }

  /** Find or create the local cache record for one cloud project. */
  async ensureLocalProject(remote) {
    const registry = await this.store.readRegistry()
    let local = Object.values(registry.projects).find((record) => record.cloudId === remote.id)
    if (!local && typeof remote.identity === 'string') {
      local = Object.values(registry.projects).find((record) => record.identity === remote.identity)
    }
    if (!local) {
      const hinted = await this.findHintedCheckout(remote)
      const cachePath = hinted ?? join(this.cloudDir, 'remote', remote.id)
      local = await this.store.registerProject({ path: cachePath, title: remote.title })
      local = await this.store.updateProjectMeta(local.key, {
        remote: hinted === undefined,
        identity: remote.identity,
        identitySource: remote.identitySource,
        cloudId: remote.id,
      }) ?? local
      if (hinted !== undefined) {
        this.logger?.info?.(`dsh-project-memory: linked shared project ${remote.id} to local checkout ${hinted}`)
      }
    }
    return local
  }

  /** Reuse an existing checkout on this Mac when a path hint matches its git remote. */
  async findHintedCheckout(remote) {
    if (!Array.isArray(remote.pathHints) || remote.pathHints.length === 0) return undefined
    for (const hint of remote.pathHints.slice(0, 5)) {
      const path = typeof hint?.path === 'string' ? hint.path : undefined
      if (!path || !path.startsWith('/')) continue
      try {
        await access(path)
      } catch {
        continue
      }
      const identity = await resolveProjectIdentity({
        path,
        title: remote.title,
        override: this.cloud.identity,
        record: { identity: remote.identity, identitySource: remote.identitySource, identityCheckedAt: this.clock(), remote: false },
        maxAgeMs: 0,
        execFileImpl: this.deps.execFileImpl,
      })
      if (identity.identity === remote.identity) return path
    }
    return undefined
  }

  async ensureCloudRecord(localKey) {
    let record = await this.freshRecord(localKey)
    if (!record) return undefined
    const remoteAuthoritative = record.remote === true && typeof record.identity === 'string' && record.identity.length > 0
    if (!remoteAuthoritative && (!record.identity || !identityIsFresh(record, { now: this.clock() }))) {
      const identity = await resolveProjectIdentity({
        path: record.path,
        title: record.title,
        override: this.cloud.identity,
        record,
        now: this.clock(),
        execFileImpl: this.deps.execFileImpl,
      })
      record = await this.store.updateProjectMeta(localKey, identity) ?? record
    }
    if (record.cloudId && record.remote !== true && !record.cloudBackfilledAt) {
      await this.enqueueBackfill(record, { includeSummary: false })
    }
    if (!record.cloudId && !this.outbox.has('project.register', localKey)) {
      await this.outbox.enqueue('project.register', {
        identity: record.identity,
        identitySource: record.identitySource,
        title: record.title,
        ...(record.remote === true ? {} : { pathHint: record.path }),
      }, { localKey })
    }
    return record
  }

  async pullProject(record, { signal } = {}) {
    const cloudId = await this.resolveCloudId(record.key, { signal })
    const entry = this.stateEntry(record.key)
    // If the pull had to register the project directly, drop the now-redundant
    // queued registration (the operation is idempotent either way).
    const queuedRegister = this.outbox.pending.find(
      (op) => op.type === 'project.register' && op.localKey === record.key,
    )
    if (queuedRegister) await this.outbox.ack(queuedRegister.opId).catch(() => {})
    let cursor = entry.notesSeq ?? 0
    let pages = 0
    let first = undefined
    let latest = undefined
    while (pages < 5) {
      const query = new URLSearchParams({ notesSinceSeq: String(cursor), notesLimit: '200' })
      if (pages === 0) query.set('includeSummary', '1')
      const result = await this.client.request(
        'GET',
        `/v1/projects/${encodeURIComponent(cloudId)}?${query.toString()}`,
        { signal },
      )
      if (pages === 0) first = result
      latest = result
      if (Array.isArray(result?.notes) && result.notes.length > 0) {
        await this.store.importNotes(record, result.notes)
      }
      cursor = Number.isSafeInteger(result?.paging?.nextSinceSeq) ? result.paging.nextSinceSeq : cursor
      entry.notesSeq = cursor
      pages += 1
      if (result?.paging?.hasMore !== true) break
    }
    const summary = first?.summary
    const knownSummaryVersion = entry.summaryCached === true ? (entry.summaryVersion ?? 0) : 0
    if (summary && Number.isSafeInteger(summary.version) && summary.version > knownSummaryVersion) {
      if (!this.outbox.has('summary.upsert', record.key)) {
        await this.store.importSummary(record, {
          content: summary.content,
          version: summary.version,
          updatedAt: summary.updatedAt,
          updatedBy: summary.updatedBy,
        })
        entry.summaryVersion = summary.version
        entry.summaryCached = true
      }
    }
    const project = latest?.project ?? first?.project
    if (project) {
      entry.cloudNoteCount = project.noteCount
      await this.store.updateProjectMeta(record.key, {
        cloudId,
        cloudNoteCount: project.noteCount,
        cloudLastSeq: project.lastSeq,
        cloudSummaryVersion: entry.summaryVersion ?? record.cloudSummaryVersion ?? 0,
        cloudUpdatedAt: project.updatedAt,
      }).catch(() => {})
    }
    entry.lastPulledAt = this.clock()
  }

  async freshRecord(localKey) {
    const registry = await this.store.readRegistry()
    return registry.projects[localKey]
  }

  // ------------------------------------------------------------------ writes

  async resolveProject(args = {}) {
    const text = typeof args.project === 'string' ? args.project.trim() : ''
    if (text.length > 0) {
      const registry = await this.store.readRegistry()
      const byCloud = Object.values(registry.projects).find(
        (record) => record.identity === text || record.cloudId === text,
      )
      if (byCloud) return byCloud
    }
    return this.store.resolveProject(args)
  }

  async registerProject({ path, title } = {}) {
    let record = await this.store.registerProject({ path, title })
    if (!this.client) return record
    record = await this.ensureIdentity(record)
    const entry = this.stateEntry(record.key)
    const needsRegister = !record.cloudId
      || entry.identity !== record.identity
      || (entry.cloudId && entry.identity && entry.identity !== record.identity)
    if (needsRegister && !this.outbox.has('project.register', record.key)) {
      await this.outbox.enqueue('project.register', {
        identity: record.identity,
        identitySource: record.identitySource,
        title: record.title,
        ...(record.remote === true ? {} : { pathHint: record.path }),
      }, { localKey: record.key })
      this.kick({ budgetMs: 1_200 })
    }
    return record
  }

  async ensureIdentity(record) {
    if (!this.client) return record
    if (record.remote === true && typeof record.identity === 'string' && record.identity.length > 0) return record
    if (identityIsFresh(record, { now: this.clock() })) return record
    const identity = await resolveProjectIdentity({
      path: record.path,
      title: record.title,
      override: this.cloud.identity,
      record,
      now: this.clock(),
      execFileImpl: this.deps.execFileImpl,
    })
    return (await this.store.updateProjectMeta(record.key, identity)) ?? record
  }

  async appendNote({ project, title, body, tags, authorRole, authorId } = {}) {
    const result = await this.store.appendNote({ project, title, body, tags, authorRole, authorId })
    if (!this.client) return result
    const record = await this.ensureCloudRecord(project.key)
    if (!record) return result
    const note = {
      id: result.note.id,
      at: result.note.atMs,
      authorRole: authorRole === 'super' ? 'super' : 'worker',
      authorId: typeof authorId === 'string' ? authorId : '',
      title: result.note.title,
      tags: result.note.tags,
      body: String(body ?? ''),
    }
    await this.outbox.enqueue('note.append', { note }, { localKey: project.key })
    const flushed = await this.flush({ budgetMs: this.cloud.writeBudgetMs ?? 1_800 })
    if (flushed?.pending > 0 && !flushed.error && !flushed.offline) {
      await this.flush({ budgetMs: this.cloud.writeBudgetMs ?? 1_800 })
    }
    return result
  }

  async writeSummary({ project, content, mode = 'replace' } = {}) {
    if (!this.client) return this.store.writeSummary({ project, content, mode })
    const record = await this.ensureCloudRecord(project.key)
    if (!record) return this.store.writeSummary({ project, content, mode })
    if (mode === 'append') {
      try {
        const entry = this.stateEntry(project.key)
        if (this.clock() - (entry.lastPulledAt ?? 0) > (this.cloud.pullIntervalMs ?? 5_000)) {
          await this.pullProject(record, { signal: AbortSignal.timeout(1_200) })
        }
      } catch (error) {
        this.noteError(error)
      }
    }
    const result = await this.store.writeSummary({ project: record, content, mode })
    const stored = await this.store.readSummary(record, { full: true })
    const entry = this.stateEntry(project.key)
    await this.outbox.enqueue('summary.upsert', {
      content: summaryForCloud(stored.content),
      baseVersion: entry.summaryVersion ?? record.cloudSummaryVersion ?? 0,
    }, { localKey: project.key })
    const flushed = await this.flush({ budgetMs: this.cloud.writeBudgetMs ?? 1_800 })
    if (flushed?.pending > 0 && !flushed.error && !flushed.offline) {
      await this.flush({ budgetMs: this.cloud.writeBudgetMs ?? 1_800 })
    }
    return result
  }
}

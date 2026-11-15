import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { MemoryError } from './errors.js'
import { withFileLock } from './lock.js'
import { assertProjectKey, canonicalProjectPath, isoTimestamp, projectKeyFor } from './projects.js'
import { normalizeTags } from './tags.js'

/** Format version for every file this store owns. */
export const STORE_VERSION = 1

/** Hard write/read limits chosen so one note can never dominate a context. */
export const LIMITS = Object.freeze({
  titleChars: 200,
  bodyChars: 64 * 1024,
  summaryChars: 32 * 1024,
  previewChars: 320,
  readLimitDefault: 20,
  readLimitMax: 100,
  summaryReadDefault: 6_000,
  searchLimitDefault: 20,
  searchLimitMax: 50,
  resultBudgetChars: 120_000,
  projectsDefault: 50,
  projectsMax: 200,
  writesPerCall: 20,
  indexPreviewChars: 320,
})

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clip(value, max) {
  const text = String(value ?? '')
  if (text.length <= max) return { text, truncated: false }
  return { text: `${text.slice(0, Math.max(0, max - 1))}…`, truncated: true }
}

function textOf(value) {
  return typeof value === 'string' ? value : ''
}

function normalizeSince(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (typeof value === 'string') {
    const text = value.trim()
    if (/^\d+$/.test(text)) return Number(text)
    const parsed = Date.parse(text)
    if (Number.isFinite(parsed)) return parsed
  }
  throw new MemoryError('notes/since-invalid', `since must be an ISO date or epoch milliseconds, got ${JSON.stringify(value)}`)
}

function normalizeLimit(value, fallback, max) {
  if (value === undefined || value === null) return fallback
  if (!Number.isSafeInteger(value) || value < 1) throw new MemoryError('read/limit-invalid', `limit must be a positive integer, got ${JSON.stringify(value)}`)
  return Math.min(value, max)
}

function normalizeMode(value) {
  if (value === undefined || value === null || value === '') return 'replace'
  if (value === 'replace' || value === 'append') return value
  throw new MemoryError('summary/mode-invalid', `mode must be "replace" or "append", got ${JSON.stringify(value)}`)
}

function notePreview(body) {
  return clip(String(body ?? '').replace(/\s+/g, ' ').trim(), LIMITS.indexPreviewChars)
}

function noteEntry(note, lineBytes) {
  const preview = notePreview(note.body)
  return {
    id: note.id,
    at: note.at,
    authorRole: note.authorRole,
    ...(note.machineId ? { machineId: note.machineId } : {}),
    title: note.title,
    tags: note.tags,
    preview: preview.text,
    bodyChars: String(note.body ?? '').length,
    bytes: lineBytes,
  }
}

function parseNoteLine(line, projectKey) {
  if (line.trim().length === 0) return undefined
  let raw
  try {
    raw = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(raw)) return undefined
  if (typeof raw.id !== 'string' || raw.id.length === 0) return undefined
  if (typeof raw.at !== 'number' || !Number.isFinite(raw.at) || raw.at < 0) return undefined
  if (typeof raw.title !== 'string' || raw.title.length === 0) return undefined
  if (typeof raw.body !== 'string') return undefined
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((tag) => typeof tag === 'string') : []
  return {
    id: raw.id,
    at: raw.at,
    authorRole: raw.authorRole === 'super' ? 'super' : 'worker',
    authorId: textOf(raw.authorId),
    machineId: textOf(raw.machineId),
    projectKey: typeof raw.projectKey === 'string' && raw.projectKey.length > 0 ? raw.projectKey : projectKey,
    title: raw.title,
    tags,
    body: raw.body,
  }
}

function emptyRegistry() {
  return { version: STORE_VERSION, updatedAt: null, projects: {} }
}

/** Fields synced from the cloud registry; all are optional local metadata. */
const CLOUD_PROJECT_FIELDS = Object.freeze([
  'identity', 'identitySource', 'gitRemote', 'cloudId', 'cloudSummaryVersion',
  'cloudNoteCount', 'cloudLastSeq', 'cloudUpdatedAt', 'identityCheckedAt', 'remote', 'cloudBackfilledAt',
])

function cloudProjectFields(value) {
  return {
    identity: typeof value.identity === 'string' && value.identity.length > 0 ? value.identity : null,
    identitySource: value.identitySource === 'git' || value.identitySource === 'title' || value.identitySource === 'config'
      ? value.identitySource
      : null,
    gitRemote: typeof value.gitRemote === 'string' && value.gitRemote.length > 0 ? value.gitRemote : null,
    cloudId: typeof value.cloudId === 'string' && value.cloudId.length > 0 ? value.cloudId : null,
    cloudSummaryVersion: Number.isSafeInteger(value.cloudSummaryVersion) && value.cloudSummaryVersion >= 0 ? value.cloudSummaryVersion : 0,
    cloudNoteCount: Number.isSafeInteger(value.cloudNoteCount) && value.cloudNoteCount >= 0 ? value.cloudNoteCount : null,
    cloudLastSeq: Number.isSafeInteger(value.cloudLastSeq) && value.cloudLastSeq >= 0 ? value.cloudLastSeq : 0,
    cloudUpdatedAt: typeof value.cloudUpdatedAt === 'number' && value.cloudUpdatedAt > 0 ? value.cloudUpdatedAt : null,
    identityCheckedAt: typeof value.identityCheckedAt === 'number' && value.identityCheckedAt > 0 ? value.identityCheckedAt : null,
    remote: value.remote === true,
    cloudBackfilledAt: typeof value.cloudBackfilledAt === 'number' && value.cloudBackfilledAt > 0 ? value.cloudBackfilledAt : null,
  }
}

function pickCloudFields(patch) {
  const picked = {}
  for (const field of CLOUD_PROJECT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) picked[field] = patch[field]
  }
  return picked
}

function normalizeRegistry(raw) {
  const registry = emptyRegistry()
  if (!isRecord(raw) || !isRecord(raw.projects)) return registry
  for (const value of Object.values(raw.projects)) {
    if (!isRecord(value) || typeof value.key !== 'string' || typeof value.path !== 'string') continue
    if (!/^[a-z0-9\u4e00-\u9fff][a-z0-9\u4e00-\u9fff-]{0,80}$/.test(value.key)) continue
    registry.projects[value.key] = {
      key: value.key,
      path: value.path,
      title: typeof value.title === 'string' && value.title.trim() ? value.title.trim() : basename(value.path) || value.path,
      createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
      updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
      summaryUpdatedAt: typeof value.summaryUpdatedAt === 'number' ? value.summaryUpdatedAt : null,
      summaryChars: typeof value.summaryChars === 'number' ? value.summaryChars : 0,
      noteCount: Number.isSafeInteger(value.noteCount) && value.noteCount >= 0 ? value.noteCount : 0,
      lastNoteAt: typeof value.lastNoteAt === 'number' ? value.lastNoteAt : null,
      indexBytes: typeof value.indexBytes === 'number' ? value.indexBytes : 0,
      ...cloudProjectFields(value),
    }
  }
  registry.updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : null
  return registry
}

function emptyBindings() {
  return { version: STORE_VERSION, updatedAt: null, bindings: {} }
}

function normalizeBindings(raw) {
  const doc = emptyBindings()
  if (!isRecord(raw) || !isRecord(raw.bindings)) return doc
  for (const [sessionId, value] of Object.entries(raw.bindings)) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) continue
    if (!isRecord(value) || typeof value.path !== 'string' || value.path.length === 0) continue
    doc.bindings[sessionId] = {
      projectKey: typeof value.projectKey === 'string' ? value.projectKey : '',
      path: value.path,
      title: typeof value.title === 'string' && value.title.trim() ? value.title.trim() : basename(value.path) || value.path,
      workspacePath: typeof value.workspacePath === 'string' ? value.workspacePath : '',
      boundAt: typeof value.boundAt === 'number' ? value.boundAt : 0,
    }
  }
  doc.updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : null
  return doc
}

/**
 * One project-memory store rooted at `$DSH_HOME/state/dsh-project-memory`.
 *
 * Layout:
 *   registry.json                     compact project index
 *   projects/<key>/project.json       one project's identity
 *   projects/<key>/summary.md         Super Agent's curated summary
 *   projects/<key>/notes.jsonl        append-only detail notes
 *   projects/<key>/index.json         compact note index (self-healing)
 *   locks/                            cross-process lock directories
 */
export class ProjectMemoryStore {
  constructor({ rootDir, clock = Date.now, lockTimeoutMs = 15_000 } = {}) {
    if (typeof rootDir !== 'string' || rootDir.length === 0) throw new Error('rootDir is required')
    this.rootDir = rootDir
    this.projectsDir = join(rootDir, 'projects')
    this.locksDir = join(rootDir, 'locks')
    this.clock = clock
    this.lockTimeoutMs = lockTimeoutMs
  }

  async init() {
    await mkdir(this.projectsDir, { recursive: true, mode: 0o700 })
    await mkdir(this.locksDir, { recursive: true, mode: 0o700 })
  }

  registryPath() {
    return join(this.rootDir, 'registry.json')
  }

  lockPath(name) {
    return join(this.locksDir, `${name}.lock`)
  }

  projectDir(key) {
    return join(this.projectsDir, assertProjectKey(key))
  }

  notesPath(key) {
    return join(this.projectDir(key), 'notes.jsonl')
  }

  indexPath(key) {
    return join(this.projectDir(key), 'index.json')
  }

  summaryPath(key) {
    return join(this.projectDir(key), 'summary.md')
  }

  projectFilePath(key) {
    return join(this.projectDir(key), 'project.json')
  }

  bindingsPath() {
    return join(this.rootDir, 'bindings.json')
  }

  /** Canonical paths of every registered project, used by the root resolver. */
  async registeredPaths() {
    const registry = await this.readRegistry()
    return Object.values(registry.projects).map((project) => project.path)
  }

  async readBindings() {
    try {
      return normalizeBindings(JSON.parse(await readFile(this.bindingsPath(), 'utf8')))
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyBindings()
      try {
        await rename(this.bindingsPath(), `${this.bindingsPath()}.corrupt-${Date.now()}`)
      } catch { /* best effort */ }
      return emptyBindings()
    }
  }

  /** One session's persisted worker project binding, if any. */
  async getBinding(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    const doc = await this.readBindings()
    return doc.bindings[sessionId]
  }

  /**
   * Persist the first binding for a session. A binding is immutable: a second
   * caller receives the existing record instead of replacing it.
   */
  async bindWorker(sessionId, binding) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new MemoryError('binding/invalid', 'session id is required for a worker binding')
    if (!binding || typeof binding.path !== 'string' || binding.path.length === 0) {
      throw new MemoryError('binding/invalid', 'binding.path is required')
    }
    return withFileLock(this.lockPath('bindings'), async () => {
      const doc = await this.readBindings()
      if (doc.bindings[sessionId] !== undefined) return doc.bindings[sessionId]
      const now = this.clock()
      const record = {
        projectKey: typeof binding.projectKey === 'string' ? binding.projectKey : '',
        path: binding.path,
        title: typeof binding.title === 'string' && binding.title.trim() ? binding.title.trim() : basename(binding.path) || binding.path,
        workspacePath: typeof binding.workspacePath === 'string' ? binding.workspacePath : '',
        boundAt: now,
      }
      doc.bindings[sessionId] = record
      // Bound sessions are long-lived; keep a bounded, newest-first catalog.
      const entries = Object.entries(doc.bindings)
      if (entries.length > 2000) {
        entries.sort((a, b) => (b[1].boundAt || 0) - (a[1].boundAt || 0))
        doc.bindings = Object.fromEntries(entries.slice(0, 2000))
      }
      doc.updatedAt = now
      await this.writeAtomic(this.bindingsPath(), `${JSON.stringify(doc, null, 2)}\n`)
      return record
    }, { timeoutMs: this.lockTimeoutMs })
  }

  /** Remove a stale binding (e.g. its workspace no longer matches the session). */
  async clearBinding(sessionId) {
    return withFileLock(this.lockPath('bindings'), async () => {
      const doc = await this.readBindings()
      if (doc.bindings[sessionId] === undefined) return false
      delete doc.bindings[sessionId]
      doc.updatedAt = this.clock()
      await this.writeAtomic(this.bindingsPath(), `${JSON.stringify(doc, null, 2)}\n`)
      return true
    }, { timeoutMs: this.lockTimeoutMs })
  }

  async readRegistry() {
    try {
      return normalizeRegistry(JSON.parse(await readFile(this.registryPath(), 'utf8')))
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyRegistry()
      // A malformed registry is moved aside, never trusted.
      try {
        await rename(this.registryPath(), `${this.registryPath()}.corrupt-${Date.now()}`)
      } catch { /* best effort */ }
      return emptyRegistry()
    }
  }

  async writeRegistryRaw(registry) {
    const text = `${JSON.stringify(registry, null, 2)}\n`
    await this.writeAtomic(this.registryPath(), text)
  }

  async updateRegistry(mutate) {
    return withFileLock(this.lockPath('registry'), async () => {
      const registry = await this.readRegistry()
      const result = mutate(registry)
      registry.updatedAt = this.clock()
      await this.writeRegistryRaw(registry)
      return result
    }, { timeoutMs: this.lockTimeoutMs })
  }

  /** Atomic replace used for every JSON/markdown file this store owns. */
  async writeAtomic(file, text) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, text, { mode: 0o600 })
      await rename(temporary, file)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }

  async listProjects({ limit = LIMITS.projectsDefault } = {}) {
    const registry = await this.readRegistry()
    const max = normalizeLimit(limit, LIMITS.projectsDefault, LIMITS.projectsMax)
    const projects = Object.values(registry.projects)
      .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
    return { projects: projects.slice(0, max).map(publicProject), total: projects.length }
  }

  /**
   * Resolve a project by key, unique title/basename, or path. Writes register
   * the canonical path on first use.
   * @returns {Promise<Record<string, unknown>>}
   */
  async resolveProject({ project, cwd, autoRegister = true, title } = {}) {
    const text = typeof project === 'string' ? project.trim() : ''
    if (text.length === 0) throw new MemoryError('project/missing', 'project is required')
    const registry = await this.readRegistry()
    if (registry.projects[text]) return registry.projects[text]

    if (!text.includes('/') && !text.includes('\\') && !text.startsWith('.') && !text.startsWith('~')) {
      const matches = Object.values(registry.projects).filter((record) =>
        record.title === text || basename(record.path) === text)
      if (matches.length === 1) return matches[0]
      if (matches.length > 1) {
        throw new MemoryError(
          'project/ambiguous',
          `project name "${text}" matches several projects; use a project key or absolute path: ${matches.map((record) => record.key).join(', ')}`,
        )
      }
    }

    const canonical = await canonicalProjectPath(text, { cwd })
    const existing = Object.values(registry.projects).find((record) => record.path === canonical)
    if (existing) return existing
    if (!autoRegister) {
      throw new MemoryError('project/unknown', `project "${canonical}" is not registered; write to it once or use an absolute path`)
    }
    return this.registerProject({ path: canonical, title })
  }

  async registerProject({ path, title } = {}) {
    const canonical = await canonicalProjectPath(path)
    return withFileLock(this.lockPath('registry'), async () => {
      const registry = await this.readRegistry()
      const existing = Object.values(registry.projects).find((record) => record.path === canonical)
      if (existing) {
        if (typeof title === 'string' && title.trim() && title.trim() !== existing.title) {
          existing.title = title.trim()
          existing.updatedAt = this.clock()
          registry.updatedAt = this.clock()
          await this.writeRegistryRaw(registry)
        }
        return existing
      }
      let key = projectKeyFor(canonical)
      if (registry.projects[key] && registry.projects[key].path !== canonical) {
        key = `${key}-${randomUUID().slice(0, 6)}`
      }
      const now = this.clock()
      const record = {
        key,
        path: canonical,
        title: typeof title === 'string' && title.trim() ? title.trim() : basename(canonical) || canonical,
        createdAt: now,
        updatedAt: now,
        summaryUpdatedAt: null,
        summaryChars: 0,
        noteCount: 0,
        lastNoteAt: null,
        indexBytes: 0,
        ...cloudProjectFields({}),
      }
      await mkdir(this.projectDir(key), { recursive: true, mode: 0o700 })
      await this.writeAtomic(this.projectFilePath(key), `${JSON.stringify({ version: STORE_VERSION, ...record }, null, 2)}\n`)
      registry.projects[key] = record
      registry.updatedAt = now
      await this.writeRegistryRaw(registry)
      return record
    }, { timeoutMs: this.lockTimeoutMs })
  }

  /** Update the local metadata cache for one project (cloud sync fields included). */
  async updateProjectMeta(key, patch = {}) {
    const safeKey = assertProjectKey(key)
    return withFileLock(this.lockPath('registry'), async () => {
      const registry = await this.readRegistry()
      const stored = registry.projects[safeKey]
      if (!stored) return undefined
      const picked = pickCloudFields(patch)
      const cloud = cloudProjectFields({ ...stored, ...picked })
      for (const field of Object.keys(picked)) stored[field] = cloud[field]
      if (typeof patch.title === 'string' && patch.title.trim()) stored.title = patch.title.trim()
      if (Number.isFinite(patch.summaryUpdatedAt)) stored.summaryUpdatedAt = patch.summaryUpdatedAt
      if (Number.isSafeInteger(patch.summaryChars) && patch.summaryChars >= 0) stored.summaryChars = patch.summaryChars
      if (Number.isSafeInteger(patch.noteCount) && patch.noteCount >= 0) stored.noteCount = patch.noteCount
      if (Number.isFinite(patch.lastNoteAt)) stored.lastNoteAt = patch.lastNoteAt
      if (Number.isFinite(patch.updatedAt)) stored.updatedAt = patch.updatedAt
      if (Number.isSafeInteger(patch.indexBytes) && patch.indexBytes >= 0) stored.indexBytes = patch.indexBytes
      await this.writeAtomic(this.projectFilePath(safeKey), `${JSON.stringify({ version: STORE_VERSION, ...stored }, null, 2)}\n`)
      registry.updatedAt = this.clock()
      await this.writeRegistryRaw(registry)
      return stored
    }, { timeoutMs: this.lockTimeoutMs })
  }

  /**
   * Merge notes fetched from the cloud into the local append-only log.
   * Idempotent by note id: a note that already exists locally is never rewritten.
   * @returns {Promise<{imported: number, skipped: number}>}
   */
  async importNotes(record, notes) {
    const incoming = []
    if (!Array.isArray(notes)) return { imported: 0, skipped: 0 }
    for (const raw of notes) {
      if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0) continue
      if (typeof raw.at !== 'number' || !Number.isFinite(raw.at) || raw.at < 0) continue
      if (typeof raw.title !== 'string' || raw.title.length === 0) continue
      if (typeof raw.body !== 'string') continue
      incoming.push({
        id: raw.id,
        at: raw.at,
        authorRole: raw.authorRole === 'super' ? 'super' : 'worker',
        authorId: textOf(raw.authorId),
        machineId: textOf(raw.machineId),
        title: raw.title,
        tags: Array.isArray(raw.tags) ? raw.tags.filter((tag) => typeof tag === 'string') : [],
        body: raw.body,
      })
    }
    if (incoming.length === 0) return { imported: 0, skipped: 0 }
    return withFileLock(this.lockPath(record.key), async () => {
      const notesFile = this.notesPath(record.key)
      let text = ''
      try {
        text = await readFile(notesFile, 'utf8')
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      const existing = new Set()
      for (const line of text.split('\n')) {
        const note = parseNoteLine(line, record.key)
        if (note) existing.add(note.id)
      }
      const fresh = []
      for (const note of incoming) {
        if (existing.has(note.id)) continue
        existing.add(note.id)
        fresh.push(note)
      }
      if (fresh.length === 0) return { imported: 0, skipped: incoming.length }
      await mkdir(this.projectDir(record.key), { recursive: true, mode: 0o700 })
      const separator = text.length > 0 && !text.endsWith('\n') ? '\n' : ''
      const payload = separator + fresh
        .map((note) => `${JSON.stringify({ ...note, projectKey: record.key })}\n`)
        .join('')
      await appendFile(notesFile, payload, { encoding: 'utf8', mode: 0o600 })
      const fileBytes = (await stat(notesFile)).size
      const index = await this.rebuildIndexUnlocked(record, fileBytes)
      const now = this.clock()
      const newest = fresh.reduce((max, note) => Math.max(max, note.at), 0)
      await this.updateRegistry((registry) => {
        const stored = registry.projects[record.key]
        if (!stored) return
        stored.noteCount = index.noteCount
        stored.lastNoteAt = Math.max(stored.lastNoteAt ?? 0, newest) || null
        stored.updatedAt = now
        stored.indexBytes = Buffer.byteLength(JSON.stringify(index))
      })
      return { imported: fresh.length, skipped: incoming.length - fresh.length }
    }, { timeoutMs: this.lockTimeoutMs })
  }

  /**
   * Install a summary fetched from the cloud into the local cache.
   * The cloud keeps the version history; the cache always mirrors the newest
   * accepted server version. Callers must not use this while a local summary
   * upsert is still queued.
   */
  async importSummary(record, { content, version, updatedAt, updatedBy } = {}) {
    if (typeof content !== 'string' || content.trim().length === 0) return { imported: false }
    const numericVersion = Number.isSafeInteger(version) && version > 0 ? version : 0
    return withFileLock(this.lockPath(record.key), async () => {
      const text = content.endsWith('\n') ? content : `${content}\n`
      await mkdir(this.projectDir(record.key), { recursive: true, mode: 0o700 })
      await this.writeAtomic(this.summaryPath(record.key), text)
      const at = typeof updatedAt === 'number' && updatedAt > 0 ? updatedAt : this.clock()
      await this.updateProjectMeta(record.key, {
        cloudSummaryVersion: numericVersion,
        summaryUpdatedAt: at,
        summaryChars: text.length,
        updatedAt: Math.max(record.updatedAt ?? 0, at),
      })
      record.cloudSummaryVersion = numericVersion
      record.summaryUpdatedAt = at
      record.summaryChars = text.length
      record.updatedAt = Math.max(record.updatedAt ?? 0, at)
      return { imported: true, chars: text.length, version: numericVersion, updatedBy: textOf(updatedBy) }
    }, { timeoutMs: this.lockTimeoutMs })
  }

  async loadIndex(record) {
    return withFileLock(this.lockPath(record.key), async () => this.loadIndexUnlocked(record), { timeoutMs: this.lockTimeoutMs })
  }

  async loadIndexUnlocked(record) {
    const notesFile = this.notesPath(record.key)
    let fileBytes = 0
    try {
      fileBytes = (await stat(notesFile)).size
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    try {
      const raw = JSON.parse(await readFile(this.indexPath(record.key), 'utf8'))
      if (isRecord(raw) && raw.sourceBytes === fileBytes && Array.isArray(raw.notes) && raw.noteCount === raw.notes.length && raw.notes.every(indexEntryLooksValid)) {
        return {
          version: STORE_VERSION,
          projectKey: record.key,
          sourceBytes: fileBytes,
          noteCount: Number.isSafeInteger(raw.noteCount) ? raw.noteCount : raw.notes.length,
          updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : record.updatedAt,
          notes: raw.notes.filter(isRecord).filter((entry) => typeof entry.id === 'string'),
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // A malformed index is a cache miss; rebuild from the append-only log.
      }
    }
    return this.rebuildIndexUnlocked(record, fileBytes)
  }

  async rebuildIndexUnlocked(record, knownBytes) {
    const notesFile = this.notesPath(record.key)
    let text = ''
    try {
      text = await readFile(notesFile, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const notes = []
    for (const line of text.split('\n')) {
      const note = parseNoteLine(line, record.key)
      if (!note) continue
      notes.push(noteEntry(note, Buffer.byteLength(line) + 1))
    }
    const sourceBytes = knownBytes ?? Buffer.byteLength(text)
    const index = {
      version: STORE_VERSION,
      projectKey: record.key,
      sourceBytes,
      noteCount: notes.length,
      updatedAt: this.clock(),
      notes,
    }
    // A read of an empty project must not create a file. Projects get their
    // index on the first append or on the first rebuild with actual notes.
    if (notes.length > 0 || sourceBytes > 0) {
      await this.writeAtomic(this.indexPath(record.key), `${JSON.stringify(index)}\n`)
    }
    return index
  }

  /** Append one validated note and update both compact indexes before resolving. */
  async appendNote({ project, title, body, tags, authorRole, authorId } = {}) {
    const record = project
    const titleText = String(title ?? '').trim()
    if (titleText.length === 0) throw new MemoryError('note/title-missing', 'title is required')
    if (titleText.length > LIMITS.titleChars) {
      throw new MemoryError('note/title-too-large', `title must be at most ${LIMITS.titleChars} characters`)
    }
    const bodyText = String(body ?? '')
    if (bodyText.trim().length === 0) throw new MemoryError('note/body-missing', 'body is required')
    if (bodyText.length > LIMITS.bodyChars) {
      throw new MemoryError('note/body-too-large', `body must be at most ${LIMITS.bodyChars} characters (${bufferBytes(bodyText)} bytes)`)
    }
    const normalizedTags = normalizeTags(tags)
    const role = authorRole === 'super' ? 'super' : 'worker'
    const now = this.clock()
    const note = {
      id: `note-${now.toString(36)}-${randomUUID().slice(0, 8)}`,
      at: now,
      authorRole: role,
      authorId: textOf(authorId),
      projectKey: record.key,
      title: titleText,
      tags: normalizedTags,
      body: bodyText,
    }
    return withFileLock(this.lockPath(record.key), async () => {
      await mkdir(this.projectDir(record.key), { recursive: true, mode: 0o700 })
      const line = `${JSON.stringify(note)}\n`
      await appendFile(this.notesPath(record.key), line, { encoding: 'utf8', mode: 0o600 })
      const fileBytes = (await stat(this.notesPath(record.key))).size
      const index = await this.loadIndexUnlocked(record)
      if (!index.notes.some((entry) => entry.id === note.id)) {
        index.notes.push(noteEntry(note, Buffer.byteLength(line)))
      }
      index.noteCount = index.notes.length
      index.sourceBytes = fileBytes
      index.updatedAt = now
      await this.writeAtomic(this.indexPath(record.key), `${JSON.stringify(index)}\n`)

      await this.updateRegistry((registry) => {
        const stored = registry.projects[record.key]
        if (stored) {
          stored.noteCount = index.noteCount
          stored.lastNoteAt = now
          stored.updatedAt = now
          stored.indexBytes = Buffer.byteLength(JSON.stringify(index))
        }
      })
      return { note: publicNote(note), noteCount: index.noteCount }
    }, { timeoutMs: this.lockTimeoutMs })
  }

  /**
   * Every stored note with its body, used once per project to backfill the
   * cloud after the backend is enabled. Unlike readNotes this is not capped.
   */
  async readAllNotes(record) {
    return withFileLock(this.lockPath(record.key), async () => {
      let text = ''
      try {
        text = await readFile(this.notesPath(record.key), 'utf8')
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        return []
      }
      const notes = []
      for (const line of text.split('\n')) {
        const note = parseNoteLine(line, record.key)
        if (note) notes.push(note)
      }
      return notes
    }, { timeoutMs: this.lockTimeoutMs })
  }

  /** Read note metadata (and optionally bodies) from the compact index. */
  async readNotes({ projects = [], tags, since, limit = LIMITS.readLimitDefault, full = false } = {}) {
    const max = normalizeLimit(limit, LIMITS.readLimitDefault, LIMITS.readLimitMax)
    const tagFilter = tags === undefined ? undefined : normalizeTags(tags)
    const sinceAt = normalizeSince(since)
    const found = []
    for (const record of projects) {
      const index = await this.loadIndex(record)
      for (const entry of index.notes) {
        if (sinceAt !== undefined && entry.at < sinceAt) continue
        if (tagFilter !== undefined && !tagFilter.some((tag) => entry.tags.includes(tag))) continue
        found.push({ record, entry })
      }
    }
    found.sort((a, b) => b.entry.at - a.entry.at || b.entry.id.localeCompare(a.entry.id))
    const total = found.length
    const selected = found.slice(0, max)
    let bodies = new Map()
    if (full && selected.length > 0) {
      const byProject = new Map()
      for (const item of selected) {
        if (!byProject.has(item.record.key)) byProject.set(item.record.key, { record: item.record, ids: new Set() })
        byProject.get(item.record.key).ids.add(item.entry.id)
      }
      for (const group of byProject.values()) {
        const read = await this.readBodies(group.record, group.ids)
        for (const [id, body] of read) bodies.set(id, body)
      }
    }
    const notes = selected.map(({ record, entry }) => ({
      ...entry,
      projectKey: record.key,
      projectPath: record.path,
      truncated: full ? false : (entry.bodyChars ?? 0) > String(entry.preview ?? '').length,
      ...(full ? { body: bodies.get(entry.id) ?? '' } : {}),
    }))
    return { notes, total, returned: notes.length, truncated: total > notes.length }
  }

  async readBodies(record, ids) {
    const result = new Map()
    if (ids.size === 0) return result
    let text = ''
    try {
      text = await readFile(this.notesPath(record.key), 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return result
    }
    for (const line of text.split('\n')) {
      const note = parseNoteLine(line, record.key)
      if (note && ids.has(note.id)) result.set(note.id, note.body)
    }
    return result
  }

  async readSummary(record, { full = false } = {}) {
    try {
      const text = await readFile(this.summaryPath(record.key), 'utf8')
      const clipped = full ? clip(text, LIMITS.summaryChars + 1) : clip(text, LIMITS.summaryReadDefault)
      return {
        project: publicProject(record),
        exists: true,
        chars: text.length,
        content: clipped.text,
        truncated: clipped.truncated,
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return { project: publicProject(record), exists: false, chars: 0, content: '', truncated: false }
    }
  }

  /** Atomically replace or append one project's summary. */
  async writeSummary({ project, content, mode = 'replace' } = {}) {
    const record = project
    const next = String(content ?? '')
    if (next.trim().length === 0) throw new MemoryError('summary/empty', 'content is required')
    if (next.length > LIMITS.summaryChars) {
      throw new MemoryError('summary/too-large', `summary must be at most ${LIMITS.summaryChars} characters`)
    }
    const normalizedMode = normalizeMode(mode)
    return withFileLock(this.lockPath(record.key), async () => {
      await mkdir(this.projectDir(record.key), { recursive: true, mode: 0o700 })
      let existing = ''
      try {
        existing = await readFile(this.summaryPath(record.key), 'utf8')
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      const body = normalizedMode === 'append' && existing.trim().length > 0
        ? `${existing.trimEnd()}\n\n${next.trim()}`
        : next.trim()
      if (body.length > LIMITS.summaryChars) {
        throw new MemoryError('summary/too-large', `merged summary must be at most ${LIMITS.summaryChars} characters`)
      }
      const text = `${body}\n`
      await this.writeAtomic(this.summaryPath(record.key), text)
      const now = this.clock()
      await this.updateRegistry((registry) => {
        const stored = registry.projects[record.key]
        if (stored) {
          stored.summaryUpdatedAt = now
          stored.summaryChars = text.length
          stored.updatedAt = now
          record.summaryUpdatedAt = now
          record.summaryChars = text.length
          record.updatedAt = now
        }
      })
      return {
        project: publicProject(record),
        mode: normalizedMode,
        chars: text.length,
        updatedAt: isoTimestamp(now),
      }
    }, { timeoutMs: this.lockTimeoutMs })
  }

  /**
   * Search compact indexes first; read bodies only for candidates whose preview
   * did not already match. Tag-only searches never read notes.jsonl.
   */
  async searchNotes({ projects = [], query, tags, since, limit = LIMITS.searchLimitDefault, full = false } = {}) {
    const max = normalizeLimit(limit, LIMITS.searchLimitDefault, LIMITS.searchLimitMax)
    const tagFilter = tags === undefined ? undefined : normalizeTags(tags)
    const sinceAt = normalizeSince(since)
    const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
    const matches = []
    for (const record of projects) {
      const index = await this.loadIndex(record)
      const candidates = []
      for (const entry of index.notes) {
        if (sinceAt !== undefined && entry.at < sinceAt) continue
        if (tagFilter !== undefined && !tagFilter.some((tag) => entry.tags.includes(tag))) continue
        if (needle.length === 0) {
          matches.push({ record, entry, matchedBody: false })
          continue
        }
        const haystack = `${entry.title}\n${entry.tags.join(' ')}\n${entry.preview}`.toLowerCase()
        if (haystack.includes(needle)) {
          matches.push({ record, entry, matchedBody: false })
        } else {
          candidates.push(entry)
        }
      }
      if (candidates.length > 0) {
        const bodies = await this.readBodies(record, new Set(candidates.map((entry) => entry.id)))
        for (const entry of candidates) {
          if ((bodies.get(entry.id) ?? '').toLowerCase().includes(needle)) {
            matches.push({ record, entry, matchedBody: true })
          }
        }
      }
    }
    matches.sort((a, b) => b.entry.at - a.entry.at || b.entry.id.localeCompare(a.entry.id))
    const total = matches.length
    const selected = matches.slice(0, max)
    let bodies = new Map()
    if (full && selected.length > 0) {
      const byProject = new Map()
      for (const item of selected) {
        if (!byProject.has(item.record.key)) byProject.set(item.record.key, { record: item.record, ids: new Set() })
        byProject.get(item.record.key).ids.add(item.entry.id)
      }
      for (const group of byProject.values()) {
        const read = await this.readBodies(group.record, group.ids)
        for (const [id, body] of read) bodies.set(id, body)
      }
    }
    const results = selected.map(({ record, entry, matchedBody }) => ({
      ...entry,
      projectKey: record.key,
      projectPath: record.path,
      matchedBody,
      truncated: full ? false : (entry.bodyChars ?? 0) > String(entry.preview ?? '').length,
      ...(full ? { body: bodies.get(entry.id) ?? '' } : {}),
    }))
    return { matches: results, total, returned: results.length, truncated: total > results.length }
  }

  /** Compact project metadata used by list/search output. */
  get limits() {
    return LIMITS
  }
}

/** Whether one cached index entry has every field readers rely on. */
function indexEntryLooksValid(entry) {
  return isRecord(entry)
    && typeof entry.id === 'string'
    && typeof entry.at === 'number'
    && typeof entry.title === 'string'
    && Array.isArray(entry.tags)
    && typeof entry.preview === 'string'
    && typeof entry.bodyChars === 'number'
}

/** Byte length of a UTF-8 string. */
function bufferBytes(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8')
}

/** Public (non-sensitive) projection of a project record. */
export function publicProject(record) {
  return {
    key: record.key,
    path: record.path,
    title: record.title,
    noteCount: record.noteCount ?? 0,
    lastNoteAt: isoTimestamp(record.lastNoteAt),
    summaryUpdatedAt: isoTimestamp(record.summaryUpdatedAt),
    summaryChars: record.summaryChars ?? 0,
    ...(record.identity ? { identity: record.identity } : {}),
    ...(record.identitySource ? { identitySource: record.identitySource } : {}),
    ...(record.cloudId ? { cloudId: record.cloudId } : {}),
    ...(record.remote ? { remote: true } : {}),
    ...(Number.isSafeInteger(record.cloudNoteCount) ? { sharedNoteCount: record.cloudNoteCount } : {}),
    ...(Number.isSafeInteger(record.cloudSummaryVersion) && record.cloudSummaryVersion > 0 ? { summaryVersion: record.cloudSummaryVersion } : {}),
  }
}

/** Public projection of one note (never includes the body). */
export function publicNote(note) {
  return {
    id: note.id,
    at: isoTimestamp(note.at),
    atMs: note.at,
    projectKey: note.projectKey,
    authorRole: note.authorRole,
    ...(note.machineId ? { machineId: note.machineId } : {}),
    title: note.title,
    tags: note.tags,
    bodyChars: String(note.body ?? '').length,
    preview: notePreview(note.body).text,
  }
}

export { clip, normalizeSince, normalizeLimit, notePreview }

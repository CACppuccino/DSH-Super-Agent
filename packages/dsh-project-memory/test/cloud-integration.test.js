import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import worker from '../cloudflare/worker/src/index.ts'
import { createTestD1 } from '../cloudflare/worker/test/d1-shim.ts'
import { CloudflareBackend } from '../lib/backends/cloudflare.js'
import { ProjectMemoryStore } from '../lib/store.js'
import { waitForAbort } from './helpers.js'

const TOKEN = 'integration-test-token-value'
const URL_BASE = 'https://memory.test'

async function makeRepo(remote) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pm-cloud-repo-')))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir })
  return dir
}

async function makeRoot() {
  return realpath(await mkdtemp(join(tmpdir(), 'pm-cloud-root-')))
}

function harness() {
  const d1 = createTestD1()
  // If the shim silently skipped the migration, this fails with a clear error.
  d1.db.prepare('SELECT COUNT(*) AS count FROM projects').first()
  const env = { DB: d1.db, MEMORY_TOKEN: TOKEN }
  const rawFetch = (url, init) => worker.fetch(new Request(url, init), env)
  const state = { network: true, calls: 0, failMode: undefined }
  const fetchImpl = async (url, init) => {
    state.calls += 1
    if (!state.network) throw Object.assign(new Error('fetch failed: network offline'), { code: 'ECONNREFUSED' })
    if (state.failMode === 'timeout') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    return rawFetch(url, init)
  }
  const authHeaders = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'x-machine-id': 'inspect' }
  const raw = async (method, path, body) => {
    const response = await rawFetch(`${URL_BASE}${path}`, {
      method,
      headers: authHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }
  return { d1, env, rawFetch, fetchImpl, state, raw, close: () => d1.close() }
}

function cloudConfig(machineId) {
  return {
    url: URL_BASE,
    machineId,
    token: TOKEN,
    keychainService: 'test-service',
    keychainAccount: 'test-account',
    timeoutMs: 500,
    maxAttempts: 2,
    pullIntervalMs: 0,
    offlineBackoffMs: 800,
    staleAfterMs: 1_000,
    syncBudgetMs: 1_500,
    writeBudgetMs: 1_500,
    autoSync: false,
    autoSyncIntervalMs: 60_000,
  }
}

async function cloudIdOf(backend, key) {
  const registry = await backend.readRegistry()
  return registry.projects[key]?.cloudId
}

async function machine(harnessRef, machineId, { cloud = {}, fetchImpl } = {}) {
  const rootDir = await makeRoot()
  const backend = new CloudflareBackend({
    rootDir,
    cloud: { ...cloudConfig(machineId), ...cloud },
    fetchImpl: fetchImpl ?? harnessRef.fetchImpl,
    autoSync: false,
    logger: { info() {}, warn() {}, error() {} },
  })
  await backend.init()
  return { backend, rootDir }
}

/** Seed `count` notes through the real Worker in batches the API accepts. */
async function seedNotes(h, cloudId, count) {
  const ids = []
  for (let start = 0; start < count; start += 50) {
    const notes = Array.from({ length: Math.min(50, count - start) }, (_, index) => {
      const ordinal = start + index
      ids.push(`note-seed-${ordinal}`)
      return {
        id: `note-seed-${ordinal}`,
        at: Date.now(),
        title: `seed note ${ordinal}`,
        tags: ['工程'],
        body: `## seed\n\nbody ${ordinal}`,
      }
    })
    const response = await h.raw('POST', `/v1/projects/${encodeURIComponent(cloudId)}/notes`, { notes })
    assert.equal(response.status, 200, JSON.stringify(response.body))
  }
  return ids
}

test('two machines share notes through the real Worker while keeping separate local stores', async (t) => {
  const h = harness()
  t.after(() => h.close())
  const dirA = await makeRepo('git@github.com:example/shared.git')
  const dirB = await makeRepo('ssh://git@github.com/example/shared.git')
  assert.notEqual(dirA, dirB)

  const a = await machine(h, 'mac-a')
  const b = await machine(h, 'mac-b')
  t.after(() => a.backend.close())
  t.after(() => b.backend.close())

  const recordA = await a.backend.registerProject({ path: dirA, title: 'Shared app' })
  assert.equal(recordA.identity, 'git:github.com/example/shared')
  await a.backend.flush()
  assert.equal(a.backend.syncInfo().pendingWrites, 0)

  const recordB = await b.backend.registerProject({ path: dirB, title: 'Shared app' })
  assert.equal(recordB.identity, recordA.identity)
  await b.backend.flush()

  const byIdentity = await a.backend.resolveProject({ project: recordA.identity })
  assert.equal(byIdentity.key, recordA.key, 'projects resolve by shared identity')
  const cloudIdA = await cloudIdOf(a.backend, recordA.key)
  const byCloudId = await a.backend.resolveProject({ project: cloudIdA })
  assert.equal(byCloudId.key, recordA.key, 'projects resolve by cloud id')

  const listedB = await b.backend.listProjects()
  const sharedB = listedB.projects.find((project) => project.identity === recordA.identity)
  assert.ok(sharedB, 'machine B sees the shared project pulled from the cloud')
  assert.equal(sharedB.path, dirB, 'B reuses its own checkout as the local cache for the same git identity')
  assert.equal(sharedB.remote, undefined)

  const noteA = await a.backend.appendNote({
    project: recordA,
    title: 'note from A',
    body: '## A\n\nwritten on machine A',
    tags: ['工程'],
    authorRole: 'worker',
    authorId: 'worker-a',
  })
  assert.match(noteA.note.id, /^note-/)

  const readOnB = await b.backend.readNotes({ projects: [recordB], full: true })
  assert.equal(readOnB.total, 1)
  assert.equal(readOnB.notes[0].id, noteA.note.id)
  assert.equal(readOnB.notes[0].body, '## A\n\nwritten on machine A')
  assert.equal(readOnB.notes[0].machineId, 'mac-a')
  assert.equal(b.backend.syncInfo().stale, false)

  const noteB = await b.backend.appendNote({
    project: recordB,
    title: 'note from B',
    body: '## B\n\nwritten on machine B',
    tags: ['教训'],
    authorRole: 'worker',
    authorId: 'worker-b',
  })

  const readOnA = await a.backend.readNotes({ projects: [recordA], full: true })
  assert.equal(readOnA.total, 2, 'notes are a union by id')
  assert.deepEqual(new Set(readOnA.notes.map((note) => note.id)), new Set([noteA.note.id, noteB.note.id]))

  // Replaying the same note is idempotent at the Worker.
  assert.equal(typeof cloudIdA, 'string')
  const replay = await h.raw('POST', `/v1/projects/${encodeURIComponent(cloudIdA)}/notes`, {
    notes: [{
      id: noteA.note.id,
      at: Date.now(),
      title: 'note from A',
      tags: ['工程'],
      body: '## A\n\nwritten on machine A',
    }],
  })
  assert.equal(replay.status, 200)
  assert.deepEqual(replay.body.inserted, [])
  assert.deepEqual(replay.body.existing, [noteA.note.id])
})

test('conflicting summaries are last-write-wins but keep every previous version', async (t) => {
  const h = harness()
  t.after(() => h.close())
  const dirA = await makeRepo('git@github.com:example/conflict.git')
  const dirB = await makeRepo('git@github.com:example/conflict.git')
  const a = await machine(h, 'mac-a')
  const b = await machine(h, 'mac-b')
  t.after(() => a.backend.close())
  t.after(() => b.backend.close())

  const recordA = await a.backend.registerProject({ path: dirA, title: 'Conflict app' })
  await a.backend.flush()
  const recordB = await b.backend.registerProject({ path: dirB, title: 'Conflict app' })
  await b.backend.flush()

  await a.backend.writeSummary({ project: recordA, content: '# App\n\nA first' })
  await b.backend.readSummary(recordB, { full: true })
  await b.backend.writeSummary({ project: recordB, content: '# App\n\nB second' })

  // A still believes version 1 is current; the server is at 2.
  const third = await a.backend.writeSummary({ project: recordA, content: '# App\n\nA third' })
  assert.equal(third.chars, '# App\n\nA third\n'.length)
  const info = a.backend.syncInfo()
  assert.ok(info.lastConflict, 'the stale-base write is reported as a conflict')
  assert.equal(info.lastConflict.previousVersion, 2)
  assert.equal(info.lastConflict.version, 3)

  const cloudIdA = await cloudIdOf(a.backend, recordA.key)
  const history = await h.raw('GET', `/v1/projects/${encodeURIComponent(cloudIdA)}/summary/versions`)
  assert.equal(history.status, 200)
  assert.deepEqual(history.body.versions.map((entry) => entry.version), [3, 2, 1])
  assert.equal(history.body.versions[0].current, true)

  const archivedB = await h.raw('GET', `/v1/projects/${encodeURIComponent(cloudIdA)}/summary/versions/2`)
  assert.equal(archivedB.status, 200)
  assert.equal(archivedB.body.content, '# App\n\nB second', 'B\'s overwritten summary is preserved')

  const summaryOnB = await b.backend.readSummary(recordB, { full: true })
  assert.equal(summaryOnB.content, '# App\n\nA third\n', 'B observes the winning summary')
  assert.equal(summaryOnB.chars, '# App\n\nA third\n'.length)
})

test('offline writes queue durably, reads stay local and stale, and replay catches up', async (t) => {
  const h = harness()
  t.after(() => h.close())
  const dirA = await makeRepo('git@github.com:example/offline.git')
  const dirB = await makeRepo('git@github.com:example/offline.git')
  const a = await machine(h, 'mac-a')
  const b = await machine(h, 'mac-b')
  t.after(() => b.backend.close())

  const recordA = await a.backend.registerProject({ path: dirA, title: 'Offline app' })
  await a.backend.flush()
  const recordB = await b.backend.registerProject({ path: dirB, title: 'Offline app' })
  await b.backend.flush()
  await a.backend.writeSummary({ project: recordA, content: '# Offline\n\nbase' })
  await b.backend.readSummary(recordB, { full: true })

  h.state.network = false
  const offlineNote = await a.backend.appendNote({
    project: recordA,
    title: 'offline note',
    body: '## queued\n\nwritten without network',
    tags: ['经验'],
    authorRole: 'worker',
    authorId: 'worker-a',
  })
  assert.match(offlineNote.note.id, /^note-/, 'the local write succeeds')
  const offlineSummary = await a.backend.writeSummary({ project: recordA, content: '# Offline\n\noffline change' })
  assert.equal(offlineSummary.chars, '# Offline\n\noffline change\n'.length)

  const stale = await a.backend.readNotes({ projects: [recordA] })
  assert.equal(stale.total >= 1, true)
  const status = a.backend.syncInfo()
  assert.equal(status.online, false)
  assert.equal(status.stale, true)
  assert.ok(status.pendingWrites >= 2, `pending writes retained (${status.pendingWrites})`)
  assert.equal(status.error.kind, 'network')
  assert.equal(JSON.stringify(status).includes(TOKEN), false, 'sync status never contains the token')

  // The cloud has not seen the offline writes yet.
  const cloudIdA = await cloudIdOf(a.backend, recordA.key)
  const serverBefore = await h.raw('GET', `/v1/projects/${encodeURIComponent(cloudIdA)}?includeSummary=1`)
  assert.equal(serverBefore.body.notes.some((note) => note.id === offlineNote.note.id), false)
  assert.equal(serverBefore.body.summary.version, 1)

  await a.backend.close()

  // Restart the same machine (same cache + outbox) with the network back.
  h.state.network = true
  const restarted = new CloudflareBackend({
    rootDir: a.rootDir,
    cloud: cloudConfig('mac-a'),
    fetchImpl: h.fetchImpl,
    autoSync: false,
    logger: { info() {}, warn() {}, error() {} },
  })
  await restarted.init()
  assert.ok(restarted.syncInfo().pendingWrites >= 2, 'the outbox survived the restart')
  const flushed = await restarted.flush({ budgetMs: 5_000 })
  assert.equal(flushed.pending, 0, JSON.stringify(flushed))
  assert.equal(restarted.syncInfo().online, true)
  await restarted.close()

  const serverAfter = await h.raw('GET', `/v1/projects/${encodeURIComponent(cloudIdA)}?includeSummary=1`)
  assert.equal(serverAfter.body.notes.some((note) => note.id === offlineNote.note.id), true)
  assert.equal(serverAfter.body.summary.version, 2)
  assert.equal(serverAfter.body.summary.content, '# Offline\n\noffline change')

  const bNotes = await b.backend.readNotes({ projects: [recordB], full: true })
  assert.ok(bNotes.notes.some((note) => note.id === offlineNote.note.id), 'B receives the replayed note')
  const bSummary = await b.backend.readSummary(recordB, { full: true })
  assert.equal(bSummary.content, '# Offline\n\noffline change\n')
})

test('a worker token is required for every endpoint and wrong tokens never mutate data', async (t) => {
  const h = harness()
  t.after(() => h.close())
  const missing = await h.rawFetch(`${URL_BASE}/v1/projects`, { method: 'GET' })
  assert.equal(missing.status, 401)
  const wrong = await h.rawFetch(`${URL_BASE}/v1/projects`, {
    method: 'POST',
    headers: { authorization: 'Bearer wrong-token', 'content-type': 'application/json', 'x-machine-id': 'mac-x' },
    body: JSON.stringify({ identity: 'git:github.com/example/nope', title: 'nope' }),
  })
  assert.equal(wrong.status, 401)
  const list = await h.raw('GET', '/v1/projects')
  assert.deepEqual(list.body.projects, [])
})


test('enabling cloud mode backfills pre-existing local notes and a first summary exactly once', async (t) => {
  const h = harness()
  t.after(() => h.close())
  const dirA = await makeRepo('git@github.com:example/backfill.git')
  const rootDir = await makeRoot()

  // Existing local memory written before the cloud backend was enabled.
  const local = new ProjectMemoryStore({ rootDir })
  await local.init()
  const localRecord = await local.registerProject({ path: dirA, title: 'Backfill app' })
  const oldOne = await local.appendNote({
    project: localRecord,
    title: 'old note one',
    body: '## old\n\nfirst',
    tags: ['经验'],
    authorRole: 'worker',
    authorId: 'worker-old',
  })
  const oldTwo = await local.appendNote({
    project: localRecord,
    title: 'old note two',
    body: '## old\n\nsecond',
    tags: ['教训'],
    authorRole: 'worker',
    authorId: 'worker-old',
  })
  await local.writeSummary({ project: localRecord, content: '# Backfill app\n\npre-cloud summary' })

  const backend = new CloudflareBackend({
    rootDir,
    cloud: cloudConfig('mac-a'),
    fetchImpl: h.fetchImpl,
    autoSync: false,
    logger: { info() {}, warn() {}, error() {} },
  })
  await backend.init()
  t.after(() => backend.close())
  const record = await backend.registerProject({ path: dirA, title: 'Backfill app' })
  assert.equal(record.identity, 'git:github.com/example/backfill')

  // The register op and the backfill ops are queued together; drain them.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await backend.flush({ budgetMs: 5_000 })
    if (backend.syncInfo().pendingWrites === 0) break
  }
  assert.equal(backend.syncInfo().failedWrites, 0)
  assert.equal(backend.syncInfo().pendingWrites, 0)

  const cloudId = await cloudIdOf(backend, record.key)
  const remote = await h.raw('GET', `/v1/projects/${encodeURIComponent(cloudId)}?includeSummary=1&notesLimit=100`)
  assert.deepEqual(
    new Set(remote.body.notes.map((note) => note.id)),
    new Set([oldOne.note.id, oldTwo.note.id]),
    'all pre-cloud notes reached the shared store',
  )
  assert.equal(remote.body.summary.version, 1)
  assert.equal(remote.body.summary.content, '# Backfill app\n\npre-cloud summary')

  const registry = await backend.readRegistry()
  assert.ok(registry.projects[record.key].cloudBackfilledAt > 0)

  // Restarting the backend must not upload the same notes again.
  await backend.close()
  const restarted = new CloudflareBackend({
    rootDir,
    cloud: cloudConfig('mac-a'),
    fetchImpl: h.fetchImpl,
    autoSync: false,
    logger: { info() {}, warn() {}, error() {} },
  })
  await restarted.init()
  await restarted.flush({ budgetMs: 5_000 })
  assert.equal(restarted.syncInfo().pendingWrites, 0)
  await restarted.close()

  const again = await h.raw('GET', `/v1/projects/${encodeURIComponent(cloudId)}?notesLimit=100`)
  assert.equal(again.body.notes.length, 2)
  assert.equal(again.body.summary.version, 1)

  // A second machine receives the backfilled history.
  const b = await machine(h, 'mac-b')
  t.after(() => b.backend.close())
  const dirB = await makeRepo('git@github.com:example/backfill.git')
  const recordB = await b.backend.registerProject({ path: dirB, title: 'Backfill app' })
  await b.backend.flush()
  const readB = await b.backend.readNotes({ projects: [recordB], full: true })
  assert.deepEqual(new Set(readB.notes.map((note) => note.id)), new Set([oldOne.note.id, oldTwo.note.id]))
  const summaryB = await b.backend.readSummary(recordB, { full: true })
  assert.match(summaryB.content, /pre-cloud summary/)
})

test('pull paginates notes at 50 per page, merges the summary and advances lastPulledAt', async (t) => {
  const h = harness()
  t.after(() => h.close())
  const dirA = await makeRepo('git@github.com:example/paged.git')
  const dirB = await makeRepo('git@github.com:example/paged.git')
  const a = await machine(h, 'mac-a')
  t.after(() => a.backend.close())
  const recordA = await a.backend.registerProject({ path: dirA, title: 'Paged app' })
  await a.backend.flush()
  const cloudId = await cloudIdOf(a.backend, recordA.key)
  assert.equal(typeof cloudId, 'string')

  const seededIds = await seedNotes(h, cloudId, 120)
  const summaryResponse = await h.raw('PUT', `/v1/projects/${encodeURIComponent(cloudId)}/summary`, {
    content: '# Paged app\n\ncloud summary',
    clientOpId: 'seed-paged-summary',
  })
  assert.equal(summaryResponse.status, 200)
  assert.equal(summaryResponse.body.summary.version, 1)

  const seen = []
  const recordingFetch = async (url, init) => {
    seen.push({ url: String(url), method: init?.method ?? 'GET' })
    return h.fetchImpl(url, init)
  }
  const b = await machine(h, 'mac-b', { fetchImpl: recordingFetch })
  t.after(() => b.backend.close())
  const recordB = await b.backend.registerProject({ path: dirB, title: 'Paged app' })
  await b.backend.flush()

  const pulled = await b.backend.readNotes({ projects: [recordB], full: true })
  assert.equal(pulled.total, 120, 'every page is indexed locally')
  const allNotes = await b.backend.store.readAllNotes(recordB)
  assert.deepEqual(new Set(allNotes.map((note) => note.id)), new Set(seededIds), 'every page is merged into the note log')
  assert.equal(allNotes.find((note) => note.id === 'note-seed-119')?.body, '## seed\n\nbody 119', 'note bodies survive pagination')

  const pages = seen
    .filter((request) => request.method === 'GET' && request.url.includes(`/v1/projects/${cloudId}`))
    .map((request) => new URL(request.url))
  assert.equal(pages.length, 3, `three pages of 50 notes (saw ${pages.length})`)
  assert.deepEqual(pages.map((url) => url.searchParams.get('notesLimit')), ['50', '50', '50'])
  assert.deepEqual(pages.map((url) => url.searchParams.get('notesSinceSeq')), ['0', '50', '100'])

  const entry = b.backend.state.projects[recordB.key]
  assert.ok(entry.lastPulledAt > 0, 'lastPulledAt advances after a complete pull')
  assert.equal(entry.notesSeq, 120)

  const persisted = JSON.parse(await readFile(join(b.rootDir, '.cloud', 'sync-state.json'), 'utf8'))
  assert.equal(persisted.projects[recordB.key].notesSeq, 120)
  assert.ok(persisted.projects[recordB.key].lastPulledAt > 0, 'the cursor is persisted for the next pull')

  const sync = b.backend.syncInfo()
  assert.equal(sync.online, true)
  assert.equal(sync.stale, false)
  assert.equal(sync.pendingWrites, 0)

  const localSummary = await b.backend.readSummary(recordB, { full: true })
  assert.equal(localSummary.content, '# Paged app\n\ncloud summary\n', 'the pulled summary is merged locally')
})

test('a pull budget timeout degrades to the local cache without corrupting imported notes', async (t) => {
  const h = harness()
  t.after(() => h.close())
  const dirA = await makeRepo('git@github.com:example/pull-timeout.git')
  const dirB = await makeRepo('git@github.com:example/pull-timeout.git')
  const a = await machine(h, 'mac-a')
  t.after(() => a.backend.close())
  const recordA = await a.backend.registerProject({ path: dirA, title: 'Timeout app' })
  await a.backend.flush()
  const cloudId = await cloudIdOf(a.backend, recordA.key)
  const seededIds = await seedNotes(h, cloudId, 6)
  const summaryResponse = await h.raw('PUT', `/v1/projects/${encodeURIComponent(cloudId)}/summary`, {
    content: '# Timeout app\n\nbase summary',
    clientOpId: 'seed-timeout-summary',
  })
  assert.equal(summaryResponse.status, 200)

  const stall = { on: false }
  const fetchImpl = async (url, init) => {
    if (stall.on && (init?.method ?? 'GET') === 'GET' && String(url).includes(`/v1/projects/${cloudId}`)) {
      await waitForAbort(init?.signal, 5_000)
    }
    return h.fetchImpl(url, init)
  }
  const b = await machine(h, 'mac-b', { cloud: { pullBudgetMs: 400, offlineBackoffMs: 50 }, fetchImpl })
  t.after(() => b.backend.close())
  const recordB = await b.backend.registerProject({ path: dirB, title: 'Timeout app' })
  await b.backend.flush()

  const healthy = await b.backend.readNotes({ projects: [recordB], full: true })
  assert.equal(healthy.total, 6, 'the first pull imports every note')
  const summaryBefore = await b.backend.readSummary(recordB, { full: true })
  assert.equal(summaryBefore.content, '# Timeout app\n\nbase summary\n')

  stall.on = true
  const started = Date.now()
  const degraded = await b.backend.readNotes({ projects: [recordB], full: true })
  const elapsed = Date.now() - started
  assert.ok(elapsed < 5_000, `the pull stops after its own budget (${elapsed} ms)`)
  assert.equal(degraded.total, 6)
  assert.deepEqual(new Set(degraded.notes.map((note) => note.id)), new Set(seededIds), 'the local cache survives a stalled pull')
  const status = b.backend.syncInfo()
  assert.equal(status.online, false, 'a real pull timeout is reported as degraded')
  assert.equal(status.stale, true)
  assert.equal(status.error.kind, 'timeout')
  assert.match(status.error.message, /budget|timed out/)
  assert.equal(status.pendingWrites, 0)

  const persisted = JSON.parse(await readFile(join(b.rootDir, '.cloud', 'sync-state.json'), 'utf8'))
  assert.equal(persisted.projects[recordB.key].notesSeq, 6, 'the last complete cursor is kept')
  assert.ok(persisted.projects[recordB.key].lastPulledAt > 0)

  await new Promise((resolve) => setTimeout(resolve, 80))
  stall.on = false
  const recovered = await b.backend.readNotes({ projects: [recordB], full: true })
  assert.equal(recovered.total, 6, 'resuming the pull does not duplicate or drop notes')
  assert.deepEqual(new Set(recovered.notes.map((note) => note.id)), new Set(seededIds))
  assert.equal(b.backend.syncInfo().online, true)
})

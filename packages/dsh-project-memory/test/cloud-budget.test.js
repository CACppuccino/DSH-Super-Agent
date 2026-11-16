import test from 'node:test'
import assert from 'node:assert/strict'
import { CloudflareBackend } from '../lib/backends/cloudflare.js'
import { tempDir, sleepOrAbort } from './helpers.js'

const TOKEN = 'budget-test-token-value'

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function projectBody(id = 'p-budget', title = 'Budget app') {
  return {
    project: {
      id,
      identity: 'git:github.com/example/budget',
      identitySource: 'git',
      title,
      noteCount: 0,
      lastSeq: 0,
      summaryVersion: 0,
      summaryUpdatedAt: null,
      summaryChars: 0,
      updatedAt: Date.now(),
      lastNoteAt: null,
      pathHints: [],
    },
    created: true,
  }
}

/** Minimal Worker stub; only the endpoints the backend calls in these tests. */
function stub(state) {
  return async (request, init) => {
    if (state.offline) {
      throw Object.assign(new Error('fetch failed: connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    }
    if (request.method === 'POST' && request.url.endsWith('/v1/projects')) {
      return json(200, projectBody())
    }
    if (request.method === 'POST' && request.url.endsWith('/notes')) {
      if (state.noteDelayMs > 0) await sleepOrAbort(state.noteDelayMs, init?.signal)
      const body = JSON.parse(request.body ?? '{}')
      const notes = body.notes ?? [body.note]
      return json(200, {
        inserted: notes.map((note) => note.id),
        existing: [],
        project: { id: 'p-budget', noteCount: notes.length, lastSeq: notes.length, summaryVersion: 0, updatedAt: Date.now(), title: 'Budget app' },
        paging: { nextSinceSeq: notes.length },
      })
    }
    if (request.method === 'GET' && request.url.includes('/v1/projects/')) {
      return json(200, { ...projectBody(), summary: null, notes: [], paging: { nextSinceSeq: 0, hasMore: false } })
    }
    return json(404, { error: { code: 'not_found', message: 'not found' } })
  }
}

async function backendWith({ cloud = {}, state } = {}) {
  const rootDir = await tempDir('pm-cloud-budget-')
  const requests = []
  const handler = stub(state)
  const fetchImpl = async (url, init = {}) => {
    const request = { url: String(url), method: init.method ?? 'GET', body: init.body }
    requests.push(request)
    return handler(request, init)
  }
  const backend = new CloudflareBackend({
    rootDir,
    cloud: {
      url: 'https://stub.test',
      machineId: 'mac-budget',
      token: TOKEN,
      timeoutMs: 5_000,
      maxAttempts: 1,
      pullIntervalMs: 600_000,
      offlineBackoffMs: 1_000,
      autoSync: false,
      ...cloud,
    },
    fetchImpl,
    autoSync: false,
    logger: { info() {}, warn() {}, error() {} },
  })
  await backend.init()
  return { backend, rootDir, requests }
}

async function registerAndFlush(backend) {
  const project = await backend.registerProject({ path: `${backend.rootDir}/project-a`, title: 'Budget app' })
  const flushed = await backend.flush({ budgetMs: 3_000 })
  assert.equal(flushed.pending, 0, JSON.stringify(flushed))
  assert.equal(backend.syncInfo().online, true)
  return project
}

test('the default write budget absorbs a Worker slower than the old 1800 ms budget', async () => {
  const state = { noteDelayMs: 1_900 }
  const { backend, requests } = await backendWith({ state })
  const project = await registerAndFlush(backend)

  const started = Date.now()
  const note = await backend.appendNote({
    project,
    title: 'slow but healthy',
    body: '## body\n\ndelivered inside the default budget',
    tags: ['工程'],
    authorRole: 'worker',
    authorId: 'w',
  })
  const elapsed = Date.now() - started
  assert.match(note.note.id, /^note-/)
  assert.ok(elapsed >= 1_800, `the stub took ${elapsed} ms, slower than the old 1800 ms budget`)

  const info = backend.syncInfo()
  assert.equal(info.pendingWrites, 0, 'the write is delivered before the default 6 s budget expires')
  assert.equal(info.online, true)
  assert.equal(info.stale, false)
  assert.equal(info.error, undefined)
  assert.equal(JSON.stringify(info).includes(TOKEN), false)
  assert.ok(requests.some((request) => request.method === 'POST' && request.url.endsWith('/notes')))
  await backend.close()
})

test('a flush that only exhausts its budget reports queued writes, not offline', async () => {
  const state = { noteDelayMs: 0 }
  const { backend } = await backendWith({ cloud: { writeBudgetMs: 250, syncBudgetMs: 250 }, state })
  const project = await registerAndFlush(backend)

  state.noteDelayMs = 500
  const note = await backend.appendNote({
    project,
    title: 'queued while slow',
    body: '## body\n\nstill safe in the outbox',
    tags: ['经验'],
    authorRole: 'worker',
    authorId: 'w',
  })
  assert.match(note.note.id, /^note-/)

  const queued = backend.syncInfo()
  assert.equal(queued.online, true, 'a budget timeout with queued writes is not an offline signal')
  assert.equal(queued.stale, false)
  assert.equal(queued.pendingWrites, 1, 'the write stays queued')
  assert.equal(queued.failedWrites, 0)
  assert.equal(queued.error.kind, 'timeout')

  // The local cache is intact while the write waits.
  const local = await backend.readNotes({ projects: [project], full: true })
  assert.equal(local.notes.length, 1)
  assert.equal(local.notes[0].title, 'queued while slow')
  assert.equal(backend.syncInfo().online, true, 'a read through a slow budget stays online')

  // The next sync drains the outbox and clears the transient timeout.
  state.noteDelayMs = 0
  const drained = await backend.flush({ budgetMs: 3_000 })
  assert.equal(drained.sent, 1, JSON.stringify(drained))
  assert.equal(drained.pending, 0, JSON.stringify(drained))
  const recovered = backend.syncInfo()
  assert.equal(recovered.online, true)
  assert.equal(recovered.pendingWrites, 0)
  assert.equal(recovered.error, undefined)
  await backend.close()
})

test('a real network failure still marks the backend offline and keeps the write queued', async () => {
  const state = { noteDelayMs: 0, offline: true }
  const { backend } = await backendWith({ state })
  const project = await backend.registerProject({ path: `${backend.rootDir}/project-a`, title: 'Offline app' })
  const note = await backend.appendNote({
    project,
    title: 'network down',
    body: '## body\n\ncannot reach the Worker',
    tags: ['教训'],
    authorRole: 'worker',
    authorId: 'w',
  })
  assert.match(note.note.id, /^note-/)

  const info = backend.syncInfo()
  assert.equal(info.online, false, 'real network failures still go offline')
  assert.equal(info.stale, true)
  assert.equal(info.error.kind, 'network')
  assert.ok(info.pendingWrites >= 1, 'nothing is dropped')
  assert.equal(JSON.stringify(info).includes(TOKEN), false)

  const local = await backend.readNotes({ projects: [project], full: true })
  assert.equal(local.notes.length, 1, 'the local cache is intact')
  await backend.close()
})

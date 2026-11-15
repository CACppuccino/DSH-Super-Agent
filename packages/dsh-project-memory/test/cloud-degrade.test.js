import test from 'node:test'
import assert from 'node:assert/strict'
import { CloudflareBackend } from '../lib/backends/cloudflare.js'
import { tempDir } from './helpers.js'

async function backendWith({ cloud, fetchImpl } = {}) {
  const rootDir = await tempDir('pm-cloud-degrade-')
  const backend = new CloudflareBackend({
    rootDir,
    cloud: cloud ?? { url: 'https://memory.invalid', machineId: 'mac-x', token: 'degrade-token-value', timeoutMs: 200, maxAttempts: 1, autoSync: false },
    fetchImpl,
    autoSync: false,
    logger: { info() {}, warn() {}, error() {} },
  })
  await backend.init()
  return { backend, rootDir }
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('a misconfigured cloud backend degrades to local-only writes with a clear config error', async () => {
  const { backend } = await backendWith({
    cloud: { machineId: 'mac-x', token: 'unused-token-value', autoSync: false },
  })
  assert.equal(backend.syncInfo().configured, false)
  assert.equal(backend.syncInfo().error.kind, 'config')

  const project = await backend.registerProject({ path: `${backend.rootDir}/project-a`, title: 'A' })
  const result = await backend.appendNote({
    project,
    title: 'local only',
    body: '## body\n\nstill saved',
    tags: ['工程'],
    authorRole: 'worker',
    authorId: 'w',
  })
  assert.match(result.note.id, /^note-/)
  const read = await backend.readNotes({ projects: [project], full: true })
  assert.equal(read.notes.length, 1)
  assert.equal(read.notes[0].body, '## body\n\nstill saved')
  assert.equal(backend.syncInfo().pendingWrites, 0)
  await backend.close()
})

test('an auth failure keeps writes queued, reports the error, and does not corrupt the cache', async () => {
  let calls = 0
  const { backend } = await backendWith({
    fetchImpl: async () => {
      calls += 1
      return json(401, { error: { code: 'unauthorized', message: 'bad token' } })
    },
  })
  const project = await backend.registerProject({ path: `${backend.rootDir}/project-a`, title: 'A' })
  const result = await backend.appendNote({
    project,
    title: 'kept',
    body: 'body',
    tags: ['工程'],
    authorRole: 'worker',
    authorId: 'w',
  })
  assert.match(result.note.id, /^note-/)
  const info = backend.syncInfo()
  assert.equal(info.online, false)
  assert.equal(info.stale, true)
  assert.equal(info.error.kind, 'auth')
  assert.ok(info.pendingWrites >= 1, 'the write stays queued after auth failure')
  assert.equal(JSON.stringify(info).includes('degrade-token-value'), false)

  const read = await backend.readNotes({ projects: [project], full: true })
  assert.equal(read.notes.length, 1, 'local cache is intact')
  assert.ok(calls >= 1)
  await backend.close()
})

test('a permanent 4xx moves the write to the dead-letter file instead of dropping it', async () => {
  const { backend } = await backendWith({
    fetchImpl: async (url) => {
      if (String(url).endsWith('/v1/projects')) {
        return json(200, { project: { id: 'p-dead', identity: 'git:github.com/x/y', summaryVersion: 0, noteCount: 0, lastSeq: 0, updatedAt: Date.now(), title: 'X' }, created: true })
      }
      return json(400, { error: { code: 'note_body_invalid', message: 'rejected by server' } })
    },
  })
  // A project whose note body triggers a permanent 4xx.
  const project = await backend.registerProject({ path: `${backend.rootDir}/project-a`, title: 'A' })
  await backend.appendNote({
    project,
    title: 'bad',
    body: 'rejected body',
    tags: ['工程'],
    authorRole: 'worker',
    authorId: 'w',
  })
  const info = backend.syncInfo()
  assert.equal(info.pendingWrites, 0)
  assert.equal(info.failedWrites, 1)
  assert.equal(info.lastFailedWrite.type, 'note.append')
  assert.match(info.lastFailedWrite.error.message, /rejected by server/)

  const local = await backend.readNotes({ projects: [project], full: true })
  assert.equal(local.notes.length, 1, 'the local note is still readable')
  await backend.close()
})

test('force flush retries during an offline backoff window', async () => {
  let up = false
  let calls = 0
  const { backend } = await backendWith({
    fetchImpl: async (url, init) => {
      calls += 1
      if (!up) throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' })
      if (String(url).endsWith('/v1/projects')) {
        return json(200, { project: { id: 'p-up', identity: 'git:github.com/x/y', summaryVersion: 0, noteCount: 0, lastSeq: 0, updatedAt: Date.now(), title: 'Y' }, created: true })
      }
      return json(200, { inserted: [], existing: [], project: { id: 'p-up', noteCount: 0, lastSeq: 0, summaryVersion: 0, updatedAt: Date.now(), title: 'Y' }, paging: { nextSinceSeq: 0 } })
    },
  })
  const project = await backend.registerProject({ path: `${backend.rootDir}/project-a`, title: 'A' })
  await backend.appendNote({ project, title: 'queued', body: 'body', tags: ['工程'], authorRole: 'worker', authorId: 'w' })
  assert.ok(backend.syncInfo().pendingWrites >= 1)
  const callsWhileOffline = calls

  const skipped = await backend.flush({ budgetMs: 500 })
  assert.equal(skipped.offline, true)
  assert.equal(calls, callsWhileOffline, 'normal flush respects the offline window')

  up = true
  const forced = await backend.flush({ budgetMs: 1_000, force: true })
  assert.equal(forced.pending, 0)
  assert.equal(backend.syncInfo().online, true)
  await backend.close()
})

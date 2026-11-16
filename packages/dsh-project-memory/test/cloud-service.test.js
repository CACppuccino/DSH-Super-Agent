import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import worker from '../cloudflare/worker/src/index.ts'
import { createTestD1 } from '../cloudflare/worker/test/d1-shim.ts'
import { CloudflareBackend } from '../lib/backends/cloudflare.js'
import { apply } from '../index.js'
import { FakeAgent, callTool, catalogFor, makeService, sleepOrAbort, tempDir, writeCatalog } from './helpers.js'

const TOKEN = 'service-test-token-value'
const URL_BASE = 'https://memory.test'

async function makeRepo(remote = 'git@github.com:example/service.git') {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pm-cloud-service-')))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir })
  return dir
}

async function cloudSetup(overrides = {}) {
  const d1 = createTestD1()
  const env = { DB: d1.db, MEMORY_TOKEN: TOKEN }
  const rawFetch = (url, init) => worker.fetch(new Request(url, init), env)
  const state = { network: true, slowNotesMs: 0 }
  const fetchImpl = async (url, init) => {
    if (!state.network) throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' })
    if (state.slowNotesMs > 0 && String(url).includes('/notes')) {
      await sleepOrAbort(state.slowNotesMs, init?.signal)
    }
    return rawFetch(url, init)
  }
  const rootDir = await realpath(await mkdtemp(join(tmpdir(), 'pm-cloud-svc-root-')))
  const backend = new CloudflareBackend({
    rootDir,
    cloud: {
      url: URL_BASE,
      machineId: 'mac-service',
      token: TOKEN,
      timeoutMs: 500,
      maxAttempts: 1,
      pullIntervalMs: 0,
      offlineBackoffMs: 60_000,
      syncBudgetMs: 800,
      writeBudgetMs: 800,
      autoSync: false,
      ...overrides,
    },
    fetchImpl,
    autoSync: false,
    logger: { info() {}, warn() {}, error() {} },
  })
  await backend.init()
  return { d1, backend, state, close: () => d1.close() }
}

test('service results expose sync metadata and keep working while offline', async (t) => {
  const cloud = await cloudSetup()
  t.after(() => cloud.close())
  t.after(() => cloud.backend.close())
  const repo = await makeRepo()
  const catalog = catalogFor({ workerPath: repo })
  const service = makeService({ store: cloud.backend, catalog })
  const agent = new FakeAgent('worker-1', { cwd: repo, catalog })
  service.registerAgent(agent)
  agent.loadSkill()

  const first = await callTool(agent, 'project_memory_note_append', {
    title: 'shared note',
    body: '## body\n\nvisible from both machines',
    tags: ['工程'],
  })
  assert.equal(first.saved, true)
  assert.ok(first.sync, 'cloud mode results carry a sync block')
  assert.equal(first.sync.backend, 'cloudflare')
  assert.equal(first.sync.configured, true)
  assert.equal(first.sync.pendingWrites, 0)

  // The same note is readable through another machine's service layer.
  const registry = await cloud.backend.readRegistry()
  const record = Object.values(registry.projects)[0]

  cloud.state.network = false
  const offline = await callTool(agent, 'project_memory_note_append', {
    title: 'offline note',
    body: '## body\n\nqueued while offline',
    tags: ['经验'],
  })
  assert.equal(offline.saved, true, 'the local write is not blocked by the network')
  assert.equal(offline.sync.online, false)
  assert.equal(offline.sync.stale, true)
  assert.ok(offline.sync.pendingWrites >= 1)
  assert.equal(offline.sync.error.kind, 'network')
  assert.equal(JSON.stringify(offline.sync).includes(TOKEN), false)

  const cached = await callTool(agent, 'project_memory_notes_read', { limit: 10 })
  assert.equal(cached.notes.length >= 2, true, 'reads are served from the local cache')
  assert.equal(cached.sync.stale, true)
  assert.equal(cached.sync.online, false)
  assert.ok(cached.notes.some((note) => note.title === 'offline note'))

  cloud.state.network = true
  await cloud.backend.flush({ budgetMs: 2_000, force: true })
  const recovered = await callTool(agent, 'project_memory_notes_read', { limit: 10 })
  assert.equal(recovered.sync.online, true)
  assert.equal(recovered.sync.stale, false)
  assert.equal(recovered.sync.pendingWrites, 0)

  const fresh = await cloud.backend.readRegistry()
  const cloudId = Object.values(fresh.projects)[0].cloudId
  assert.equal(typeof cloudId, 'string')
  const remote = await cloud.backend.client.request('GET', `/v1/projects/${cloudId}?notesLimit=10`)
  assert.deepEqual(
    new Set(remote.notes.map((note) => note.title)),
    new Set(['shared note', 'offline note']),
  )
  assert.equal(record.key, Object.values(fresh.projects)[0].key)
})

test('a slow-but-healthy Worker never makes tool results report offline', async (t) => {
  const cloud = await cloudSetup({ writeBudgetMs: 400, syncBudgetMs: 400 })
  t.after(() => cloud.close())
  t.after(() => cloud.backend.close())
  const repo = await makeRepo('git@github.com:example/slow-worker.git')
  const catalog = catalogFor({ workerPath: repo })
  const service = makeService({ store: cloud.backend, catalog })
  const agent = new FakeAgent('worker-1', { cwd: repo, catalog })
  service.registerAgent(agent)
  agent.loadSkill()

  const first = await callTool(agent, 'project_memory_note_append', {
    title: 'first note',
    body: '## body\n\nfast enough',
    tags: ['工程'],
  })
  assert.equal(first.saved, true)
  assert.equal(first.sync.online, true)
  assert.equal(first.sync.pendingWrites, 0)

  // The Worker now answers slower than the inline write budget.
  cloud.state.slowNotesMs = 800
  const slow = await callTool(agent, 'project_memory_note_append', {
    title: 'slow note',
    body: '## body\n\nqueued, not lost',
    tags: ['经验'],
  })
  assert.equal(slow.saved, true)
  assert.equal(slow.sync.online, true, 'a budget timeout with a queued write is not offline')
  assert.equal(slow.sync.stale, false)
  assert.equal(slow.sync.pendingWrites, 1, 'the write stays queued')
  assert.equal(slow.sync.failedWrites, 0)
  assert.equal(slow.sync.error.kind, 'timeout')
  assert.equal(JSON.stringify(slow.sync).includes(TOKEN), false)

  // The next write retries the queue; nothing was dropped or duplicated.
  cloud.state.slowNotesMs = 0
  const next = await callTool(agent, 'project_memory_note_append', {
    title: 'after note',
    body: '## body\n\ndrained',
    tags: ['工程'],
  })
  assert.equal(next.sync.online, true)
  assert.equal(next.sync.pendingWrites, 0, 'the outbox drains on the next write')
  assert.equal(next.sync.error, undefined)

  const read = await callTool(agent, 'project_memory_notes_read', { limit: 10 })
  assert.deepEqual(
    new Set(read.notes.map((note) => note.title)),
    new Set(['first note', 'slow note', 'after note']),
  )
})

test('apply selects the cloudflare backend from environment config without touching the network', async () => {
  const stateDir = await tempDir('pm-plugin-cloud-')
  const memoryDir = join(stateDir, 'memory')
  const catalog = catalogFor({ workerPath: '/tmp/project-a' })
  await writeCatalog(join(stateDir, 'state.json'), catalog)
  const agent = new FakeAgent('worker-1', { cwd: '/tmp/project-a' })
  const handlers = new Map()
  const disposers = []
  const logs = []
  const ctx = {
    agents: { list: () => [agent] },
    skills: {
      register() { return () => {} },
      async get() { return undefined },
    },
    tools: {},
    logger: {
      info(...args) { logs.push(['info', ...args]) },
      warn(...args) { logs.push(['warn', ...args]) },
      error(...args) { logs.push(['error', ...args]) },
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event).add(handler)
      return () => handlers.get(event)?.delete(handler)
    },
  }
  const previous = {
    DSH_PROJECT_MEMORY_DIR: process.env.DSH_PROJECT_MEMORY_DIR,
    DSH_SUPERAGENT_STATE_DIR: process.env.DSH_SUPERAGENT_STATE_DIR,
    DSH_PROJECT_MEMORY_BACKEND: process.env.DSH_PROJECT_MEMORY_BACKEND,
    DSH_PROJECT_MEMORY_CLOUD_URL: process.env.DSH_PROJECT_MEMORY_CLOUD_URL,
    DSH_PROJECT_MEMORY_TOKEN: process.env.DSH_PROJECT_MEMORY_TOKEN,
    DSH_PROJECT_MEMORY_AUTO_SYNC: process.env.DSH_PROJECT_MEMORY_AUTO_SYNC,
  }
  process.env.DSH_PROJECT_MEMORY_DIR = memoryDir
  process.env.DSH_SUPERAGENT_STATE_DIR = stateDir
  process.env.DSH_PROJECT_MEMORY_BACKEND = 'cloudflare'
  process.env.DSH_PROJECT_MEMORY_CLOUD_URL = 'http://127.0.0.1:9'
  process.env.DSH_PROJECT_MEMORY_TOKEN = 'apply-test-token-value'
  process.env.DSH_PROJECT_MEMORY_AUTO_SYNC = '0'
  try {
    await apply(ctx)
    const ready = logs.find(([level, message]) => level === 'info' && String(message).includes('dsh-project-memory ready'))
    assert.ok(ready)
    assert.match(ready.slice(1).join(' '), /cloudflare/)
    assert.ok((await stat(join(memoryDir, '.cloud', 'machine-id'))).isFile())
    assert.deepEqual([...agent.tools.keys()].sort(), ['project_memory_note_append', 'project_memory_notes_read'])
    for (const dispose of disposers) dispose()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_MEMORY_INDEX_MAX_CHARS, DEFAULT_MEMORY_INDEX_REFRESH_MS, resolveMemoryIndexConfig } from '../lib/config.js'
import { MEMORY_INDEX_HEADER } from '../lib/guidance.js'
import { buildMemoryIndex, renderMemoryIndex, summaryExcerpt } from '../lib/memory-index.js'
import { ProjectMemoryService } from '../lib/service.js'
import { ProjectMemoryStore } from '../lib/store.js'
import { FakeAgent, catalogFor, tempDir } from './helpers.js'

const T0 = Date.UTC(2025, 0, 1, 0, 0, 0)
const MINUTE = 60_000

const SECTION_ROLE = 'dsh-project-memory:role'
const SECTION_INDEX = 'dsh-project-memory:index'

const SUPER_RULE = 'Opening check: at the start of a new session or task, before substantive work, call project_memory_projects once and project_memory_summary_read for the bound/root project; if no relevant project exists, state that and proceed. After finishing significant work, write or update that project\'s summary.'
const WORKER_RULE = 'Opening check: at the start of a new session or task, before substantive work, call project_memory_notes_read for your bound project;'

async function makeClock(now = T0) {
  const state = { now }
  return { state, clock: () => state.now }
}

async function makeStoreWithClock(clock) {
  const rootDir = await tempDir('pm-memory-index-')
  const store = new ProjectMemoryStore({ rootDir, clock })
  await store.init()
  return { store, rootDir }
}

function makeService(store, clock, { memoryIndex, logger } = {}) {
  return new ProjectMemoryService({
    store,
    catalog: { readSync: () => catalogFor({}) },
    skill: { name: 'project-memory', description: 'test skill', content: '# body' },
    logger: logger ?? { info() {}, warn() {} },
    clock,
    memoryIndex,
  })
}

function superAgent() {
  return new FakeAgent('super-1', { catalog: catalogFor({}) })
}

function indexSection(agent) {
  return agent.sections.find((section) => section.name === SECTION_INDEX)
}

test('the prompt index lists every project as one capped line, newest first', async () => {
  const { state, clock } = await makeClock()
  const { store } = await makeStoreWithClock(clock)

  const alpha = await store.registerProject({ path: '/tmp/demo-alpha', title: 'Alpha app' })
  await store.writeSummary({ project: alpha, content: '# Alpha app\n\n## State\n\nAlpha summary text with some detail.' })
  await store.appendNote({
    project: alpha,
    title: 'alpha note',
    body: 'body',
    tags: ['工程'],
    authorRole: 'worker',
    authorId: 'w',
  })

  state.now = T0 + MINUTE
  const beta = await store.registerProject({ path: '/tmp/demo-beta', title: 'Beta app' })
  await store.writeSummary({ project: beta, content: '# Beta\n\nBeta summary.' })

  state.now = T0 + 2 * MINUTE
  const gamma = await store.registerProject({ path: '/tmp/demo-gamma', title: 'Gamma (empty)' })

  const service = makeService(store, clock)
  const agent = superAgent()
  service.registerAgent(agent)
  const section = indexSection(agent)
  assert.ok(section, 'the Super Agent gets an index section')
  assert.equal(section.order, 9999)
  assert.equal(typeof section.text, 'function')
  assert.equal(section.interpolate, false)

  await service.refreshMemoryIndex()
  const text = section.text()
  assert.equal(text, service.memoryIndexText())
  assert.ok(text.startsWith(MEMORY_INDEX_HEADER), text)
  assert.ok(text.length <= DEFAULT_MEMORY_INDEX_MAX_CHARS, `${text.length} chars`)
  for (const record of [alpha, beta, gamma]) {
    assert.ok(text.includes(record.title), `missing title for ${record.key}`)
    assert.ok(text.includes(record.key), `missing key ${record.key}`)
  }
  assert.match(text, /Alpha summary text with some detail\./)
  assert.match(text, /Beta summary\./)
  assert.match(text, /\(no summary yet\)/)
  assert.match(text, /updated 2025-01-01T00:00:00\.000Z/, 'the stale summary timestamp is shown')
  assert.match(text, /notes 1/, 'the cheap note count is included')
  const order = [gamma.key, beta.key, alpha.key].map((key) => text.indexOf(key))
  assert.deepEqual(order, [...order].sort((left, right) => left - right), 'projects are sorted by updatedAt desc')
})

test('the index is truncated at memoryIndexMaxChars with an explicit omission notice', async () => {
  const { state, clock } = await makeClock()
  const { store } = await makeStoreWithClock(clock)
  for (let index = 0; index < 12; index += 1) {
    state.now = T0 + index * MINUTE
    const record = await store.registerProject({ path: `/tmp/trunc-${index}`, title: `Truncation project ${index}` })
    await store.writeSummary({
      project: record,
      content: `# Project ${index}\n\n## State\n\n${'x'.repeat(180)}`,
    })
  }
  const service = makeService(store, clock, { memoryIndex: { maxChars: 400 } })
  const agent = superAgent()
  service.registerAgent(agent)
  await service.refreshMemoryIndex()
  const text = indexSection(agent).text()
  assert.ok(text.length <= 400, `${text.length} chars exceed the cap`)
  assert.ok(text.startsWith(MEMORY_INDEX_HEADER))
  assert.match(text, /more projects omitted; memory index capped/)
  assert.match(text, /Truncation project 11/, 'the newest project survives truncation')
  assert.equal(text.includes('Truncation project 0'), false)
})

test('a disabled memoryIndex injects nothing, while the role guidance stays', async () => {
  const { clock } = await makeClock()
  const { store } = await makeStoreWithClock(clock)
  await store.registerProject({ path: '/tmp/disabled', title: 'Disabled project' })
  const service = makeService(store, clock, { memoryIndex: { enabled: false } })
  const agent = superAgent()
  service.registerAgent(agent)
  assert.equal(indexSection(agent), undefined, 'no index section is registered when disabled')
  assert.ok(agent.sections.some((section) => section.name === SECTION_ROLE), 'the role guidance still loads')
  assert.equal(await service.refreshMemoryIndex(), '')
  assert.equal(service.memoryIndexText(), '')
})

test('no projects yields an empty index and injects nothing', async () => {
  const { clock } = await makeClock()
  const { store } = await makeStoreWithClock(clock)
  const service = makeService(store, clock)
  const agent = superAgent()
  service.registerAgent(agent)
  const section = indexSection(agent)
  assert.ok(section, 'the section stays registered so projects added later appear')
  assert.equal(await service.refreshMemoryIndex(), '')
  assert.equal(section.text(), '', 'empty text is dropped by prompt rendering')
  assert.equal(service.memoryIndexText(), '')
  assert.equal(await buildMemoryIndex({ store }), '')
})

test('malformed projects and unreadable summaries are skipped without failing the build', async () => {
  const { clock } = await makeClock()
  const { store, rootDir } = await makeStoreWithClock(clock)
  const good = await store.registerProject({ path: '/tmp/good-project', title: 'Good project' })
  await store.writeSummary({ project: good, content: 'Good summary.' })
  const broken = await store.registerProject({ path: '/tmp/broken-project', title: 'Broken summary' })
  await rm(join(rootDir, 'projects', broken.key, 'summary.md'), { force: true })
  await mkdir(join(rootDir, 'projects', broken.key, 'summary.md'), { recursive: true })

  const registryPath = join(rootDir, 'registry.json')
  const raw = JSON.parse(await readFile(registryPath, 'utf8'))
  raw.projects['bad key!'] = { key: 'bad key!', path: '/tmp/bad' }
  raw.projects.nullish = null
  await writeFile(registryPath, JSON.stringify(raw))
  const warnings = []
  const text = await buildMemoryIndex({ store, logger: { warn: (...args) => warnings.push(args.join(' ')) } })
  assert.match(text, /Good project/)
  assert.match(text, /Broken summary/)
  assert.match(text, /\(no summary yet\)/)
  assert.equal(text.includes('bad key!'), false, 'a malformed registry entry is skipped')
  assert.ok(warnings.some((line) => line.includes('summary')), 'the unreadable summary is logged, not thrown')
})

test('a corrupt registry produces no index instead of failing prompt assembly', async () => {
  const { clock } = await makeClock()
  const { store, rootDir } = await makeStoreWithClock(clock)
  await writeFile(join(rootDir, 'registry.json'), '{not json')
  const warnings = []
  const text = await buildMemoryIndex({ store, logger: { warn: (...args) => warnings.push(args.join(' ')) } })
  assert.equal(text, '')
  assert.equal(warnings.some((line) => line.includes('could not read the registry')), false, 'an unreadable registry is quarantined by the store')
})

test('the injected guidance carries the exact opening-check rule for both roles', async () => {
  const { clock } = await makeClock()
  const { store } = await makeStoreWithClock(clock)
  const service = makeService(store, clock)
  const superSession = superAgent()
  const workerSession = new FakeAgent('worker-1', { cwd: '/tmp/project-a', catalog: catalogFor({}) })
  service.registerAgent(superSession)
  service.registerAgent(workerSession)

  const superRole = superSession.sections.find((section) => section.name === SECTION_ROLE)
  assert.ok(superRole.text.includes(SUPER_RULE), 'the Super Agent rule is verbatim in the injected block')
  const workerRole = workerSession.sections.find((section) => section.name === SECTION_ROLE)
  assert.ok(workerRole.text.includes(WORKER_RULE), 'the worker rule uses only tools a worker has')

  const names = superSession.sections.map((section) => section.name)
  assert.equal(names.indexOf(SECTION_INDEX) > names.indexOf(SECTION_ROLE), true, 'the index follows the role section')
  assert.equal(workerSession.sections.some((section) => section.name === SECTION_INDEX), false, 'workers never get all-project summary excerpts')
})

test('the cached index refreshes after memoryIndexRefreshMs', async () => {
  const { state, clock } = await makeClock()
  const { store } = await makeStoreWithClock(clock)
  await store.registerProject({ path: '/tmp/old-project', title: 'Old project' })
  const service = makeService(store, clock, { memoryIndex: { refreshMs: 5 * MINUTE } })
  const agent = superAgent()
  service.registerAgent(agent)
  await service.refreshMemoryIndex()
  const section = indexSection(agent)
  assert.equal(section.text().includes('New project'), false)

  state.now = T0 + 10 * MINUTE
  const newcomer = await store.registerProject({ path: '/tmp/new-project', title: 'New project' })
  await store.writeSummary({ project: newcomer, content: 'Fresh summary.' })
  const cached = section.text()
  assert.equal(cached.includes('New project'), false, 'prompt assembly serves the cache immediately')
  await service.refreshMemoryIndexIfStale()
  assert.match(section.text(), /New project/)
})

test('memoryIndex config resolves defaults, overrides, clamps, and the disable flag', () => {
  assert.deepEqual(resolveMemoryIndexConfig({}, { env: {} }), {
    enabled: true,
    maxChars: DEFAULT_MEMORY_INDEX_MAX_CHARS,
    refreshMs: DEFAULT_MEMORY_INDEX_REFRESH_MS,
  })
  assert.equal(DEFAULT_MEMORY_INDEX_MAX_CHARS, 1_500)
  assert.equal(DEFAULT_MEMORY_INDEX_REFRESH_MS, 300_000)

  assert.deepEqual(
    resolveMemoryIndexConfig({ memoryIndex: false, memoryIndexMaxChars: 900, memoryIndexRefreshMs: 60_000 }, { env: {} }),
    { enabled: false, maxChars: 900, refreshMs: 60_000 },
  )
  assert.deepEqual(
    resolveMemoryIndexConfig({}, {
      env: {
        DSH_PROJECT_MEMORY_INDEX: '0',
        DSH_PROJECT_MEMORY_INDEX_MAX_CHARS: '800',
        DSH_PROJECT_MEMORY_INDEX_REFRESH_MS: '2000',
      },
    }),
    { enabled: false, maxChars: 800, refreshMs: 2_000 },
  )
  assert.equal(
    resolveMemoryIndexConfig({ memoryIndex: true }, { env: { DSH_PROJECT_MEMORY_INDEX: '0' } }).enabled,
    false,
    'the environment can always turn the injection off (like autoSync)',
  )
  assert.deepEqual(
    resolveMemoryIndexConfig({ memoryIndexMaxChars: 10, memoryIndexRefreshMs: 1 }, { env: {} }),
    { enabled: true, maxChars: 200, refreshMs: 1_000 },
  )
  assert.equal(resolveMemoryIndexConfig({ memoryIndexMaxChars: 'big' }, { env: {} }).maxChars, 1_500)
})

test('summary excerpts collapse whitespace and cap at ~120 chars', () => {
  assert.equal(summaryExcerpt('# Title\n\nbody   text'), 'Title body text')
  assert.equal(summaryExcerpt('a'.repeat(200)).length, 120)
  assert.equal(summaryExcerpt('a'.repeat(200)).endsWith('…'), true)
  assert.equal(renderMemoryIndex([]), '')
  assert.equal(renderMemoryIndex([{ key: 'k', title: 'T', updatedAt: T0, noteCount: 2, summary: 's' }]).split('\n').length, 2)
})

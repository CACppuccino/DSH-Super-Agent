import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, test } from 'node:test'
import { StateStore, defaultStateDir, emptyState, normalizeState, profileName } from '../lib/state.js'

const dirs = []
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop(), { recursive: true, force: true })
})

async function temporaryStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-super-agent-state-'))
  dirs.push(dir)
  const file = join(dir, 'state.json')
  const store = new StateStore(file)
  await store.load()
  return { dir, file, store }
}

const conversation = (id, overrides = {}) => ({
  id,
  kind: 'super',
  title: 'Super Agent',
  workspaceId: 'ws-1',
  workspacePath: '/tmp/work',
  workspaceTitle: 'work',
  parentId: null,
  createdAt: 1,
  updatedAt: 1,
  status: 'idle',
  lastMessage: '',
  lastOutput: '',
  progress: [],
  ...overrides,
})

test('a missing state file starts empty and persists conversation records', async () => {
  const { file, store } = await temporaryStore()
  assert.deepEqual(store.snapshot(), emptyState())
  await store.update((state) => {
    state.conversations['super-1'] = conversation('super-1')
    state.workspaces['ws-1'] = { id: 'ws-1', path: '/tmp/work', title: 'work', createdAt: 1 }
  })
  const raw = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(raw.conversations['super-1'].title, 'Super Agent')

  const reloaded = new StateStore(file)
  await reloaded.load()
  assert.equal(reloaded.conversation('super-1').workspacePath, '/tmp/work')
  assert.equal(reloaded.workspace('ws-1').title, 'work')
})

test('writes are serialized and a mutation sees the previous result', async () => {
  const { store } = await temporaryStore()
  await Promise.all([
    store.update((state) => { state.conversations.a = conversation('a', { updatedAt: 2 }) }),
    store.update((state) => { state.conversations.b = conversation('b', { updatedAt: 3 }) }),
    store.update((state) => { state.conversations.c = conversation('c', { updatedAt: 4 }) }),
  ])
  assert.deepEqual(store.conversations().map((item) => item.id), ['c', 'b', 'a'])
})

test('invalid records are dropped and progress is bounded on load', async () => {
  const { file } = await temporaryStore()
  const progress = Array.from({ length: 100 }, (_, index) => ({ at: index, status: 'progress', text: `step ${index}` }))
  await writeFile(file, JSON.stringify({
    version: 1,
    conversations: {
      good: conversation('good', { progress }),
      bad: { id: 42 },
      worker: conversation('worker', { kind: 'worker', parentId: 'good', title: '  Worker one  ' }),
    },
    workspaces: {
      good: { id: 'ws-1', path: '/tmp/work', title: 'work', createdAt: 1 },
      bad: { id: 'ws-2' },
    },
  }))
  const store = new StateStore(file)
  await store.load()
  assert.equal(store.conversation('good').progress.length, 80)
  assert.equal(store.conversation('good').progress.at(-1).text, 'step 99')
  assert.equal(store.conversation('bad'), undefined)
  assert.equal(store.conversation('worker').title, 'Worker one')
  assert.equal(store.workspace('bad'), undefined)
})

test('a malformed file is preserved beside the state file and starts empty', async () => {
  const { file, store } = await temporaryStore()
  await writeFile(file, '{not json')
  const reloaded = new StateStore(file)
  await reloaded.load()
  assert.deepEqual(reloaded.snapshot(), emptyState())
})

test('normalizeState keeps the newest conversation first', () => {
  const state = normalizeState({
    version: 1,
    conversations: {
      old: conversation('old', { updatedAt: 10 }),
      fresh: conversation('fresh', { updatedAt: 20 }),
    },
  })
  const store = new StateStore('/tmp/does-not-exist-state.json')
  store.state = state
  assert.deepEqual(store.conversations().map((item) => item.id), ['fresh', 'old'])
  assert.equal(store.latestSuper().id, 'fresh')
})


test('state is scoped to the profile so two DSH processes do not share one catalog', () => {
  assert.equal(profileName({ DSH_PROFILE: 'web' }, []), 'web')
  assert.equal(profileName({}, ['node', '--profile', 'headless']), 'headless')
  assert.equal(profileName({}, ['node', '/Users/me/.dsh/profiles/desktop']), 'desktop')
  assert.equal(profileName({}, []), '')
  assert.equal(defaultStateDir({ DSH_HOME: '/home/.dsh' }, '/home', ['node']), '/home/.dsh/state/dsh-super-agent')
  assert.equal(defaultStateDir({ DSH_HOME: '/home/.dsh', DSH_PROFILE: 'desktop' }, '/home', []), '/home/.dsh/state/dsh-super-agent')
  assert.equal(defaultStateDir({ DSH_HOME: '/home/.dsh', DSH_PROFILE: 'web' }, '/home', []), '/home/.dsh/state/dsh-super-agent/profiles/web')
  assert.equal(defaultStateDir({ DSH_HOME: '/home/.dsh' }, '/home', ['node', '--profile', 'web']), '/home/.dsh/state/dsh-super-agent/profiles/web')
})

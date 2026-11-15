import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, test } from 'node:test'
import { PendingStore, normalizeOptions, normalizePending } from '../lib/pending.js'

const dirs = []
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop(), { recursive: true, force: true })
})

async function setup() {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-super-agent-pending-'))
  dirs.push(stateDir)
  const file = join(stateDir, 'pending.json')
  const store = new PendingStore(file, { now: () => 1000 })
  await store.load()
  return { stateDir, file, store }
}

test('pending decisions persist atomically and survive a reload', async () => {
  const { file, store } = await setup()
  const item = await store.create({
    conversationId: 'super-1',
    question: '  Ship it?  ',
    context: ' All tests pass. ',
    options: ['Yes', 'No', 'Yes', '  ', 'Later'],
  })
  assert.match(item.id, /^pending-/)
  assert.equal(item.question, 'Ship it?')
  assert.equal(item.context, 'All tests pass.')
  assert.deepEqual(item.options, ['Yes', 'No', 'Later'])
  assert.equal(item.resolved_at, null)
  assert.equal(item.answer, '')

  const text = await readFile(file, 'utf8')
  assert.equal(text.includes('Ship it?'), true)
  const leftovers = (await readdir(dirname(file))).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], 'no temporary files are left behind')

  const reopened = new PendingStore(file)
  await reopened.load()
  assert.deepEqual(reopened.list(), [item])
})

test('list returns unanswered decisions newest first and filters by conversation', async () => {
  let now = 100
  const { store } = await setup()
  store.now = () => now
  const first = await store.create({ conversationId: 'a', question: 'First?' })
  now = 200
  const second = await store.create({ conversationId: 'b', question: 'Second?' })
  now = 300
  await store.create({ conversationId: 'a', question: 'Third?' })

  assert.deepEqual(store.list().map((item) => item.question), ['Third?', 'Second?', 'First?'])
  assert.deepEqual(store.list({ conversationId: 'a' }).map((item) => item.question), ['Third?', 'First?'])
  assert.deepEqual(store.list({ conversationId: 'missing' }), [])

  await store.resolve({ id: first.id, answer: 'done', conversationId: 'a' })
  assert.deepEqual(store.list({ conversationId: 'a' }).map((item) => item.question), ['Third?'])
  assert.deepEqual(store.list({ conversationId: 'a', includeResolved: true }).map((item) => item.question), ['Third?', 'First?'])
  const resolved = store.list({ includeResolved: true }).find((item) => item.id === first.id)
  assert.equal(resolved.answer, 'done')
  assert.equal(typeof resolved.resolved_at, 'number')
  assert.equal(second.resolved_at, null)
})

test('resolve stores the first answer, is idempotent, and enforces conversation scope', async () => {
  const { store } = await setup()
  const item = await store.create({ conversationId: 'a', question: 'Choose?' })
  await assert.rejects(() => store.resolve({ id: item.id, answer: '   ' }), /answer is required/)
  await assert.rejects(() => store.resolve({ id: 'missing', answer: 'x' }), /Unknown pending decision/)
  await assert.rejects(() => store.resolve({ id: item.id, answer: 'x', conversationId: 'b' }), /Unknown pending decision/)

  const first = await store.resolve({ id: item.id, answer: 'one', conversationId: 'a' })
  assert.equal(first.changed, true)
  assert.equal(first.item.answer, 'one')
  const again = await store.resolve({ id: item.id, answer: 'two', conversationId: 'a' })
  assert.equal(again.changed, false)
  assert.equal(again.item.answer, 'one')
})

test('option and item normalization rejects untrusted records', () => {
  assert.deepEqual(normalizeOptions([' a ', 'a', '', 3, 'b']), ['a', 'b'])
  assert.deepEqual(normalizeOptions(Array.from({ length: 12 }, (_, index) => `o${index}`)), ['o0', 'o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7'])
  const pending = normalizePending({
    items: {
      good: { id: 'good', question: 'Q', options: ['A'], created_at: 5, resolved_at: 7, answer: 'A' },
      missingQuestion: { id: 'missing', question: '   ' },
      missingId: { question: 'Q' },
    },
  })
  assert.deepEqual(Object.keys(pending.items), ['good'])
  assert.equal(pending.items.good.resolved_at, 7)
})

test('a malformed pending file is preserved and the queue starts empty', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-super-agent-pending-bad-'))
  dirs.push(stateDir)
  const file = join(stateDir, 'pending.json')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(file, '{ not json', 'utf8')
  const store = new PendingStore(file)
  await store.load()
  assert.deepEqual(store.list(), [])
  const copies = (await readdir(stateDir)).filter((name) => name.startsWith('pending.json.corrupt-'))
  assert.equal(copies.length, 1)
  assert.equal(await readFile(join(stateDir, copies[0]), 'utf8'), '{ not json')
})

test('concurrent creates do not lose records', async () => {
  const { store } = await setup()
  await Promise.all(Array.from({ length: 6 }, (_, index) => store.create({ conversationId: 's', question: `Q${index}` })))
  const items = store.list()
  assert.equal(items.length, 6)
  assert.deepEqual(new Set(items.map((item) => item.question)), new Set(Array.from({ length: 6 }, (_, index) => `Q${index}`)))
})

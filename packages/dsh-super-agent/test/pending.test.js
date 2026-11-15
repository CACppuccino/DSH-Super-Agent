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

test('update revises an open decision, bumps revision, and preserves history', async () => {
  let now = 1000
  const { store } = await setup()
  store.now = () => now
  const item = await store.create({
    conversationId: 'a',
    question: 'Which plan?',
    context: 'Initial context.',
    options: ['A', 'B'],
  })
  now = 2000
  const first = await store.revise({ id: item.id, question: 'Which plan v2?', context: 'New inputs.', options: ['A', 'C'] })
  assert.equal(first.changed, true)
  assert.equal(first.item.status, 'open')
  assert.equal(first.item.revision, 2)
  assert.equal(first.item.question, 'Which plan v2?')
  assert.equal(first.item.context, 'New inputs.')
  assert.deepEqual(first.item.options, ['A', 'C'])
  assert.equal(first.item.updated_at, 2000)
  assert.deepEqual(first.item.history, [{
    revision: 1,
    question: 'Which plan?',
    context: 'Initial context.',
    options: ['A', 'B'],
    updated_at: 1000,
  }])

  now = 3000
  const second = await store.revise({ id: item.id, context: 'Only context changed.' })
  assert.equal(second.item.revision, 3)
  assert.equal(second.item.question, 'Which plan v2?')
  assert.equal(second.item.context, 'Only context changed.')
  assert.deepEqual(second.item.options, ['A', 'C'])
  assert.equal(second.item.history.length, 2)
  assert.equal(second.item.history[1].question, 'Which plan v2?')

  const listed = store.list().find((entry) => entry.id === item.id)
  assert.equal(listed.status, 'open')
  assert.equal(listed.revision, 3)
  assert.equal(listed.history.length, 2)

  const reopened = new PendingStore(store.file)
  await reopened.load()
  assert.equal(reopened.get(item.id).revision, 3)
  assert.equal(reopened.get(item.id).history.length, 2)

  await assert.rejects(() => store.revise({ id: item.id }), /question, context, or options is required/)
  await assert.rejects(() => store.revise({ id: item.id, question: '   ' }), /question is required/)
  await assert.rejects(() => store.revise({ id: 'missing', question: 'x' }), /Unknown pending decision/)
  await assert.rejects(() => store.revise({ id: item.id, question: 'x', conversationId: 'b' }), /Unknown pending decision/)
})

test('retract withdraws an open decision without recording an answer', async () => {
  const { store } = await setup()
  const item = await store.create({ conversationId: 'a', question: 'Still needed?', options: ['Yes', 'No'] })
  const retracted = await store.retract({ id: item.id, reason: 'Decided in conversation', conversationId: 'a' })
  assert.equal(retracted.changed, true)
  assert.equal(retracted.item.status, 'retracted')
  assert.equal(retracted.item.retract_reason, 'Decided in conversation')
  assert.equal(typeof retracted.item.retracted_at, 'number')
  assert.equal(retracted.item.resolved_at, null)
  assert.equal(retracted.item.answer, '')
  assert.deepEqual(retracted.item.options, ['Yes', 'No'])

  assert.deepEqual(store.list(), [], 'retracted cards are not actionable')
  assert.deepEqual(store.list({ includeResolved: true }), [], 'retracted is not answered')
  assert.deepEqual(store.list({ includeRetracted: true }).map((entry) => entry.id), [item.id])
  assert.deepEqual(store.list({ includeResolved: true, includeRetracted: true }).map((entry) => entry.id), [item.id])

  const again = await store.retract({ id: item.id, reason: 'Different reason' })
  assert.equal(again.changed, false)
  assert.equal(again.item.retract_reason, 'Decided in conversation')
  await assert.rejects(() => store.resolve({ id: item.id, answer: 'Yes' }), /retracted/)
  await assert.rejects(() => store.revise({ id: item.id, question: 'New?' }), /retracted/)
  await assert.rejects(() => store.retract({ id: item.id, reason: '   ' }), /reason is required/)
  await assert.rejects(() => store.retract({ id: 'missing', reason: 'x' }), /Unknown pending decision/)
  await assert.rejects(() => store.retract({ id: item.id, reason: 'x', conversationId: 'other' }), /Unknown pending decision/)
})

test('answered decisions can be resolved idempotently but not updated or retracted', async () => {
  const { store } = await setup()
  const item = await store.create({ conversationId: 'a', question: 'Ship?' })
  await store.resolve({ id: item.id, answer: 'Yes' })
  const answered = store.get(item.id)
  assert.equal(answered.status, 'resolved')
  assert.equal(answered.revision, 1)
  assert.equal(typeof answered.updated_at, 'number')
  await assert.rejects(() => store.revise({ id: item.id, question: 'Ship v2?' }), /resolved and cannot be updated/)
  await assert.rejects(() => store.retract({ id: item.id, reason: 'Moot' }), /answered and cannot be retracted/)
  const listed = store.list({ includeResolved: true }).find((entry) => entry.id === item.id)
  assert.equal(listed.status, 'resolved')
  assert.equal(listed.revision, 1)
  assert.equal(listed.answer, 'Yes')
})

test('legacy pending records without status/revision can still be listed and retracted', async () => {
  const { file, store } = await setup()
  const { writeFile } = await import('node:fs/promises')
  await writeFile(file, JSON.stringify({
    version: 1,
    items: {
      'pending-legacy': {
        id: 'pending-legacy',
        conversation_id: 'super-1',
        question: 'Old open question?',
        context: 'Created before status/revision existed.',
        options: ['A', 'B'],
        created_at: 10,
        resolved_at: null,
        answer: '',
      },
    },
  }), 'utf8')
  const reopened = new PendingStore(file)
  await reopened.load()
  const legacy = reopened.list()[0]
  assert.equal(legacy.status, 'open')
  assert.equal(legacy.revision, 1)
  assert.deepEqual(legacy.history, [])
  const retracted = await reopened.retract({ id: 'pending-legacy', reason: 'Superseded by a later decision' })
  assert.equal(retracted.item.status, 'retracted')
  assert.equal(retracted.item.resolved_at, null)
  assert.equal(reopened.list().length, 0)
  assert.equal(reopened.list({ includeRetracted: true }).length, 1)
  assert.equal(store.list().length, 0)
})

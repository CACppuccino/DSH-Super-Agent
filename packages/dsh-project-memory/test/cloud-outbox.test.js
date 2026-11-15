import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Outbox } from '../lib/backends/outbox.js'
import { tempDir } from './helpers.js'

async function outboxAt(dir) {
  const outbox = new Outbox({ file: join(dir, 'outbox.jsonl'), deadFile: join(dir, 'outbox-dead.jsonl') })
  await outbox.load()
  return outbox
}

test('enqueue survives a reload and the log is private', async () => {
  const dir = await tempDir('pm-outbox-')
  const outbox = await outboxAt(dir)
  const op = await outbox.enqueue('note.append', { note: { id: 'note-1' } }, { localKey: 'proj-1' })
  assert.match(op.opId, /^op-/)
  assert.equal(outbox.size(), 1)
  const mode = (await stat(outbox.file)).mode & 0o777
  assert.equal(mode, 0o600)

  const reloaded = await outboxAt(dir)
  assert.equal(reloaded.size(), 1)
  assert.equal(reloaded.pending[0].opId, op.opId)
  assert.equal(reloaded.pending[0].localKey, 'proj-1')
  assert.deepEqual(reloaded.pending[0].payload.note, { id: 'note-1' })
})

test('ack removes an operation and compaction drops ack records', async () => {
  const dir = await tempDir('pm-outbox-')
  const outbox = await outboxAt(dir)
  const first = await outbox.enqueue('note.append', { n: 1 })
  await outbox.enqueue('note.append', { n: 2 })
  await outbox.ack(first.opId)
  assert.equal(outbox.size(), 1)
  await outbox.compact()
  const text = await readFile(outbox.file, 'utf8')
  assert.equal(text.includes('"ack"'), false)
  const reloaded = await outboxAt(dir)
  assert.equal(reloaded.size(), 1)
  assert.equal(reloaded.pending[0].payload.n, 2)
})

test('corrupt lines are skipped and never destroy the rest of the queue', async () => {
  const dir = await tempDir('pm-outbox-')
  const outbox = await outboxAt(dir)
  await outbox.enqueue('note.append', { n: 1 })
  await writeFile(outbox.file, `${await readFile(outbox.file, 'utf8')}{not json}\n`)
  const reloaded = await outboxAt(dir)
  assert.equal(reloaded.size(), 1)
  assert.equal(reloaded.corruptLines, 1)
})

test('dead letters keep the payload verbatim and drop the retry entry', async () => {
  const dir = await tempDir('pm-outbox-')
  const outbox = await outboxAt(dir)
  const op = await outbox.enqueue('summary.upsert', { content: 'important summary' }, { localKey: 'proj-1' })
  await outbox.enqueue('note.append', { n: 2 })
  const error = Object.assign(new Error('rejected'), {
    toJSON: () => ({ kind: 'client', message: 'rejected', status: 400 }),
  })
  await outbox.deadLetter(op, error)
  assert.equal(outbox.size(), 1)
  assert.equal(outbox.deadCount, 1)
  const dead = await readFile(outbox.deadFile, 'utf8')
  assert.match(dead, /important summary/)
  assert.match(dead, /"kind":"client"/)
  await outbox.compact()
  assert.equal((await outboxAt(dir)).deadCount, 1)
})

test('many writes are not lost under concurrency', async () => {
  const dir = await tempDir('pm-outbox-')
  const outbox = await outboxAt(dir)
  await Promise.all(Array.from({ length: 25 }, (_, index) => outbox.enqueue('note.append', { index })))
  const reloaded = await outboxAt(dir)
  assert.equal(reloaded.size(), 25)
  assert.deepEqual(new Set(reloaded.pending.map((op) => op.payload.index)).size, 25)
})

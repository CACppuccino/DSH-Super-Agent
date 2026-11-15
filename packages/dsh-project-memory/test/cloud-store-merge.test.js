import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeStore, tempDir } from './helpers.js'

async function addProject(store, name = 'alpha') {
  return store.registerProject({ path: join(store.rootDir, 'src', name), title: name })
}

test('importNotes unions remote notes by id and isolates a partial trailing line', async () => {
  const { store } = await makeStore()
  const project = await addProject(store)
  await store.appendNote({ project, title: 'local', body: 'local body', tags: ['工程'], authorRole: 'worker' })

  // Simulate a crash mid-append: the last line has no newline.
  await appendFile(store.notesPath(project.key), '{"id":"partial","at":1,"title":"tor')

  const result = await store.importNotes(project, [
    { id: 'remote-1', at: 1_700_000_000_000, authorRole: 'worker', authorId: 'w-b', machineId: 'mac-b', title: 'remote', tags: ['教训'], body: 'remote body' },
    { id: 'partial', at: 1_700_000_000_001, authorRole: 'worker', authorId: 'w-b', machineId: 'mac-b', title: 'remote partial', tags: ['研究'], body: 'remote partial body' },
    { id: 'remote-1', at: 1_700_000_000_002, authorRole: 'worker', title: 'duplicate in batch', tags: ['研究'], body: 'ignored' },
  ])
  assert.equal(result.imported, 2)
  assert.equal(result.skipped, 1)

  const read = await store.readNotes({ projects: [project], limit: 10, full: true })
  assert.equal(read.total, 3, 'local + two imported notes; the corrupt partial line is ignored')
  const remote = read.notes.find((note) => note.id === 'remote-1')
  assert.equal(remote.body, 'remote body')
  assert.equal(remote.machineId, 'mac-b')

  // Importing the same notes again is a no-op.
  const again = await store.importNotes(project, [
    { id: 'remote-1', at: 1_700_000_000_000, title: 'remote', tags: ['教训'], body: 'remote body' },
  ])
  assert.deepEqual(again, { imported: 0, skipped: 1 })
})

test('importSummary installs the server version and keeps cloud metadata fields', async () => {
  const { store } = await makeStore()
  const project = await addProject(store)
  await store.writeSummary({ project, content: '# local' })
  await store.updateProjectMeta(project.key, {
    identity: 'git:github.com/example/alpha',
    identitySource: 'git',
    cloudId: 'alpha-abcdef1234',
    remote: false,
  })
  // A partial update must not reset the fields it does not mention.
  await store.updateProjectMeta(project.key, { cloudNoteCount: 7 })

  const imported = await store.importSummary(project, {
    content: '# shared',
    version: 4,
    updatedAt: 1_700_000_000_000,
    updatedBy: 'mac-b',
  })
  assert.equal(imported.imported, true)
  assert.equal(imported.version, 4)

  const summary = await store.readSummary(project, { full: true })
  assert.equal(summary.content, '# shared\n')
  const registry = await store.readRegistry()
  const record = registry.projects[project.key]
  assert.equal(record.cloudSummaryVersion, 4)
  assert.equal(record.identity, 'git:github.com/example/alpha')
  assert.equal(record.cloudId, 'alpha-abcdef1234')
  assert.equal(record.cloudNoteCount, 7)
  assert.equal(record.summaryChars, '# shared\n'.length)
  assert.equal(record.summaryUpdatedAt, 1_700_000_000_000)

  const projectJson = JSON.parse(await readFile(store.projectFilePath(project.key), 'utf8'))
  assert.equal(projectJson.cloudId, 'alpha-abcdef1234')
})

test('updateProjectMeta rejects an unknown project without touching the registry', async () => {
  const { store } = await makeStore()
  const missing = await store.updateProjectMeta('does-not-exist', { cloudId: 'x' })
  assert.equal(missing, undefined)
})

test('cloud-only cache projects use a local cache path and stay resolvable', async () => {
  const root = await tempDir('pm-cloud-cache-')
  const { store } = await makeStore()
  const cachePath = join(root, '.cloud', 'remote', 'shared-123')
  const record = await store.registerProject({ path: cachePath, title: 'Shared' })
  await store.updateProjectMeta(record.key, {
    identity: 'git:github.com/example/shared',
    cloudId: 'shared-123',
    remote: true,
  })
  const registry = await store.readRegistry()
  assert.equal(registry.projects[record.key].remote, true)
  assert.equal(registry.projects[record.key].path, cachePath)
})

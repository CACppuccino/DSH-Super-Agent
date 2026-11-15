import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ProjectMemoryStore, LIMITS } from '../lib/store.js'
import { projectKeyFor } from '../lib/projects.js'
import { makeStore, tempDir } from './helpers.js'

async function addProject(store, name) {
  return store.registerProject({ path: join(store.rootDir, 'projects-src', name), title: name })
}

test('project keys are stable per path and separate per project', async () => {
  const { store, rootDir } = await makeStore()
  const a = await addProject(store, 'alpha')
  const b = await addProject(store, 'beta')
  assert.equal(a.key, projectKeyFor(a.path))
  assert.notEqual(a.key, b.key)
  assert.notEqual(a.key, b.key)
  assert.equal(a.path, join(rootDir, 'projects-src', 'alpha'))
  const again = await store.resolveProject({ project: a.path })
  assert.equal(again.key, a.key)
  const byTitle = await store.resolveProject({ project: 'alpha' })
  assert.equal(byTitle.key, a.key)
})

test('append + compact read + full read preserve note structure and filters', async () => {
  const { store } = await makeStore()
  const project = await addProject(store, 'alpha')
  const body = '## 现象\n\nSSE 丢了空行。\n\n<details><summary>细节</summary>\n\n日志...\n\n</details>'
  const appended = await store.appendNote({
    project,
    title: 'SSE 空行',
    body,
    tags: ['教训', '工程'],
    authorRole: 'worker',
    authorId: 'worker-1',
  })
  assert.match(appended.note.id, /^note-/)
  assert.equal(appended.noteCount, 1)

  const compact = await store.readNotes({ projects: [project], limit: 10 })
  assert.equal(compact.notes.length, 1)
  assert.equal(compact.notes[0].title, 'SSE 空行')
  assert.deepEqual(compact.notes[0].tags, ['教训', '工程'])
  assert.ok(compact.notes[0].preview.length <= LIMITS.indexPreviewChars)
  assert.equal(compact.notes[0].body, undefined)
  assert.equal(compact.notes[0].truncated, true)

  const full = await store.readNotes({ projects: [project], limit: 10, full: true })
  assert.equal(full.notes[0].body, body)
  assert.equal(full.notes[0].truncated, false)
  assert.match(full.notes[0].body, /<details>/)

  const filtered = await store.readNotes({ projects: [project], tags: ['研究'] })
  assert.equal(filtered.notes.length, 0)
  const since = await store.readNotes({ projects: [project], since: Date.now() + 60_000 })
  assert.equal(since.notes.length, 0)
})

test('note size limits reject before writing', async () => {
  const { store } = await makeStore()
  const project = await addProject(store, 'alpha')
  await assert.rejects(() => store.appendNote({
    project, title: 'x'.repeat(LIMITS.titleChars + 1), body: 'ok', tags: ['工程'], authorRole: 'worker',
  }), /title must be at most/)
  await assert.rejects(() => store.appendNote({
    project, title: 'ok', body: 'x'.repeat(LIMITS.bodyChars + 1), tags: ['工程'], authorRole: 'worker',
  }), /body must be at most/)
  const notesFile = store.notesPath(project.key)
  await assert.rejects(() => stat(notesFile), (error) => error.code === 'ENOENT')
})

test('summary replace/append is atomic and size-capped', async () => {
  const { store } = await makeStore()
  const project = await addProject(store, 'alpha')
  const first = await store.writeSummary({ project, content: '# Alpha\n\nfirst' })
  assert.equal(first.mode, 'replace')
  assert.equal(first.project.summaryChars, first.chars)
  assert.equal((await store.readSummary(project, {})).content, '# Alpha\n\nfirst\n')

  const appended = await store.writeSummary({ project, content: '## Update\n\nsecond', mode: 'append' })
  assert.equal(appended.mode, 'append')
  const summary = await store.readSummary(project, { full: true })
  assert.match(summary.content, /## Update/)
  assert.match(summary.content, /first/)

  await assert.rejects(
    () => store.writeSummary({ project, content: 'x'.repeat(LIMITS.summaryChars + 1) }),
    /summary must be at most/,
  )
  const unchanged = await store.readSummary(project, { full: true })
  assert.match(unchanged.content, /## Update/)

  const files = await readdir(store.projectDir(project.key))
  assert.equal(files.some((name) => name.endsWith('.tmp')), false, 'atomic writes leave no temp files')

  const boundary = await addProject(store, 'boundary')
  const exact = 'x'.repeat(LIMITS.summaryChars)
  const written = await store.writeSummary({ project: boundary, content: exact })
  assert.equal(written.chars, LIMITS.summaryChars + 1, 'the stored newline does not count against the body limit')
  assert.equal((await store.readSummary(boundary, { full: true })).content.length, LIMITS.summaryChars + 1)
})

test('concurrent appends from two store instances are serialized and indexed', async () => {
  const { store, rootDir } = await makeStore()
  const project = await addProject(store, 'alpha')
  const peer = new ProjectMemoryStore({ rootDir })
  await peer.init()
  const count = 30
  await Promise.all(Array.from({ length: count }, (_, index) => {
    const writer = index % 2 === 0 ? store : peer
    return writer.appendNote({
      project,
      title: `note ${index}`,
      body: `## body\n\nentry ${index}`,
      tags: ['简单执行'],
      authorRole: 'worker',
      authorId: `worker-${index}`,
    })
  }))

  const raw = await readFile(store.notesPath(project.key), 'utf8')
  const lines = raw.trim().split('\n')
  assert.equal(lines.length, count)
  const ids = lines.map((line) => JSON.parse(line).id)
  assert.equal(new Set(ids).size, count)
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line))

  const index = JSON.parse(await readFile(store.indexPath(project.key), 'utf8'))
  assert.equal(index.noteCount, count)
  assert.equal(index.notes.length, count)
  const read = await store.readNotes({ projects: [project], limit: 100 })
  assert.equal(read.total, count)
  assert.equal(read.notes.length, count)
})

test('a corrupt index is rebuilt from the append-only log', async () => {
  const { store } = await makeStore()
  const project = await addProject(store, 'alpha')
  await store.appendNote({ project, title: 'one', body: 'body', tags: ['经验'], authorRole: 'worker' })
  await writeFile(store.indexPath(project.key), '{not json')
  const read = await store.readNotes({ projects: [project], limit: 5 })
  assert.equal(read.notes.length, 1)
  assert.equal(read.notes[0].title, 'one')
  const rebuilt = JSON.parse(await readFile(store.indexPath(project.key), 'utf8'))
  assert.equal(rebuilt.noteCount, 1)
})

test('corrupt note lines are ignored and do not corrupt reads', async () => {
  const { store } = await makeStore()
  const project = await addProject(store, 'alpha')
  await store.appendNote({ project, title: 'valid', body: 'body', tags: ['经验'], authorRole: 'worker' })
  await writeFile(store.notesPath(project.key), `${await readFile(store.notesPath(project.key), 'utf8')}{bad json}\n`)
  const read = await store.readNotes({ projects: [project], limit: 5, full: true })
  assert.equal(read.notes.length, 1)
  assert.equal(read.notes[0].title, 'valid')
})

test('search checks tags, previews, and then bodies', async () => {
  const { store } = await makeStore()
  const a = await addProject(store, 'alpha')
  const b = await addProject(store, 'beta')
  await store.appendNote({ project: a, title: 'Alpha note', body: '## 结论\n\nonly-in-body-token', tags: ['研究'], authorRole: 'worker' })
  await store.appendNote({ project: b, title: 'Beta note', body: '## 结论\n\nvisible preview', tags: ['教训'], authorRole: 'worker' })

  const byTag = await store.searchNotes({ projects: [a, b], tags: ['教训'] })
  assert.equal(byTag.matches.length, 1)
  assert.equal(byTag.matches[0].projectKey, b.key)

  const byBody = await store.searchNotes({ projects: [a, b], query: 'only-in-body-token' })
  assert.equal(byBody.matches.length, 1)
  assert.equal(byBody.matches[0].projectKey, a.key)

  const byProject = await store.searchNotes({ projects: [a], query: 'note' })
  assert.equal(byProject.matches.length, 1)
  assert.equal(byProject.matches[0].projectKey, a.key)

  const none = await store.searchNotes({ projects: [a, b], query: 'missing-token' })
  assert.equal(none.matches.length, 0)
})

test('listProjects exposes the compact registry', async () => {
  const { store } = await makeStore()
  const a = await addProject(store, 'alpha')
  await store.appendNote({ project: a, title: 'one', body: 'body', tags: ['经验'], authorRole: 'worker' })
  await store.writeSummary({ project: a, content: '# Alpha' })
  const listed = await store.listProjects({ limit: 10 })
  assert.equal(listed.total, 1)
  assert.equal(listed.projects[0].key, a.key)
  assert.equal(listed.projects[0].noteCount, 1)
  assert.equal(listed.projects[0].summaryChars, 8)
})

test('the root can be isolated for tests and deployment', async () => {
  const root = await tempDir('pm-isolated-')
  const store = new ProjectMemoryStore({ rootDir: root })
  await store.init()
  assert.equal(store.registryPath(), join(root, 'registry.json'))
  assert.equal(store.lockPath('registry'), join(root, 'locks', 'registry.lock'))
})

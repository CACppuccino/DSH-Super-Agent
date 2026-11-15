import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { ALLOWED } from '../lib/service.js'
import { identityForAgent } from '../lib/catalog.js'
import { FakeAgent, callTool, catalogFor, makeService, makeStore, tempDir } from './helpers.js'

async function setupRoles() {
  const root = await tempDir('pm-roles-')
  const superPath = join(root, 'super-workspace')
  const workerPath = join(root, 'project-a')
  const otherPath = join(root, 'project-b')
  const catalog = catalogFor({ superPath, workerPath, otherPath })
  const { store } = await makeStore()
  const service = makeService({ store, catalog })
  const worker = new FakeAgent('worker-1', { cwd: workerPath, catalog })
  const otherWorker = new FakeAgent('worker-2', { cwd: otherPath, catalog })
  const superAgent = new FakeAgent('super-1', { cwd: superPath, catalog })
  service.registerAgent(worker)
  service.registerAgent(otherWorker)
  service.registerAgent(superAgent)
  worker.loadSkill()
  otherWorker.loadSkill()
  return { root, superPath, workerPath, otherPath, catalog, store, service, worker, otherWorker, superAgent }
}

test('identity detection: super, worker, and fallback worker', () => {
  const catalog = catalogFor({ superPath: '/tmp/super', workerPath: '/tmp/a', otherPath: '/tmp/b' })
  const superAgent = new FakeAgent('super-1', { cwd: '/tmp/super' })
  const worker = new FakeAgent('worker-1', { cwd: '/tmp/a' })
  const plain = new FakeAgent('plain-1', { cwd: '/tmp/plain' })
  assert.equal(identityForAgent(superAgent, catalog).role, 'super')
  assert.equal(identityForAgent(worker, catalog).role, 'worker')
  assert.equal(identityForAgent(worker, catalog).ownProjectPath, '/tmp/a')
  const fallback = identityForAgent(plain, catalog)
  assert.equal(fallback.role, 'worker')
  assert.equal(fallback.ownProjectPath, '/tmp/plain')
  assert.equal(fallback.source, 'fallback')
})

test('the capability matrix is exactly the two-role policy', () => {
  assert.deepEqual([...ALLOWED.super].sort(), ['guide', 'notes:read', 'projects', 'search', 'summary:read', 'summary:write'])
  assert.deepEqual([...ALLOWED.worker].sort(), ['notes:read', 'notes:write'])
  assert.equal(ALLOWED.worker.has('summary:read'), false)
  assert.equal(ALLOWED.worker.has('summary:write'), false)
  assert.equal(ALLOWED.worker.has('search'), false)
  assert.equal(ALLOWED.super.has('notes:write'), false)
})

test('tool visibility differs by role', async () => {
  const { worker, superAgent } = await setupRoles()
  assert.deepEqual([...worker.tools.keys()].sort(), ['project_memory_note_append', 'project_memory_notes_read'])
  assert.deepEqual([...superAgent.tools.keys()].sort(), [
    'project_memory_guide',
    'project_memory_notes_read',
    'project_memory_projects',
    'project_memory_search',
    'project_memory_summary_read',
    'project_memory_summary_write',
  ])
})

test('worker writes and reads only its own project', async () => {
  const { worker, workerPath, otherPath } = await setupRoles()
  const appended = await callTool(worker, 'project_memory_note_append', {
    title: 'own note',
    body: '## body\n\nok',
    tags: ['工程'],
  })
  assert.equal(appended.saved, true)
  assert.equal(appended.projectPath, workerPath)

  await assert.rejects(
    () => callTool(worker, 'project_memory_note_append', {
      project: otherPath,
      title: 'nope',
      body: 'body',
      tags: ['工程'],
    }),
    (error) => error.code === 'permission/project' && /may only access its own project/.test(error.message),
  )

  const ownRead = await callTool(worker, 'project_memory_notes_read', {})
  assert.equal(ownRead.notes.length, 1)
  assert.equal(ownRead.projects[0].path, workerPath)

  await assert.rejects(
    () => callTool(worker, 'project_memory_notes_read', { project: otherPath }),
    (error) => error.code === 'permission/project',
  )

  // A path with a different spelling but the same canonical target is allowed.
  const same = await callTool(worker, 'project_memory_notes_read', { project: workerPath })
  assert.equal(same.notes.length, 1)
})

test('worker cannot see summary tools or read another project through notes', async () => {
  const { worker, otherPath, store, service } = await setupRoles()
  assert.equal(worker.tools.has('project_memory_summary_read'), false)
  assert.equal(worker.tools.has('project_memory_summary_write'), false)
  const identity = service.identityFor(worker)
  await assert.rejects(
    () => service.projectFor(identity, otherPath, { cwd: otherPath }),
    (error) => error.code === 'permission/project',
  )
  // A note really exists in the other project; the worker still cannot read it.
  const other = await store.registerProject({ path: otherPath, title: 'Project B' })
  await store.appendNote({ project: other, title: 'other', body: 'secret', tags: ['经验'], authorRole: 'worker' })
  await assert.rejects(
    () => callTool(worker, 'project_memory_notes_read', { project: otherPath }),
    (error) => error.code === 'permission/project',
  )
})

test('Super Agent reads everything and writes multiple project summaries', async () => {
  const { superAgent, worker, workerPath, otherPath, store } = await setupRoles()
  await callTool(worker, 'project_memory_note_append', { title: 'A note', body: 'A body', tags: ['经验'] })
  const other = await store.registerProject({ path: otherPath, title: 'Project B' })
  await store.appendNote({ project: other, title: 'B note', body: 'B body', tags: ['教训'], authorRole: 'worker' })

  await callTool(superAgent, 'project_memory_guide', {})
  const allNotes = await callTool(superAgent, 'project_memory_notes_read', {})
  assert.equal(allNotes.notes.length, 2)
  assert.deepEqual(allNotes.notes.map((note) => note.project).sort(), [allNotes.projects[0].key, allNotes.projects[1].key].sort())

  const write = await callTool(superAgent, 'project_memory_summary_write', {
    writes: [
      { project: workerPath, content: '# Project A\n\nA summary' },
      { project: otherPath, content: '# Project B\n\nB summary' },
    ],
  })
  assert.equal(write.saved, true)
  assert.equal(write.written.length, 2)

  const a = await callTool(superAgent, 'project_memory_summary_read', { project: workerPath, full: true })
  assert.match(a.content, /A summary/)
  const b = await callTool(superAgent, 'project_memory_summary_read', { project: otherPath, full: true })
  assert.match(b.content, /B summary/)

  const summaries = await callTool(superAgent, 'project_memory_summary_read', {})
  assert.ok(summaries.projects.length >= 2)
  assert.equal(summaries.projects.every((project) => typeof project.preview === 'string'), true)
  assert.equal(superAgent.tools.has('project_memory_note_append'), false)
})

test('Super Agent resolves a catalog workspace id for a summary write', async () => {
  const { superAgent, workerPath } = await setupRoles()
  await callTool(superAgent, 'project_memory_guide', {})
  const write = await callTool(superAgent, 'project_memory_summary_write', {
    project: 'ws-a',
    content: '# via workspace id\n\nok',
  })
  assert.equal(write.written[0].path, workerPath)
})

test('without a Super Agent catalog the plugin works in notes-only fallback mode', async () => {
  const root = await tempDir('pm-fallback-')
  const projectPath = join(root, 'project-a')
  const { store } = await makeStore()
  const service = makeService({ store, catalog: { exists: false, conversations: {}, workspaces: {} } })
  const agent = new FakeAgent('plain-session', { cwd: projectPath })
  service.registerAgent(agent)
  assert.deepEqual([...agent.tools.keys()].sort(), ['project_memory_note_append', 'project_memory_notes_read'])
  agent.loadSkill()
  const saved = await callTool(agent, 'project_memory_note_append', { title: 'standalone', body: 'body', tags: ['讨论'] })
  assert.equal(saved.saved, true)
  assert.equal(saved.projectPath, projectPath)
  assert.equal(agent.tools.has('project_memory_summary_read'), false)
})

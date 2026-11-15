import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { loadSkillDefinition } from '../lib/skill.js'
import { LIMITS } from '../lib/store.js'
import { FakeAgent, callTool, catalogFor, makeService, makeStore, tempDir } from './helpers.js'

async function setupTools() {
  const root = await tempDir('pm-tools-')
  const workerPath = join(root, 'project-a')
  const otherPath = join(root, 'project-b')
  const catalog = catalogFor({ superPath: join(root, 'super'), workerPath, otherPath })
  const { store } = await makeStore()
  const service = makeService({ store, catalog })
  const worker = new FakeAgent('worker-1', { cwd: workerPath })
  const superAgent = new FakeAgent('super-1', { cwd: join(root, 'super') })
  service.registerAgent(worker)
  service.registerAgent(superAgent)
  worker.loadSkill()
  await callTool(superAgent, 'project_memory_guide', {})
  return { root, workerPath, otherPath, catalog, store, service, worker, superAgent }
}

test('notes are compact by default and full with an explicit opt-in', async () => {
  const { worker } = await setupTools()
  const longBody = `## 长正文\n\n${'x'.repeat(LIMITS.previewChars * 4)}\n\n<details><summary>细节</summary>hidden</details>`
  await callTool(worker, 'project_memory_note_append', { title: 'long', body: longBody, tags: ['研究'] })

  const compact = await callTool(worker, 'project_memory_notes_read', {})
  assert.equal(compact.notes.length, 1)
  assert.equal(compact.notes[0].body, undefined)
  assert.ok(compact.notes[0].preview.length <= LIMITS.previewChars * 2)
  assert.equal(compact.notes[0].truncated, true)

  const full = await callTool(worker, 'project_memory_notes_read', { full: true })
  assert.equal(full.notes[0].body, longBody)
  assert.match(full.notes[0].body, /<details>/)
})

test('tag and since filters work through the worker tool', async () => {
  const { worker } = await setupTools()
  await callTool(worker, 'project_memory_note_append', { title: 'one', body: 'one', tags: ['经验', '工程'] })
  await callTool(worker, 'project_memory_note_append', { title: 'two', body: 'two', tags: ['教训'] })
  const byTag = await callTool(worker, 'project_memory_notes_read', { tags: ['教训'] })
  assert.equal(byTag.notes.length, 1)
  assert.equal(byTag.notes[0].title, 'two')
  const future = await callTool(worker, 'project_memory_notes_read', { since: '2999-01-01T00:00:00Z' })
  assert.equal(future.notes.length, 0)
})

test('summary write supports multiple projects in one call and auto-registers them', async () => {
  const { superAgent, workerPath, otherPath, store } = await setupTools()
  const result = await callTool(superAgent, 'project_memory_summary_write', {
    writes: [
      { project: workerPath, content: '# A\n\nOne', mode: 'replace' },
      { project: otherPath, content: '# B\n\nTwo', mode: 'replace' },
    ],
  })
  assert.equal(result.written.length, 2)
  const projects = await store.listProjects({ limit: 10 })
  const paths = projects.projects.map((project) => project.path).sort()
  assert.deepEqual(paths, [workerPath, otherPath].sort())

  const readA = await callTool(superAgent, 'project_memory_summary_read', { project: workerPath, full: true })
  assert.match(readA.content, /# A/)
  await callTool(superAgent, 'project_memory_summary_write', { project: workerPath, content: 'appended', mode: 'append' })
  const appended = await callTool(superAgent, 'project_memory_summary_read', { project: workerPath, full: true })
  assert.match(appended.content, /One/)
  assert.match(appended.content, /appended/)
})

test('summary_write rejects mixed shapes and oversized summaries', async () => {
  const { superAgent, workerPath } = await setupTools()
  await assert.rejects(
    () => callTool(superAgent, 'project_memory_summary_write', {
      writes: [{ project: workerPath, content: 'a' }],
      project: workerPath,
      content: 'b',
    }),
    /use either writes\[\] or project\+content/,
  )
  await assert.rejects(
    () => callTool(superAgent, 'project_memory_summary_write', {
      project: workerPath,
      content: 'x'.repeat(LIMITS.summaryChars + 1),
    }),
    /summary must be at most/,
  )
})

test('Super Agent search spans projects and finds body-only text', async () => {
  const { superAgent, workerPath, otherPath, store } = await setupTools()
  const other = await store.registerProject({ path: otherPath, title: 'B' })
  await store.appendNote({ project: other, title: 'B note', body: 'only-in-body-b-token', tags: ['教训'], authorRole: 'worker' })
  await callTool(superAgent, 'project_memory_summary_write', { project: workerPath, content: '# A' })

  const byQuery = await callTool(superAgent, 'project_memory_search', { query: 'only-in-body-b-token' })
  assert.equal(byQuery.matches.length, 1)
  assert.equal(byQuery.matches[0].project, other.key)

  const byTag = await callTool(superAgent, 'project_memory_search', { tags: ['教训'] })
  assert.equal(byTag.matches.length, 1)
  assert.equal(byTag.matches[0].title, 'B note')

  const limited = await callTool(superAgent, 'project_memory_search', { query: 'note', limit: 1 })
  assert.equal(limited.returned <= 1, true)

  await assert.rejects(() => callTool(superAgent, 'project_memory_search', {}), /provide query, tags, or project/)
})

test('projects lists the registry and can add a project explicitly', async () => {
  const { superAgent } = await setupTools()
  const before = await callTool(superAgent, 'project_memory_projects', {})
  assert.equal(before.total, 0)
  const added = await callTool(superAgent, 'project_memory_projects', { add: '/tmp/new-project', title: 'New' })
  assert.equal(added.added.title, 'New')
  const after = await callTool(superAgent, 'project_memory_projects', {})
  assert.equal(after.total, 1)
  assert.equal(after.projects[0].path, '/tmp/new-project')
  assert.equal(after.projects[0].lastNoteAt, null)
  assert.equal(after.projects[0].summaryUpdatedAt, null)
})

test('worker result includes a note id, tags, and project key', async () => {
  const { worker, workerPath, superAgent } = await setupTools()
  const saved = await callTool(worker, 'project_memory_note_append', {
    title: 'structured',
    body: '## 小节\n\n结论',
    tags: ['经验'],
  })
  assert.match(saved.id, /^note-/)
  assert.deepEqual(saved.tags, ['经验'])
  assert.equal(saved.projectPath, workerPath)
  assert.equal(saved.noteCount, 1)
  const listed = await callTool(superAgent, 'project_memory_projects', {})
  const project = listed.projects.find((entry) => entry.path === workerPath)
  assert.equal(typeof project.lastNoteAt, 'string')
  assert.equal(project.noteCount, 1)
})

test('the guide re-reads the shipped skill so the Super Agent sees the latest conventions', async () => {
  const { store } = await makeStore()
  const catalog = catalogFor({ superPath: '/tmp/super' })
  const realSkill = loadSkillDefinition()
  const service = makeService({
    store,
    catalog,
    skill: realSkill,
    skills: {
      async get() {
        return { name: 'project-memory', description: 'stale', provider: 'stale', content: '# stale body' }
      },
    },
  })
  const superAgent = new FakeAgent('super-1', { cwd: '/tmp/super' })
  service.registerAgent(superAgent)
  const guide = await callTool(superAgent, 'project_memory_guide', {})
  assert.match(guide.content, /Super Agent 使用约定/)
  assert.match(guide.content, /summary 是给"下一次的自己"看的/)
})

test('the guide result points at the bundled skill and marks the gate open', async () => {
  const { superAgent } = await setupTools()
  const guide = await callTool(superAgent, 'project_memory_guide', {})
  assert.equal(guide.name, 'project-memory')
  assert.match(guide.content, /Project memory/)
  assert.equal(guide.loaded, true)
  assert.match(guide.next, /opens the skill gate/)
  const rendered = superAgent.tools.get('project_memory_guide').output.render({}, guide)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /<skill_content name="project-memory">/)
  assert.match(rendered[0].text, /Project memory/)
})

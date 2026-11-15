import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalProjectPath } from '../lib/projects.js'
import { findChildProjectRoots, findProjectRootUp, resolveWorkerScope } from '../lib/project-root.js'
import { FakeAgent, callTool, catalogFor, makeService, makeStore, tempDir } from './helpers.js'

async function makeGitProject(root, name) {
  const project = join(root, name)
  await mkdir(join(project, '.git'), { recursive: true })
  return project
}

test('project-root resolver walks from a subdirectory to the enclosing project root', async () => {
  const root = await tempDir('pm-root-')
  const project = await makeGitProject(root, 'QuantResearch')
  const src = join(project, 'src')
  await mkdir(src, { recursive: true })
  const canonicalProject = await canonicalProjectPath(project)
  const canonicalSrc = await canonicalProjectPath(src)
  assert.equal(await findProjectRootUp(canonicalSrc), canonicalProject)
  const scope = await resolveWorkerScope({ workspacePath: src })
  assert.equal(scope.kind, 'bound')
  assert.equal(scope.reason, 'workspace-inside-project')
  assert.equal(scope.root, canonicalProject)
})

test('project-root resolver treats a plain directory as its own project', async () => {
  const root = await tempDir('pm-plain-')
  const plain = join(root, 'plain')
  await mkdir(plain, { recursive: true })
  const scope = await resolveWorkerScope({ workspacePath: plain })
  assert.equal(scope.kind, 'bound')
  assert.equal(scope.reason, 'plain-workspace')
  assert.equal(scope.root, await canonicalProjectPath(plain))
})

test('project-root resolver reports a broad workspace as unbound with candidates', async () => {
  const root = await tempDir('pm-broad-')
  const workspace = join(root, 'Projects')
  const quant = await makeGitProject(workspace, 'QuantResearch')
  const other = await makeGitProject(workspace, 'Other')
  const scope = await resolveWorkerScope({ workspacePath: workspace })
  assert.equal(scope.kind, 'unbound')
  assert.equal(scope.candidates.length, 2)
  assert.ok(scope.candidates.includes(await canonicalProjectPath(quant)))
  assert.ok(scope.candidates.includes(await canonicalProjectPath(other)))
  const children = await findChildProjectRoots(await canonicalProjectPath(workspace))
  assert.deepEqual(children.sort(), [await canonicalProjectPath(other), await canonicalProjectPath(quant)].sort())
})

test('project-root resolver binds a broad workspace to one named project root', async () => {
  const root = await tempDir('pm-bind-')
  const workspace = join(root, 'Projects')
  const quant = await makeGitProject(workspace, 'QuantResearch')
  const other = await makeGitProject(workspace, 'Other')
  await mkdir(join(quant, 'src'), { recursive: true })
  const canonicalQuant = await canonicalProjectPath(quant)
  const chosen = await resolveWorkerScope({ workspacePath: workspace, requestedPath: join(quant, 'src') })
  assert.equal(chosen.kind, 'bound')
  assert.equal(chosen.reason, 'requested-root')
  assert.equal(chosen.root, canonicalQuant)
  const outside = await resolveWorkerScope({ workspacePath: workspace, requestedPath: join(root, 'Elsewhere') })
  assert.equal(outside.kind, 'outside')
  assert.notEqual(canonicalQuant, await canonicalProjectPath(other))
})

test('project-root resolver auto-binds the only child project', async () => {
  const root = await tempDir('pm-single-')
  const workspace = join(root, 'OnlyParent')
  const only = await makeGitProject(workspace, 'OnlyProject')
  const scope = await resolveWorkerScope({ workspacePath: workspace })
  assert.equal(scope.kind, 'bound')
  assert.equal(scope.reason, 'single-child')
  assert.equal(scope.root, await canonicalProjectPath(only))
})

test('a broad workspace worker must bind once, then is locked to that project', async () => {
  const root = await tempDir('pm-broad-worker-')
  const workspace = join(root, 'Projects')
  const quant = await makeGitProject(workspace, 'QuantResearch')
  const other = await makeGitProject(workspace, 'Other')
  const canonicalQuant = await canonicalProjectPath(quant)
  const canonicalOther = await canonicalProjectPath(other)
  const catalog = catalogFor({ workerPath: workspace, otherPath: other })
  const { store, rootDir } = await makeStore()
  const service = makeService({ store, catalog })
  const worker = new FakeAgent('worker-1', { cwd: workspace })
  service.registerAgent(worker)
  worker.loadSkill()

  await assert.rejects(
    () => callTool(worker, 'project_memory_note_append', { title: 'unbound', body: 'body', tags: ['工程'] }),
    (error) => {
      assert.equal(error.code, 'project/unbound')
      assert.match(error.message, /contains several projects/)
      assert.match(error.message, /multi-project writes are reserved for the Super Agent/)
      assert.match(error.message, /QuantResearch/)
      return true
    },
  )

  await assert.rejects(
    () => callTool(worker, 'project_memory_note_append', {
      project: join(root, 'OutsideProject'),
      title: 'outside',
      body: 'body',
      tags: ['工程'],
    }),
    (error) => error.code === 'permission/project' && /assigned workspace/.test(error.message),
  )

  const saved = await callTool(worker, 'project_memory_note_append', {
    project: join(quant, 'src'),
    title: 'bound note',
    body: '## body\n\nroot-bound',
    tags: ['工程'],
  })
  assert.equal(saved.saved, true)
  assert.equal(saved.projectPath, canonicalQuant)

  const own = await callTool(worker, 'project_memory_notes_read', {})
  assert.equal(own.notes.length, 1)
  assert.equal(own.notes[0].project, saved.projectKey)

  await assert.rejects(
    () => callTool(worker, 'project_memory_note_append', {
      project: other,
      title: 'other',
      body: 'body',
      tags: ['工程'],
    }),
    (error) => error.code === 'permission/project' && /may only access its own project/.test(error.message),
  )
  await assert.rejects(
    () => callTool(worker, 'project_memory_notes_read', { project: other }),
    (error) => error.code === 'permission/project',
  )

  const bindings = JSON.parse(await readFile(join(rootDir, 'bindings.json'), 'utf8'))
  assert.equal(bindings.bindings['worker-1'].path, canonicalQuant)

  // A new service (simulating resume/reload) must recover the same binding.
  const resumed = makeService({ store, catalog })
  const resumedWorker = new FakeAgent('worker-1', { cwd: workspace })
  resumed.registerAgent(resumedWorker)
  resumedWorker.loadSkill()
  const resumedRead = await callTool(resumedWorker, 'project_memory_notes_read', {})
  assert.equal(resumedRead.notes.length, 1)
  assert.equal(resumedRead.notes[0].title, 'bound note')
  assert.equal(resumedRead.notes[0].project, saved.projectKey)
  assert.equal(canonicalOther, await canonicalProjectPath(other))
})

test('a worker assigned a project subdirectory resolves to the project root', async () => {
  const root = await tempDir('pm-subdir-worker-')
  const project = await makeGitProject(root, 'QuantResearch')
  const subdir = join(project, 'src', 'feature')
  await mkdir(subdir, { recursive: true })
  const canonicalProject = await canonicalProjectPath(project)
  const catalog = catalogFor({ workerPath: subdir })
  const { store } = await makeStore()
  const service = makeService({ store, catalog })
  const worker = new FakeAgent('worker-1', { cwd: subdir })
  service.registerAgent(worker)
  worker.loadSkill()

  const saved = await callTool(worker, 'project_memory_note_append', {
    title: 'subdir note',
    body: 'body',
    tags: ['研究'],
  })
  assert.equal(saved.projectPath, canonicalProject)
  const own = await callTool(worker, 'project_memory_notes_read', {})
  assert.equal(own.notes.length, 1)
  assert.equal(own.projects[0].path, canonicalProject)
  assert.equal(await realpath(project), canonicalProject)
})

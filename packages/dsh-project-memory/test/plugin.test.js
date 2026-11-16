import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { apply } from '../index.js'
import { FakeAgent, catalogFor, tempDir, writeCatalog } from './helpers.js'

function fakeContext(agents) {
  const handlers = new Map()
  const disposers = []
  const registeredSkills = []
  const logs = []
  const ctx = {
    agents: { list: () => agents },
    skills: {
      register(skill) {
        registeredSkills.push(skill)
        return () => {}
      },
      async get(name) {
        const skill = registeredSkills.find((entry) => entry.name === name)
        return skill ? { ...skill, provider: 'dsh-project-memory' } : undefined
      },
    },
    tools: {},
    logger: {
      info(...args) { logs.push(['info', ...args]) },
      warn(...args) { logs.push(['warn', ...args]) },
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event).add(handler)
      return () => handlers.get(event)?.delete(handler)
    },
  }
  return { ctx, handlers, disposers, registeredSkills, logs }
}

async function withEnv(values, fn) {
  const previous = {}
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('package and bundle metadata are loadable', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.name, '@local/dsh-project-memory')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /id: dsh-project-memory/)
  assert.match(patch, /name: '@local\/dsh-project-memory'/)
})

test('apply registers the standard skill and decorates a Super Agent session', async () => {
  const stateDir = await tempDir('pm-plugin-super-')
  const memoryDir = join(stateDir, 'memory')
  const catalog = catalogFor({ superPath: '/tmp/super', workerPath: '/tmp/a' })
  await writeCatalog(join(stateDir, 'state.json'), catalog)
  const agent = new FakeAgent('super-1', { cwd: '/tmp/super' })
  const { ctx, registeredSkills, logs } = fakeContext([agent])
  await withEnv({ DSH_PROJECT_MEMORY_DIR: memoryDir, DSH_SUPERAGENT_STATE_DIR: stateDir }, async () => {
    await apply(ctx)
    assert.equal(registeredSkills.length, 1)
    assert.equal(registeredSkills[0].name, 'project-memory')
    assert.match(registeredSkills[0].content, /Project memory/)
    assert.match(registeredSkills[0].content, /Super Agent 使用约定/)
    assert.deepEqual([...agent.tools.keys()].sort(), [
      'project_memory_guide',
      'project_memory_notes_read',
      'project_memory_projects',
      'project_memory_search',
      'project_memory_summary_read',
      'project_memory_summary_write',
    ])
    assert.ok((await stat(memoryDir)).isDirectory())
    assert.equal(logs.some(([level, message]) => level === 'info' && String(message).includes('dsh-project-memory ready')), true)
  })
})

test('agent/created decorates a worker and agent/disposed releases it', async () => {
  const stateDir = await tempDir('pm-plugin-worker-')
  const memoryDir = join(stateDir, 'memory')
  const catalog = catalogFor({ workerPath: '/tmp/a' })
  await writeCatalog(join(stateDir, 'state.json'), catalog)
  const { ctx, handlers } = fakeContext([])
  await withEnv({ DSH_PROJECT_MEMORY_DIR: memoryDir, DSH_SUPERAGENT_STATE_DIR: stateDir }, async () => {
    await apply(ctx)
    const agent = new FakeAgent('worker-1', { cwd: '/tmp/a' })
    for (const handler of handlers.get('agent/created')) handler({ agent })
    assert.deepEqual([...agent.tools.keys()].sort(), ['project_memory_note_append', 'project_memory_notes_read'])
    for (const handler of handlers.get('agent/disposed')) handler({ agent })
    assert.equal(agent.tools.size, 0)
  })
})

test('apply injects the compact memory index after the role section', async () => {
  const stateDir = await tempDir('pm-plugin-index-')
  const memoryDir = join(stateDir, 'memory')
  const now = Date.UTC(2025, 0, 2, 3, 4, 5)
  await mkdir(join(memoryDir, 'projects', 'demo-seed'), { recursive: true })
  await writeFile(join(memoryDir, 'projects', 'demo-seed', 'summary.md'), '# Seed\n\nSeeded summary for the prompt index.\n')
  await writeFile(join(memoryDir, 'registry.json'), JSON.stringify({
    version: 1,
    updatedAt: now,
    projects: {
      'demo-seed': {
        key: 'demo-seed',
        path: '/tmp/demo-seed',
        title: 'Seeded project',
        createdAt: now,
        updatedAt: now,
        summaryUpdatedAt: now,
        summaryChars: 40,
        noteCount: 2,
        lastNoteAt: null,
        indexBytes: 0,
      },
    },
  }))
  const catalog = catalogFor({ superPath: '/tmp/super' })
  await writeCatalog(join(stateDir, 'state.json'), catalog)
  const agent = new FakeAgent('super-1', { cwd: '/tmp/super' })
  const { ctx } = fakeContext([agent])
  await withEnv({ DSH_PROJECT_MEMORY_DIR: memoryDir, DSH_SUPERAGENT_STATE_DIR: stateDir }, async () => {
    await apply(ctx)
    const names = agent.sections.map((section) => section.name)
    assert.deepEqual(names, ['dsh-project-memory:role', 'dsh-project-memory:index'])
    const index = agent.sections.find((section) => section.name === 'dsh-project-memory:index')
    assert.equal(index.order, 9999)
    assert.match(index.text(), /Memory index \(context, not authority; verify before relying\):/)
    assert.match(index.text(), /Seeded project \/ demo-seed \/ updated 2025-01-02T03:04:05\.000Z \/ notes 2 \/ Seed Seeded summary for the prompt index\./)
  })
})

test('apply omits the memory index when DSH_PROJECT_MEMORY_INDEX=0', async () => {
  const stateDir = await tempDir('pm-plugin-index-off-')
  const memoryDir = join(stateDir, 'memory')
  const catalog = catalogFor({ superPath: '/tmp/super' })
  await writeCatalog(join(stateDir, 'state.json'), catalog)
  const agent = new FakeAgent('super-1', { cwd: '/tmp/super' })
  const { ctx } = fakeContext([agent])
  await withEnv({
    DSH_PROJECT_MEMORY_DIR: memoryDir,
    DSH_SUPERAGENT_STATE_DIR: stateDir,
    DSH_PROJECT_MEMORY_INDEX: '0',
  }, async () => {
    await apply(ctx)
    assert.deepEqual(agent.sections.map((section) => section.name), ['dsh-project-memory:role'])
  })
})

test('apply degrades to notes-only mode when the Super Agent catalog is absent', async () => {
  const stateDir = await tempDir('pm-plugin-missing-')
  const memoryDir = join(stateDir, 'memory')
  const agent = new FakeAgent('plain-1', { cwd: '/tmp/plain' })
  const { ctx, logs } = fakeContext([agent])
  await withEnv({ DSH_PROJECT_MEMORY_DIR: memoryDir, DSH_SUPERAGENT_STATE_DIR: stateDir }, async () => {
    await apply(ctx)
    assert.deepEqual([...agent.tools.keys()].sort(), ['project_memory_note_append', 'project_memory_notes_read'])
    assert.equal(agent.tools.has('project_memory_summary_write'), false)
    assert.equal(logs.some(([level, message]) => level === 'info' && String(message).includes('notes-only')), true)
  })
})

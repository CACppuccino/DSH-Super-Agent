import test from 'node:test'
import assert from 'node:assert/strict'
import { isSkillLoaded } from '../lib/gate.js'
import { FakeAgent, callTool, catalogFor, makeService, makeStore } from './helpers.js'

test('the gate opens only after a successful skill loader call', () => {
  const agent = new FakeAgent('worker-1')
  assert.equal(isSkillLoaded(agent), false)

  const failed = agent.addToolCall('skill', { name: 'project-memory' })
  agent.addToolResult(failed, { isError: true })
  assert.equal(isSkillLoaded(agent), false, 'a failed load must not open the gate')

  agent.loadSkill()
  assert.equal(isSkillLoaded(agent), true)
})

test('the gate ignores other skills and malformed call arguments', () => {
  const agent = new FakeAgent('worker-1')
  const other = agent.addToolCall('skill', { name: 'office' })
  agent.addToolResult(other)
  assert.equal(isSkillLoaded(agent), false)

  agent.events.push({ type: 'tool/call', data: { name: 'skill', arguments: '{bad json', callId: 'bad' } })
  agent.events.push({ type: 'tool/result', data: { message: { content: [{ toolCallId: 'bad' }] } } })
  assert.equal(isSkillLoaded(agent), false)

  agent.events.push({ type: 'tool/call', data: { name: 'project_memory_guide' } })
  assert.equal(isSkillLoaded(agent), false, 'a pending guide call is not enough')
})

test('a user-explicit skill invocation opens the gate', () => {
  const agent = new FakeAgent('worker-1')
  agent.addUserSkillInvocation('project-memory')
  assert.equal(isSkillLoaded(agent), true)
  const other = new FakeAgent('worker-2')
  other.addUserSkillInvocation('office')
  assert.equal(isSkillLoaded(other), false)
})

test('the guide tool opens the gate for a Super Agent session', async () => {
  const { store } = await makeStore()
  const catalog = catalogFor({ superPath: '/tmp/super', workerPath: '/tmp/a' })
  let getCalled = 0
  const service = makeService({
    store,
    catalog,
    skills: {
      async get(name) {
        getCalled += 1
        assert.equal(name, 'project-memory')
        return { name, description: 'registered skill', provider: 'dsh-project-memory', content: '# registered body' }
      },
    },
  })
  const agent = new FakeAgent('super-1', { cwd: '/tmp/super' })
  service.registerAgent(agent)

  await assert.rejects(() => callTool(agent, 'project_memory_summary_read', {}), (error) => {
    assert.equal(error.code, 'skill/required')
    assert.match(error.message, /project_memory_guide/)
    return true
  })
  assert.equal(getCalled, 0)

  const guide = await callTool(agent, 'project_memory_guide', {})
  assert.equal(guide.loaded, true)
  assert.equal(guide.content, '# registered body')
  assert.equal(getCalled, 1)
  await assert.doesNotReject(() => callTool(agent, 'project_memory_summary_read', {}))
})

test('a worker gets an actionable error until it loads the skill', async () => {
  const { store } = await makeStore()
  const catalog = catalogFor({ workerPath: '/tmp/project-a' })
  const service = makeService({ store, catalog })
  const agent = new FakeAgent('worker-1', { cwd: '/tmp/project-a' })
  service.registerAgent(agent)

  await assert.rejects(
    () => callTool(agent, 'project_memory_note_append', { title: 'x', body: 'y', tags: ['工程'] }),
    (error) => {
      assert.equal(error.code, 'skill/required')
      assert.match(error.message, /Load the "project-memory" skill/)
      assert.match(error.message, /skill with \{"name":"project-memory"\}/)
      return true
    },
  )

  await assert.rejects(
    () => callTool(agent, 'project_memory_notes_read', {}),
    (error) => error.code === 'skill/required',
  )

  agent.loadSkill('project-memory', { failed: true })
  await assert.rejects(
    () => callTool(agent, 'project_memory_note_append', { title: 'x', body: 'y', tags: ['工程'] }),
    (error) => error.code === 'skill/required',
  )
  assert.equal((await store.listProjects({})).total, 0, 'a gated call must not register or write')

  agent.loadSkill()
  const saved = await callTool(agent, 'project_memory_note_append', { title: 'x', body: 'y', tags: ['工程'] })
  assert.equal(saved.saved, true)
})

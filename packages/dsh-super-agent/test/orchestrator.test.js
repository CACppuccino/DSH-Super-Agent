import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, test } from 'node:test'
import { Orchestrator, SUPER_DENY, SUPER_PROMPT, WORKER_PROMPT } from '../lib/orchestrator.js'
import { StateStore } from '../lib/state.js'
import { FakeHost } from './fakes.js'

const dirs = []
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop(), { recursive: true, force: true })
})

async function setup() {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-super-agent-orch-'))
  dirs.push(stateDir)
  const host = new FakeHost()
  const store = new StateStore(join(stateDir, 'state.json'))
  const orchestrator = new Orchestrator({ ctx: host, store, stateDir, now: () => Date.now() })
  await orchestrator.load()
  return { stateDir, host, store, orchestrator }
}

async function bootstrapped() {
  const context = await setup()
  const state = await context.orchestrator.bootstrap()
  const superConversation = state.conversations.find((item) => item.kind === 'super')
  return { ...context, state, superConversation, superAgent: context.host.get(superConversation.id) }
}

const messageEvent = (text, turn = 1) => ({
  type: 'assistant/message',
  seq: 1,
  time: Date.now(),
  data: { turn, message: { content: [{ type: 'text', text }] } },
})

test('bootstrap creates a Super Agent conversation, workspace, prompt, and tools', async () => {
  const { stateDir, host, orchestrator, state, superConversation, superAgent } = await bootstrapped()
  assert.equal(state.conversations.length, 1)
  assert.equal(superConversation.kind, 'super')
  assert.equal(superConversation.title, 'Super Agent')
  assert.ok(superConversation.workspacePath.startsWith(join(stateDir, 'workspaces')))
  assert.equal((await stat(superConversation.workspacePath)).isDirectory(), true)
  assert.equal(host.renameCalls.at(-1).title, 'Super Agent')
  assert.equal(superAgent.sections[0].text, SUPER_PROMPT)
  const names = [...superAgent.tools.keys()].sort()
  assert.deepEqual(names, [
    'superagent_create_conversation',
    'superagent_create_workspace',
    'superagent_dispatch_task',
    'superagent_list_conversations',
    'superagent_list_workers',
    'superagent_send_message',
    'superagent_stop_worker',
    'superagent_worker_output',
  ])
  const dispatch = superAgent.tools.get('superagent_dispatch_task')
  assert.equal(dispatch.output.schema.type, 'object')
  assert.equal(dispatch.output.render({}, { ok: true })[0].type, 'text')
  for (const definition of superAgent.tools.values()) {
    const parameters = definition.parameters
    assert.equal(parameters.type, 'object')
    if (parameters.required !== undefined) assert.equal(Array.isArray(parameters.required), true)
    for (const property of Object.values(parameters.properties || {})) {
      assert.equal(Object.hasOwn(property, 'required'), false, `${definition.name} uses standard JSON Schema`)
    }
  }
  assert.deepEqual(superAgent.restrictions, [
    { deny: ['subagent'] },
    { deny: ['send_message'] },
    { deny: ['workflow'] },
    { deny: ['spawn_teammate'] },
    { deny: ['bash'] },
    { deny: ['read'] },
    { deny: ['job_output'] },
  ])
  assert.deepEqual((await orchestrator.bootstrap()).conversations.length, 1)
})

test('Super Agent and worker restrictions include preset-scoped tools the global view cannot see', async () => {
  // A preset tool is restrictable through the agent's ancestor scope but
  // invisible to the unscoped tools.get() global view. The old filter used
  // that view and dropped ask_user_question, leaving it callable.
  const context = await setup()
  context.host.presetTools.add('ask_user_question')
  const state = await context.orchestrator.bootstrap()
  const superConversation = state.conversations.find((item) => item.kind === 'super')
  const superAgent = context.host.get(superConversation.id)
  assert.equal(superAgent.ctx.tools.get('ask_user_question'), undefined)
  assert.ok(superAgent.restrictions.some((restriction) => restriction.deny.includes('ask_user_question')))

  const worker = await superAgent.tools.get('superagent_dispatch_task').execute({
    title: 'Ask nothing',
    prompt: 'Do the work without question cards.',
  }, { agent: superAgent, signal: new AbortController().signal })
  const workerAgent = await context.orchestrator.ensureAgent(context.orchestrator.store.conversation(worker.id))
  assert.equal(workerAgent.ctx.tools.get('ask_user_question'), undefined)
  assert.deepEqual(workerAgent.restrictions, [{ deny: ['ask_user_question'] }])
})

test('a tool registered after decoration is still denied', async () => {
  const { superAgent } = await bootstrapped()
  assert.equal(superAgent.restrictions.some((restriction) => restriction.deny.includes('interrupt_agent')), false)
  superAgent.exposeTool('interrupt_agent')
  assert.equal(superAgent.restrictions.some((restriction) => restriction.deny.includes('interrupt_agent')), true)

  // Repeated registry changes must not duplicate an existing denial.
  superAgent.exposeTool('workflow')
  superAgent.emitToolsChange()
  assert.equal(superAgent.restrictions.filter((restriction) => restriction.deny.includes('workflow')).length, 1)
})

test('every SUPER_DENY name is blocked for a Super Agent scope', async () => {
  const context = await setup()
  for (const name of SUPER_DENY) context.host.presetTools.add(name)
  const state = await context.orchestrator.bootstrap()
  const superConversation = state.conversations.find((item) => item.kind === 'super')
  const superAgent = context.host.get(superConversation.id)
  const visible = superAgent.visibleToolNames()
  assert.equal(new Set(SUPER_DENY).size, SUPER_DENY.length, 'SUPER_DENY has no duplicate names')
  for (const name of SUPER_DENY) {
    assert.equal(visible.has(name), false, `${name} is still visible to the Super Agent`)
  }
  for (const name of superAgent.tools.keys()) {
    assert.equal(SUPER_DENY.includes(name), false, `plugin tool ${name} must not be denied`)
    assert.equal(visible.has(name), true, `plugin tool ${name} must stay available`)
  }
  for (const name of ['todo_write', 'create_goal', 'get_goal', 'update_goal', 'exit_plan_mode']) {
    assert.equal(SUPER_DENY.includes(name), false, `planning tool ${name} must stay available`)
  }
})

test('SUPER_DENY covers every host-side tool category in this build', () => {
  const expected = [
    // Shell/exec.
    'bash', 'pwsh',
    'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
    // Filesystem read/write/edit/patch and search.
    'read', 'write', 'edit', 'apply_patch', 'str_replace_editor', 'read_image', 'glob', 'grep',
    // Jobs/background.
    'job_list', 'job_output', 'job_kill',
    // Browser/web.
    'web_search', 'web_fetch',
    // Host environment, plugin, runtime, and session-log inspection.
    'working_directory', 'load_workspace_dependencies', 'plugin_manager',
    'cordis_inspect_list', 'cordis_inspect_query', 'create_worktree',
    'session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read',
    // Scheduling.
    'schedule_create', 'schedule_edit', 'schedule_delete', 'schedule_update', 'schedule_list', 'schedule_view',
    // Skills (the office/document path in this build), presentation, questions.
    'skill', 'present', 'ask_user_question',
    // One-shot delegation that bypasses workers.
    'subagent', 'subagent_fork', 'workflow', 'ralph',
  ]
  for (const name of expected) assert.ok(SUPER_DENY.includes(name), `${name} is missing from SUPER_DENY`)
})

test('worker scope keeps the local-execution tools the Super Agent loses', async () => {
  const local = [
    'bash', 'read', 'write', 'edit', 'glob', 'grep',
    'job_list', 'job_output', 'job_kill', 'web_search', 'web_fetch',
    'read_image', 'skill', 'present',
    'schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit',
  ]
  const context = await setup()
  for (const name of local) context.host.presetTools.add(name)
  context.host.presetTools.add('ask_user_question')
  const state = await context.orchestrator.bootstrap()
  const superConversation = state.conversations.find((item) => item.kind === 'super')
  const superAgent = context.host.get(superConversation.id)
  for (const name of local) {
    assert.equal(SUPER_DENY.includes(name), true, `${name} must be denied to the Super Agent`)
    assert.equal(superAgent.visibleToolNames().has(name), false, `${name} must not reach the Super Agent`)
  }

  const worker = await superAgent.tools.get('superagent_dispatch_task').execute({
    title: 'Run local tools',
    prompt: 'Use bash and edit files.',
  }, { agent: superAgent, signal: new AbortController().signal })
  const workerAgent = await context.orchestrator.ensureAgent(context.orchestrator.store.conversation(worker.id))
  const visible = workerAgent.visibleToolNames()
  assert.deepEqual(workerAgent.restrictions, [{ deny: ['ask_user_question'] }])
  for (const name of local) assert.equal(visible.has(name), true, `${name} must stay available to workers`)
  assert.equal(visible.has('ask_user_question'), false)
})

test('SUPER_DENY applies to every tool registered after decoration', async () => {
  const { superAgent } = await bootstrapped()
  for (const name of SUPER_DENY) superAgent.exposeTool(name)
  const visible = superAgent.visibleToolNames()
  for (const name of SUPER_DENY) {
    assert.equal(visible.has(name), false, `${name} is still visible after late registration`)
    assert.equal(superAgent.restrictions.filter((restriction) => restriction.deny.includes(name)).length, 1)
  }
})

test('the built-in tool guard fails fast only for denied tools in managed conversations', async () => {
  const { orchestrator, superConversation, superAgent } = await bootstrapped()
  assert.match(orchestrator.deniedToolReason({ name: 'ask_user_question', agent: superAgent }), /ask in a normal message/)
  assert.match(orchestrator.deniedToolReason({ name: 'bash', agent: superAgent }), /dispatch a worker/)
  assert.match(orchestrator.deniedToolReason({ name: 'read', agent: superAgent }), /dispatch a worker/)
  assert.equal(orchestrator.deniedToolReason({ name: 'superagent_dispatch_task', agent: superAgent }), undefined)
  assert.equal(orchestrator.deniedToolReason({ name: 'bash', agent: { id: 'session-other' } }), undefined)

  const worker = await superAgent.tools.get('superagent_dispatch_task').execute({
    title: 'Worker guard',
    prompt: 'Do the work.',
  }, { agent: superAgent, signal: new AbortController().signal })
  const workerAgent = await orchestrator.ensureAgent(orchestrator.store.conversation(worker.id))
  assert.match(orchestrator.deniedToolReason({ name: 'ask_user_question', agent: workerAgent }), /ask in a normal message/)
  assert.equal(orchestrator.deniedToolReason({ name: 'bash', agent: workerAgent }), undefined)
  assert.ok(orchestrator.store.conversation(superConversation.id))
})

test('the Super Agent prompt delegates host work and asks in plain text', async () => {
  assert.match(SUPER_PROMPT, /You do not operate the computer yourself/)
  assert.match(SUPER_PROMPT, /Every host action belongs to a worker/)
  assert.match(SUPER_PROMPT, /dispatch a worker/)
  assert.match(SUPER_PROMPT, /do not have an ask_user_question tool/)
  assert.match(SUPER_PROMPT, /write the question and any options as text/)
  assert.match(WORKER_PROMPT, /do not use ask_user_question/)
})

test('dispatch creates a worker in a requested workspace and sends a self-contained brief', async () => {
  const { orchestrator, superConversation, superAgent } = await bootstrapped()
  const workspacePath = join((await mkdtemp(join(tmpdir(), 'dsh-super-agent-project-'))), 'project')
  dirs.push(workspacePath)
  const dispatch = superAgent.tools.get('superagent_dispatch_task')
  const worker = await dispatch.execute({
    title: 'Write hello',
    prompt: 'Create hello.txt with the word hi and verify it.',
    workspace: workspacePath,
  }, { agent: superAgent, signal: new AbortController().signal })

  assert.equal(worker.kind, 'worker')
  assert.equal(worker.parentId, superConversation.id)
  assert.equal(worker.status, 'running')
  assert.equal(worker.workspacePath, workspacePath)
  assert.equal((await stat(workspacePath)).isDirectory(), true)

  const workerAgent = await orchestrator.ensureAgent(orchestrator.store.conversation(worker.id))
  assert.ok(workerAgent)
  assert.equal(workerAgent.sections[0].text, WORKER_PROMPT)
  assert.ok(workerAgent.tools.has('superagent_report_progress'))
  assert.equal(workerAgent.inbox.length, 1)
  assert.equal(workerAgent.inbox[0].source.kind, 'dsh-super-agent')
  assert.equal(workerAgent.inbox[0].source.form, 'relay')
  assert.match(workerAgent.inbox[0].content[0].text, /Create hello\.txt/)
  assert.match(workerAgent.inbox[0].content[0].text, /Workspace:/)
})

test('worker progress is recorded, relayed to the Super Agent, and readable', async () => {
  const { orchestrator, host, superConversation, superAgent } = await bootstrapped()
  const worker = await superAgent.tools.get('superagent_dispatch_task').execute({
    title: 'Investigate',
    prompt: 'Investigate the bug.',
  }, { agent: superAgent, signal: new AbortController().signal })
  const workerAgent = await orchestrator.ensureAgent(orchestrator.store.conversation(worker.id))
  const report = workerAgent.tools.get('superagent_report_progress')
  const result = await report.execute({ summary: 'Found the failing branch', status: 'progress' }, { agent: workerAgent })
  assert.deepEqual(result, { ok: true, worker_id: worker.id, recorded: true })
  assert.equal(host.get(superConversation.id).inbox.at(-1).source.form, 'notice')
  assert.match(host.get(superConversation.id).inbox.at(-1).content[0].text, /Found the failing branch/)

  const output = orchestrator.workerOutput({ workerId: worker.id, limit: 3 })
  assert.equal(output.worker.status, 'running')
  assert.equal(output.progress.at(-1).text, 'Found the failing branch')
  const listed = orchestrator.listWorkers({})
  assert.equal(listed.workers.length, 1)
  assert.equal(orchestrator.listWorkers({ status: 'failed' }).workers.length, 0)
})

test('a completed turn records the last assistant text and wakes the parent', async () => {
  const { orchestrator, host, superConversation, superAgent } = await bootstrapped()
  const worker = await superAgent.tools.get('superagent_dispatch_task').execute({
    title: 'Write result',
    prompt: 'Write the result.',
    new_workspace: { title: 'result' },
  }, { agent: superAgent, signal: new AbortController().signal })
  const workerAgent = await orchestrator.ensureAgent(orchestrator.store.conversation(worker.id))
  workerAgent.events = [messageEvent('Created result.txt and verified its contents.')]
  await orchestrator.onSessionEvent(workerAgent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

  const stored = orchestrator.store.conversation(worker.id)
  assert.equal(stored.status, 'waiting')
  assert.equal(stored.lastOutput, 'Created result.txt and verified its contents.')
  assert.equal(stored.progress.at(-1).status, 'turn-end')
  const notice = host.get(superConversation.id).inbox.at(-1)
  assert.equal(notice.source.form, 'notice')
  assert.match(notice.content[0].text, /Created result\.txt/)
  assert.match(notice.content[0].text, /Status: waiting/)
})

test('a failed turn marks the worker failed and a question needs input', async () => {
  const { orchestrator, superAgent, superConversation } = await bootstrapped()
  const worker = await superAgent.tools.get('superagent_dispatch_task').execute({
    title: 'Fragile',
    prompt: 'Do the fragile thing.',
  }, { agent: superAgent, signal: new AbortController().signal })
  const workerAgent = await orchestrator.ensureAgent(orchestrator.store.conversation(worker.id))
  await orchestrator.onSessionEvent(workerAgent.session, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'error', error: { message: 'provider unavailable' } } },
  })
  assert.equal(orchestrator.store.conversation(worker.id).status, 'failed')
  assert.match(superAgent.inbox.at(-1).content[0].text, /provider unavailable/)

  workerAgent.events = [messageEvent('Should I overwrite the existing file?', 2)]
  await orchestrator.onSessionEvent(workerAgent.session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  assert.equal(orchestrator.store.conversation(worker.id).status, 'needs_input')
})

test('a follow-up moves the worker to running and stop cancels its live agent', async () => {
  const { orchestrator, superAgent } = await bootstrapped()
  const worker = await superAgent.tools.get('superagent_dispatch_task').execute({
    title: 'Follow up',
    prompt: 'First pass.',
  }, { agent: superAgent, signal: new AbortController().signal })
  const workerAgent = await orchestrator.ensureAgent(orchestrator.store.conversation(worker.id))
  workerAgent.inbox.length = 0

  const sent = await orchestrator.sendWorkerMessage({ workerId: worker.id, message: 'Also add a test.' })
  assert.equal(sent.status, 'running')
  assert.equal(workerAgent.inbox.length, 1)
  assert.equal(workerAgent.inbox[0].content[0].text, 'Also add a test.')

  const stopped = await orchestrator.stopWorker({ workerId: worker.id, reason: 'No longer needed' })
  assert.equal(stopped.status, 'stopped')
  assert.equal(workerAgent.cancelled[0].kind, 'user')
  assert.equal(orchestrator.store.conversation(worker.id).lastMessage, 'No longer needed')
})

test('conversations and workspaces can be created in separate directories', async () => {
  const { orchestrator, stateDir } = await bootstrapped()
  const path = join(stateDir, 'another-place')
  const created = await orchestrator.createConversation({ title: 'Ops', path })
  assert.equal(created.kind, 'super')
  assert.equal(created.title, 'Ops')
  assert.equal(created.workspacePath, path)
  assert.equal((await stat(path)).isDirectory(), true)
  assert.equal(orchestrator.state().conversations.filter((item) => item.kind === 'super').length, 2)

  const workspace = await orchestrator.createWorkspace({ title: 'Prepared', path: join(stateDir, 'prepared') })
  assert.equal(workspace.title, 'Prepared')
  assert.equal(orchestrator.state().workspaces.some((item) => item.path === join(stateDir, 'prepared')), true)

  const withoutPath = await orchestrator.createConversation({ title: 'No path', newWorkspace: true })
  assert.equal(withoutPath.title, 'No path')
  assert.notEqual(withoutPath.workspaceId, created.workspaceId)
  assert.equal(orchestrator.state().workspaces.some((item) => item.id === withoutPath.workspaceId), true)
})

test('the super tools expose conversation listing and workspace preparation', async () => {
  const { orchestrator, superAgent } = await bootstrapped()
  const list = await superAgent.tools.get('superagent_list_conversations').execute({}, { agent: superAgent })
  assert.equal(list.conversations.length, 1)
  const workspace = await superAgent.tools.get('superagent_create_workspace').execute({ title: 'Scratch' }, { agent: superAgent })
  assert.equal(workspace.title, 'Scratch')
  assert.equal(orchestrator.state().workspaces.some((item) => item.id === workspace.id), true)
})

test('a worker that already reported done does not produce a second turn-end notice', async () => {
  const { orchestrator, superConversation, superAgent } = await bootstrapped()
  const worker = await superAgent.tools.get('superagent_dispatch_task').execute({
    title: 'Report done',
    prompt: 'Do the work and report.',
  }, { agent: superAgent, signal: new AbortController().signal })
  const workerAgent = await orchestrator.ensureAgent(orchestrator.store.conversation(worker.id))
  const before = superAgent.inbox.length
  await workerAgent.tools.get('superagent_report_progress').execute({ summary: 'All done', status: 'done' }, { agent: workerAgent })
  assert.equal(superAgent.inbox.length, before + 1)
  workerAgent.events = [messageEvent('All done', 1)]
  await orchestrator.onSessionEvent(workerAgent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(superAgent.inbox.length, before + 1)
  assert.equal(orchestrator.store.conversation(worker.id).status, 'waiting')
  assert.equal(orchestrator.store.conversation(worker.id).lastOutput, 'All done')
  assert.equal(superConversation.id, worker.parentId)

  // A later turn without a done report must still notify the parent.
  await orchestrator.onSessionEvent(workerAgent.session, { type: 'turn/start', data: { turn: 2 } })
  workerAgent.events = [messageEvent('Second turn finished', 2)]
  await orchestrator.onSessionEvent(workerAgent.session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  assert.equal(superAgent.inbox.length, before + 2)
  assert.match(superAgent.inbox.at(-1).content[0].text, /Second turn finished/)
})

test('dispose releases the prompt and tool bindings added to live agents', async () => {
  const { orchestrator, superAgent } = await bootstrapped()
  assert.equal(orchestrator.bindings.size, 1)
  orchestrator.dispose()
  assert.equal(orchestrator.bindings.size, 0)
  assert.equal(superAgent.sections.length, 1)
  assert.deepEqual(superAgent.restrictions, [])
  orchestrator.onAgentDisposed(superAgent)
  assert.equal(orchestrator.bindings.size, 0)
})

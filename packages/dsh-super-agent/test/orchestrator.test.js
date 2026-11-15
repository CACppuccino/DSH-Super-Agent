import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, test } from 'node:test'
import { Orchestrator, SUPER_DENY, SUPER_PROMPT, THEME_CATALOG, WORKER_PROMPT } from '../lib/orchestrator.js'
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
    'superagent_pending_decision',
    'superagent_send_message',
    'superagent_stop_worker',
    'superagent_worker_output',
    'superagent_worker_tags',
    'superagent_workspaces',
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
  assert.match(SUPER_PROMPT, /superagent_pending_decision/)
  assert.match(WORKER_PROMPT, /do not use ask_user_question/)
})

test('the pending decision tool creates, lists, and resolves items scoped to its conversation', async () => {
  const { orchestrator, host, store, superAgent, superConversation, stateDir } = await bootstrapped()
  const pending = superAgent.tools.get('superagent_pending_decision')
  assert.ok(pending, 'the pending decision tool is registered')
  assert.deepEqual(pending.parameters.properties.action.enum, ['create', 'list', 'resolve', 'update', 'retract'])

  const created = await pending.execute({
    action: 'create',
    question: 'Which channel?',
    context: 'Both are ready.',
    options: ['stable', 'beta'],
  }, { agent: superAgent })
  assert.equal(created.ok, true)
  assert.equal(created.item.conversation_id, superConversation.id)
  assert.deepEqual(created.item.options, ['stable', 'beta'])
  assert.equal((await readFile(join(stateDir, 'pending.json'), 'utf8')).includes('Which channel?'), true)

  const listed = await pending.execute({ action: 'list' }, { agent: superAgent })
  assert.deepEqual(listed.items.map((item) => item.id), [created.item.id])

  const second = await orchestrator.createConversation({ title: 'Second' })
  const secondAgent = await orchestrator.ensureAgent(store.conversation(second.id))
  const secondTool = secondAgent.tools.get('superagent_pending_decision')
  assert.deepEqual((await secondTool.execute({ action: 'list' }, { agent: secondAgent })).items, [])
  await assert.rejects(
    () => secondTool.execute({ action: 'resolve', id: created.item.id, answer: 'beta' }, { agent: secondAgent }),
    /Unknown pending decision/,
  )

  const resolved = await pending.execute({ action: 'resolve', id: created.item.id, answer: 'beta' }, { agent: superAgent })
  assert.equal(resolved.item.answer, 'beta')
  assert.equal(typeof resolved.item.resolved_at, 'number')
  assert.deepEqual((await pending.execute({ action: 'list' }, { agent: superAgent })).items, [])
  const withHistory = await pending.execute({ action: 'list', include_resolved: true }, { agent: superAgent })
  assert.equal(withHistory.items.length, 1)
  assert.equal(withHistory.items[0].answer, 'beta')
  await assert.rejects(
    () => pending.execute({ action: 'create', question: '   ' }, { agent: superAgent }),
    /question is required/,
  )
  await assert.rejects(
    () => pending.execute({ action: 'explode' }, { agent: superAgent }),
    /action must be create, list, resolve, update, or retract/,
  )

  // The queue is durable across a process-style reload.
  const reloaded = new Orchestrator({ ctx: host, store: new StateStore(join(stateDir, 'state.json')), stateDir })
  await reloaded.load()
  assert.equal(reloaded.listPendingDecisions({ includeResolved: true }).length, 1)
  assert.equal(reloaded.listPendingDecisions().length, 0)
})

test('answering a pending decision delivers a plain user message to the Super Agent', async () => {
  const { orchestrator, host, superConversation, superAgent } = await bootstrapped()
  const item = await orchestrator.createPendingDecision({
    question: 'Ship the release?',
    context: 'All checks passed.',
    options: ['Yes', 'No'],
  })
  assert.equal(item.conversation_id, superConversation.id)
  superAgent.inbox.length = 0

  const outcome = await orchestrator.answerPendingDecision({ id: item.id, answer: 'Yes' })
  assert.equal(outcome.delivered, true)
  assert.equal(outcome.item.answer, 'Yes')
  assert.equal(superAgent.inbox.length, 1)
  const message = superAgent.inbox[0]
  assert.equal(message.role, 'user')
  assert.deepEqual(message.source, { kind: 'user' })
  assert.match(message.content[0].text, /Ship the release\?/)
  assert.match(message.content[0].text, /The user answered: Yes/)
  assert.equal(host.get(superConversation.id).inbox.length, 1)

  const retry = await orchestrator.answerPendingDecision({ id: item.id, answer: 'No' })
  assert.equal(retry.delivered, false)
  assert.equal(retry.item.answer, 'Yes')
  assert.equal(superAgent.inbox.length, 1)
  assert.equal(orchestrator.listPendingDecisions().length, 0)
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


test('worker tags are many-to-many, normalized, persisted, and exposed by the tool', async () => {
  const { orchestrator, host, store, superAgent, stateDir } = await bootstrapped()
  const dispatch = superAgent.tools.get('superagent_dispatch_task')
  const first = await dispatch.execute({ title: 'Quant audit', prompt: 'Audit quant.' }, { agent: superAgent, signal: new AbortController().signal })
  const second = await dispatch.execute({ title: 'Infra fix', prompt: 'Fix infra.' }, { agent: superAgent, signal: new AbortController().signal })

  const tagsTool = superAgent.tools.get('superagent_worker_tags')
  assert.ok(tagsTool, 'the worker tags tool is registered')
  assert.deepEqual(tagsTool.parameters.properties.action.enum, ['set', 'add', 'remove', 'list'])

  const setFirst = await tagsTool.execute({
    action: 'set',
    worker_id: first.id,
    tags: [' quant ', 'DSH', 'quant', ''],
  }, { agent: superAgent })
  assert.deepEqual(setFirst.worker.tags, ['quant', 'DSH'])
  await tagsTool.execute({ action: 'set', worker_id: second.id, tags: ['quant', 'infra'] }, { agent: superAgent })

  const listed = await tagsTool.execute({ action: 'list' }, { agent: superAgent })
  assert.deepEqual(listed.tags.map((entry) => [entry.tag, entry.count]), [['DSH', 1], ['infra', 1], ['quant', 2]])
  assert.deepEqual(listed.tags.find((entry) => entry.tag === 'quant').workerIds.sort(), [first.id, second.id].sort())
  assert.deepEqual(listed.workers.find((worker) => worker.id === first.id).tags, ['quant', 'DSH'])

  const one = await tagsTool.execute({ action: 'list', worker_id: second.id }, { agent: superAgent })
  assert.equal(one.worker.id, second.id)
  assert.deepEqual(one.tags, ['quant', 'infra'])

  const added = await tagsTool.execute({ action: 'add', worker_id: first.id, tags: ['infra', 'quant'] }, { agent: superAgent })
  assert.deepEqual(added.worker.tags, ['quant', 'DSH', 'infra'])
  const removed = await tagsTool.execute({ action: 'remove', worker_id: second.id, tags: ['QUANT'] }, { agent: superAgent })
  assert.deepEqual(removed.worker.tags, ['infra'])
  await assert.rejects(
    () => tagsTool.execute({ action: 'explode', worker_id: first.id }, { agent: superAgent }),
    /action must be set, add, remove, or list/,
  )
  await assert.rejects(
    () => tagsTool.execute({ action: 'set', worker_id: 'missing', tags: ['x'] }, { agent: superAgent }),
    /Unknown worker/,
  )

  // The state view carries tags for the panel and the catalog survives a reload.
  assert.deepEqual(orchestrator.state().conversations.find((worker) => worker.id === first.id).tags, ['quant', 'DSH', 'infra'])
  const reloaded = new Orchestrator({ ctx: host, store: new StateStore(join(stateDir, 'state.json')), stateDir })
  await reloaded.load()
  assert.deepEqual(reloaded.listWorkerTags().tags.find((entry) => entry.tag === 'infra').workerIds.sort(), [first.id, second.id].sort())
  assert.deepEqual(reloaded.state().conversations.find((worker) => worker.id === second.id).tags, ['infra'])
  assert.ok(store.conversation(first.id))
})

test('the Super Agent prompt tells the model how to use worker tags', () => {
  assert.match(SUPER_PROMPT, /superagent_worker_tags/)
  assert.match(SUPER_PROMPT, /short tags/i)
})

test('dispatch classifies by theme, reuses the theme workspace, and never creates silently', async () => {
  const { orchestrator, host, superAgent, stateDir } = await bootstrapped()
  const workspacesTool = superAgent.tools.get('superagent_workspaces')
  assert.ok(workspacesTool, 'the workspace discovery tool is registered')
  assert.deepEqual(workspacesTool.parameters.properties.action.enum, ['list', 'themes', 'assign', 'suggest', 'retire', 'reactivate'])
  const dispatch = superAgent.tools.get('superagent_dispatch_task')

  const quant = await orchestrator.createWorkspace({ title: 'Quant Research Hub' })
  const assigned = await workspacesTool.execute({
    action: 'assign',
    theme: 'quant-research',
    workspace_id: quant.id,
    description: 'Quant strategies, backtests, and research.',
  }, { agent: superAgent })
  assert.equal(assigned.ok, true)
  assert.equal(assigned.theme.id, 'quant-research')
  assert.equal(assigned.theme.workspaceId, quant.id)
  assert.equal(assigned.theme.workspace.path, quant.path)

  const first = await dispatch.execute({
    title: 'Backtest momentum strategy',
    prompt: 'Run the backtest and report the result.',
    theme: 'quant-research',
  }, { agent: superAgent, signal: new AbortController().signal })
  assert.equal(first.theme, 'quant-research')
  assert.equal(first.workspace_created, false)
  assert.equal(first.workspace_reused, true)
  assert.equal(first.workspaceId, quant.id)
  assert.equal(first.workspacePath, quant.path)
  assert.equal(orchestrator.store.theme('quant-research').workspaceId, quant.id)

  // Theme labels normalize to the same registry id; a new conversation in the
  // same theme reuses the canonical workspace.
  const second = await dispatch.execute({
    title: 'Analyze factor stability',
    prompt: 'Analyze the factors.',
    theme: 'Quant Research',
  }, { agent: superAgent, signal: new AbortController().signal })
  assert.equal(second.workspace_created, false)
  assert.equal(second.workspaceId, quant.id)
  assert.notEqual(second.id, first.id)
  assert.equal(orchestrator.store.conversation(first.id).workspaceId, quant.id)
  assert.equal(orchestrator.store.conversation(second.id).workspaceId, quant.id)

  // A registered theme wins over a different explicit `workspace` unless
  // new_workspace is requested.
  const other = await orchestrator.createWorkspace({ title: 'Unrelated scratch' })
  const ignored = await dispatch.execute({
    title: 'A third quant task',
    prompt: 'Keep it in the theme workspace.',
    theme: 'quant-research',
    workspace: other.id,
  }, { agent: superAgent, signal: new AbortController().signal })
  assert.equal(ignored.workspaceId, quant.id)
  assert.equal(ignored.workspace_created, false)
  assert.equal(orchestrator.store.theme('quant-research').workspaceId, quant.id)

  // An explicit new workspace is still honored, but it does not silently
  // replace the theme's canonical workspace.
  const explicit = await dispatch.execute({
    title: 'Separate quant deliverable',
    prompt: 'Build the separate deliverable.',
    theme: 'quant-research',
    new_workspace: { title: 'Quant separate deliverable' },
  }, { agent: superAgent, signal: new AbortController().signal })
  assert.equal(explicit.workspace_created, true)
  assert.equal(explicit.workspace_reused, false)
  assert.notEqual(explicit.workspaceId, quant.id)
  assert.equal(orchestrator.store.theme('quant-research').workspaceId, quant.id)

  // An unknown theme requires a justification to create a workspace.
  await assert.rejects(
    () => dispatch.execute({ title: 'Legal review', prompt: 'Review it.', theme: 'legal-review' }, { agent: superAgent }),
    /justification/,
  )
  await assert.rejects(
    () => dispatch.execute({ title: 'Legal review', prompt: 'Review it.', theme: 'legal-review', new_workspace: { title: 'Legal' } }, { agent: superAgent }),
    /justification/,
  )
  const legal = await dispatch.execute({
    title: 'Legal review',
    prompt: 'Review the contract.',
    theme: 'legal-review',
    justification: 'Contracts need an isolated directory; do not mix them with product work.',
  }, { agent: superAgent, signal: new AbortController().signal })
  assert.equal(legal.workspace_created, true)
  assert.equal(legal.theme, 'legal-review')
  assert.equal(orchestrator.store.theme('legal-review').workspaceId, legal.workspaceId)
  assert.ok(legal.workspacePath.startsWith(join(stateDir, 'workspaces')))

  // A theme with no workspace can adopt an explicitly supplied existing
  // workspace without creating another directory.
  const infra = await orchestrator.createWorkspace({ title: 'Infra Hub' })
  const adopted = await dispatch.execute({
    title: 'Check disk health',
    prompt: 'Check the disks.',
    theme: 'infra-ops',
    workspace: infra.id,
  }, { agent: superAgent, signal: new AbortController().signal })
  assert.equal(adopted.workspace_created, false)
  assert.equal(adopted.workspaceId, infra.id)
  assert.equal(orchestrator.store.theme('infra-ops').workspaceId, infra.id)

  // The registry and assignments survive a process-style reload.
  const reloaded = new Orchestrator({ ctx: host, store: new StateStore(join(stateDir, 'state.json')), stateDir })
  await reloaded.load()
  assert.equal(reloaded.store.theme('quant-research').workspaceId, quant.id)
  assert.equal(reloaded.store.theme('legal-review').workspaceId, legal.workspaceId)
  assert.equal(reloaded.listThemes().length, THEME_CATALOG.length + 1, 'known themes plus the custom legal-review theme')
  assert.deepEqual(reloaded.listThemes().filter((theme) => theme.workspaceId).map((theme) => theme.id).sort(), ['infra-ops', 'legal-review', 'quant-research'])
})

test('the workspace tool inventories emptiness and groups, and suggest classifies descriptions', async () => {
  const { orchestrator, superAgent } = await bootstrapped()
  const workspacesTool = superAgent.tools.get('superagent_workspaces')
  const memory = await orchestrator.createWorkspace({ title: 'Memory Hub' })
  const scratch = await orchestrator.createWorkspace({ title: 'Scratch empty' })
  await workspacesTool.execute({
    action: 'assign',
    theme: 'memory',
    workspace_id: memory.id,
    title: 'Memory systems',
    description: 'Cloudflare memory sync, project memories, summaries, and notes.',
  }, { agent: superAgent })
  const worker = await superAgent.tools.get('superagent_dispatch_task').execute({
    title: 'Sync memory to Cloudflare',
    prompt: 'Sync the memory store.',
    theme: 'memory',
  }, { agent: superAgent, signal: new AbortController().signal })

  const list = await workspacesTool.execute({ action: 'list' }, { agent: superAgent })
  assert.equal(list.ok, true)
  const memoryRow = list.workspaces.find((workspace) => workspace.id === memory.id)
  assert.equal(memoryRow.workerCount, 1)
  assert.equal(memoryRow.activeWorkers, 1)
  assert.equal(memoryRow.theme, 'memory')
  assert.equal(memoryRow.proposedTheme, 'memory')
  const scratchRow = list.workspaces.find((workspace) => workspace.id === scratch.id)
  assert.equal(scratchRow.workerCount, 0)
  assert.equal(scratchRow.emptyDirectory, true)
  assert.equal(scratchRow.empty, true)
  const memoryGroup = list.groups.find((group) => group.theme.id === 'memory')
  assert.equal(memoryGroup.canonicalId, memory.id)
  assert.equal(memoryGroup.workspaceIds.includes(memory.id), true)
  assert.equal(list.themes.some((theme) => theme.id === 'memory'), true)

  const themes = await workspacesTool.execute({ action: 'themes' }, { agent: superAgent })
  assert.equal(themes.themes.length, THEME_CATALOG.length)
  const memoryTheme = themes.themes.find((theme) => theme.id === 'memory')
  assert.equal(memoryTheme.workspace.id, memory.id)

  const suggestion = await workspacesTool.execute({
    action: 'suggest',
    description: 'Deploy the Cloudflare memory sync backend and update project summaries',
  }, { agent: superAgent })
  assert.equal(suggestion.registered, true)
  assert.equal(suggestion.theme.id, 'memory')
  assert.equal(suggestion.workspace.id, memory.id)

  const fallback = await workspacesTool.execute({
    action: 'suggest',
    description: 'Package a new DSH plugin panel for the desktop sidebar',
  }, { agent: superAgent })
  assert.equal(fallback.theme.id, 'dsh-plugin')
  assert.equal(fallback.registered, false)

  await assert.rejects(
    () => workspacesTool.execute({ action: 'assign', theme: 'x', workspace_id: 'missing' }, { agent: superAgent }),
    /Workspace not found/,
  )
  await assert.rejects(
    () => workspacesTool.execute({ action: 'explode' }, { agent: superAgent }),
    /action must be list, themes, assign, suggest, retire, or reactivate/,
  )
  assert.equal(worker.theme, 'memory')
  assert.equal(worker.workspace_created, false)
})

test('the Super Agent prompt teaches workspace discipline', () => {
  assert.match(SUPER_PROMPT, /Workspace discipline/)
  assert.match(SUPER_PROMPT, /superagent_workspaces/)
  assert.match(SUPER_PROMPT, /workspace_created/)
  assert.match(SUPER_PROMPT, /never create a workspace silently/i)
})

test('workspace retirement is metadata-only, guarded, and reversible', async () => {
  const { orchestrator, host, superAgent, superConversation } = await bootstrapped()
  const workspacesTool = superAgent.tools.get('superagent_workspaces')
  const canonical = await orchestrator.createWorkspace({ title: 'Quant canonical' })
  const duplicate = await orchestrator.createWorkspace({ title: 'Quant duplicate' })
  await workspacesTool.execute({ action: 'assign', theme: 'quant-research', workspace_id: canonical.id }, { agent: superAgent })
  const worker = await superAgent.tools.get('superagent_dispatch_task').execute({
    title: 'Old quant task',
    prompt: 'Do the old task.',
    workspace: duplicate.id,
    theme: 'quant-research',
  }, { agent: superAgent, signal: new AbortController().signal })
  assert.equal(worker.workspaceId, canonical.id, 'registered theme reuses the canonical workspace')

  await assert.rejects(
    () => workspacesTool.execute({ action: 'retire', workspace_id: canonical.id }, { agent: superAgent }),
    /canonical for theme/,
  )
  await assert.rejects(
    () => workspacesTool.execute({ action: 'retire', workspace_id: superConversation.workspaceId }, { agent: superAgent }),
    /protected/,
  )

  const retired = await workspacesTool.execute({
    action: 'retire',
    workspace_id: duplicate.id,
    reason: 'Duplicate of Quant canonical; consolidation approved',
  }, { agent: superAgent })
  assert.equal(retired.workspace.retired, true)
  assert.equal(retired.workspace.retiredReason, 'Duplicate of Quant canonical; consolidation approved')
  assert.equal(retired.workspace.workerCount, 0)

  const list = await workspacesTool.execute({ action: 'list' }, { agent: superAgent })
  assert.equal(list.workspaces.some((workspace) => workspace.id === duplicate.id), false)
  assert.equal(list.workspaces.some((workspace) => workspace.id === canonical.id), true)
  const retiredRow = list.retired.find((workspace) => workspace.id === duplicate.id)
  assert.equal(retiredRow.retired, true)
  assert.equal(retiredRow.retiredReason, 'Duplicate of Quant canonical; consolidation approved')
  const groups = list.groups.find((group) => group.theme.id === 'quant-research')
  assert.equal(groups.workspaceIds.includes(duplicate.id), false)

  // Hidden from the picker, but the workspace record, registry entry, directory,
  // and any worker conversations remain resolvable.
  assert.equal(orchestrator.state().workspaces.some((workspace) => workspace.id === duplicate.id), false)
  assert.equal(orchestrator.state().workspaces.some((workspace) => workspace.id === canonical.id), true)
  assert.ok(orchestrator.store.workspace(duplicate.id))
  assert.ok(host.workspaceRegistry.get(duplicate.id))
  assert.equal(orchestrator.workspaceDetail(duplicate.id).retired, true)
  assert.equal(orchestrator.workspaceDetail(duplicate.id).id, duplicate.id)
  assert.equal(orchestrator.store.conversation(worker.id).workspaceId, canonical.id)

  const reactivated = await workspacesTool.execute({ action: 'reactivate', workspace_id: duplicate.id }, { agent: superAgent })
  assert.equal(reactivated.workspace.retired, false)
  assert.equal(reactivated.workspace.retiredReason, '')
  const after = await workspacesTool.execute({ action: 'list' }, { agent: superAgent })
  assert.equal(after.workspaces.some((workspace) => workspace.id === duplicate.id), true)
  assert.equal(after.retired.some((workspace) => workspace.id === duplicate.id), false)
  assert.equal(orchestrator.state().workspaces.some((workspace) => workspace.id === duplicate.id), true)

  await assert.rejects(
    () => workspacesTool.execute({ action: 'retire', workspace_id: 'missing' }, { agent: superAgent }),
    /Workspace not found/,
  )
})

test('the approved quant-research canonical is reused by dispatch', async () => {
  const { orchestrator, superAgent } = await bootstrapped()
  const workspacesTool = superAgent.tools.get('superagent_workspaces')
  const canonical = await orchestrator.createWorkspace({ title: 'qr-data-power-options' })
  await workspacesTool.execute({
    action: 'assign',
    theme: 'quant-research',
    workspace_id: canonical.id,
    description: 'Quant strategies, research pipelines, and backtests.',
  }, { agent: superAgent })
  const suggestion = await workspacesTool.execute({
    action: 'suggest',
    description: 'Backtest a momentum strategy on QuantResearch',
  }, { agent: superAgent })
  assert.equal(suggestion.theme.id, 'quant-research')
  assert.equal(suggestion.workspace.id, canonical.id)

  const result = await superAgent.tools.get('superagent_dispatch_task').execute({
    title: 'Quant reuse integration check',
    prompt: 'Confirm the canonical workspace is reused.',
    theme: 'quant-research',
  }, { agent: superAgent, signal: new AbortController().signal })
  assert.equal(result.workspaceId, canonical.id)
  assert.equal(result.workspace_created, false)
  assert.equal(result.workspace_reused, true)
  assert.equal(result.theme, 'quant-research')
  assert.equal(orchestrator.store.theme('quant-research').workspaceId, canonical.id)
  assert.equal(orchestrator.store.workspace(canonical.id).retired, false)
})

test('the pending decision tool updates in place and retracts without answering', async () => {
  const { orchestrator, superAgent, superConversation } = await bootstrapped()
  const pending = superAgent.tools.get('superagent_pending_decision')
  const created = await pending.execute({
    action: 'create',
    question: 'Which release?',
    context: 'First context.',
    options: ['stable', 'beta'],
  }, { agent: superAgent })
  assert.equal(created.item.status, 'open')
  assert.equal(created.item.revision, 1)
  assert.deepEqual(created.item.history, [])

  const updated = await pending.execute({
    action: 'update',
    id: created.item.id,
    question: 'Which release channel now?',
    context: 'New evidence changed the options.',
    options: ['stable', 'canary'],
  }, { agent: superAgent })
  assert.equal(updated.ok, true)
  assert.equal(updated.changed, true)
  assert.equal(updated.item.revision, 2)
  assert.equal(updated.item.status, 'open')
  assert.equal(updated.item.question, 'Which release channel now?')
  assert.deepEqual(updated.item.options, ['stable', 'canary'])
  assert.deepEqual(updated.item.history, [{
    revision: 1,
    question: 'Which release?',
    context: 'First context.',
    options: ['stable', 'beta'],
    updated_at: created.item.updated_at,
  }])

  const listed = await pending.execute({ action: 'list' }, { agent: superAgent })
  const listedItem = listed.items.find((item) => item.id === created.item.id)
  assert.equal(listedItem.status, 'open')
  assert.equal(listedItem.revision, 2)
  assert.deepEqual(listedItem.history.map((entry) => entry.revision), [1])
  assert.equal((await pending.execute({ action: 'list', include_resolved: true }, { agent: superAgent })).items.some((item) => item.id === created.item.id), true)
  assert.equal((await pending.execute({ action: 'list', include_retracted: true }, { agent: superAgent })).items.some((item) => item.id === created.item.id), true)

  const retracted = await pending.execute({
    action: 'retract',
    id: created.item.id,
    reason: 'Decided in conversation; the release choice is moot',
  }, { agent: superAgent })
  assert.equal(retracted.ok, true)
  assert.equal(retracted.changed, true)
  assert.equal(retracted.item.status, 'retracted')
  assert.equal(retracted.item.resolved_at, null)
  assert.equal(retracted.item.answer, '')
  assert.equal(retracted.item.retract_reason, 'Decided in conversation; the release choice is moot')
  assert.equal(typeof retracted.item.retracted_at, 'number')
  assert.equal((await pending.execute({ action: 'list' }, { agent: superAgent })).items.some((item) => item.id === created.item.id), false)
  assert.equal((await pending.execute({ action: 'list', include_retracted: true }, { agent: superAgent })).items.some((item) => item.id === created.item.id), true)
  assert.equal((await pending.execute({ action: 'list', include_resolved: true }, { agent: superAgent })).items.some((item) => item.id === created.item.id), false)
  await assert.rejects(
    () => pending.execute({ action: 'update', id: created.item.id, question: 'Again?' }, { agent: superAgent }),
    /retracted and cannot be updated/,
  )
  await assert.rejects(
    () => pending.execute({ action: 'resolve', id: created.item.id, answer: 'stable' }, { agent: superAgent }),
    /retracted and cannot be answered/,
  )
  await assert.rejects(
    () => pending.execute({ action: 'retract', id: created.item.id }, { agent: superAgent }),
    /reason is required/,
  )

  const answered = await pending.execute({ action: 'create', question: 'Answered one?' }, { agent: superAgent })
  await pending.execute({ action: 'resolve', id: answered.item.id, answer: 'yes' }, { agent: superAgent })
  await assert.rejects(
    () => pending.execute({ action: 'update', id: answered.item.id, question: 'Change it?' }, { agent: superAgent }),
    /resolved and cannot be updated/,
  )
  await assert.rejects(
    () => pending.execute({ action: 'retract', id: answered.item.id, reason: 'Moot' }, { agent: superAgent }),
    /answered and cannot be retracted/,
  )

  const reloaded = new Orchestrator({ ctx: orchestrator.ctx, store: new StateStore(join(orchestrator.stateDir, 'state.json')), stateDir: orchestrator.stateDir })
  await reloaded.load()
  assert.equal(reloaded.pending.get(created.item.id).status, 'retracted')
  assert.equal(reloaded.pending.get(created.item.id).revision, 2)
  assert.equal(reloaded.pending.get(created.item.id).history.length, 1)
  assert.equal(reloaded.listPendingDecisions({ includeRetracted: true }).length, 1)
  assert.equal(superConversation.id, reloaded.store.latestSuper().id)
})

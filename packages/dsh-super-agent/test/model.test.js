import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, test } from 'node:test'
import { Orchestrator } from '../lib/orchestrator.js'
import { StateStore } from '../lib/state.js'
import { FakeHost } from './fakes.js'

const dirs = []
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop(), { recursive: true, force: true })
})

async function bootstrapped() {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-super-agent-model-'))
  dirs.push(stateDir)
  const host = new FakeHost()
  const store = new StateStore(join(stateDir, 'state.json'))
  const orchestrator = new Orchestrator({ ctx: host, store, stateDir, now: () => Date.now() })
  await orchestrator.load()
  const state = await orchestrator.bootstrap()
  const superConversation = state.conversations.find((item) => item.kind === 'super')
  return {
    stateDir,
    host,
    store,
    orchestrator,
    superConversation,
    superAgent: host.get(superConversation.id),
  }
}

const dispatch = (orchestrator, superConversation, args = {}) => orchestrator.dispatchTask({
  parentId: superConversation.id,
  title: 'Quant audit',
  prompt: 'Audit the quant work.',
  ...args,
})

test('the dispatch schema advertises the optional worker route without changing the required brief', async () => {
  const { superAgent } = await bootstrapped()
  const definition = superAgent.tools.get('superagent_dispatch_task')
  const properties = definition.parameters.properties
  assert.deepEqual(definition.parameters.required, ['title', 'prompt', 'theme'])
  assert.equal(properties.provider.type, 'string')
  assert.equal(properties.model.type, 'string')
  assert.equal(properties.reasoning_effort.type, 'string')
  assert.match(properties.model.description, /provider\/model/)
  assert.match(properties.model.description, /inherit/)
  assert.match(properties.provider.description, /inherit/)
})

test('a worker inherits the Super Agent route without touching the Host default model', async () => {
  const { host, orchestrator, superConversation, superAgent } = await bootstrapped()
  host.enableModels()
  superAgent.useRoute('didi-global', 'deepseek-v4-flash', 'high')
  const before = { ...host.defaultSelection }

  const worker = await dispatch(orchestrator, superConversation)

  assert.deepEqual(host.modelSelections, [{
    sessionId: worker.id,
    provider: 'didi-global',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'high',
    appliedBy: 'agent',
  }], 'the worker Session is switched to the parent route')
  assert.deepEqual(worker.model, {
    provider: 'didi-global',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'high',
    source: 'inherited',
    applied: true,
  })
  assert.deepEqual(host.defaultSelection, before, 'the Host default model is untouched')
  assert.equal(host.savedSelections.length, 0, 'no user setting is written')
  assert.equal(orchestrator.listWorkers({}).workers[0].model.source, 'inherited')
})

test('an explicit provider and model override the inherited route', async () => {
  const { host, orchestrator, superConversation, superAgent } = await bootstrapped()
  host.enableModels()
  superAgent.useRoute('didi-global', 'deepseek-v4-flash', 'high')

  const worker = await dispatch(orchestrator, superConversation, {
    provider: 'didi-global',
    model: 'claude-opus-5-5',
  })

  assert.deepEqual(host.modelSelections, [{
    sessionId: worker.id,
    provider: 'didi-global',
    model: 'claude-opus-5-5',
    appliedBy: 'agent',
  }], 'a route change drops the parent reasoning effort')
  assert.deepEqual(worker.model, { provider: 'didi-global', model: 'claude-opus-5-5', source: 'explicit', applied: true })
  assert.equal(host.savedSelections.length, 0)
})

test('a model given as "provider/model" is split into an exact route', async () => {
  const { host, orchestrator, superConversation, superAgent } = await bootstrapped()
  host.enableModels()
  superAgent.useRoute('deepseek-account', 'deepseek-flash')

  const worker = await dispatch(orchestrator, superConversation, {
    model: 'didi-global/glm-5.2',
    reasoningEffort: 'low',
  })

  assert.deepEqual(host.modelSelections, [{
    sessionId: worker.id,
    provider: 'didi-global',
    model: 'glm-5.2',
    reasoningEffort: 'low',
    appliedBy: 'agent',
  }])
  assert.equal(worker.model.provider, 'didi-global')
  assert.equal(worker.model.model, 'glm-5.2')
  assert.equal(worker.model.reasoningEffort, 'low')
  assert.equal(worker.model.source, 'explicit')
})

test('the dispatch tool wires the snake_case reasoning effort and keeps the pair honest', async () => {
  const { host, orchestrator, superConversation, superAgent } = await bootstrapped()
  host.enableModels()
  superAgent.useRoute('didi-global', 'deepseek-v4-flash')
  const tool = superAgent.tools.get('superagent_dispatch_task')

  const worker = await tool.execute({
    title: 'Audit',
    prompt: 'Audit it.',
    new_workspace: { title: 'Model route' },
    provider: 'didi-global',
    model: 'deepseek-v4-pro',
    reasoning_effort: 'medium',
  }, { agent: superAgent, signal: new AbortController().signal })
  assert.equal(worker.model.model, 'deepseek-v4-pro')
  assert.equal(host.modelSelections.at(-1).reasoningEffort, 'medium')

  await assert.rejects(
    tool.execute({ title: 'Half', prompt: 'Half route.', provider: 'didi-global' },
      { agent: superAgent, signal: new AbortController().signal }),
    /must be supplied together/,
  )
  await assert.rejects(
    tool.execute({ title: 'Mismatch', prompt: 'Mismatch.', provider: 'deepseek-account', model: 'didi-global/glm-5.2' },
      { agent: superAgent, signal: new AbortController().signal }),
    /pass one or the other/,
  )
  await assert.rejects(
    tool.execute({ title: 'Effort', prompt: 'Effort only.', reasoning_effort: 'high' },
      { agent: superAgent, signal: new AbortController().signal }),
    /requires both `provider` and `model`/,
  )
  assert.equal(orchestrator.listWorkers({}).workers.length, 1, 'rejected calls never create a worker')
})

test('a Host-rejected explicit route fails the dispatch before any worker Session exists', async () => {
  const { host, orchestrator, superConversation, superAgent } = await bootstrapped()
  host.enableModels()
  host.llmErrors.set('didi-global/claude-opus-5-5', 'model "claude-opus-5-5" is not registered on provider "didi-global"')
  superAgent.useRoute('didi-global', 'deepseek-v4-flash')
  const sessionsBefore = host.createdSessions.length

  await assert.rejects(
    dispatch(orchestrator, superConversation, { provider: 'didi-global', model: 'claude-opus-5-5' }),
    /Cannot dispatch a worker with model "didi-global\/claude-opus-5-5": model "claude-opus-5-5" is not registered/,
  )
  assert.equal(host.createdSessions.length, sessionsBefore, 'no Session is created for a rejected route')
  assert.equal(host.modelSelections.length, 0, 'no model is applied for a rejected route')
  assert.equal(orchestrator.listWorkers({}).workers.length, 0)
})

test('a conversation with no route yet still dispatches on the Harness default', async () => {
  const { host, orchestrator, superConversation } = await bootstrapped()

  const worker = await dispatch(orchestrator, superConversation)

  assert.equal(worker.model, undefined, 'no route is invented when the Host cannot name one')
  assert.equal(host.modelSelections.length, 0)
  assert.equal(orchestrator.store.conversation(worker.id).status, 'running')
})

test('without an Agent model controller the fallback selects the model and restores the Host default', async () => {
  const { host, orchestrator, superConversation, superAgent } = await bootstrapped()
  host.enableModels()
  host.agentModelController = false
  superAgent.useRoute('didi-global', 'deepseek-v4-flash', 'high')
  const before = { ...host.defaultSelection }

  const worker = await dispatch(orchestrator, superConversation)

  assert.deepEqual(host.modelSelections, [{
    sessionId: worker.id,
    provider: 'didi-global',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'high',
    appliedBy: 'sessionController',
  }])
  assert.deepEqual(host.savedSelections, [before], 'the Host default is saved back after the worker selection')
  assert.deepEqual(host.defaultSelection, before)
  assert.equal(worker.model.applied, true)
})

test('an explicit route fails clearly when the Harness cannot select a model at all', async () => {
  const { host, orchestrator, superConversation, superAgent } = await bootstrapped()
  host.enableModels()
  host.agentModelController = false
  superAgent.useRoute('didi-global', 'deepseek-v4-flash')
  delete host.sessionController.selectModel

  await assert.rejects(
    dispatch(orchestrator, superConversation, { provider: 'didi-global', model: 'glm-5.2' }),
    /neither the Agent model controller nor sessionController.selectModel is available/,
  )

  // Inheritance degrades to the Host default with a warning instead of failing,
  // and the record keeps the planned route with `applied: false` so the panel
  // never claims a model the worker is not actually running on.
  const worker = await dispatch(orchestrator, superConversation, { title: 'Inherit only' })
  assert.deepEqual(worker.model, {
    provider: 'didi-global',
    model: 'deepseek-v4-flash',
    source: 'inherited',
    applied: false,
  })
  assert.equal(host.logs.some(([level, message]) => level === 'warn' && /no worker model controller/.test(message)), true)
})

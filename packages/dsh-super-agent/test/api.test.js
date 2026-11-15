import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, test } from 'node:test'
import { createApi, isAuthorized } from '../lib/api.js'
import { Orchestrator } from '../lib/orchestrator.js'
import { StateStore } from '../lib/state.js'
import { FakeHost } from './fakes.js'

const dirs = []
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop(), { recursive: true, force: true })
})

const ORIGIN = 'http://127.0.0.1:63100'
const headers = { host: '127.0.0.1:63100', 'x-superagent-request': '1' }

async function setup() {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-super-agent-api-'))
  dirs.push(stateDir)
  const host = new FakeHost()
  const store = new StateStore(join(stateDir, 'state.json'))
  const orchestrator = new Orchestrator({ ctx: host, store, stateDir })
  await orchestrator.load()
  const api = createApi({ orchestrator, origin: ORIGIN })
  return { stateDir, host, orchestrator, api }
}

test('same-origin checks require the authority, the marker, and a matching Origin', () => {
  assert.equal(isAuthorized(headers, ORIGIN), true)
  assert.equal(isAuthorized({ ...headers, host: 'localhost:63100' }, ORIGIN), true)
  assert.equal(isAuthorized({ host: '127.0.0.1:63100' }, ORIGIN), false)
  assert.equal(isAuthorized({ ...headers, host: 'example.com:63100' }, ORIGIN), false)
  assert.equal(isAuthorized({ ...headers, origin: 'http://evil.example' }, ORIGIN), false)
  assert.equal(isAuthorized({ ...headers, origin: ORIGIN }, ORIGIN), true)
})

test('an unauthorized request is refused before any orchestration', async () => {
  const { api } = await setup()
  const response = await api.request({ method: 'GET', pathname: '/superagent/api/state', headers: {} })
  assert.equal(response.status, 403)
})

test('bootstrap creates the first conversation and state exposes it', async () => {
  const { api } = await setup()
  const empty = await api.request({ method: 'GET', pathname: '/superagent/api/state', headers })
  assert.equal(empty.status, 200)
  assert.equal(empty.body.conversations.length, 0)

  const boot = await api.request({ method: 'POST', pathname: '/superagent/api/bootstrap', headers })
  assert.equal(boot.status, 200)
  assert.equal(boot.body.conversations.length, 1)
  assert.equal(boot.body.conversations[0].kind, 'super')
  assert.equal(boot.body.activeConversationId, boot.body.conversations[0].id)

  const again = await api.request({ method: 'POST', pathname: '/superagent/api/bootstrap', headers })
  assert.equal(again.body.conversations.length, 1)
})

test('conversations and workspaces can be created through the API', async () => {
  const { api, stateDir } = await setup()
  await api.request({ method: 'POST', pathname: '/superagent/api/bootstrap', headers })
  const conversation = await api.request({
    method: 'POST',
    pathname: '/superagent/api/conversations',
    headers,
    body: { title: 'Second thread', path: join(stateDir, 'second') },
  })
  assert.equal(conversation.status, 200)
  assert.equal(conversation.body.conversation.title, 'Second thread')
  assert.equal(conversation.body.conversation.workspacePath, join(stateDir, 'second'))

  const workspace = await api.request({
    method: 'POST',
    pathname: '/superagent/api/workspaces',
    headers,
    body: { title: 'Prepared', path: join(stateDir, 'prepared') },
  })
  assert.equal(workspace.status, 200)
  assert.equal(workspace.body.workspace.title, 'Prepared')
})

test('worker output, message, and stop routes reach the orchestrator', async () => {
  const { api, orchestrator } = await setup()
  const boot = await api.request({ method: 'POST', pathname: '/superagent/api/bootstrap', headers })
  const superId = boot.body.activeConversationId
  const worker = await orchestrator.dispatchTask({
    parentId: superId,
    title: 'API worker',
    prompt: 'Do the API thing.',
  })

  const output = await api.request({ method: 'GET', pathname: `/superagent/api/workers/${worker.id}/output`, query: { limit: '2' }, headers })
  assert.equal(output.status, 200)
  assert.equal(output.body.worker.id, worker.id)

  const message = await api.request({
    method: 'POST',
    pathname: `/superagent/api/workers/${worker.id}/message`,
    headers,
    body: { message: 'Add a test.' },
  })
  assert.equal(message.status, 200)
  assert.equal(message.body.worker.status, 'running')

  const stop = await api.request({
    method: 'POST',
    pathname: `/superagent/api/workers/${worker.id}/stop`,
    headers,
    body: { reason: 'Done' },
  })
  assert.equal(stop.status, 200)
  assert.equal(stop.body.worker.status, 'stopped')
})

test('unknown routes and unknown workers return structured errors', async () => {
  const { api } = await setup()
  const missing = await api.request({ method: 'GET', pathname: '/superagent/api/nope', headers })
  assert.equal(missing.status, 404)
  const worker = await api.request({ method: 'GET', pathname: '/superagent/api/workers/missing/output', headers })
  assert.equal(worker.status, 404)
  assert.match(worker.body.error, /Unknown worker/)
})

test('pending decisions can be created, listed, and resolved through the API', async () => {
  const { api, host } = await setup()
  const boot = await api.request({ method: 'POST', pathname: '/superagent/api/bootstrap', headers })
  const superId = boot.body.activeConversationId

  const created = await api.request({
    method: 'POST',
    pathname: '/superagent/api/pending',
    headers,
    body: { question: 'Which release channel?', context: 'The worker prepared both.', options: ['stable', 'beta'] },
  })
  assert.equal(created.status, 200)
  const item = created.body.item
  assert.match(item.id, /^pending-/)
  assert.equal(item.conversation_id, superId)
  assert.deepEqual(item.options, ['stable', 'beta'])
  assert.equal(item.resolved_at, null)

  const listed = await api.request({ method: 'GET', pathname: '/superagent/api/pending', headers })
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.body.pending.map((entry) => entry.id), [item.id])

  const state = await api.request({ method: 'GET', pathname: '/superagent/api/state', headers })
  assert.deepEqual(state.body.pending.map((entry) => entry.id), [item.id])
  assert.equal(state.body.conversations[0].lastMessage, 'Pending decision: Which release channel?')

  const resolved = await api.request({
    method: 'POST',
    pathname: `/superagent/api/pending/${item.id}/resolve`,
    headers,
    body: { answer: 'beta' },
  })
  assert.equal(resolved.status, 200)
  assert.equal(resolved.body.delivered, true)
  assert.equal(resolved.body.conversationId, superId)
  assert.equal(resolved.body.item.answer, 'beta')
  assert.equal(typeof resolved.body.item.resolved_at, 'number')

  // The answer arrives in the Super Agent conversation as the human's own
  // message, not a plugin-sourced compact notice row.
  const inbox = host.get(superId).inbox
  const delivered = inbox.at(-1)
  assert.equal(delivered.role, 'user')
  assert.deepEqual(delivered.source, { kind: 'user' })
  assert.match(delivered.content[0].text, /Which release channel\?/)
  assert.match(delivered.content[0].text, /The user answered: beta/)

  // Answered items disappear from the default list but stay durable and a
  // retry is idempotent (no duplicate conversation message).
  const after = await api.request({ method: 'GET', pathname: '/superagent/api/pending', headers })
  assert.deepEqual(after.body.pending, [])
  const history = await api.request({ method: 'GET', pathname: '/superagent/api/pending', query: { includeResolved: '1' }, headers })
  assert.equal(history.body.pending.length, 1)
  assert.equal(history.body.pending[0].answer, 'beta')
  const beforeRetry = inbox.length
  const retry = await api.request({
    method: 'POST',
    pathname: `/superagent/api/pending/${item.id}/resolve`,
    headers,
    body: { answer: 'stable' },
  })
  assert.equal(retry.status, 200)
  assert.equal(retry.body.delivered, false)
  assert.equal(retry.body.item.answer, 'beta')
  assert.equal(inbox.length, beforeRetry)
})

test('pending decisions validate input and expose structured errors', async () => {
  const { api } = await setup()
  await api.request({ method: 'POST', pathname: '/superagent/api/bootstrap', headers })

  const blank = await api.request({
    method: 'POST',
    pathname: '/superagent/api/pending',
    headers,
    body: { question: '   ' },
  })
  assert.equal(blank.status, 400)
  assert.match(blank.body.error, /question is required/)

  const missing = await api.request({
    method: 'POST',
    pathname: '/superagent/api/pending/pending-missing/resolve',
    headers,
    body: { answer: 'x' },
  })
  assert.equal(missing.status, 404)
  assert.match(missing.body.error, /Unknown pending decision/)

  const unauthorized = await api.request({ method: 'GET', pathname: '/superagent/api/pending', headers: {} })
  assert.equal(unauthorized.status, 403)
})

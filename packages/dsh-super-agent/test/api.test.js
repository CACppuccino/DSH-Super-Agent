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

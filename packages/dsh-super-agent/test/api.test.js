import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, test } from 'node:test'
import { createApi, isAuthorized } from '../lib/api.js'
import { createBilling } from '../lib/billing.js'
import { Orchestrator } from '../lib/orchestrator.js'
import { StateStore } from '../lib/state.js'
import { FakeHost } from './fakes.js'

const dirs = []
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop(), { recursive: true, force: true })
})

const ORIGIN = 'http://127.0.0.1:63100'
const headers = { host: '127.0.0.1:63100', 'x-superagent-request': '1' }

async function setup(options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-super-agent-api-'))
  dirs.push(stateDir)
  const host = new FakeHost()
  const store = new StateStore(join(stateDir, 'state.json'))
  const orchestrator = new Orchestrator({ ctx: host, store, stateDir })
  await orchestrator.load()
  const api = createApi({ orchestrator, origin: ORIGIN, billing: options.billing })
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

test('the usage route is same-origin only and forwards locale and timezone', async () => {
  const calls = []
  const billing = {
    async summary(client) {
      calls.push(client)
      return {
        balance: { status: 'ready', wallets: [{ currency: 'CNY', balance: '12.34' }], bonusWallets: [], fetchedAt: 1 },
        usage: { status: 'ready', windowHours: 24, since: 0, keys: [], totalTokens: 0, requests: 0, generatedAt: 2 },
        generatedAt: 2,
      }
    },
  }
  const { api } = await setup({ billing })

  const refused = await api.request({ method: 'GET', pathname: '/superagent/api/usage', headers: {} })
  assert.equal(refused.status, 403)

  const response = await api.request({
    method: 'GET',
    pathname: '/superagent/api/usage',
    query: { locale: 'zh-CN', tz: '28800' },
    headers,
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.balance.wallets[0].currency, 'CNY')
  assert.deepEqual(calls, [{ locale: 'zh-CN', timezoneOffsetSeconds: 28_800 }])

  const clamped = await api.request({
    method: 'GET',
    pathname: '/superagent/api/usage',
    query: { locale: 'not a locale!', tz: '999999' },
    headers,
  })
  assert.equal(clamped.status, 200)
  assert.deepEqual(calls[1], { locale: 'en', timezoneOffsetSeconds: 0 })
})

test('the usage route degrades to unavailable when no billing service is mounted', async () => {
  const { api } = await setup()
  const response = await api.request({ method: 'GET', pathname: '/superagent/api/usage', headers })
  assert.equal(response.status, 200)
  assert.equal(response.body.balance.status, 'unavailable')
  assert.equal(response.body.usage.status, 'unavailable')
  assert.equal(response.body.platform.status, 'unavailable')
  assert.deepEqual(response.body.usage.keys, [])
})



test('the serialized usage response never contains key secrets', async () => {
  const billing = createBilling({
    ctx: {
      get(name) {
        if (name !== 'credentials') return undefined
        return {
          async readRecord() {
            return { kind: 'grant', payload: { token: 'grant-secret', issuer: 'https://platform.deepseek.com' } }
          },
        }
      },
    },
    now: () => Date.parse('2026-11-14T06:00:00Z'),
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          code: 0,
          data: {
            biz_code: 0,
            biz_data: {
              data: [{
                currency: 'CNY',
                series: [{
                  api_key: {
                    tracking_id: 'tracking-secret-value',
                    name: 'DeepSeek Harness',
                    key_type: 'DSH',
                    sensitive_id: 'sk-super-secret',
                  },
                  model: 'deepseek-flash',
                  buckets: [{ time: Date.parse('2026-11-14T06:00:00Z') / 1000, cost: '1.25' }],
                }],
              }],
            },
          },
        }
      },
    }),
  })
  const { api } = await setup({ billing })
  const response = await api.request({
    method: 'GET',
    pathname: '/superagent/api/usage',
    query: { locale: 'zh-CN', tz: '28800' },
    headers,
  })
  assert.equal(response.status, 200)
  const text = JSON.stringify(response.body)
  for (const forbidden of ['sensitive_id', 'sk-super-secret', 'tracking-secret-value', 'grant-secret', 'tracking_id']) {
    assert.equal(text.includes(forbidden), false, forbidden)
  }
  assert.match(text, /DeepSeek Harness/)
  assert.match(text, /1\.25/)
})


test('worker tag routes persist set/add/remove and expose the many-to-many index', async () => {
  const { api, orchestrator } = await setup()
  const boot = await api.request({ method: 'POST', pathname: '/superagent/api/bootstrap', headers })
  const superId = boot.body.activeConversationId
  const first = await orchestrator.dispatchTask({ parentId: superId, title: 'Quant worker', prompt: 'Do quant work.' })
  const second = await orchestrator.dispatchTask({ parentId: superId, title: 'Infra worker', prompt: 'Do infra work.' })

  const set = await api.request({
    method: 'POST',
    pathname: `/superagent/api/workers/${first.id}/tags`,
    headers,
    body: { tags: [' quant ', 'DSH', 'quant'] },
  })
  assert.equal(set.status, 200)
  assert.deepEqual(set.body.worker.tags, ['quant', 'DSH'])

  const added = await api.request({
    method: 'POST',
    pathname: `/superagent/api/workers/${first.id}/tags`,
    headers,
    body: { action: 'add', tags: ['infra'] },
  })
  assert.deepEqual(added.body.worker.tags, ['quant', 'DSH', 'infra'])
  await api.request({
    method: 'POST',
    pathname: `/superagent/api/workers/${second.id}/tags`,
    headers,
    body: { tags: ['quant', 'infra'] },
  })

  const one = await api.request({ method: 'GET', pathname: `/superagent/api/workers/${first.id}/tags`, headers })
  assert.equal(one.status, 200)
  assert.deepEqual(one.body.tags, ['quant', 'DSH', 'infra'])

  const index = await api.request({ method: 'GET', pathname: '/superagent/api/tags', headers })
  assert.equal(index.status, 200)
  const quant = index.body.tags.find((entry) => entry.tag === 'quant')
  assert.deepEqual(quant.workerIds.sort(), [first.id, second.id].sort())
  assert.equal(quant.count, 2)

  const state = await api.request({ method: 'GET', pathname: '/superagent/api/state', headers })
  assert.deepEqual(state.body.conversations.find((worker) => worker.id === second.id).tags, ['quant', 'infra'])

  const removed = await api.request({
    method: 'POST',
    pathname: `/superagent/api/workers/${second.id}/tags`,
    headers,
    body: { action: 'remove', tags: ['quant'] },
  })
  assert.deepEqual(removed.body.worker.tags, ['infra'])

  const missing = await api.request({
    method: 'POST',
    pathname: '/superagent/api/workers/missing/tags',
    headers,
    body: { tags: ['x'] },
  })
  assert.equal(missing.status, 404)
  assert.match(missing.body.error, /Unknown worker/)

  const unauthorized = await api.request({ method: 'GET', pathname: '/superagent/api/tags', headers: {} })
  assert.equal(unauthorized.status, 403)
})

test('the polled state payload carries status and running for every worker state', async () => {
  const { api, orchestrator, host } = await setup()
  const boot = await api.request({ method: 'POST', pathname: '/superagent/api/bootstrap', headers })
  const superId = boot.body.activeConversationId
  const workers = []
  for (const title of ['Dispatching worker', 'Running worker', 'Waiting worker']) {
    workers.push(await orchestrator.dispatchTask({ parentId: superId, title, prompt: `Do ${title}.` }))
  }
  await orchestrator.store.update((state) => {
    state.conversations[workers[0].id].status = 'dispatching'
    state.conversations[workers[1].id].status = 'running'
    state.conversations[workers[2].id].status = 'waiting'
  })
  // The live Agent status is layered over durable status; this is the same
  // source the panel polls every 2.5 seconds.
  host.get(workers[1].id).status = 'running'

  const response = await api.request({ method: 'GET', pathname: '/superagent/api/state', headers })
  assert.equal(response.status, 200)
  const byId = new Map(response.body.conversations.filter((item) => item.kind === 'worker').map((item) => [item.id, item]))
  for (const worker of workers) {
    const view = byId.get(worker.id)
    assert.equal(typeof view.status, 'string', `${worker.title} has a polled status`)
    assert.equal(typeof view.running, 'boolean', `${worker.title} has the live running flag`)
  }
  assert.deepEqual(
    Array.from(workers, (worker) => byId.get(worker.id).status),
    ['dispatching', 'running', 'waiting'],
  )
  const running = workers.filter((worker) => {
    const view = byId.get(worker.id)
    return view.running === true || view.status === 'running' || view.status === 'dispatching'
  })
  assert.equal(running.length, 2, 'dispatching and running count as in progress; waiting does not')
})

test('workspace and theme routes expose inventory, assignment, and suggestion', async () => {
  const { api, orchestrator } = await setup()
  const boot = await api.request({ method: 'POST', pathname: '/superagent/api/bootstrap', headers })
  assert.equal(boot.status, 200)
  const workspace = await orchestrator.createWorkspace({ title: 'Memory Hub' })

  const assigned = await api.request({
    method: 'POST',
    pathname: '/superagent/api/themes',
    headers,
    body: {
      theme: 'memory',
      workspaceId: workspace.id,
      title: 'Memory systems',
      description: 'Cloudflare memory sync, project memories, summaries, and notes.',
    },
  })
  assert.equal(assigned.status, 200)
  assert.equal(assigned.body.theme.id, 'memory')
  assert.equal(assigned.body.theme.workspaceId, workspace.id)

  const themes = await api.request({ method: 'GET', pathname: '/superagent/api/themes', headers })
  assert.equal(themes.status, 200)
  assert.equal(themes.body.themes.length >= 7, true, 'known taxonomy entries are persisted even before assignment')
  const memoryTheme = themes.body.themes.find((theme) => theme.id === 'memory')
  assert.equal(memoryTheme.workspace.path, workspace.path)

  const inventory = await api.request({ method: 'GET', pathname: '/superagent/api/workspaces', headers })
  assert.equal(inventory.status, 200)
  const row = inventory.body.workspaces.find((item) => item.id === workspace.id)
  assert.equal(row.title, 'Memory Hub')
  assert.equal(row.workerCount, 0)
  assert.equal(row.empty, true)
  assert.equal(row.theme, 'memory')
  assert.equal(inventory.body.groups.find((group) => group.theme.id === 'memory').canonicalId, workspace.id)

  const suggestion = await api.request({
    method: 'GET',
    pathname: '/superagent/api/workspaces/suggest',
    query: { description: 'Deploy the Cloudflare memory sync backend' },
    headers,
  })
  assert.equal(suggestion.status, 200)
  assert.equal(suggestion.body.theme.id, 'memory')
  assert.equal(suggestion.body.workspace.id, workspace.id)

  const state = await api.request({ method: 'GET', pathname: '/superagent/api/state', headers })
  assert.equal(state.body.themes.some((theme) => theme.id === 'memory'), true)

  const missing = await api.request({
    method: 'POST',
    pathname: '/superagent/api/themes',
    headers,
    body: { theme: 'x', workspaceId: 'missing' },
  })
  assert.equal(missing.status, 404)
  assert.match(missing.body.error, /Workspace not found/)

  const unauthorized = await api.request({ method: 'GET', pathname: '/superagent/api/workspaces', headers: {} })
  assert.equal(unauthorized.status, 403)
})

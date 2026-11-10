import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, readOrCreateTokenFile, resolveConfig, resolveTokens } from '../lib/index.js'
import { createCompat, historyPage, sseEnvelope, workspaceView } from '../lib/compat.js'

const TOKEN = 'test-token-0123456789abcdef'

/** A tiny Cordis-like context with the Host services this plugin drives. */
function fakeContext() {
  const listeners = new Map()
  const cleanups = []
  const prompts = []
  const archived = new Set(['archived-1'])
  const workspaces = [{
    id: 'w1',
    path: '/work',
    title: 'Work',
    sessionIds: ['s1'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }]
  const ctx = {
    promptCalls: prompts,
    emit(name, ...args) {
      for (const listener of listeners.get(name) ?? []) listener(...args)
    },
    on(name, listener) {
      const set = listeners.get(name) ?? new Set()
      set.add(listener)
      listeners.set(name, set)
      return () => set.delete(listener)
    },
    effect(callback) {
      const cleanup = callback()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return () => {}
    },
    dispose() {
      for (const cleanup of cleanups.splice(0)) cleanup()
    },
    logger: {
      info(message) { ctx.loggerLine = String(message) },
      warn() {},
    },
    sessionController: {
      async list() {
        return { items: [{ sessionId: 's1', updatedAt: 1, running: false, blank: false }] }
      },
      async *follow() {
        yield {
          type: 'snapshot',
          header: {},
          cursor: 5,
          records: [{ type: 'event', event: { type: 'assistant/message', seq: 5, time: 1, data: { message: { content: [{ type: 'text', text: 'hi' }] } } } }],
          hasMore: false,
          projections: { asOfSeq: 5, values: { title: 'Super Agent' } },
        }
      },
      async projections() { return { kind: 'sequenced', asOfSeq: 5, values: { title: 'Super Agent' } } },
      async create(request) { return { sessionId: request.sessionId ?? 's2' } },
      async prompt(request) { prompts.push(request); return { accepted: true } },
      async cancel() { return { accepted: true } },
      async rename() { return { title: 'renamed', seq: 7 } },
      async fork() { return { sessionId: 's3' } },
      async modelCatalog() {
        return {
          default: { provider: 'p', model: 'm' },
          routableProviders: ['p'],
          groups: [],
          failures: [],
        }
      },
      async selectModel(request) { return { selected: { provider: request.provider, model: request.model } } },
      async updateQueue() { return { accepted: true } },
    },
    workspaceRegistry: {
      list: () => workspaces,
      get(id) { return workspaces.find(workspace => workspace.id === id) },
      get archivedSessionIds() { return [...archived] },
      async archiveSession(sessionId) { archived.add(sessionId) },
      async unarchiveSession(sessionId) { archived.delete(sessionId) },
    },
    directoryPickerController: {
      async list(path) { return { path: path ?? '/home', home: '/home', crumbs: [], entries: [], truncated: false } },
      async createDirectory(path, name) { return `${path}/${name}` },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    agents: { get: () => undefined, list: () => [] },
    workingDirectory: { defaultDirectory: '/cwd' },
  }
  return ctx
}

/** A response object that records SSE writes. */
function fakeSseResponse() {
  return {
    chunks: [],
    writeHead() {},
    write(chunk) { this.chunks.push(String(chunk)); return true },
    end() {},
    once() {},
  }
}

test('resolveConfig applies defaults and validates shapes', () => {
  const cfg = resolveConfig({ listen: { port: 0 } })
  assert.equal(cfg.path, '/remote-api')
  assert.equal(cfg.listen.host, '0.0.0.0')
  assert.equal(cfg.listen.port, 0)
  assert.throws(() => resolveConfig({ path: 'remote-api' }), /path/)
})

test('resolveTokens accepts a direct token and a token file', () => {
  const tokens = resolveTokens({ ...resolveConfig(), auth: { token: TOKEN, tokenFile: undefined, tokens: [] } })
  assert.deepEqual(tokens, [TOKEN])
  assert.equal(readOrCreateTokenFile('/tmp/dsh-remote-test-token-does-not-exist').length, 1)
})

test('pure wire helpers preserve the iOS field names', () => {
  const envelope = JSON.parse(sseEnvelope({ type: 'session/event', sessionId: 's1', event: { type: 'x' } }, 'r1'))
  assert.deepEqual(envelope, {
    type: 'server-request',
    rpcId: 'r1',
    method: 'session/event',
    payload: { type: 'session/event', sessionId: 's1', event: { type: 'x' } },
  })
  assert.deepEqual(historyPage({ records: [{ type: 'event', event: { type: 'e' } }], hasMore: false }, { kind: 'sequenced', asOfSeq: 1, values: {} }), {
    events: [{ event: { type: 'e' } }],
    hasMore: false,
    projections: { asOfSeq: 1, values: {} },
  })
  assert.deepEqual(workspaceView({ id: 'w1', path: '/w', title: 'W', sessionIds: ['s'], createdAt: 'a', updatedAt: 'b' }), {
    workspaceId: 'w1', path: '/w', title: 'W', sessionIds: ['s'], createdAt: 'a', updatedAt: 'b',
  })
})

test('compat maps old iOS methods to 0.2.x Host services', async () => {
  const ctx = fakeContext()
  const compat = createCompat(ctx, { version: 'test' })
  const signal = new AbortController().signal
  try {
    assert.deepEqual(await compat.rpc('host.describe', {}, signal), {
      version: 'test', cwd: '/cwd', provider: 'p', model: 'm', attachedSessions: 0,
    })
    assert.deepEqual(await compat.rpc('session.list', {}, signal), {
      items: [{ sessionId: 's1', updatedAt: 1, running: false, blank: false }],
    })
    const history = await compat.rpc('session.history', { sessionId: 's1', maxMessages: 50 }, signal)
    assert.equal(history.events[0].event.type, 'assistant/message')
    assert.deepEqual(history.projections, { asOfSeq: 5, values: { title: 'Super Agent' } })
    const prompt = await compat.rpc('session.prompt', { sessionId: 's1', content: [{ type: 'text', text: 'hello' }] }, signal)
    assert.deepEqual(prompt, { accepted: true })
    assert.equal(ctx.promptCalls[0].sessionId, 's1')
    assert.match(ctx.promptCalls[0].requestId, /^remote-/)
    assert.deepEqual(await compat.rpc('workspace.list', {}, signal), {
      items: [{ workspaceId: 'w1', path: '/work', title: 'Work', sessionIds: ['s1'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
      archivedSessionIds: ['archived-1'],
    })
    assert.deepEqual(await compat.rpc('host.listDirectory', { path: '/home' }, signal), {
      path: '/home', home: '/home', crumbs: [], entries: [], truncated: false,
    })
    assert.deepEqual(await compat.rpc('host.createDirectory', { path: '/home', name: 'x' }), { path: '/home/x' })
    assert.deepEqual(await compat.rpc('session.selectModel', { sessionId: 's1', provider: 'p', model: 'm' }), {
      selected: { provider: 'p', model: 'm' },
    })
    assert.deepEqual(await compat.rpc('session.rename', { sessionId: 's1', title: 'new' }), { title: 'renamed', seq: 7 })
  } finally {
    compat.dispose()
  }
})

test('compat reads durable image attachments additively', async () => {
  const ctx = fakeContext()
  const calls = []
  const ref = { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }
  ctx.sessionController.attachment = async (request) => {
    calls.push(request)
    return { attachment: ref, data: 'AQID' }
  }
  const compat = createCompat(ctx, { version: 'test' })
  try {
    const value = await compat.rpc('session.attachment', {
      sessionId: 's1', attachment: ref,
    }, new AbortController().signal)
    assert.deepEqual(calls, [{ sessionId: 's1', attachment: ref, attachmentId: 'sha256:abc' }])
    assert.equal(value.data, 'AQID')
    assert.equal(value.attachment.mediaType, 'image/png')
  } finally {
    compat.dispose()
  }
})

test('compat exposes additive backwards history pages through page()', async () => {
  const ctx = fakeContext()
  const calls = []
  ctx.sessionController.page = async (request) => {
    calls.push(request)
    return {
      records: [{ type: 'event', event: { type: 'user/message', seq: 2, time: 1, data: {} } }],
      hasMore: true,
    }
  }
  const compat = createCompat(ctx, { version: 'test' })
  const signal = new AbortController().signal
  try {
    const initial = await compat.rpc('session.history', { sessionId: 's1', maxMessages: 50 }, signal)
    // The opening snapshot advertises the cut the client must send back.
    assert.equal(initial.throughSeq, 5)
    const older = await compat.rpc('session.history', {
      sessionId: 's1', maxMessages: 2, beforeSeq: 3, throughSeq: 5,
    }, signal)
    assert.deepEqual(calls, [{
      address: { kind: 'session', sessionId: 's1' },
      throughSeq: 5,
      beforeSeq: 3,
      maxMessages: 2,
    }])
    assert.equal(older.throughSeq, 5)
    assert.equal(older.hasMore, true)
    assert.equal(older.events.length, 1)
    assert.equal(older.events[0].event.seq, 2)
    assert.equal(older.projections, undefined)
  } finally {
    compat.dispose()
  }
})

test('compat falls back to events() for backwards history pages', async () => {
  const ctx = fakeContext()
  const calls = []
  ctx.sessionController.events = async (request) => {
    calls.push(request)
    return {
      records: [{ type: 'event', event: { type: 'assistant/message', seq: 1, time: 1, data: {} } }],
      hasMore: false,
    }
  }
  const compat = createCompat(ctx, { version: 'test' })
  try {
    const older = await compat.rpc('session.history', {
      sessionId: 's1', maxMessages: 5, beforeSeq: 4, throughSeq: 6,
    }, new AbortController().signal)
    assert.deepEqual(calls, [{
      address: { kind: 'session', sessionId: 's1' },
      throughSeq: 6,
      beforeSeq: 4,
      maxMessages: 5,
    }])
    assert.equal(older.throughSeq, 6)
    assert.equal(older.hasMore, false)
    assert.equal(older.events[0].event.seq, 1)
  } finally {
    compat.dispose()
  }
})

test('compat exposes the host account balance read-only', async () => {
  const ctx = fakeContext()
  const calls = []
  let outcome = {
    status: 'ready',
    value: [{ currency: 'CNY', balance: '123.45' }, { currency: 'USD', balance: '6.78' }],
    bonusWallets: [{ currency: 'CNY', balance: '10.00' }],
  }
  ctx.accountController = {
    async getBalance(client) {
      calls.push(client)
      return outcome
    },
  }
  const compat = createCompat(ctx, { version: 'test' })
  const signal = new AbortController().signal
  try {
    const balance = await compat.rpc('host.balance', {
      locale: 'zh-Hans-CN', timezoneOffsetSeconds: 28800,
    }, signal)
    assert.equal(balance.status, 'ready')
    assert.deepEqual(balance.wallets, [
      { currency: 'CNY', balance: '123.45' },
      { currency: 'USD', balance: '6.78' },
    ])
    assert.deepEqual(balance.bonusWallets, [{ currency: 'CNY', balance: '10.00' }])
    assert.deepEqual(calls, [{ version: 'test', locale: 'zh-Hans-CN', timezoneOffsetSeconds: 28800 }])
    assert.equal(typeof balance.fetchedAt, 'number')

    outcome = null
    const signedOut = await compat.rpc('host.balance', {}, signal)
    assert.equal(signedOut.status, 'signed-out')
    assert.deepEqual(signedOut.wallets, [])
    assert.deepEqual(calls.at(-1), { version: 'test', locale: 'en', timezoneOffsetSeconds: 0 })

    outcome = { status: 'failed' }
    const failed = await compat.rpc('host.balance', {}, signal)
    assert.equal(failed.status, 'failed')
  } finally {
    compat.dispose()
  }
})

test('compat translates session and host events into old SSE envelopes', async () => {
  const ctx = fakeContext()
  const compat = createCompat(ctx, { version: 'test' })
  const mux = fakeSseResponse()
  const host = fakeSseResponse()
  const req = { once() {} }
  try {
    compat.openMux(req, mux)
    compat.openHost(req, host)
    ctx.emit('session/event', { id: 's1' }, { type: 'assistant/message', seq: 1, time: 1, data: { message: { content: [] } } })
    ctx.emit('agent/status', { agent: { id: 's1' }, status: 'running' })
    ctx.emit('agent/assistant-stream', { agent: { id: 's1' }, frame: { type: 'chunk', time: 2, chunk: { type: 'text-delta', text: 'hi' } } })
    const muxLines = mux.chunks.join('')
    const hostLines = host.chunks.join('')
    assert.match(muxLines, /"type":"session\/event"/)
    assert.match(muxLines, /"type":"assistant\/chunk"/)
    assert.match(hostLines, /"type":"host\/session-status"/)
    assert.match(hostLines, /"running":true/)
  } finally {
    compat.dispose()
  }
})

test('the HTTP endpoint keeps bearer auth and serves RPC plus SSE', async (t) => {
  const ctx = fakeContext()
  await apply(ctx, {
    listen: { host: '127.0.0.1', port: 0 },
    auth: { token: TOKEN, tokenFile: undefined, tokens: [] },
    health: true,
  })
  t.after(() => ctx.dispose())
  const line = ctx.loggerLine
  // apply logs through ctx.logger; the fake keeps the line below.
  const port = Number(/127\.0\.0\.1:(\d+)/.exec(line)?.[1])
  assert.ok(Number.isInteger(port) && port > 0, 'the server did not report a listening port')
  const base = `http://127.0.0.1:${port}`

  const health = await fetch(`${base}/healthz`)
  assert.equal(health.status, 200)
  assert.equal((await health.json()).service, 'dsh-remote')

  const denied = await fetch(`${base}/remote-api/session.list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session.list', payload: {} }),
  })
  assert.equal(denied.status, 401)

  const listed = await fetch(`${base}/remote-api/session.list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session.list', payload: {} }),
  })
  assert.equal(listed.status, 200)
  const envelope = await listed.json()
  assert.equal(envelope.type, 'server-response')
  assert.equal(envelope.result.value.items[0].sessionId, 's1')

  const controller = new AbortController()
  const sse = await fetch(`${base}/remote-api/events.mux`, {
    headers: { authorization: `Bearer ${TOKEN}` },
    signal: controller.signal,
  })
  assert.equal(sse.status, 200)
  assert.match(sse.headers.get('content-type'), /text\/event-stream/)
  controller.abort()
})


test('directory browsing falls back to the filesystem when the picker is native', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-dir-'))
  try {
    await mkdir(join(dir, 'child'))
    await writeFile(join(dir, 'file.txt'), 'x')
    const ctx = fakeContext()
    ctx.directoryPickerController = {
      async list() { throw new Error('native picker') },
      async createDirectory() { throw new Error('native picker') },
    }
    const compat = createCompat(ctx, { version: 'test' })
    const listing = await compat.rpc('host.listDirectory', { path: dir }, new AbortController().signal)
    assert.equal(listing.path, dir)
    assert.deepEqual(listing.entries.map((entry) => entry.name), ['child'])
    assert.equal(listing.entries[0].hidden, false)
    assert.equal(listing.crumbs.at(-1).path, dir)
    const created = await compat.rpc('host.createDirectory', { path: dir, name: 'new-folder' })
    assert.equal(created.path, join(dir, 'new-folder'))
    compat.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

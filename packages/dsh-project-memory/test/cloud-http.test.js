import test from 'node:test'
import assert from 'node:assert/strict'
import { CloudflareClient } from '../lib/backends/http.js'
import { CloudError } from '../lib/backends/errors.js'

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function tokenProvider(tokens = ['test-token-value']) {
  let index = 0
  return {
    calls: [],
    invalidated: 0,
    async get(options) {
      this.calls.push(options ?? {})
      if (options?.force) return tokens[Math.min(index, tokens.length - 1)]
      return tokens[Math.min(index, tokens.length - 1)]
    },
    next() {
      index = Math.min(tokens.length - 1, index + 1)
    },
    invalidate() {
      this.invalidated += 1
      this.next()
    },
  }
}

function client(overrides = {}) {
  return new CloudflareClient({
    baseUrl: 'https://memory.test',
    tokenProvider: tokenProvider(),
    machineId: 'mac-a',
    fetchImpl: async () => jsonResponse(200, { ok: true }),
    sleepImpl: async () => {},
    maxAttempts: 3,
    timeoutMs: 100,
    ...overrides,
  })
}

test('requests send bearer auth, machine id, and JSON', async () => {
  const seen = []
  const http = client({
    fetchImpl: async (url, init) => {
      seen.push({ url, init })
      return jsonResponse(200, { ok: true })
    },
  })
  const result = await http.request('POST', '/v1/projects', { body: { identity: 'git:github.com/a/b' } })
  assert.deepEqual(result, { ok: true })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, 'https://memory.test/v1/projects')
  assert.equal(seen[0].init.headers.authorization, 'Bearer test-token-value')
  assert.equal(seen[0].init.headers['x-machine-id'], 'mac-a')
  assert.equal(seen[0].init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(seen[0].init.body), { identity: 'git:github.com/a/b' })
})

test('transient 5xx is retried with backoff', async () => {
  let calls = 0
  const sleeps = []
  const http = client({
    sleepImpl: async (ms) => { sleeps.push(ms) },
    fetchImpl: async () => {
      calls += 1
      return calls === 1 ? jsonResponse(503, { error: { code: 'db_busy', message: 'busy' } }) : jsonResponse(200, { ok: true })
    },
  })
  assert.deepEqual(await http.request('GET', '/v1/health'), { ok: true })
  assert.equal(calls, 2)
  assert.equal(sleeps.length, 1)
  assert.ok(sleeps[0] >= 0)
})

test('network errors are retried then surfaced as a retriable CloudError', async () => {
  let calls = 0
  const http = client({
    maxAttempts: 2,
    fetchImpl: async () => {
      calls += 1
      throw new Error('ECONNREFUSED')
    },
  })
  await assert.rejects(() => http.request('GET', '/v1/health'), (error) => {
    assert.ok(error instanceof CloudError)
    assert.equal(error.kind, 'network')
    assert.equal(error.retriable, true)
    return true
  })
  assert.equal(calls, 2)
})

test('timeouts are reported as retriable timeouts', async () => {
  const http = client({
    maxAttempts: 1,
    timeoutMs: 60,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      // Keep a real timer alive so the test runner does not exit before the
      // client's AbortSignal.timeout fires (its timer is unref'd).
      const keepAlive = setTimeout(() => {}, 500)
      init.signal.addEventListener('abort', () => {
        clearTimeout(keepAlive)
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      }, { once: true })
    }),
  })
  await assert.rejects(() => http.request('GET', '/v1/health'), (error) => {
    assert.equal(error.kind, 'timeout')
    assert.equal(error.retriable, true)
    return true
  })
})

test('401 invalidates the token, re-reads the Keychain, and retries once', async () => {
  const provider = tokenProvider(['stale-token', 'fresh-token'])
  const seen = []
  const http = client({
    tokenProvider: provider,
    fetchImpl: async (_url, init) => {
      seen.push(init.headers.authorization)
      if (seen.length === 1) return jsonResponse(401, { error: { code: 'unauthorized', message: 'bad token' } })
      return jsonResponse(200, { ok: true })
    },
  })
  assert.deepEqual(await http.request('GET', '/v1/health'), { ok: true })
  assert.equal(provider.invalidated, 1)
  assert.deepEqual(seen, ['Bearer stale-token', 'Bearer fresh-token'])
})

test('persistent 401 is not retried into a loop and never leaks the token', async () => {
  let calls = 0
  const http = client({
    fetchImpl: async () => {
      calls += 1
      return jsonResponse(401, { error: { code: 'unauthorized', message: 'bad token' } })
    },
  })
  await assert.rejects(() => http.request('GET', '/v1/health'), (error) => {
    assert.equal(error.kind, 'auth')
    assert.equal(error.retriable, false)
    assert.equal(String(error.message).includes('test-token-value'), false)
    return true
  })
  assert.equal(calls, 2, 'one original attempt plus one forced-token retry')
})

test('404/400 are not retried; 429 honours retry-after', async () => {
  let notFoundCalls = 0
  const notFound = client({
    fetchImpl: async () => {
      notFoundCalls += 1
      return jsonResponse(404, { error: { code: 'project_not_found', message: 'missing' } })
    },
  })
  await assert.rejects(() => notFound.request('GET', '/v1/projects/x'), (error) => {
    assert.equal(error.kind, 'not-found')
    assert.equal(error.code, 'project_not_found')
    return true
  })
  assert.equal(notFoundCalls, 1)

  const sleeps = []
  let rateLimitCalls = 0
  const limited = client({
    sleepImpl: async (ms) => { sleeps.push(ms) },
    fetchImpl: async () => {
      rateLimitCalls += 1
      if (rateLimitCalls === 1) {
        return jsonResponse(429, { error: { code: 'rate_limited', message: 'slow down' } }, { 'retry-after': '1' })
      }
      return jsonResponse(200, { ok: true })
    },
  })
  assert.deepEqual(await limited.request('GET', '/v1/health'), { ok: true })
  assert.deepEqual(sleeps, [1_000])
})

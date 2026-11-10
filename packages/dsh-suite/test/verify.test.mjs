/**
 * Tests for the endpoint verification against a local stub server — no DSH
 * process is involved.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { checkHealthz, requestSessionList, verifyRemote } from '../scripts/lib/verify.mjs'

const TOKEN = 'a'.repeat(64)

/**
 * Start one stub remote endpoint.
 * @param {object} [options]
 * @param {boolean} [options.health] whether /healthz answers like dsh-remote
 * @param {string} [options.token] accepted bearer token
 * @param {number} [options.items] session count
 * @param {object} [options.rpcError] result error envelope
 * @param {boolean} [options.missingSessionRoute] answer 404 for session.list
 */
async function startStub({
  health = true, token = TOKEN, items = 2, rpcError, missingSessionRoute = false,
} = {}) {
  const server = createServer((request, response) => {
    if (request.url === '/healthz') {
      const body = health
        ? { ok: true, service: 'dsh-remote', version: '0.1.0', path: '/remote-api', authenticated: false }
        : { ok: true, service: 'something-else' }
      response.writeHead(health ? 200 : 200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
      return
    }
    if (missingSessionRoute) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'not found' }))
      return
    }
    const authorization = request.headers.authorization
    if (authorization !== `Bearer ${token}`) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      assert.equal(request.method, 'POST')
      assert.match(request.url, /^\/remote-api\/session\.list$/)
      assert.deepEqual(JSON.parse(body).payload, {})
      const result = rpcError ?? { ok: true, value: { items: Array.from({ length: items }, (_, index) => ({ id: `s${index}` })) } }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ type: 'server-response', rpcId: 'test', result }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

test('healthz recognizes a dsh-remote endpoint', async () => {
  const stub = await startStub()
  try {
    const result = await checkHealthz({ baseUrl: stub.baseUrl })
    assert.equal(result.ok, true)
    assert.equal(result.body.version, '0.1.0')
  } finally {
    await stub.close()
  }
})

test('an authenticated session.list returns the iOS envelope payload', async () => {
  const stub = await startStub({ items: 3 })
  try {
    const result = await requestSessionList({ baseUrl: stub.baseUrl, pathPrefix: '/remote-api', token: TOKEN })
    assert.equal(result.ok, true)
    assert.equal(result.items.length, 3)
  } finally {
    await stub.close()
  }
})

test('a full verification reports health and sessions in one attempt', async () => {
  const stub = await startStub()
  try {
    const result = await verifyRemote({
      baseUrl: stub.baseUrl, pathPrefix: '/remote-api', token: TOKEN, waitMs: 0,
    })
    assert.equal(result.ok, true)
    assert.equal(result.attempts, 1)
    assert.equal(result.health.version, '0.1.0')
    assert.equal(result.items.length, 2)
  } finally {
    await stub.close()
  }
})

test('a rejected token fails immediately with an actionable hint', async () => {
  const stub = await startStub({ token: 'b'.repeat(64) })
  try {
    const started = Date.now()
    const result = await verifyRemote({
      baseUrl: stub.baseUrl, pathPrefix: '/remote-api', token: TOKEN, waitMs: 5000,
    })
    assert.equal(result.ok, false)
    assert.equal(result.kind, 'unauthorized')
    assert.equal(result.attempts, 1)
    assert.match(result.hint, /Token/)
    assert.ok(Date.now() - started < 2000, 'authentication failures must not retry')
  } finally {
    await stub.close()
  }
})

test('an unrelated service on the port is not accepted as dsh-remote', async () => {
  const stub = await startStub({ health: false })
  try {
    const result = await verifyRemote({
      baseUrl: stub.baseUrl, pathPrefix: '/remote-api', token: TOKEN, waitMs: 0,
    })
    assert.equal(result.ok, false)
    assert.equal(result.kind, 'not-served')
  } finally {
    await stub.close()
  }
})

test('a missing session.list route is reported as not served', async () => {
  const stub = await startStub({ missingSessionRoute: true })
  try {
    const result = await verifyRemote({
      baseUrl: stub.baseUrl, pathPrefix: '/remote-api', token: TOKEN, waitMs: 0,
    })
    assert.equal(result.ok, false)
    assert.equal(result.stage, 'session.list')
    assert.equal(result.kind, 'not-served')
  } finally {
    await stub.close()
  }
})

test('an rpc error envelope fails the verification', async () => {
  const stub = await startStub({ rpcError: { ok: false, error: { code: 'gateway/internal', message: 'boom' } } })
  try {
    const result = await verifyRemote({
      baseUrl: stub.baseUrl, pathPrefix: '/remote-api', token: TOKEN, waitMs: 0,
    })
    assert.equal(result.ok, false)
    assert.equal(result.kind, 'rpc-error')
    assert.match(result.message, /gateway\/internal/)
  } finally {
    await stub.close()
  }
})

test('a refused connection is retried until the deadline', async () => {
  const stub = await startStub()
  const { port } = new URL(stub.baseUrl)
  await stub.close()
  const result = await verifyRemote({
    baseUrl: `http://127.0.0.1:${port}`,
    pathPrefix: '/remote-api',
    token: TOKEN,
    waitMs: 400,
    intervalMs: 50,
  })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'unreachable')
  assert.ok(result.attempts >= 2, `expected retries, saw ${result.attempts}`)
})

test('a transient network failure succeeds on the retry', async () => {
  const stub = await startStub()
  let calls = 0
  const flaky = async (url, init) => {
    calls += 1
    if (calls === 1) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    return fetch(url, init)
  }
  try {
    const result = await verifyRemote({
      baseUrl: stub.baseUrl, pathPrefix: '/remote-api', token: TOKEN, waitMs: 2000, intervalMs: 10, fetchImpl: flaky,
    })
    assert.equal(result.ok, true)
    assert.equal(result.attempts, 2)
  } finally {
    await stub.close()
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProxyFetch, normalizeProxyUrl } from '../lib/backends/proxy.js'
import { CloudflareBackend } from '../lib/backends/cloudflare.js'

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

/** Minimal HTTP CONNECT proxy used only by tests. */
async function startProxy() {
  const connects = []
  const server = http.createServer((_request, response) => {
    response.statusCode = 405
    response.end()
  })
  server.on('connect', (request, clientSocket, head) => {
    connects.push(request.url)
    const [host, port] = String(request.url).split(':')
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
  const port = await listen(server)
  return { url: `http://127.0.0.1:${port}`, connects, close: () => server.close() }
}

async function startTarget(handler) {
  const requests = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, headers: request.headers, body })
      const { status = 200, json } = handler(request, body)
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(json))
    })
  })
  const port = await listen(server)
  return { url: `http://127.0.0.1:${port}`, requests, close: () => server.close() }
}

test('proxy URLs are validated and credentials are supported but never required', () => {
  assert.equal(normalizeProxyUrl('http://127.0.0.1:15236'), 'http://127.0.0.1:15236')
  assert.equal(normalizeProxyUrl('http://127.0.0.1:15236/'), 'http://127.0.0.1:15236')
  assert.equal(normalizeProxyUrl('https://127.0.0.1:15236'), undefined)
  assert.equal(normalizeProxyUrl('socks5://127.0.0.1:1080'), undefined)
  assert.equal(normalizeProxyUrl('http://127.0.0.1:15236/path'), undefined)
  assert.equal(normalizeProxyUrl('not a url'), undefined)
  assert.equal(normalizeProxyUrl(''), undefined)
  assert.throws(() => createProxyFetch('socks5://127.0.0.1:1080'), /invalid proxy URL/)
})

test('proxy fetch tunnels HTTP requests through CONNECT', async (t) => {
  const proxy = await startProxy()
  const target = await startTarget((request) => ({
    json: { ok: true, method: request.method, url: request.url },
  }))
  t.after(() => { target.close(); proxy.close() })
  const fetchImpl = createProxyFetch(proxy.url)
  const response = await fetchImpl(`${target.url}/v1/health?x=1`, {
    method: 'POST',
    headers: { authorization: 'Bearer local', 'content-type': 'application/json' },
    body: '{"hello":"world"}',
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, method: 'POST', url: '/v1/health?x=1' })
  assert.equal(target.requests[0].headers.authorization, 'Bearer local')
  assert.equal(target.requests[0].body, '{"hello":"world"}')
  assert.equal(proxy.connects.length, 1)
  assert.match(proxy.connects[0], /^127\.0\.0\.1:\d+$/)
})

test('proxy fetch rejects with AbortError when the caller aborts', async (t) => {
  const proxy = await startProxy()
  const target = http.createServer((_request, response) => {
    setTimeout(() => response.end('late'), 500)
  })
  const port = await listen(target)
  t.after(() => { target.close(); proxy.close() })
  const fetchImpl = createProxyFetch(proxy.url)
  await assert.rejects(
    () => fetchImpl(`http://127.0.0.1:${port}/slow`, { signal: AbortSignal.timeout(50) }),
    (error) => error.name === 'AbortError',
  )
})

test('CloudflareBackend sends its writes through the configured proxy', async (t) => {
  const proxy = await startProxy()
  const seen = []
  const target = await startTarget((request, body) => {
    seen.push({ url: request.url, headers: request.headers, body })
    if (request.url === '/v1/projects') {
      return {
        json: {
          project: {
            id: 'proxied-1',
            identity: 'title:proxied',
            identitySource: 'title',
            title: 'Proxied',
            noteCount: 0,
            lastSeq: 0,
            summaryVersion: 0,
            summaryUpdatedAt: null,
            summaryChars: 0,
            updatedAt: Date.now(),
            lastNoteAt: null,
            pathHints: [],
          },
          created: true,
        },
      }
    }
    if (String(request.url).endsWith('/notes')) {
      const parsed = JSON.parse(body)
      return {
        json: {
          inserted: parsed.notes.map((note) => note.id),
          existing: [],
          project: { id: 'proxied-1', noteCount: 1, lastSeq: 1, summaryVersion: 0, updatedAt: Date.now(), title: 'Proxied' },
          paging: { nextSinceSeq: 1 },
        },
      }
    }
    return { status: 404, json: { error: { code: 'not_found', message: 'not found' } } }
  })
  t.after(() => { target.close(); proxy.close() })
  const rootDir = await mkdtemp(join(tmpdir(), 'pm-proxy-backend-'))
  const backend = new CloudflareBackend({
    rootDir,
    cloud: {
      url: target.url,
      proxy: proxy.url,
      machineId: 'mac-proxy',
      token: 'proxy-test-token',
      timeoutMs: 1_000,
      maxAttempts: 1,
      autoSync: false,
    },
    autoSync: false,
    logger: { info() {}, warn() {}, error() {} },
  })
  await backend.init()
  const project = await backend.registerProject({ path: join(rootDir, 'project'), title: 'Proxied' })
  const note = await backend.appendNote({
    project,
    title: 'through the proxy',
    body: 'body',
    tags: ['工程'],
    authorRole: 'worker',
    authorId: 'w',
  })
  assert.match(note.note.id, /^note-/)
  assert.equal(backend.syncInfo().pendingWrites, 0)
  assert.ok(seen.length >= 2)
  assert.equal(seen[0].headers.authorization, 'Bearer proxy-test-token')
  assert.equal(seen[0].headers['x-machine-id'], 'mac-proxy')
  assert.ok(proxy.connects.length >= 2)
  await backend.close()
})

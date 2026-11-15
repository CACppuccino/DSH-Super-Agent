/**
 * Optional HTTP-CONNECT proxy transport for networks that block the Worker
 * hostname directly (for example a local Veee/Clash-style proxy that only
 * allows browser traffic). Node 22's fetch does not honour HTTPS_PROXY, so the
 * backend gets a tiny fetch-compatible implementation instead of a dependency.
 */
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'

const DEFAULT_TIMEOUT_MS = 10_000

function abortError(message = 'request aborted') {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function normalizeHeaders(headers) {
  const output = {}
  if (!headers) return output
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue
    output[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return output
}

function connectViaProxy(proxy, host, port, { signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const headers = { host: `${host}:${port}` }
    if (proxy.username) {
      const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
      headers['proxy-authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`
    }
    const request = http.request({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
      agent: false,
    })
    const cleanup = () => {
      signal?.removeEventListener?.('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      request.destroy()
      reject(abortError())
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    request.setTimeout(timeoutMs, () => {
      cleanup()
      request.destroy()
      reject(new Error(`proxy CONNECT to ${host}:${port} timed out after ${timeoutMs} ms`))
    })
    request.on('connect', (response, socket) => {
      cleanup()
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`proxy CONNECT to ${host}:${port} failed with HTTP ${response.statusCode}`))
        return
      }
      socket.setNoDelay?.(true)
      resolve(socket)
    })
    request.on('error', (error) => {
      cleanup()
      reject(error)
    })
    request.end()
  })
}

function requestThroughSocket({ target, options, body, socket, signal, timeoutMs, secure }) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener?.('abort', onAbort)
      fn(value)
    }
    const onAbort = () => {
      request.destroy()
      socket.destroy()
      finish(reject, abortError())
    }
    const agent = secure ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false })
    agent.createConnection = () => socket
    const request = (secure ? https : http).request({
      host: target.hostname,
      port: Number(target.port || (secure ? 443 : 80)),
      path: `${target.pathname}${target.search}`,
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
      agent,
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const headers = {}
        for (const [key, value] of Object.entries(response.headers)) {
          if (['connection', 'transfer-encoding', 'content-length'].includes(key)) continue
          if (value === undefined) continue
          headers[key] = Array.isArray(value) ? value.join(', ') : value
        }
        const status = response.statusCode ?? 502
        const noBody = status === 204 || status === 205 || status === 304 || options.method === 'HEAD'
        finish(resolve, new Response(noBody ? null : Buffer.concat(chunks), { status, headers }))
      })
      response.on('error', (error) => finish(reject, error))
    })
    request.setTimeout(timeoutMs, () => {
      request.destroy()
      socket.destroy()
      finish(reject, Object.assign(new Error(`request to ${target.href} timed out after ${timeoutMs} ms`), { name: 'TimeoutError' }))
    })
    request.on('error', (error) => {
      socket.destroy()
      finish(reject, error)
    })
    signal?.addEventListener?.('abort', onAbort, { once: true })
    request.end(body)
  })
}

/**
 * Validate a proxy URL. Only `http://host[:port]` is supported; credentials in
 * the URL are allowed but discouraged for shared configuration files.
 * @param {string} value
 * @returns {string|undefined}
 */
export function normalizeProxyUrl(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) return undefined
  let url
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:') return undefined
  if (url.pathname !== '/' && url.pathname.length > 1) return undefined
  if (!url.hostname) return undefined
  return text.replace(/\/+$/, '')
}

/**
 * Build a `fetch`-compatible function that tunnels every request through an
 * HTTP CONNECT proxy and upgrades to TLS for https targets.
 * @param {string} proxyUrl
 * @param {{timeoutMs?: number, tlsOptions?: import('node:tls').ConnectionOptions}} [options]
 * @returns {typeof fetch}
 */
export function createProxyFetch(proxyUrl, { timeoutMs = DEFAULT_TIMEOUT_MS, tlsOptions = {} } = {}) {
  const normalized = normalizeProxyUrl(proxyUrl)
  if (!normalized) throw new Error(`invalid proxy URL ${JSON.stringify(proxyUrl)}; expected http://host:port`)
  const proxy = new URL(normalized)
  return async function proxyFetch(input, init = {}) {
    const target = new URL(typeof input === 'string' ? input : input.url ?? String(input))
    const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      throw new Error(`unsupported target protocol ${target.protocol}`)
    }
    if (init.signal?.aborted) throw abortError()
    const socket = await connectViaProxy(proxy, target.hostname, port, { signal: init.signal, timeoutMs })
    let transport = socket
    if (target.protocol === 'https:') {
      transport = tls.connect({ ...tlsOptions, socket, servername: target.hostname, ALPNProtocols: ['http/1.1'] })
      try {
        await waitForTls(transport, init.signal, timeoutMs)
      } catch (error) {
        socket.destroy()
        throw error
      }
    }
    const body = typeof init.body === 'string' ? init.body : init.body === undefined ? undefined : String(init.body)
    const headers = normalizeHeaders(init.headers)
    if (body !== undefined && headers['content-length'] === undefined) {
      headers['content-length'] = String(Buffer.byteLength(body))
    }
    return requestThroughSocket({
      target,
      options: { method: init.method, headers },
      body,
      socket: transport,
      signal: init.signal,
      timeoutMs,
      secure: target.protocol === 'https:',
    })
  }
}

function waitForTls(socket, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeListener('secureConnect', onSecure)
      socket.removeListener('error', onError)
      signal?.removeEventListener?.('abort', onAbort)
      fn(value)
    }
    const onSecure = () => finish(resolve)
    const onError = (error) => finish(reject, error)
    const onAbort = () => {
      socket.destroy()
      finish(reject, abortError())
    }
    const timer = setTimeout(() => {
      socket.destroy()
      finish(reject, new Error(`TLS handshake timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    socket.once('secureConnect', onSecure)
    socket.once('error', onError)
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

export { DEFAULT_TIMEOUT_MS as PROXY_TIMEOUT_MS }

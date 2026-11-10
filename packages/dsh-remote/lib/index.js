/**
 * dsh-remote — authenticated remote control endpoint for DeepSeek Harness.
 *
 * A pure Cordis plugin: no dsh core changes. It mounts a standalone
 * node:http / node:https server and preserves the older iOS four-quadrant
 * contract through a compatibility layer over the current Host Services:
 *
 *   POST  /remote-api/session.list      (any /api/<method> RPC)
 *   POST  /remote-api/respond           (approval / question answers)
 *   GET   /remote-api/events.mux        (SSE downstream event stream)
 *   GET   /remote-api/events.host       (SSE host event stream)
 *   GET   /healthz                      (unauthenticated liveness)
 *
 * Transport choices:
 *   - Tailscale tailnet (recommended): WireGuard already encrypts the
 *     transport, so plain HTTP + bearer token is safe inside the tailnet.
 *   - Public HTTPS: set tls.certFile / tls.keyFile; keep the token secret.
 *
 * The token has FULL control of the host (same capability surface as the Web
 * frontend plus the privileged settings/credentials methods the loopback Web
 * fence pins). Treat it like a root credential.
 *
 * @module dsh-remote
 */

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { CompatError, createCompat } from './compat.js'

const require = createRequire(import.meta.url)
const PACKAGE = require('../package.json')

/** Stable Cordis plugin name used by Loader diagnostics. */
export const name = 'dsh-remote'

/** Host services the compatibility layer drives directly. */
export const inject = {
  sessionController: { required: true },
  workspaceRegistry: { required: true },
  workspaceController: { required: true },
  directoryPickerController: { required: true },
  agentDefaultModel: { required: true },
  agents: { required: true },
  workingDirectory: { required: true },
  // Optional: older/alternative profiles may not mount the desktop account
  // service, and the remote endpoint must still load without it.
  accountController: { required: false },
}

const DEFAULTS = Object.freeze({
  enabled: true,
  path: '/remote-api',
  listen: Object.freeze({ host: '0.0.0.0', port: 3443 }),
  tls: Object.freeze({ certFile: null, keyFile: null }),
  auth: Object.freeze({ token: null, tokenFile: null, tokens: [] }),
  maxBodyBytes: 32 * 1024 * 1024,
  health: true,
})

/** Expand a leading ~ the same way users expect in a config file. */
export function expandHome(path) {
  if (path === '~') return homedir()
  if (typeof path === 'string' && path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

function fail(message) {
  throw new Error(`dsh-remote: ${message}`)
}

function asString(value, field) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') fail(`${field} must be a string`)
  return value
}

function asInteger(value, field, min, max) {
  if (!Number.isInteger(value)) fail(`${field} must be an integer`)
  if (value < min || value > max) fail(`${field} must be between ${min} and ${max}`)
  return value
}

/**
 * Resolve the raw row config over the defaults. Throws on malformed values so
 * the Loader's fail-loud sweep reports a bad deployment instead of serving a
 * half-configured endpoint.
 */
export function resolveConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('config must be an object')
  }
  const cfg = {
    enabled: raw.enabled ?? DEFAULTS.enabled,
    path: raw.path ?? DEFAULTS.path,
    listen: { ...DEFAULTS.listen, ...(raw.listen ?? {}) },
    tls: { ...DEFAULTS.tls, ...(raw.tls ?? {}) },
    auth: {
      token: asString(raw.auth?.token, 'auth.token'),
      tokenFile: asString(raw.auth?.tokenFile, 'auth.tokenFile'),
      tokens: Array.isArray(raw.auth?.tokens) ? [...raw.auth.tokens] : DEFAULTS.auth.tokens,
    },
    maxBodyBytes: raw.maxBodyBytes ?? DEFAULTS.maxBodyBytes,
    health: raw.health ?? DEFAULTS.health,
  }
  if (typeof cfg.enabled !== 'boolean') fail('enabled must be a boolean')
  if (typeof cfg.path !== 'string' || !cfg.path.startsWith('/') || cfg.path.endsWith('/') || /\s/.test(cfg.path)) {
    fail('path must be an absolute path prefix without trailing slash or whitespace')
  }
  if (typeof cfg.listen.host !== 'string' || cfg.listen.host.length === 0) fail('listen.host must be a non-empty string')
  asInteger(cfg.listen.port, 'listen.port', 0, 65535)
  asInteger(cfg.maxBodyBytes, 'maxBodyBytes', 1024, 1024 * 1024 * 1024)
  for (const token of cfg.auth.tokens) {
    if (typeof token !== 'string' || token.length < 16) fail('auth.tokens entries must be strings of at least 16 characters')
  }
  if (cfg.auth.token !== undefined && cfg.auth.token.length < 16) {
    fail('auth.token must be at least 16 characters')
  }
  if (cfg.auth.tokenFile !== undefined && cfg.auth.tokenFile.length === 0) {
    fail('auth.tokenFile must not be empty')
  }
  const hasCert = cfg.tls.certFile !== null && cfg.tls.certFile !== undefined
  const hasKey = cfg.tls.keyFile !== null && cfg.tls.keyFile !== undefined
  if (hasCert !== hasKey) fail('tls.certFile and tls.keyFile must be configured together')
  return cfg
}

/** Compare two strings without leaking length via early exit. */
function tokenEqual(actual, expected) {
  const a = createHash('sha256').update(actual).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/** Default token path, used when the row names no token source. */
export function defaultTokenFile() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'remote', 'token')
}

/** Read or atomically create a 32-byte hex bearer token. */
export function readOrCreateTokenFile(file) {
  const target = resolve(expandHome(file))
  if (existsSync(target)) {
    const text = readFileSync(target, 'utf8')
    const found = text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0)
    if (found.length > 0) return found
    fail(`token file ${target} exists but contains no token lines`)
  }
  mkdirSync(dirname(target), { recursive: true })
  const token = randomBytes(32).toString('hex')
  try {
    writeFileSync(target, `${token}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error?.code === 'EEXIST') return readOrCreateTokenFile(target)
    throw error
  }
  return [token]
}

/** Resolve every configured token source into one deduplicated token list. */
export function resolveTokens(cfg) {
  const out = []
  const add = (value) => {
    if (value === undefined || value === null || value === '') return
    const trimmed = String(value).trim()
    if (trimmed.length < 16) fail('every bearer token must be at least 16 characters')
    if (!out.includes(trimmed)) out.push(trimmed)
  }
  add(cfg.auth.token)
  for (const value of cfg.auth.tokens) add(value)
  if (cfg.auth.tokenFile !== undefined && cfg.auth.tokenFile !== null) {
    for (const value of readOrCreateTokenFile(cfg.auth.tokenFile)) add(value)
  }
  // The default token file is a fallback: when the row names any direct token
  // source, that source alone is authoritative and no extra file appears.
  if (out.length === 0) {
    for (const value of readOrCreateTokenFile(defaultTokenFile())) add(value)
  }
  if (out.length === 0) fail('no bearer token could be resolved')
  return out
}

/** Read the request body with a hard byte bound. */
async function readBody(req, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) {
      const error = new Error(`request body exceeds ${maxBytes} bytes`)
      error.code = 'DSH_REMOTE_TOO_LARGE'
      throw error
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function sendJson(res, status, value, extraHeaders = {}) {
  if (res.headersSent) return
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(body)
}

/** Write one RPC result in the iOS `server-response` envelope. */
function sendRpc(res, rpcId, result) {
  sendJson(res, 200, { type: 'server-response', rpcId, result })
}

/** One authenticated request: SSE, respond, or an old-style dot-named RPC. */
async function handleRequest(req, res, compat, cfg, tokens) {
  let pathname
  try {
    pathname = new URL(req.url ?? '/', 'http://dsh-remote.internal').pathname
  } catch {
    sendJson(res, 400, { error: 'bad request path' })
    return
  }

  const healthPath = cfg.health ? pathname === '/healthz' || pathname === `${cfg.path}/healthz` : false
  if (!healthPath) {
    const header = req.headers.authorization
    const presented = typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : ''
    const authorized = presented.length > 0 && tokens.some(token => tokenEqual(presented, token))
    if (!authorized) {
      sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer realm="dsh-remote"' })
      return
    }
  }

  if (healthPath) {
    sendJson(res, 200, {
      ok: true,
      service: 'dsh-remote',
      version: PACKAGE.version,
      path: cfg.path,
      authenticated: false,
    })
    return
  }

  if (pathname === cfg.path) {
    sendJson(res, 404, { error: 'not found' })
    return
  }
  if (!pathname.startsWith(`${cfg.path}/`)) {
    sendJson(res, 404, { error: 'not found' })
    return
  }
  const rel = pathname.slice(cfg.path.length + 1)

  if (rel === 'events.mux' || rel === 'events.host') {
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' })
      res.end()
      return
    }
    if (rel === 'events.mux') compat.openMux(req, res)
    else compat.openHost(req, res)
    return
  }

  if (rel === 'respond') {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    try {
      const body = await readBody(req, cfg.maxBodyBytes)
      const envelope = body.length === 0 ? {} : JSON.parse(body.toString('utf8'))
      const value = await compat.respond(envelope)
      sendJson(res, 200, value)
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }

  let envelope
  try {
    const body = await readBody(req, cfg.maxBodyBytes)
    envelope = body.length === 0 ? {} : JSON.parse(body.toString('utf8'))
  } catch (error) {
    if (error?.code === 'DSH_REMOTE_TOO_LARGE') {
      sendJson(res, 413, { error: 'payload too large' })
      return
    }
    sendJson(res, 400, { error: 'invalid JSON request body' })
    return
  }

  const rpcId = typeof envelope.rpcId === 'string' && envelope.rpcId.length > 0 ? envelope.rpcId : `rpc-${Date.now()}`
  const method = rel.includes('/') ? rel.replaceAll('/', '.') : rel
  const payload = envelope.payload !== null && typeof envelope.payload === 'object' ? envelope.payload : {}
  const abort = new AbortController()
  res.once('close', () => {
    if (!res.writableEnded) abort.abort()
  })

  try {
    const value = await compat.rpc(method, payload, abort.signal)
    sendRpc(res, rpcId, { ok: true, value })
  } catch (error) {
    const code = error instanceof CompatError ? error.code : 'gateway/internal'
    const message = error instanceof Error ? error.message : String(error)
    const details = error instanceof CompatError ? error.details : {}
    sendRpc(res, rpcId, { ok: false, error: { code, message, details } })
  }
}

/** Wrap node request dispatch so one malformed request never takes down the process. */
function guardedHandle(req, res, compat, cfg, tokens, logger) {
  handleRequest(req, res, compat, cfg, tokens).catch((error) => {
    logger.warn?.(error instanceof Error ? error : new Error(String(error)))
    if (res.headersSent) {
      res.destroy()
      return
    }
    sendJson(res, 500, { error: 'internal error' })
  })
}

/**
 * Mount the remote endpoint.
 * @param ctx - Cordis context carrying connection.
 * @param config - row config (defaults merged by resolveConfig).
 */
export async function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const cfg = resolveConfig(config)
  if (!cfg.enabled) {
    logger.info?.('dsh-remote: disabled by config')
    return
  }
  const tokens = resolveTokens(cfg)

  const compat = createCompat(ctx, { logger, version: PACKAGE.version })

  let server
  if (cfg.tls.certFile !== null && cfg.tls.certFile !== undefined) {
    const cert = readFileSync(resolve(expandHome(cfg.tls.certFile)))
    const key = readFileSync(resolve(expandHome(cfg.tls.keyFile)))
    server = createHttpsServer({ cert, key }, (req, res) => guardedHandle(req, res, compat, cfg, tokens, logger))
  } else {
    server = createHttpServer((req, res) => guardedHandle(req, res, compat, cfg, tokens, logger))
  }

  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    logger.warn?.(`dsh-remote: client error: ${String(error?.message ?? error)}`)
  })

  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off('listening', onListening)
      rejectListen(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(cfg.listen.port, cfg.listen.host)
  })

  ctx.effect(() => () => {
    // Release SSE listeners before closing their sockets.
    compat.dispose()
    server.closeAllConnections?.()
    server.close()
  })

  const address = server.address()
  const scheme = cfg.tls.certFile !== null && cfg.tls.certFile !== undefined ? 'https' : 'http'
  const host = typeof address === 'object' && address !== null ? address.address : cfg.listen.host
  const port = typeof address === 'object' && address !== null ? address.port : cfg.listen.port
  logger.info?.(`dsh-remote: listening on ${scheme}://${host}:${port}${cfg.path} (${tokens.length} token(s), TLS ${scheme === 'https' ? 'on' : 'off — use Tailscale or configure tls.certFile/keyFile'})`)
}

/**
 * dsh-super-agent host half.
 *
 * Wires the Super Agent orchestrator to the live Harness services, registers
 * the model tools scope, and serves the small HTTP API used by the browser
 * panel. The bundle patch inserts this row; the Client half lives in
 * `client.js`.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createApi } from './lib/api.js'
import { Orchestrator } from './lib/orchestrator.js'
import { StateStore, defaultStateDir } from './lib/state.js'

export const name = 'dsh-super-agent'
export const inject = ['agents', 'sessionController', 'workspaceRegistry', 'permissionPresets', 'systemPrompt', 'tools', 'webServer']

/** Read a JSON request body with a hard size cap. */
async function readBody(req, limit = 512 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > limit) throw new Error(`Request exceeds ${limit} bytes`)
    chunks.push(bytes)
  }
  if (size === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Write one JSON response. */
function writeJson(res, status, body) {
  const text = JSON.stringify(body ?? {})
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(text)
}

/** Build the listener origin, tolerating a server that has not bound yet. */
function originOf(ctx) {
  try {
    return ctx.webServer.getOrigin()
  } catch {
    return `http://${ctx.webServer.host}:${ctx.webServer.port}`
  }
}

/**
 * Mount the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export async function apply(ctx) {
  const stateDir = process.env.DSH_SUPERAGENT_STATE_DIR && process.env.DSH_SUPERAGENT_STATE_DIR.length > 0
    ? process.env.DSH_SUPERAGENT_STATE_DIR
    : defaultStateDir()
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const store = new StateStore(join(stateDir, 'state.json'))
  const orchestrator = new Orchestrator({ ctx, store, stateDir })
  await orchestrator.load()

  // Backstop for a denied built-in call that slips past the per-agent deny
  // restrictions: fail it as a normal tool error instead of running host work
  // in the main conversation or waiting for a card this panel never renders.
  ctx.effect(() => ctx.tools.guard((exec) => orchestrator.deniedToolReason(exec)), 'dsh-super-agent: deny built-in tools')

  ctx.effect(() => ctx.on('agent/created', ({ agent }) => {
    orchestrator.onAgentCreated(agent)
  }), 'dsh-super-agent: decorate new agents')

  ctx.effect(() => ctx.on('agent/disposed', ({ agent }) => {
    orchestrator.onAgentDisposed(agent)
  }), 'dsh-super-agent: release disposed agents')

  ctx.effect(() => () => orchestrator.dispose(), 'dsh-super-agent: release tool registrations')

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    Promise.resolve(orchestrator.onSessionEvent(session, event)).catch((error) => {
      ctx.logger.warn('dsh-super-agent: session event handling failed: %s', String(error))
    })
  }), 'dsh-super-agent: follow session events')

  const api = createApi({ orchestrator, origin: originOf(ctx) })
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/superagent',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (!url.pathname.startsWith('/superagent/api/')) {
          writeJson(res, 404, { error: 'Unknown Super Agent route' })
          return
        }
        const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : undefined
        const response = await api.request({
          method: req.method,
          pathname: url.pathname,
          query: Object.fromEntries(url.searchParams),
          headers: req.headers,
          body,
        })
        writeJson(res, response.status, response.body)
      } catch (error) {
        ctx.logger.warn('dsh-super-agent: request failed: %s', String(error))
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dsh-super-agent: HTTP routes')

  ctx.logger.info('dsh-super-agent ready; the Super Agent sidebar entry opens the conversation panel (state: %s)', stateDir)
}

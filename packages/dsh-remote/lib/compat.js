/**
 * dsh-remote compatibility layer for DeepSeek Harness 0.2.x.
 *
 * The iOS client speaks the older four-quadrant wire contract:
 *   - dot-named unary methods such as `session.list`,
 *   - `payload` carrying the method arguments directly,
 *   - SSE `events.mux` / `events.host` carrying `server-request` envelopes.
 *
 * DSH 0.2.1 moved the gateway to slash-named endpoints, peer-scoped fetch
 * handlers, and a WebSocket stream mux. This module keeps the iOS contract
 * stable by calling the host Services directly and translating their events
 * into the old SSE frames.
 *
 * @module dsh-remote/compat
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** A structured failure returned to the iOS client. */
export class CompatError extends Error {
  /**
   * @param {string} code stable wire code
   * @param {string} message human-readable message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'CompatError'
    this.code = code
    this.details = details
  }
}

/** Require one non-empty string argument. */
function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CompatError('gateway/bad-request', `${field} must be a non-empty string`)
  }
  return value
}

/** Require one object argument. */
function objectOf(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** A timestamp in the iOS wire form. */
const now = () => Date.now()

/** Serialize one SSE `server-request` frame. */
export function sseEnvelope(payload, rpcId = `event-${randomUUID()}`) {
  return JSON.stringify({ type: 'server-request', rpcId, method: payload?.type ?? 'event', payload })
}

/** Map one DSH 0.2.x history page to the iOS `HistoryPage` shape. */
export function historyPage(page, projections) {
  const records = Array.isArray(page?.records) ? page.records : []
  return {
    events: records
      .filter((record) => record && record.type === 'event' && record.event)
      .map((record) => ({ event: record.event })),
    hasMore: page?.hasMore === true,
    ...(projections && typeof projections.asOfSeq === 'number' && projections.values
      ? { projections: { asOfSeq: projections.asOfSeq, values: projections.values } }
      : {}),
  }
}

/** Map one DSH 0.2.x Workspace to the iOS `WorkspaceView` shape. */
export function workspaceView(workspace) {
  return {
    workspaceId: workspace.id,
    path: workspace.path,
    title: workspace.title,
    sessionIds: [...(workspace.sessionIds ?? [])],
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  }
}

/** List one directory without the deployment's optional native picker. */
async function listDirectoryFallback(path) {
  const home = homedir()
  const target = resolve(typeof path === 'string' && path.length > 0 ? path : home)
  const info = await stat(target)
  if (!info.isDirectory()) throw new CompatError('directory-picker/not-directory', `"${target}" is not a directory`)
  const entries = []
  for (const dirent of await readdir(target, { withFileTypes: true })) {
    const child = join(target, dirent.name)
    let directory = dirent.isDirectory()
    if (!directory && dirent.isSymbolicLink()) {
      directory = (await stat(child).catch(() => undefined))?.isDirectory() === true
    }
    if (directory) entries.push({ name: dirent.name, path: child, hidden: dirent.name.startsWith('.') })
  }
  entries.sort((left, right) => left.name.localeCompare(right.name))
  const crumbs = []
  let current = target
  for (;;) {
    crumbs.unshift({ name: basename(current) || current, path: current, hidden: false })
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return { path: target, home, crumbs, entries, truncated: false }
}

/** Create one child directory when the native picker cannot serve a remote browse request. */
async function createDirectoryFallback(path, name) {
  const parent = resolve(typeof path === 'string' ? path : homedir())
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new CompatError('gateway/bad-request', 'directory name must be a single path segment')
  }
  const target = join(parent, name)
  try {
    await mkdir(target)
  } catch (error) {
    throw new CompatError('directory-picker/exists', `cannot create "${target}": ${error instanceof Error ? error.message : String(error)}`)
  }
  return { path: target }
}

/**
 * Build the compatibility layer over the current Host services.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ logger?: Console, version?: string }} options
 */
export function createCompat(ctx, { logger = console, version = '0.0.0' } = {}) {
  const muxClients = new Set()
  const hostClients = new Set()
  const disposers = []
  let nextEvent = 0
  let lastWorkspaceSignature = ''
  let lastArchivedSignature = ''
  let keepalive

  /** Write one SSE payload to every interested client; drop broken sockets. */
  function emit(clients, payload) {
    if (clients.size === 0) return
    const frame = `data: ${sseEnvelope(payload, `event-${++nextEvent}`)}\n\n`
    for (const res of clients) {
      try {
        res.write(frame)
      } catch {
        clients.delete(res)
      }
    }
  }

  const emitMux = (payload) => emit(muxClients, payload)
  const emitHost = (payload) => emit(hostClients, payload)

  /** Open one authenticated SSE stream (auth is checked by the caller). */
  function openStream(req, res, clients) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(': connected\n\n')
    clients.add(res)
    const cleanup = () => clients.delete(res)
    req.once('close', cleanup)
    res.once('close', cleanup)
    res.once('error', cleanup)
  }

  /** Open the session event stream. */
  const openMux = (req, res) => openStream(req, res, muxClients)
  /** Open the host event stream. */
  const openHost = (req, res) => openStream(req, res, hostClients)

  // ── Host events → old SSE frames ────────────────────────────────────────
  disposers.push(ctx.on('session/event', (session, event) => {
    if (!session || !event) return
    emitMux({ type: 'session/event', sessionId: session.id, event })
  }))

  disposers.push(ctx.on('agent/assistant-stream', ({ agent, frame } = {}) => {
    if (!agent || !frame || frame.type !== 'chunk') return
    const chunk = frame.chunk
    if (!chunk || (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta')) return
    emitMux({
      type: 'session/event',
      sessionId: agent.id,
      event: {
        type: 'assistant/chunk',
        // Keep transient chunks below the first durable seq so they never
        // advance the client's history-merge cursor.
        seq: -1,
        time: typeof frame.time === 'number' ? frame.time : now(),
        data: { chunk },
      },
    })
  }))

  disposers.push(ctx.on('agent/status', ({ agent, status } = {}) => {
    if (!agent) return
    emitHost({ type: 'host/session-status', sessionId: agent.id, running: status === 'running' })
  }))

  disposers.push(ctx.on('agent/created', ({ agent } = {}) => {
    if (!agent) return
    emitHost({ type: 'host/session-added', sessionId: agent.id })
    emitHost({ type: 'host/workspace-changed' })
  }))

  disposers.push(ctx.on('agent/disposed', ({ agent } = {}) => {
    if (agent) emitHost({ type: 'host/session-removed', sessionId: agent.id })
  }))

  disposers.push(ctx.on('session/disposed', (session) => {
    if (session) emitHost({ type: 'host/session-removed', sessionId: session.id })
  }))

  // Workspace/archive changes do not expose a dedicated Host event in 0.2.x;
  // a small signature poll keeps the native sidebar fresh without streaming
  // the entire workspace registry on every request.
  keepalive = setInterval(() => {
    try {
      const workspaces = ctx.workspaceRegistry.list()
      const signature = JSON.stringify(workspaces.map((workspace) => [
        workspace.id,
        workspace.title,
        workspace.path,
        workspace.sessionIds,
      ]))
      if (signature !== lastWorkspaceSignature) {
        lastWorkspaceSignature = signature
        emitHost({ type: 'host/workspace-changed' })
      }
      const archived = [...(ctx.workspaceRegistry.archivedSessionIds ?? [])]
      const archivedSignature = JSON.stringify(archived)
      if (archivedSignature !== lastArchivedSignature) {
        lastArchivedSignature = archivedSignature
        emitHost({ type: 'host/archived-sessions-changed', archivedSessionIds: archived })
      }
    } catch (error) {
      logger.warn?.(`dsh-remote: workspace/archive observation failed: ${String(error)}`)
    }
  }, 3000)
  keepalive.unref?.()

  /** A lightweight keepalive comment keeps proxies from closing idle SSE. */
  const ping = setInterval(() => {
    for (const clients of [muxClients, hostClients]) {
      for (const res of clients) {
        try { res.write(': ping\n\n') } catch { clients.delete(res) }
      }
    }
  }, 15_000)
  ping.unref?.()

  // ── Unary RPC compatibility ────────────────────────────────────────────
  const handlers = {
    'host.describe': async () => {
      const selection = ctx.agentDefaultModel.currentSelection()
      return {
        version,
        cwd: ctx.workingDirectory.defaultDirectory,
        provider: selection?.provider,
        model: selection?.model,
        attachedSessions: ctx.agents.list().length,
      }
    },

    'host.balance': async (payload) => {
      const account = ctx.accountController
      if (!account) {
        throw new CompatError('gateway/not-found', 'the host does not expose an account service')
      }
      const input = objectOf(payload)
      const locale = typeof input.locale === 'string' && input.locale.length > 0 ? input.locale : 'en'
      const timezoneOffsetSeconds = Number.isFinite(input.timezoneOffsetSeconds)
        ? Math.trunc(input.timezoneOffsetSeconds)
        : 0
      try {
        // Server-side only: the Platform grant never leaves the host. The
        // controller returns recharge and bonus wallets as decimal strings.
        const balance = await account.getBalance({ version, locale, timezoneOffsetSeconds })
        if (balance === null) {
          return { status: 'signed-out', wallets: [], bonusWallets: [], fetchedAt: now() }
        }
        if (balance.status === 'failed') {
          return { status: 'failed', wallets: [], bonusWallets: [], fetchedAt: now() }
        }
        return {
          status: 'ready',
          wallets: balance.value,
          bonusWallets: balance.bonusWallets,
          fetchedAt: now(),
        }
      } catch (error) {
        throw new CompatError(
          'account/balance-failed',
          error instanceof Error ? error.message : String(error),
        )
      }
    },

    'host.listDirectory': async (payload, signal) => {
      const input = objectOf(payload)
      try {
        return await ctx.directoryPickerController.list(
          typeof input.path === 'string' ? input.path : undefined,
          signal,
        )
      } catch (error) {
        // A deployment may compose a native picker that cannot serve a
        // remote browse request; fall back to a direct, read-only listing.
        if (error instanceof CompatError) throw error
        return await listDirectoryFallback(input.path)
      }
    },

    'host.createDirectory': async (payload) => {
      const input = objectOf(payload)
      const path = requiredString(input.path, 'path')
      const name = requiredString(input.name, 'name')
      try {
        const created = await ctx.directoryPickerController.createDirectory(path, name)
        return { path: created }
      } catch (error) {
        if (error instanceof CompatError) throw error
        return await createDirectoryFallback(path, name)
      }
    },

    'session.list': async (_payload, signal) => {
      const value = await ctx.sessionController.list({}, signal)
      return { items: value.items }
    },

    'session.history': async (payload, signal) => {
      const input = objectOf(payload)
      const sessionId = requiredString(input.sessionId, 'sessionId')
      const maxMessages = Number.isFinite(input.maxMessages) ? input.maxMessages : 50
      const beforeSeq = Number.isFinite(input.beforeSeq) ? Math.trunc(input.beforeSeq) : undefined
      const throughSeq = Number.isFinite(input.throughSeq) ? Math.trunc(input.throughSeq) : undefined

      // Additive backward paging: older clients never send `beforeSeq`, so
      // the opening-snapshot path below stays byte-for-byte compatible.
      // `page` is the 0.2.1 name; 0.2.2 renamed the same paginator to
      // `events`. Both accept throughSeq + beforeSeq + maxMessages.
      if (beforeSeq !== undefined) {
        const pager = typeof ctx.sessionController.page === 'function'
          ? ctx.sessionController.page
          : typeof ctx.sessionController.events === 'function'
            ? ctx.sessionController.events
            : undefined
        if (!pager) {
          throw new CompatError('gateway/not-found', 'this host cannot page session history backwards')
        }
        if (throughSeq === undefined) {
          throw new CompatError('gateway/bad-request', 'throughSeq is required together with beforeSeq')
        }
        const page = await pager.call(ctx.sessionController, {
          address: { kind: 'session', sessionId },
          throughSeq,
          beforeSeq,
          maxMessages,
        }, signal)
        return { ...historyPage(page), throughSeq }
      }

      // 0.2.1 exposes history as the opening snapshot of the follow stream;
      // 0.2.2 also has the state + events page pair. Use whichever the Host
      // composed, so the same compatibility layer runs in both profiles.
      if (typeof ctx.sessionController.follow === 'function') {
        const stream = ctx.sessionController.follow({
          address: { kind: 'session', sessionId },
          maxMessages,
        }, signal)
        try {
          for await (const frame of stream) {
            if (frame?.type === 'snapshot') {
              return { ...historyPage(frame, frame.projections), throughSeq: frame.cursor }
            }
            if (frame?.type === 'event') break
          }
        } finally {
          await stream.return?.(undefined).catch(() => {})
        }
        throw new CompatError('gateway/internal', `history snapshot for "${sessionId}" was not produced`)
      }
      const state = await ctx.sessionController.state({ sessionId }, signal)
      const page = await ctx.sessionController.events({
        address: { kind: 'session', sessionId },
        throughSeq: state.cursor,
        maxMessages,
      }, signal)
      let projections
      try {
        projections = await ctx.sessionController.projections({ sessionId }, signal)
      } catch { /* projections are only a title hint */ }
      return { ...historyPage(page, projections), throughSeq: state.cursor }
    },

    'session.create': async (payload) => {
      const input = objectOf(payload)
      const created = await ctx.sessionController.create({
        ...(typeof input.workspaceId === 'string' ? { workspaceId: input.workspaceId } : {}),
        ...(typeof input.cwd === 'string' ? { cwd: input.cwd } : {}),
        ...(typeof input.sessionId === 'string' ? { sessionId: input.sessionId } : {}),
        ...(typeof input.agentPreset === 'string' ? { agentPreset: input.agentPreset } : {}),
      })
      return created
    },

    'session.prompt': async (payload, signal) => {
      const input = objectOf(payload)
      const sessionId = requiredString(input.sessionId, 'sessionId')
      const content = Array.isArray(input.content) ? input.content : []
      if (content.length === 0) throw new CompatError('gateway/bad-request', 'content must not be empty')
      const result = await ctx.sessionController.prompt({
        requestId: typeof input.requestId === 'string' && input.requestId.length > 0 ? input.requestId : `remote-${randomUUID()}`,
        sessionId,
        mode: input.mode === 'steer' ? 'steer' : 'queue',
        content,
        ...(typeof input.clientTimeZone === 'string' ? { clientTimeZone: input.clientTimeZone } : {}),
      }, signal)
      return { accepted: result.accepted === true }
    },

    'session.attachment': async (payload, signal) => {
      const input = objectOf(payload)
      const sessionId = requiredString(input.sessionId, 'sessionId')
      // DSH 0.2.2 takes the complete image ref from the folded session log;
      // 0.2.1 took the bare id. Send both so either host generation reads the
      // field it knows, and old clients are unaffected.
      const reference = input.attachment !== null && typeof input.attachment === 'object'
        ? input.attachment
        : undefined
      const attachmentId = reference?.attachmentId ?? requiredString(input.attachmentId, 'attachmentId')
      const request = reference === undefined
        ? { sessionId, attachmentId }
        : { sessionId, attachment: reference, attachmentId }
      // Read-only durable image bytes for transcript rendering. The host
      // returns the verified ref plus canonical base64; the caller never
      // receives a filesystem path or bearer URL.
      return await ctx.sessionController.attachment(request, signal)
    },

    'session.cancel': async (payload) => {
      const input = objectOf(payload)
      const result = await ctx.sessionController.cancel({ sessionId: requiredString(input.sessionId, 'sessionId') })
      return { accepted: result.accepted === true }
    },

    'session.rename': async (payload) => {
      const input = objectOf(payload)
      const result = await ctx.sessionController.rename({
        sessionId: requiredString(input.sessionId, 'sessionId'),
        title: requiredString(input.title, 'title'),
      })
      return { title: result.title, seq: result.seq }
    },

    'session.fork': async (payload) => {
      const input = objectOf(payload)
      const result = await ctx.sessionController.fork({
        sessionId: requiredString(input.sessionId, 'sessionId'),
        ...(typeof input.atSeq === 'number' ? { atSeq: input.atSeq } : {}),
      })
      return { sessionId: result.sessionId }
    },

    'session.models': async (payload) => {
      const input = objectOf(payload)
      const sessionId = requiredString(input.sessionId, 'sessionId')
      const catalog = await ctx.sessionController.modelCatalog()
      const agent = ctx.agents.get(sessionId)
      const live = agent?.model?.current?.()
      const current = live ?? catalog.default ?? ctx.agentDefaultModel.currentSelection()
      return {
        current,
        routable: catalog.routableProviders.length > 0,
        groups: catalog.groups,
        failures: catalog.failures,
      }
    },

    'session.selectModel': async (payload) => {
      const input = objectOf(payload)
      const result = await ctx.sessionController.selectModel({
        sessionId: requiredString(input.sessionId, 'sessionId'),
        provider: requiredString(input.provider, 'provider'),
        model: requiredString(input.model, 'model'),
        ...(typeof input.reasoningEffort === 'string' ? { reasoningEffort: input.reasoningEffort } : {}),
      })
      return { selected: result.selected }
    },

    'session.updateQueue': async (payload) => {
      const input = objectOf(payload)
      const result = await ctx.sessionController.updateQueue({
        sessionId: requiredString(input.sessionId, 'sessionId'),
        itemId: requiredString(input.itemId, 'itemId'),
        action: input.action,
      })
      return { accepted: result.accepted === true }
    },

    'workspace.list': async () => ({
      items: ctx.workspaceRegistry.list().map(workspaceView),
      archivedSessionIds: [...(ctx.workspaceRegistry.archivedSessionIds ?? [])],
    }),

    'workspace.archiveSession': async (payload) => {
      const input = objectOf(payload)
      await ctx.workspaceRegistry.archiveSession(
        requiredString(input.sessionId, 'sessionId'),
        { stopActivity: true },
      )
      return { archivedSessionIds: [...ctx.workspaceRegistry.archivedSessionIds] }
    },

    'workspace.delete': async (payload) => {
      const input = objectOf(payload)
      await ctx.workspaceController.delete(requiredString(input.workspaceId, 'workspaceId'))
      return { deleted: true }
    },

    'workspace.unarchiveSession': async (payload) => {
      const input = objectOf(payload)
      await ctx.workspaceRegistry.unarchiveSession(requiredString(input.sessionId, 'sessionId'))
      return { archivedSessionIds: [...ctx.workspaceRegistry.archivedSessionIds] }
    },

    'workspace.rename': async (payload) => {
      const input = objectOf(payload)
      const workspace = ctx.workspaceRegistry.get(input.workspaceId)
      if (!workspace) throw new CompatError('workspace/not-found', `workspace "${String(input.workspaceId)}" not found`)
      await workspace.setTitle(requiredString(input.title, 'title'))
      return workspaceView(workspace)
    },
  }

  /**
   * Dispatch one old-style iOS unary method.
   * @param {string} method dot-named method, e.g. `session.list`
   * @param {unknown} payload old direct payload
   * @param {AbortSignal} signal request lifetime
   */
  async function rpc(method, payload, signal) {
    const handler = handlers[method]
    if (!handler) throw new CompatError('gateway/not-found', `unknown remote method "${method}"`)
    return await handler(payload, signal)
  }

  /** Accept and acknowledge an answer to a server request. Our managed
   * sessions deny ask-user and use full access, so no pending request exists;
   * unknown answers are acknowledged rather than breaking the iOS client. */
  async function respond(_envelope) {
    return { accepted: true }
  }

  /** Release listeners, polling, keepalives, and open SSE responses. */
  function dispose() {
    for (const disposeListener of disposers.splice(0)) {
      try { disposeListener() } catch { /* ignore a disposed fiber */ }
    }
    clearInterval(keepalive)
    clearInterval(ping)
    for (const clients of [muxClients, hostClients]) {
      for (const res of clients) {
        try { res.end() } catch { /* socket already gone */ }
      }
      clients.clear()
    }
  }

  return { rpc, respond, openMux, openHost, dispose }
}

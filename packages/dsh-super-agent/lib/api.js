/**
 * HTTP surface for the Super Agent panel.
 *
 * The browser client polls `state`, asks for `bootstrap` on first open, and
 * creates conversations or workspaces. The same request function is used by
 * tests directly, so route behavior does not depend on a live HTTP server.
 */

/** A structured API result. */
const result = (status, body) => ({ status, body })

/** Parse a positive integer query value with a fallback. */
function positiveInt(value, fallback, max) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(max, Math.trunc(number))
}

/** Whether the request comes from this page: same authority, a marker header, and no foreign Origin. */
export function isAuthorized(headers, origin) {
  const host = headers?.host
  if (typeof host !== 'string' || host.length === 0) return false
  if (headers['x-superagent-request'] !== '1') return false
  let expected
  try {
    expected = new URL(origin)
  } catch {
    return false
  }
  const localhost = `localhost:${expected.port}`
  if (host !== expected.host && host !== localhost) return false
  const requestOrigin = headers.origin
  if (requestOrigin === undefined) return true
  return requestOrigin === expected.origin || requestOrigin === `${expected.protocol}//${localhost}`
}

/** Validate a JSON request body object. */
function objectBody(body) {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}
}

/** The payload served when the host has no billing service mounted. */
function unavailableBilling() {
  return {
    balance: { status: 'unavailable', wallets: [], bonusWallets: [], fetchedAt: Date.now() },
    usage: { status: 'unavailable', windowHours: 24, since: Date.now() - 24 * 60 * 60 * 1000, keys: [], totalTokens: 0, requests: 0, generatedAt: Date.now() },
    platform: { status: 'unavailable', keys: [], totals: [], timezoneOffsetSeconds: 0, fetchedAt: Date.now() },
    generatedAt: Date.now(),
  }
}

/** Create the API dispatcher. */
export function createApi({ orchestrator, origin, billing }) {
  /**
   * Resolve one API call.
   * @param {{ method?: string, pathname?: string, query?: Record<string,string>, headers?: Record<string,string|undefined>, body?: unknown }} request
   */
  async function request({ method = 'GET', pathname = '', query = {}, headers = {}, body } = {}) {
    if (!isAuthorized(headers, origin)) return result(403, { error: 'A same-origin Super Agent request is required' })
    const prefix = '/superagent/api/'
    if (!pathname.startsWith(prefix)) return result(404, { error: 'Unknown Super Agent route' })
    const parts = pathname.slice(prefix.length).split('/').filter(Boolean)
    const upper = method.toUpperCase()
    try {
      if (upper === 'POST' && parts.length === 1 && parts[0] === 'bootstrap') {
        return result(200, await orchestrator.bootstrap())
      }
      if (upper === 'GET' && parts.length === 1 && parts[0] === 'state') {
        return result(200, orchestrator.state())
      }
      if (upper === 'GET' && parts.length === 1 && parts[0] === 'pending') {
        const conversationId = typeof query.conversationId === 'string' ? query.conversationId : undefined
        const includeResolved = query.includeResolved === '1' || query.includeResolved === 'true'
        return result(200, {
          pending: orchestrator.listPendingDecisions({ conversationId, includeResolved }),
        })
      }
      if (upper === 'POST' && parts.length === 1 && parts[0] === 'pending') {
        const input = objectBody(body)
        const item = await orchestrator.createPendingDecision({
          conversationId: typeof input.conversationId === 'string' ? input.conversationId : undefined,
          question: input.question,
          context: typeof input.context === 'string' ? input.context : undefined,
          options: Array.isArray(input.options) ? input.options : undefined,
        })
        return result(200, { item })
      }
      if (upper === 'POST' && parts.length === 3 && parts[0] === 'pending' && parts[2] === 'resolve') {
        const input = objectBody(body)
        return result(200, await orchestrator.answerPendingDecision({
          id: decodeURIComponent(parts[1]),
          answer: input.answer,
        }))
      }
      if (upper === 'GET' && parts.length === 1 && parts[0] === 'workspaces') {
        return result(200, await orchestrator.workspaceInventory())
      }
      if (upper === 'GET' && parts.length === 2 && parts[0] === 'workspaces' && parts[1] === 'suggest') {
        return result(200, await orchestrator.suggestTheme({
          description: typeof query.description === 'string' ? query.description : undefined,
          title: typeof query.title === 'string' ? query.title : undefined,
        }))
      }
      if (upper === 'GET' && parts.length === 1 && parts[0] === 'themes') {
        return result(200, { ok: true, themes: orchestrator.listThemes() })
      }
      if (upper === 'POST' && parts.length === 1 && parts[0] === 'themes') {
        const input = objectBody(body)
        const theme = await orchestrator.assignTheme({
          theme: input.theme,
          workspaceId: typeof input.workspaceId === 'string'
            ? input.workspaceId
            : (typeof input.workspace_id === 'string' ? input.workspace_id : undefined),
          title: typeof input.title === 'string' ? input.title : undefined,
          description: typeof input.description === 'string' ? input.description : undefined,
        })
        return result(200, { ok: true, theme })
      }
      if (upper === 'GET' && parts.length === 1 && parts[0] === 'tags') {
        return result(200, orchestrator.listWorkerTags())
      }
      if (upper === 'GET' && parts.length === 1 && parts[0] === 'usage') {
        const locale = typeof query.locale === 'string' && /^[A-Za-z_-]{2,16}$/.test(query.locale) ? query.locale : 'en'
        const offset = Number(query.tz)
        const timezoneOffsetSeconds = Number.isFinite(offset) && Math.abs(offset) <= 86_400 ? Math.trunc(offset) : 0
        if (!billing || typeof billing.summary !== 'function') return result(200, unavailableBilling())
        return result(200, await billing.summary({ locale, timezoneOffsetSeconds }))
      }
      if (upper === 'POST' && parts.length === 1 && parts[0] === 'conversations') {
        const input = objectBody(body)
        const conversation = await orchestrator.createConversation({
          title: typeof input.title === 'string' ? input.title : undefined,
          workspaceId: typeof input.workspaceId === 'string'
            ? input.workspaceId
            : (typeof input.workspace_id === 'string' ? input.workspace_id : undefined),
          path: typeof input.path === 'string' ? input.path : undefined,
          newWorkspace: input.newWorkspace === true,
        })
        return result(200, { conversation })
      }
      if (upper === 'POST' && parts.length === 1 && parts[0] === 'workspaces') {
        const input = objectBody(body)
        const workspace = await orchestrator.createWorkspace({
          title: typeof input.title === 'string' ? input.title : undefined,
          path: typeof input.path === 'string' ? input.path : undefined,
        })
        return result(200, { workspace })
      }
      if (parts.length === 3 && parts[0] === 'workers') {
        const workerId = decodeURIComponent(parts[1])
        const action = parts[2]
        if (upper === 'GET' && action === 'output') {
          return result(200, orchestrator.workerOutput({
            workerId,
            limit: positiveInt(query.limit, 5, 20),
          }))
        }
        if (upper === 'POST' && action === 'message') {
          const input = objectBody(body)
          const worker = await orchestrator.sendWorkerMessage({ workerId, message: input.message })
          return result(200, { worker })
        }
        if (upper === 'POST' && action === 'stop') {
          const input = objectBody(body)
          const worker = await orchestrator.stopWorker({ workerId, reason: typeof input.reason === 'string' ? input.reason : undefined })
          return result(200, { worker })
        }
        if (upper === 'GET' && action === 'tags') {
          return result(200, orchestrator.listWorkerTags({ workerId }))
        }
        if (upper === 'POST' && action === 'tags') {
          const input = objectBody(body)
          return result(200, await orchestrator.setWorkerTags({
            workerId,
            tags: input.tags,
            action: typeof input.action === 'string' ? input.action : 'set',
          }))
        }
      }
      if (upper === 'POST' && parts.length === 3 && parts[0] === 'conversations' && parts[2] === 'stop') {
        const input = objectBody(body)
        const conversation = await orchestrator.stopConversation({
          conversationId: decodeURIComponent(parts[1]),
          reason: typeof input.reason === 'string' ? input.reason : undefined,
        })
        return result(200, { conversation })
      }
      return result(404, { error: 'Unknown Super Agent route' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = /not found|unknown/i.test(message) ? 404 : 400
      return result(status, { error: message })
    }
  }

  return { request }
}

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

/** Create the API dispatcher. */
export function createApi({ orchestrator, origin }) {
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
      if (upper === 'POST' && parts.length === 1 && parts[0] === 'conversations') {
        const input = objectBody(body)
        const conversation = await orchestrator.createConversation({
          title: typeof input.title === 'string' ? input.title : undefined,
          workspaceId: typeof input.workspaceId === 'string' ? input.workspaceId : undefined,
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

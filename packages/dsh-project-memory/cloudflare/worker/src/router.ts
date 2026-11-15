import type { Env, RouteContext } from './types.ts'
import { authorize } from './auth.ts'
import { HttpError } from './errors.ts'
import { errorJson, json } from './http.ts'
import { queryFirst } from './db.ts'
import { getProject, listProjects, registerProject } from './projects.ts'
import { appendNotes } from './notes.ts'
import { getSummaryVersion, listSummaryVersions, putSummary } from './summaries.ts'

interface RouteDefinition {
  method: string
  pattern: RegExp
  keys: string[]
  handler: (context: RouteContext) => Promise<Response>
}

/** Compile `/v1/projects/:id/...` into a RegExp plus captured key names. */
function route(
  method: string,
  path: string,
  handler: (context: RouteContext) => Promise<Response>,
): RouteDefinition {
  const keys: string[] = []
  const expression = path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_match, key: string) => {
    keys.push(key)
    return '([^/]+)'
  })
  return { method, pattern: new RegExp(`^${expression}$`), keys, handler }
}

const ROUTES: RouteDefinition[] = [
  route('GET', '/v1/health', health),
  route('GET', '/v1/projects', listProjects),
  route('POST', '/v1/projects', registerProject),
  route('GET', '/v1/projects/:id', getProject),
  route('POST', '/v1/projects/:id/notes', appendNotes),
  route('PUT', '/v1/projects/:id/summary', putSummary),
  route('GET', '/v1/projects/:id/summary/versions', listSummaryVersions),
  route('GET', '/v1/projects/:id/summary/versions/:version', getSummaryVersion),
]

/** `GET /v1/health` — bearer auth plus a trivial D1 round trip. */
async function health({ request, env }: RouteContext): Promise<Response> {
  const machineId = request.headers.get('X-Machine-Id')
  try {
    await queryFirst(env.DB, 'SELECT 1')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[dsh-project-memory] database health check failed:', message)
    throw new HttpError(500, 'db_error', 'database health check failed')
  }
  return json({
    ok: true,
    service: 'dsh-project-memory',
    version: 1,
    time: Date.now(),
    machineId,
  })
}

function matchRoute(
  routes: RouteDefinition[],
  method: string,
  pathname: string,
): { route: RouteDefinition; params: Record<string, string> } | 'method_mismatch' | null {
  let methodMismatch = false
  for (const candidate of routes) {
    const match = candidate.pattern.exec(pathname)
    if (match === null) continue
    if (candidate.method !== method) {
      methodMismatch = true
      continue
    }
    const params: Record<string, string> = {}
    for (let index = 0; index < candidate.keys.length; index += 1) {
      params[candidate.keys[index]] = decodeURIComponent(match[index + 1])
    }
    return { route: candidate, params }
  }
  return methodMismatch ? 'method_mismatch' : null
}

/** Top-level `/v1` request handler. */
export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname !== '/v1' && !url.pathname.startsWith('/v1/')) {
    return errorJson(404, 'not_found', 'not found')
  }

  try {
    const unauthorized = await authorize(request, env)
    if (unauthorized !== null) return unauthorized

    const matched = matchRoute(ROUTES, request.method, url.pathname)
    if (matched === null) return errorJson(404, 'not_found', 'route not found')
    if (matched === 'method_mismatch') {
      return errorJson(
        405,
        'method_not_allowed',
        `${request.method} is not allowed for ${url.pathname}`,
      )
    }

    return await matched.route.handler({ request, env, url, params: matched.params })
  } catch (error) {
    if (error instanceof HttpError) return errorJson(error.status, error.code, error.message)
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.error('[dsh-project-memory] unhandled worker error:', detail)
    return errorJson(500, 'internal_error', 'internal server error')
  }
}

import type { Env } from './types.ts'
import { errorJson } from './http.ts'
import { handle } from './router.ts'

/**
 * Cloudflare Worker entry point for the DSH project-memory shared backend.
 *
 * The entire HTTP contract lives under `/v1`; every route is bearer-token
 * protected (including the health check).
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    void ctx
    try {
      return await handle(request, env)
    } catch (error) {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
      console.error('[dsh-project-memory] fatal worker error:', detail)
      return errorJson(500, 'internal_error', 'internal server error')
    }
  },
}

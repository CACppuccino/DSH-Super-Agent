/** JSON response helpers shared by the router and route handlers. */

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

export function errorJson(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status)
}

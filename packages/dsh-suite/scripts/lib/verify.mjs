/**
 * End-to-end endpoint verification for the suite installer.
 *
 * Two calls prove a deployment: the unauthenticated `/healthz` probe proves
 * the dsh-remote row mounted and bound its port, and an authenticated
 * `session.list` proves the bearer token is the one the running process
 * loaded (a token file changed while DSH runs must fail loudly here rather
 * than silently pairing a phone that cannot connect).
 *
 * `fetchImpl` and the clock are injectable so the tests exercise success,
 * 401, 404, and connection-refused paths against a local stub server instead
 * of a live Harness.
 *
 * @module dsh-suite/scripts/lib/verify
 */

/** Per-request network budget. */
const REQUEST_TIMEOUT_MS = 5000

/** Default pause between retries of a transient failure. */
const DEFAULT_INTERVAL_MS = 500

/** Turn one failure into the action a user can take. */
function hintFor(stage, kind) {
  if (kind === 'unreachable') {
    return '端口上没有进程在监听：先重启 DeepSeek Harness（桌面版），或确认 dsh-remote 行已加载；'
      + '如果改了端口，用 --port 指定实际端口'
  }
  if (kind === 'unreachable-address') {
    return '该地址不可达：确认手机和 Mac 在同一网络（或同一 tailnet），并检查 DNS/防火墙设置'
  }
  if (kind === 'unauthorized') {
    return 'Token 不匹配：确认 profile 的 dsh-remote 配置没有写死 auth.token，'
      + '并删除 token 文件后重启 DSH 以重新生成、再重新配对'
  }
  if (kind === 'not-served') {
    return '端口有服务但不是 dsh-remote：确认没有别的程序占用该端口，或修改 dsh-remote 的 listen.port'
  }
  if (kind === 'rpc-error') {
    return '端点已鉴权但 session.list 失败：查看 DSH 日志里 dsh-remote 的报错（通常是 Host 服务未就绪）'
  }
  return '查看 DSH 日志中 dsh-remote / dsh-super-agent 的输出以定位原因'
}

/** Strip trailing slashes from a base URL. */
function trimBase(baseUrl) {
  return String(baseUrl).replace(/\/+$/, '')
}

/**
 * Call the unauthenticated liveness probe.
 * @param {object} options
 * @param {string} options.baseUrl origin such as `http://127.0.0.1:3443`
 * @param {typeof fetch} [options.fetchImpl] injectable fetch
 * @returns {Promise<{ ok: boolean, status?: number, body?: unknown, kind?: string, message?: string }>}
 *   the parsed healthz result or a classified failure
 */
export async function checkHealthz({ baseUrl, fetchImpl = fetch }) {
  let response
  try {
    response = await fetchImpl(`${trimBase(baseUrl)}/healthz`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    const code = error?.cause?.code ?? error?.code
    return {
      ok: false,
      kind: code === 'ENOTFOUND' || code === 'EHOSTUNREACH' ? 'unreachable-address' : 'unreachable',
      message: error instanceof Error ? error.message : String(error),
    }
  }
  let body
  try {
    body = await response.json()
  } catch {
    return { ok: false, kind: 'not-served', status: response.status, message: 'healthz did not return JSON' }
  }
  if (response.status !== 200) {
    return { ok: false, kind: 'not-served', status: response.status, body, message: `healthz returned HTTP ${response.status}` }
  }
  if (body?.ok !== true || body?.service !== 'dsh-remote') {
    return { ok: false, kind: 'not-served', status: response.status, body, message: 'healthz is served by something other than dsh-remote' }
  }
  return { ok: true, status: response.status, body }
}

/**
 * Call an authenticated `session.list` and unwrap the iOS wire envelope.
 * @param {object} options
 * @param {string} options.baseUrl origin such as `http://127.0.0.1:3443`
 * @param {string} options.pathPrefix dsh-remote URL prefix, e.g. `/remote-api`
 * @param {string} options.token bearer token
 * @param {typeof fetch} [options.fetchImpl] injectable fetch
 * @returns {Promise<{ ok: boolean, items?: Array<unknown>, rpc?: unknown, kind?: string, message?: string, status?: number }>}
 *   the session list or a classified failure
 */
export async function requestSessionList({
  baseUrl, pathPrefix, token, fetchImpl = fetch,
}) {
  let response
  try {
    response = await fetchImpl(`${trimBase(baseUrl)}${pathPrefix}/session.list`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ rpcId: 'suite-install-verify', payload: {} }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    const code = error?.cause?.code ?? error?.code
    return {
      ok: false,
      kind: code === 'ENOTFOUND' || code === 'EHOSTUNREACH' ? 'unreachable-address' : 'unreachable',
      message: error instanceof Error ? error.message : String(error),
    }
  }
  if (response.status === 401) {
    return { ok: false, kind: 'unauthorized', status: 401, message: 'session.list rejected the bearer token (HTTP 401)' }
  }
  if (response.status === 404) {
    return { ok: false, kind: 'not-served', status: 404, message: `${pathPrefix}/session.list is not served (HTTP 404)` }
  }
  let body
  try {
    body = await response.json()
  } catch {
    return { ok: false, kind: 'not-served', status: response.status, message: 'session.list did not return JSON' }
  }
  if (response.status !== 200) {
    return { ok: false, kind: 'not-served', status: response.status, message: `session.list returned HTTP ${response.status}` }
  }
  const result = body?.result
  if (result === undefined || typeof result !== 'object') {
    return { ok: false, kind: 'unexpected-response', status: response.status, message: 'session.list response has no result envelope' }
  }
  if (result.ok !== true) {
    return {
      ok: false,
      kind: 'rpc-error',
      status: response.status,
      message: `session.list failed: ${result.error?.code ?? 'unknown'} ${result.error?.message ?? ''}`.trim(),
    }
  }
  const items = Array.isArray(result.value?.items) ? result.value.items : undefined
  return { ok: true, items: items ?? [], rpc: result.value }
}

/**
 * Verify a remote endpoint, retrying transient failures until the deadline.
 *
 * Authentication failures and malformed responses fail immediately: retrying
 * them cannot succeed. Connection failures and an unserved port are retried
 * because a just-restarted DSH needs a moment to mount its rows.
 *
 * @param {object} options
 * @param {string} options.baseUrl origin to call
 * @param {string} options.pathPrefix dsh-remote URL prefix
 * @param {string} options.token bearer token
 * @param {number} [options.waitMs] total retry budget
 * @param {number} [options.intervalMs] pause between attempts
 * @param {typeof fetch} [options.fetchImpl] injectable fetch
 * @param {(ms: number) => Promise<void>} [options.sleep] injectable pause
 * @param {(line: string) => void} [options.log] progress sink
 * @returns {Promise<object>} `{ ok: true, items, attempts, health }` or
 *   `{ ok: false, stage, kind, message, hint, attempts }`
 */
export async function verifyRemote({
  baseUrl,
  pathPrefix,
  token,
  waitMs = 0,
  intervalMs = DEFAULT_INTERVAL_MS,
  fetchImpl = fetch,
  sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms)),
  log = () => {},
}) {
  const deadline = Date.now() + Math.max(0, waitMs)
  let attempts = 0
  for (;;) {
    attempts += 1
    const health = await checkHealthz({ baseUrl, fetchImpl })
    if (health.ok) {
      const listed = await requestSessionList({
        baseUrl, pathPrefix, token, fetchImpl,
      })
      if (listed.ok) {
        return { ok: true, attempts, health: health.body, items: listed.items, rpc: listed.rpc }
      }
      const permanent = !['unreachable', 'unreachable-address', 'not-served'].includes(listed.kind)
      if (permanent || Date.now() >= deadline) {
        return {
          ok: false,
          stage: 'session.list',
          kind: listed.kind,
          message: listed.message,
          hint: hintFor('session.list', listed.kind),
          attempts,
        }
      }
      log(`  … session.list 暂不可用（${listed.message}），重试中`)
    } else {
      const permanent = !['unreachable', 'unreachable-address', 'not-served'].includes(health.kind)
      if (permanent || Date.now() >= deadline) {
        return {
          ok: false,
          stage: 'healthz',
          kind: health.kind,
          message: health.message,
          hint: hintFor('healthz', health.kind),
          attempts,
        }
      }
      log(`  … /healthz 暂不可用（${health.message}），重试中`)
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        stage: 'healthz',
        kind: 'timeout',
        message: `gave up after ${attempts} attempt(s) and ${waitMs}ms`,
        hint: hintFor('healthz', 'unreachable'),
        attempts,
      }
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())))
  }
}

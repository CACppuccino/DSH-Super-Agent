/**
 * Balance, per-key Platform spend, and local 24-hour tokens for the Super
 * Agent header widget.
 *
 * Three independent facts are exposed:
 *
 * 1. Balance comes from the desktop account service — `deepseekAccount` on
 *    DSH 0.2.2 and later, the retired `accountController` before it. Both
 *    expose the same `getBalance({ version, locale, timezoneOffsetSeconds })`
 *    contract and return the DeepSeek Platform wallet for the signed-in
 *    account, never a token.
 * 2. Per-key spend comes from the Platform usage page's private
 *    `/api/v0/usage/by_api_key/cost` endpoint, authenticated with the account
 *    grant already stored for balance. The endpoint buckets by calendar day,
 *    so the money figure is "today", not a rolling 24 hours.
 * 3. Local usage is folded from durable Session logs. Every settled model
 *    attempt records an `assistant/message` with provider-reported `usage`,
 *    the route's provider/model, and an event time. That is exact rolling
 *    24-hour token accounting; it is deliberately never converted to money
 *    because the harness ships no text token price table.
 *
 * The module keeps all I/O behind `ctx.get(...)` lookups so a profile without
 * any of these services can never block or crash the panel.
 */
import { stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

/** One rolling window in milliseconds. */
export const USAGE_WINDOW_MS = 24 * 60 * 60 * 1000

/** The Platform dashboard buckets usage by calendar day, not by rolling hour. */
export const PLATFORM_DAY_MS = 24 * 60 * 60 * 1000

/** Credential record written by the DeepSeek account provider. */
export const PLATFORM_USAGE_RECORD = 'deepseek-account-platform/default'

/** The private dashboard endpoint the Platform usage page itself loads. */
export const PLATFORM_USAGE_PATH = '/api/v0/usage/by_api_key/cost'

/** Plugin version reported as the UI client version to Platform. */
export const CLIENT_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** Routes that authenticate through the DeepSeek account grant rather than an API key. */
const ACCOUNT_ROUTES = new Set(['deepseek-account'])

/** Empty, serializable balance state. */
function emptyBalance(status, fetchedAt) {
  return { status, wallets: [], bonusWallets: [], fetchedAt }
}

/** Keep only display-safe wallet rows. */
export function normalizeWallets(value) {
  if (!Array.isArray(value)) return []
  const wallets = []
  for (const wallet of value) {
    if (!wallet || typeof wallet !== 'object') continue
    const currency = typeof wallet.currency === 'string' ? wallet.currency.trim().toUpperCase() : ''
    const balance = typeof wallet.balance === 'string' ? wallet.balance.trim() : String(wallet.balance ?? '').trim()
    if (currency.length === 0 || balance.length === 0) continue
    if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(balance)) continue
    wallets.push({ currency, balance })
  }
  return wallets
}

/** Resolve provider display names without making discovery calls. */
export function providerDisplayNames(ctx) {
  const names = new Map()
  try {
    const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    const providers = llm && typeof llm.listProviders === 'function' ? llm.listProviders() : []
    for (const provider of Array.isArray(providers) ? providers : []) {
      if (!provider || typeof provider.id !== 'string' || provider.id.length === 0) continue
      names.set(provider.id, typeof provider.name === 'string' && provider.name.length > 0 ? provider.name : provider.id)
    }
  } catch {
    // A broken provider registry only costs nicer labels.
  }
  return names
}

/** A safe non-negative integer token count. */
function tokenCount(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0
}

/**
 * Fold session events into per-provider-route token totals.
 *
 * Only `assistant/message` carries the final per-attempt usage; retries and
 * failures settle as `assistant/attempt` without usage, so counting message
 * events avoids double billing. Events outside `[since, until]` are ignored.
 *
 * @param {Array<{type?: string, time?: number, data?: any}>} events
 * @param {{ since: number, until?: number, names?: Map<string,string>, totals?: Map<string, any> }} options
 * @returns {Map<string, any>} provider route id → totals
 */
export function foldUsageEvents(events, options = {}) {
  const since = Number.isFinite(options.since) ? options.since : 0
  const until = Number.isFinite(options.until) ? options.until : Number.POSITIVE_INFINITY
  const names = options.names instanceof Map ? options.names : new Map()
  const totals = options.totals instanceof Map ? options.totals : new Map()
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || event.type !== 'assistant/message') continue
    const time = Number(event.time)
    if (!Number.isFinite(time) || time < since || time > until) continue
    const data = event.data && typeof event.data === 'object' ? event.data : {}
    const usage = data.usage && typeof data.usage === 'object' ? data.usage : undefined
    if (!usage) continue
    const source = data.message && typeof data.message === 'object' && data.message.source && typeof data.message.source === 'object'
      ? data.message.source
      : undefined
    const header = data.header && typeof data.header === 'object' ? data.header : undefined
    const provider = typeof source?.provider === 'string' && source.provider.length > 0
      ? source.provider
      : typeof header?.config?.provider === 'string' && header.config.provider.length > 0
        ? header.config.provider
        : 'unknown'
    const model = typeof source?.model === 'string' && source.model.length > 0
      ? source.model
      : typeof header?.config?.model === 'string' && header.config.model.length > 0
        ? header.config.model
        : undefined
    const inputTokens = tokenCount(usage.inputTokens ?? usage.uncachedInputTokens)
    const outputTokens = tokenCount(usage.outputTokens)
    const cacheReadTokens = tokenCount(usage.cacheReadTokens)
    const cacheWriteTokens = tokenCount(usage.cacheWriteTokens)
    const totalTokens = tokenCount(usage.totalTokens) || inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
    const row = totals.get(provider) || {
      provider,
      providerName: names.get(provider) || provider,
      kind: ACCOUNT_ROUTES.has(provider) ? 'account' : 'api-key',
      models: [],
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      lastAt: 0,
    }
    row.requests += 1
    row.inputTokens += inputTokens
    row.outputTokens += outputTokens
    row.cacheReadTokens += cacheReadTokens
    row.cacheWriteTokens += cacheWriteTokens
    row.totalTokens += totalTokens
    row.lastAt = Math.max(row.lastAt, time)
    if (model !== undefined && !row.models.includes(model)) row.models.push(model)
    totals.set(provider, row)
  }
  return totals
}

/** Sort folded provider totals into a stable, display-ready list. */
export function usageKeys(totals) {
  const keys = [...(totals instanceof Map ? totals.values() : [])]
  keys.sort((left, right) => right.totalTokens - left.totalTokens || left.provider.localeCompare(right.provider))
  return keys.map((row) => ({ ...row, models: row.models.slice().sort() }))
}

/** Whether a stored Session's artifact was touched inside the window. */
export async function touchedSince(snapshot, since) {
  const path = snapshot && snapshot.location && snapshot.location.kind === 'jsonl' ? snapshot.location.path : undefined
  if (typeof path !== 'string' || path.length === 0) return true
  try {
    const info = await stat(path)
    return info.mtimeMs >= since
  } catch {
    return false
  }
}

/** Empty, serializable usage state. */
function failedUsage(status, since, generatedAt) {
  return { status, windowHours: 24, since, keys: [], totalTokens: 0, requests: 0, generatedAt }
}

/** Normalize a UI UTC offset (seconds east of UTC). */
export function normalizeTimezoneOffset(value) {
  const number = Number(value)
  return Number.isFinite(number) && Math.abs(number) <= 86_400 ? Math.trunc(number) : 0
}

/**
 * The Platform calendar-day window that contains `stamp` for one UTC offset.
 * The private usage endpoint only accepts day-aligned `start`/`end` values.
 * @param {number} stamp - epoch milliseconds
 * @param {number} timezoneOffsetSeconds - seconds east of UTC
 */
export function platformDayWindow(stamp, timezoneOffsetSeconds) {
  const offset = normalizeTimezoneOffset(timezoneOffsetSeconds)
  const localDay = Math.floor((Number(stamp) + offset * 1000) / PLATFORM_DAY_MS) * PLATFORM_DAY_MS
  const startMs = localDay - offset * 1000
  const endMs = startMs + PLATFORM_DAY_MS
  return {
    startMs,
    endMs,
    startSeconds: Math.floor(startMs / 1000),
    endSeconds: Math.floor(endMs / 1000),
    timezoneOffsetSeconds: offset,
  }
}

/** Resolve one promise with a deadline; never leaves a live timer behind. */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * Create the balance/usage service.
 *
 * @param {{
 *   ctx: any,
 *   now?: () => number,
 *   version?: string,
 *   balanceTimeoutMs?: number,
 *   balanceTtlMs?: number,
 *   usageTtlMs?: number,
 *   platformSpend?: boolean,
 *   platformTtlMs?: number,
 *   platformTimeoutMs?: number,
 *   maxSessions?: number,
 * }} options
 */
export function createBilling(options = {}) {
  const ctx = options.ctx
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const version = typeof options.version === 'string' && options.version.length > 0 ? options.version : CLIENT_VERSION
  const balanceTimeoutMs = Number.isFinite(options.balanceTimeoutMs) ? options.balanceTimeoutMs : 2500
  const balanceTtlMs = Number.isFinite(options.balanceTtlMs) ? options.balanceTtlMs : 60_000
  const usageTtlMs = Number.isFinite(options.usageTtlMs) ? options.usageTtlMs : 30_000
  const usageTimeoutMs = Number.isFinite(options.usageTimeoutMs) ? options.usageTimeoutMs : 10_000
  const platformSpend = options.platformSpend !== false
  const platformTtlMs = Number.isFinite(options.platformTtlMs) ? options.platformTtlMs : 5 * 60_000
  const platformTimeoutMs = Number.isFinite(options.platformTimeoutMs) ? options.platformTimeoutMs : 4_000
  const maxSessions = Number.isFinite(options.maxSessions) ? options.maxSessions : 400
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch

  let balanceCache
  let balanceInflight
  let usageCache
  let usageInflight
  let platformCache
  let platformInflight

  /** Read the account wallet while keeping Platform waits off the panel path. */
  async function readBalance(client) {
    let account
    try {
      // DSH 0.2.2 removed `dsh-api-account-controller`; `deepseekAccount` is
      // its replacement and keeps the same getBalance contract. Both are read
      // through ctx.get so a host with neither degrades to "unavailable".
      account = ctx && typeof ctx.get === 'function'
        ? ctx.get('deepseekAccount') ?? ctx.get('accountController')
        : undefined
    } catch {
      account = undefined
    }
    if (!account || typeof account.getBalance !== 'function') return emptyBalance('unavailable', now())
    try {
      // The current service builds its Platform identity headers from this
      // object, so it needs the UI client version as well as locale/zone.
      const request = {
        version,
        locale: client.locale,
        timezoneOffsetSeconds: client.timezoneOffsetSeconds,
      }
      const result = await withTimeout(account.getBalance(request), balanceTimeoutMs)
      if (result === null || result === undefined) return emptyBalance('signed-out', now())
      if (result.status !== 'ready') return emptyBalance('failed', now())
      const wallets = normalizeWallets(result.value)
      if (wallets.length === 0) return emptyBalance('failed', now())
      return {
        status: 'ready',
        wallets,
        bonusWallets: normalizeWallets(result.bonusWallets),
        fetchedAt: now(),
      }
    } catch {
      return emptyBalance('failed', now())
    }
  }

  /** Cached, in-flight-deduped balance for one UI locale/timezone. */
  async function balance(client) {
    const key = `${client.locale}|${client.timezoneOffsetSeconds}`
    const stamp = now()
    if (balanceCache && balanceCache.key === key && stamp - balanceCache.at < balanceTtlMs) return balanceCache.value
    if (balanceInflight && balanceInflight.key === key) return balanceInflight.promise
    const promise = readBalance(client).then((value) => {
      if (value.status === 'ready') balanceCache = { key, at: now(), value }
      return value
    }).finally(() => {
      if (balanceInflight && balanceInflight.promise === promise) balanceInflight = undefined
    })
    balanceInflight = { key, promise }
    return promise
  }

  /** Read every recent stored Session through the public persistence seam. */
  async function readUsage() {
    let persistence
    try {
      persistence = ctx && typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : undefined
    } catch {
      persistence = undefined
    }
    if (!persistence || typeof persistence.list !== 'function' || typeof persistence.open !== 'function') {
      return { status: 'unavailable', windowHours: 24, since: now() - USAGE_WINDOW_MS, keys: [], totalTokens: 0, requests: 0, generatedAt: now() }
    }
    const since = now() - USAGE_WINDOW_MS
    const until = now()
    let snapshots
    try {
      snapshots = await persistence.list()
    } catch {
      return { status: 'failed', windowHours: 24, since, keys: [], totalTokens: 0, requests: 0, generatedAt: now() }
    }
    const names = providerDisplayNames(ctx)
    const totals = new Map()
    let scanned = 0
    const selected = []
    for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
      if (!snapshot || !snapshot.header || typeof snapshot.header.id !== 'string') continue
      if (selected.length >= maxSessions) break
      if (await touchedSince(snapshot, since)) selected.push(snapshot)
    }
    const truncated = selected.length >= maxSessions
    for (const snapshot of selected) {
      let handle
      try {
        handle = await persistence.open(snapshot.header.id, 'read')
        const result = await handle.read()
        foldUsageEvents(result && Array.isArray(result.events) ? result.events : [], { since, until, names, totals })
        scanned += 1
      } catch {
        // One unreadable historical Session must not hide the others.
      } finally {
        try { await handle?.close?.() } catch { /* ignore */ }
      }
    }
    if (selected.length > 0 && scanned === 0) {
      return { ...failedUsage('failed', since, now()), scannedSessions: 0, attemptedSessions: selected.length }
    }
    const keys = usageKeys(totals)
    return {
      status: 'ready',
      windowHours: 24,
      since,
      keys,
      totalTokens: keys.reduce((sum, key) => sum + key.totalTokens, 0),
      requests: keys.reduce((sum, key) => sum + key.requests, 0),
      scannedSessions: scanned,
      attemptedSessions: selected.length,
      partial: truncated || scanned < selected.length,
      generatedAt: now(),
    }
  }

  /** Cached, in-flight-deduped 24-hour usage. */
  async function usage() {
    const stamp = now()
    if (usageCache && stamp - usageCache.at < usageTtlMs) return usageCache.value
    if (usageInflight) return usageInflight
    const since = stamp - USAGE_WINDOW_MS
    const promise = withTimeout(readUsage(), usageTimeoutMs)
      .catch(() => failedUsage('failed', since, now()))
      .then((value) => {
        if (value.status === 'ready') usageCache = { at: now(), value }
        return value
      }).finally(() => {
        if (usageInflight === promise) usageInflight = undefined
      })
    usageInflight = promise
    return promise
  }

  /**
   * Read the Platform dashboard's per-API-key cost for the current calendar
   * day. This is a private endpoint the Platform usage page itself loads; it
   * only ever exposes per-key totals, never key material. The account grant is
   * read from the credential record the account provider already owns and is
   * sent only in a host request header.
   */
  /** Empty Platform state with the day/tz window attached. */
  function emptyPlatform(status, window) {
    return {
      status,
      keys: [],
      totals: [],
      timezoneOffsetSeconds: window.timezoneOffsetSeconds,
      dayStart: window.startMs,
      dayEnd: window.endMs,
      fetchedAt: now(),
    }
  }

  /**
   * Parse one private-usage payload. This is the only place raw key metadata
   * exists: the result keeps a display label and an opaque hash, and never
   * carries `sensitive_id`, `tracking_id`, or any other raw key field.
   * A shape change returns null, which the caller turns into a token-only
   * fallback rather than a partial or fabricated result.
   */
  function parsePlatformCost(payload, window) {
    if (!payload || typeof payload !== 'object') return null
    if (payload.code !== undefined && payload.code !== 0) return null
    const envelope = payload.data
    if (!envelope || typeof envelope !== 'object' || envelope.biz_code !== 0) return null
    const biz = envelope.biz_data
    let blocks
    if (Array.isArray(biz)) blocks = biz
    else if (biz && typeof biz === 'object' && Array.isArray(biz.data)) blocks = biz.data
    else return null
    const byKey = new Map()
    for (const block of blocks) {
      if (!block || typeof block !== 'object') return null
      if (typeof block.currency !== 'string' || block.currency.trim().length === 0) return null
      if (!Array.isArray(block.series)) return null
      const currency = block.currency.trim().toUpperCase()
      for (const series of block.series) {
        if (!series || typeof series !== 'object') return null
        if (series.model !== undefined && typeof series.model !== 'string') return null
        const apiKey = series.api_key && typeof series.api_key === 'object'
          ? series.api_key
          : series.apiKey && typeof series.apiKey === 'object' ? series.apiKey : undefined
        if (!apiKey) return null
        if (!Array.isArray(series.buckets)) return null
        const tracking = typeof apiKey.tracking_id === 'string'
          ? apiKey.tracking_id
          : typeof apiKey.trackingId === 'string' ? apiKey.trackingId : ''
        const name = typeof apiKey.name === 'string' ? apiKey.name.trim().slice(0, 120) : ''
        const keyType = typeof apiKey.key_type === 'string'
          ? apiKey.key_type.trim().slice(0, 32)
          : typeof apiKey.keyType === 'string' ? apiKey.keyType.trim().slice(0, 32) : ''
        const idSource = tracking.length > 0 ? tracking : `${name}|${keyType}|${currency}`
        const id = createHash('sha256').update(idSource).digest('hex').slice(0, 12)
        const mapKey = `${id}|${currency}`
        let row = byKey.get(mapKey)
        if (!row) {
          row = {
            id,
            label: name.length > 0 ? name : `key-${id.slice(0, 6)}`,
            keyType: keyType.length > 0 ? keyType : undefined,
            currency,
            cost: 0,
            models: [],
          }
          byKey.set(mapKey, row)
        }
        for (const bucket of series.buckets) {
          if (!bucket || typeof bucket !== 'object') return null
          const time = Number(bucket.time)
          if (!Number.isFinite(time)) return null
          const rawCost = bucket.cost
          if (rawCost === undefined || rawCost === null || rawCost === '') return null
          const cost = Number(rawCost)
          if (!Number.isFinite(cost)) return null
          if (time >= window.startSeconds && time < window.endSeconds && cost > 0) row.cost += cost
        }
        if (typeof series.model === 'string' && series.model.length > 0 && !row.models.includes(series.model)) row.models.push(series.model)
      }
    }
    const keys = [...byKey.values()]
      .map((row) => ({ ...row, cost: Number(row.cost.toFixed(4)), models: row.models.slice().sort() }))
      .sort((left, right) => right.cost - left.cost || String(left.label || '').localeCompare(String(right.label || '')))
    const totals = new Map()
    for (const key of keys) totals.set(key.currency, (totals.get(key.currency) || 0) + key.cost)
    return {
      keys,
      totals: [...totals].map(([currency, cost]) => ({ currency, cost: Number(cost.toFixed(4)) })),
    }
  }

  /**
   * Read the Platform dashboard's per-API-key cost for the current calendar
   * day. This is a private endpoint the Platform usage page itself loads; it
   * only ever exposes per-key totals, never key material.
   */
  async function readPlatformCost(client, stamp = now()) {
    const offset = normalizeTimezoneOffset(client && client.timezoneOffsetSeconds)
    const window = platformDayWindow(stamp, offset)
    if (!platformSpend) return emptyPlatform('disabled', window)
    const unavailable = () => emptyPlatform('unavailable', window)
    const failed = () => emptyPlatform('failed', window)
    let credentials
    try {
      credentials = ctx && typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
    } catch {
      credentials = undefined
    }
    if (!credentials || typeof credentials.readRecord !== 'function' || typeof fetchImpl !== 'function') return unavailable()
    let record
    try {
      record = await credentials.readRecord(PLATFORM_USAGE_RECORD)
    } catch {
      return unavailable()
    }
    if (record === undefined || record === null) return emptyPlatform('signed-out', window)
    if (record.kind !== 'grant' || !record.payload || typeof record.payload.token !== 'string' || record.payload.token.length === 0) {
      return unavailable()
    }
    let origin = 'https://platform.deepseek.com'
    try {
      // Never send the account grant to an origin the stored record merely
      // names: a tampered record must not turn this into a token-exfiltration
      // request. Only the official Platform host is allowed.
      const issuer = new URL(record.payload.issuer)
      if (issuer.protocol === 'https:' && issuer.hostname === 'platform.deepseek.com') origin = issuer.origin
    } catch { /* keep the official origin */ }

    // The cost endpoint only returns keys with a series in the requested
    // range. A two-day key-enumeration window (yesterday + today) lists the
    // keys active in the current window, including a key whose only spend was
    // yesterday (shown at ¥0 for today); the cost is filtered to today below.
    const keyWindowStartSeconds = window.startSeconds - 86_400
    const query = `?start=${keyWindowStartSeconds}&end=${window.endSeconds}&tz=${offset}`
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(platformTimeoutMs)
      : undefined
    let response
    try {
      response = await withTimeout(fetchImpl(`${origin}${PLATFORM_USAGE_PATH}${query}`, {
        method: 'GET',
        redirect: 'error',
        ...signal === undefined ? {} : { signal },
        headers: {
          'x-dsh-auth-token': record.payload.token,
          accept: 'application/json',
          'x-client-platform': 'web',
        },
      }), platformTimeoutMs)
    } catch {
      return failed()
    }
    if (!response || response.ok !== true) return failed()
    let payload
    try {
      payload = await response.json()
    } catch {
      return failed()
    }
    const parsed = parsePlatformCost(payload, window)
    if (!parsed) return failed()
    return {
      status: 'ready',
      keys: parsed.keys,
      totals: parsed.totals,
      timezoneOffsetSeconds: offset,
      dayStart: window.startMs,
      dayEnd: window.endMs,
      fetchedAt: now(),
    }
  }

  /**
   * Cached, in-flight-deduped Platform per-key spend. The cache key is the
   * Platform day + UI offset: the value cannot change until the local day
   * rolls over, so a five-minute TTL is only a safety net.
   */
  async function platform(client) {
    const stamp = now()
    const offset = normalizeTimezoneOffset(client && client.timezoneOffsetSeconds)
    const window = platformDayWindow(stamp, offset)
    if (!platformSpend) return emptyPlatform('disabled', window)
    const key = `${window.startMs}|${offset}`
    if (platformCache && platformCache.key === key && stamp - platformCache.at < platformTtlMs) return platformCache.value
    if (platformInflight && platformInflight.key === key) return platformInflight.promise
    const promise = readPlatformCost({ timezoneOffsetSeconds: offset }, stamp).then((value) => {
      if (value.status === 'ready') platformCache = { key, at: now(), value }
      return value
    }).finally(() => {
      if (platformInflight && platformInflight.promise === promise) platformInflight = undefined
    })
    platformInflight = { key, promise }
    return promise
  }

  /**
   * Build the widget payload. Balance, Platform spend, and local usage are
   * independent: one failing never hides the others.
   * @param {{ locale?: string, timezoneOffsetSeconds?: number }} [client]
   */
  async function summary(client = {}) {
    const locale = typeof client.locale === 'string' && /^[A-Za-z_-]{2,16}$/.test(client.locale) ? client.locale : 'en'
    const offset = Number(client.timezoneOffsetSeconds)
    const timezoneOffsetSeconds = Number.isFinite(offset) && Math.abs(offset) <= 86_400 ? Math.trunc(offset) : 0
    const platformClient = { version, locale, timezoneOffsetSeconds }
    const [balanceValue, usageValue, platformValue] = await Promise.all([
      balance(platformClient),
      usage(),
      platform(platformClient),
    ])
    return {
      balance: balanceValue,
      usage: usageValue,
      platform: platformValue,
      generatedAt: now(),
    }
  }

  return { summary, balance, usage, platform }
}

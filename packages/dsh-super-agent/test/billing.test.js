import assert from 'node:assert/strict'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, test } from 'node:test'
import {
  createBilling,
  foldUsageEvents,
  normalizeWallets,
  providerDisplayNames,
  touchedSince,
  usageKeys,
  platformDayWindow,
} from '../lib/billing.js'

const dirs = []
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop(), { recursive: true, force: true })
})

/** One settled attempt as it appears in a Session log. */
function attempt({ provider = 'deepseek-official', model = 'deepseek-flash', time = 1_000, usage } = {}) {
  return {
    type: 'assistant/message',
    time,
    data: {
      message: { role: 'assistant', source: { kind: 'model', provider, model } },
      usage: usage || { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 0, totalTokens: 420 },
    },
  }
}

test('wallets are display-safe and unknown or malformed amounts are dropped', () => {
  assert.deepEqual(normalizeWallets(undefined), [])
  assert.deepEqual(normalizeWallets([
    { currency: 'cny', balance: '12.34' },
    { currency: 'USD', balance: '0' },
    { currency: '', balance: '1' },
    { currency: 'CNY', balance: 'NaN' },
    { currency: 'CNY', balance: '1e-3' },
  ]), [
    { currency: 'CNY', balance: '12.34' },
    { currency: 'USD', balance: '0' },
    { currency: 'CNY', balance: '1e-3' },
  ])
})

test('usage folds only settled attempts inside the window', () => {
  const now = 100_000_000
  const names = new Map([['deepseek-official', 'DeepSeek']])
  const totals = foldUsageEvents([
    attempt({ time: now - 1_000 }),
    attempt({ time: now - 2_000 }),
    attempt({ time: now - 25 * 60 * 60 * 1000 }),
    attempt({ provider: 'deepseek-account', time: now - 3_000, usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }),
    { type: 'assistant/attempt', time: now, data: { usage: { totalTokens: 999 } } },
  ], { since: now - 24 * 60 * 60 * 1000, until: now, names })

  assert.equal(totals.size, 2)
  const official = totals.get('deepseek-official')
  assert.equal(official.providerName, 'DeepSeek')
  assert.equal(official.kind, 'api-key')
  assert.equal(official.requests, 2)
  assert.equal(official.inputTokens, 200)
  assert.equal(official.outputTokens, 40)
  assert.equal(official.cacheReadTokens, 600)
  assert.equal(official.totalTokens, 840)
  assert.equal(official.lastAt, now - 1_000)
  assert.deepEqual(official.models, ['deepseek-flash'])

  const account = totals.get('deepseek-account')
  assert.equal(account.kind, 'account')
  assert.equal(account.totalTokens, 3)
})

test('usage rows sort by tokens and survive a missing provider name', () => {
  const totals = foldUsageEvents([
    attempt({ provider: 'small', time: 10, usage: { totalTokens: 5 } }),
    attempt({ provider: 'large', time: 20, usage: { totalTokens: 50 } }),
  ], { since: 0 })
  const keys = usageKeys(totals)
  assert.deepEqual(keys.map((key) => key.provider), ['large', 'small'])
  assert.equal(keys[0].providerName, 'large')
})

test('provider display names come from the LLM registry without trusting a broken one', () => {
  const ctx = { get: (name) => name === 'llm' ? { listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'x' }] } : undefined }
  const names = providerDisplayNames(ctx)
  assert.equal(names.get('deepseek-official'), 'DeepSeek')
  assert.equal(names.get('x'), 'x')
  const broken = providerDisplayNames({ get() { throw new Error('no service') } })
  assert.equal(broken.size, 0)
})

test('a balance and 24-hour usage summary are cached and independent', async () => {
  const now = 1_000_000
  let balanceCalls = 0
  let listCalls = 0
  const events = [attempt({ time: now - 60_000 })]
  const ctx = {
    get(name) {
      if (name === 'deepseekAccount') {
        return {
          async getBalance(client) {
            balanceCalls += 1
            assert.equal(typeof client.version, 'string')
            assert.equal(client.locale, 'zh-CN')
            assert.equal(client.timezoneOffsetSeconds, 28_800)
            return {
              status: 'ready',
              value: [{ currency: 'CNY', balance: '12.34' }],
              bonusWallets: [{ currency: 'CNY', balance: '1.00' }],
            }
          },
        }
      }
      if (name === 'sessionPersistence') {
        return {
          async list() {
            listCalls += 1
            return [{ header: { id: 's1' } }]
          },
          async open(id) {
            assert.equal(id, 's1')
            return { async read() { return { events } }, async close() {} }
          },
        }
      }
      if (name === 'llm') return { listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }] }
      return undefined
    },
  }
  const billing = createBilling({ ctx, now: () => now, version: '0.1.0' })
  const first = await billing.summary({ locale: 'zh-CN', timezoneOffsetSeconds: 28_800 })
  assert.equal(first.balance.status, 'ready')
  assert.deepEqual(first.balance.wallets, [{ currency: 'CNY', balance: '12.34' }])
  assert.deepEqual(first.balance.bonusWallets, [{ currency: 'CNY', balance: '1.00' }])
  assert.equal(first.usage.status, 'ready')
  assert.equal(first.usage.totalTokens, 420)
  assert.equal(first.usage.keys[0].providerName, 'DeepSeek')
  assert.equal(first.usage.scannedSessions, 1)
  assert.equal(first.platform.status, 'unavailable')

  const second = await billing.summary({ locale: 'zh-CN', timezoneOffsetSeconds: 28_800 })
  assert.equal(balanceCalls, 1)
  assert.equal(listCalls, 1)
  assert.equal(second.balance.fetchedAt, first.balance.fetchedAt)
})

test('signed-out, unavailable, and failed balance states never become zero', async () => {
  const none = createBilling({ ctx: { get: () => undefined }, now: () => 1 })
  const unavailable = await none.summary({})
  assert.equal(unavailable.balance.status, 'unavailable')
  assert.equal(unavailable.usage.status, 'unavailable')

  const signedOut = createBilling({
    ctx: { get: (name) => name === 'deepseekAccount' ? { async getBalance() { return null } } : undefined },
    now: () => 1,
  })
  assert.equal((await signedOut.summary({})).balance.status, 'signed-out')

  const failed = createBilling({
    ctx: { get: (name) => name === 'deepseekAccount' ? { async getBalance() { return { status: 'failed' } } } : undefined },
    now: () => 1,
  })
  assert.equal((await failed.summary({})).balance.status, 'failed')
})

test('the retired accountController service is still honored', async () => {
  const billing = createBilling({
    ctx: {
      get: (name) => name === 'accountController'
        ? {
            async getBalance() {
              return { status: 'ready', value: [{ currency: 'CNY', balance: '2.00' }], bonusWallets: [] }
            },
          }
        : undefined,
    },
    now: () => 1,
  })
  const summary = await billing.summary({ locale: 'zh-CN', timezoneOffsetSeconds: 28_800 })
  assert.equal(summary.balance.status, 'ready')
  assert.deepEqual(summary.balance.wallets, [{ currency: 'CNY', balance: '2.00' }])
})

test('the rc.3 deepseekAccount service takes precedence over the retired accountController', async () => {
  const calls = []
  const billing = createBilling({
    ctx: {
      get(name) {
        if (name === 'deepseekAccount') {
          return {
            async getBalance() {
              calls.push('deepseekAccount')
              return { status: 'ready', value: [{ currency: 'CNY', balance: '3.00' }], bonusWallets: [] }
            },
          }
        }
        if (name === 'accountController') {
          return {
            async getBalance() {
              calls.push('accountController')
              return { status: 'ready', value: [{ currency: 'USD', balance: '9.99' }], bonusWallets: [] }
            },
          }
        }
        return undefined
      },
    },
    now: () => 1,
  })
  const summary = await billing.summary({})
  assert.equal(summary.balance.status, 'ready')
  assert.deepEqual(summary.balance.wallets, [{ currency: 'CNY', balance: '3.00' }])
  assert.deepEqual(calls, ['deepseekAccount'])
})

test('a throwing account service degrades without throwing', async () => {
  const throwingLookup = createBilling({
    ctx: { get() { throw new Error('closed') } },
    now: () => 1,
  })
  assert.equal((await throwingLookup.summary({})).balance.status, 'unavailable')

  const throwingBalance = createBilling({
    ctx: {
      get: (name) => name === 'deepseekAccount'
        ? { async getBalance() { throw new Error('account down') } }
        : undefined,
    },
    now: () => 1,
  })
  assert.equal((await throwingBalance.summary({})).balance.status, 'failed')
})

test('a slow Platform call is bounded and reported as failed', async () => {
  const billing = createBilling({
    ctx: { get: (name) => name === 'deepseekAccount' ? { getBalance: () => new Promise(() => {}) } : undefined },
    now: () => 1,
    balanceTimeoutMs: 5,
  })
  const summary = await billing.summary({})
  assert.equal(summary.balance.status, 'failed')
})

test('one unreadable Session does not hide the readable ones', async () => {
  const now = 2_000_000
  const ctx = {
    get(name) {
      if (name !== 'sessionPersistence') return undefined
      return {
        async list() { return [{ header: { id: 'bad' } }, { header: { id: 'good' } }] },
        async open(id) {
          if (id === 'bad') throw new Error('corrupt')
          return { async read() { return { events: [attempt({ time: now - 1 })] } }, async close() {} }
        },
      }
    },
  }
  const billing = createBilling({ ctx, now: () => now })
  const usage = await billing.usage()
  assert.equal(usage.status, 'ready')
  assert.equal(usage.scannedSessions, 1)
  assert.equal(usage.totalTokens, 420)
})

test('Session artifacts outside the window are not opened', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-super-agent-billing-'))
  dirs.push(directory)
  const fresh = join(directory, 'fresh.jsonl.zstd')
  const old = join(directory, 'old.jsonl.zstd')
  await writeFile(fresh, '{}')
  await writeFile(old, '{}')
  const oldTime = new Date(1_000_000)
  await utimes(old, oldTime, oldTime)
  assert.equal(await touchedSince({ location: { kind: 'jsonl', path: fresh } }, 0), true)
  assert.equal(await touchedSince({ location: { kind: 'jsonl', path: fresh } }, 2_000_000), true)
  assert.equal(await touchedSince({ location: { kind: 'jsonl', path: old } }, 2_000_000), false)
  assert.equal(await touchedSince({ header: { id: 'pending' } }, 2_000_000), true)
  assert.equal(await touchedSince({ location: { kind: 'jsonl', path: join(directory, 'missing') } }, 0), false)
})

test('usage is re-read after the cache expires', async () => {
  let stamp = 5_000_000
  let listCalls = 0
  const ctx = {
    get: (name) => name === 'sessionPersistence' ? {
      async list() { listCalls += 1; return [] },
      async open() { return { async read() { return { events: [] } }, async close() {} } },
    } : undefined,
  }
  const billing = createBilling({ ctx, now: () => stamp, usageTtlMs: 100 })
  await billing.usage()
  await billing.usage()
  assert.equal(listCalls, 1)
  stamp += 101
  await billing.usage()
  assert.equal(listCalls, 2)
})

test('Platform per-key spend is day-bounded and drops sensitive key material', async () => {
  const now = Date.parse('2026-11-14T06:00:00Z') // 14:00 at UTC+8
  const calls = []
  const todayBucket = Date.parse('2026-11-14T02:00:00Z') / 1000 // 10:00 local
  const yesterdayBucket = Date.parse('2026-11-13T02:00:00Z') / 1000
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return {
      ok: true,
      async json() {
        return {
          code: 0,
          data: {
            biz_code: 0,
            biz_data: {
              data: [{
                currency: 'CNY',
                series: [
                  {
                    api_key: { tracking_id: 'aaaaaaaa-1111-2222-3333-444444444444', name: 'Harness', key_type: 'DSH', sensitive_id: 'sk-super-secret', valid: true },
                    model: 'deepseek-flash',
                    buckets: [{ time: todayBucket, cost: '1.2345' }, { time: yesterdayBucket, cost: '99' }],
                  },
                  {
                    api_key: { tracking_id: 'aaaaaaaa-1111-2222-3333-444444444444', name: 'Harness', key_type: 'DSH', sensitive_id: 'sk-super-secret', valid: true },
                    model: 'deepseek-v4-pro',
                    buckets: [{ time: todayBucket, cost: '0.5' }],
                  },
                  {
                    api_key: { tracking_id: 'bbbbbbbb-1111-2222-3333-444444444444', name: 'Laptop', key_type: 'NORMAL', sensitive_id: 'sk-other-secret', valid: false },
                    model: 'deepseek-flash',
                    buckets: [{ time: todayBucket, cost: '2' }],
                  },
                ],
              }],
            },
          },
        }
      },
    }
  }
  const ctx = {
    get(name) {
      if (name !== 'credentials') return undefined
      return {
        async readRecord(key) {
          assert.equal(key, 'deepseek-account-platform/default')
          return { kind: 'grant', payload: { token: 'grant-token', issuer: 'https://platform.deepseek.com' } }
        },
      }
    },
  }
  const billing = createBilling({ ctx, now: () => now, fetchImpl })
  const platform = await billing.platform({ timezoneOffsetSeconds: 28_800 })
  assert.equal(platform.status, 'ready')
  assert.deepEqual(platform.keys.map((key) => key.label), ['Laptop', 'Harness'])
  assert.equal(platform.keys[0].cost, 2)
  assert.equal(platform.keys[1].cost, 1.7345)
  assert.deepEqual(platform.keys[1].models, ['deepseek-flash', 'deepseek-v4-pro'])
  assert.deepEqual(platform.totals, [{ currency: 'CNY', cost: 3.7345 }])
  assert.equal(Object.hasOwn(platform.keys[0], 'sensitive_id'), false)
  assert.equal(JSON.stringify(platform).includes('sk-super-secret'), false)
  assert.equal(JSON.stringify(platform).includes('sk-other-secret'), false)
  assert.equal(JSON.stringify(platform).includes('aaaaaaaa-1111-2222-3333-444444444444'), false)
  assert.equal(Object.hasOwn(platform.keys[0], 'tracking_id'), false)

  const url = new URL(calls[0].url)
  assert.equal(url.origin, 'https://platform.deepseek.com')
  assert.equal(url.pathname, '/api/v0/usage/by_api_key/cost')
  assert.equal(url.searchParams.get('start'), String(Date.parse('2026-11-13T16:00:00Z') / 1000 - 86_400))
  assert.equal(url.searchParams.get('end'), String(Date.parse('2026-11-14T16:00:00Z') / 1000))
  assert.equal(url.searchParams.get('tz'), '28800')
  assert.equal(calls[0].init.headers['x-dsh-auth-token'], 'grant-token')
  assert.equal(calls[0].init.headers['x-client-platform'], 'web')
})

test('Platform spend reports signed-out, unavailable, and HTTP failure without throwing', async () => {
  const signedOut = createBilling({
    ctx: { get: (name) => name === 'credentials' ? { async readRecord() { return undefined } } : undefined },
    now: () => 1,
    fetchImpl: async () => { throw new Error('must not fetch') },
  })
  assert.equal((await signedOut.platform({ timezoneOffsetSeconds: 0 })).status, 'signed-out')

  const unavailable = createBilling({ ctx: { get: () => undefined }, now: () => 1 })
  assert.equal((await unavailable.platform({ timezoneOffsetSeconds: 0 })).status, 'unavailable')

  const denied = createBilling({
    ctx: { get: (name) => name === 'credentials' ? { async readRecord() { return { kind: 'grant', payload: { token: 't' } } } } : undefined },
    now: () => 1,
    fetchImpl: async () => ({ ok: false, status: 401 }),
  })
  assert.equal((await denied.platform({ timezoneOffsetSeconds: 0 })).status, 'failed')
})

test('Platform spend is cached per timezone', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return { ok: true, async json() { return { code: 0, data: { biz_code: 0, biz_data: { data: [] } } } } }
  }
  const ctx = {
    get: (name) => name === 'credentials' ? {
      async readRecord() { return { kind: 'grant', payload: { token: 't', issuer: 'https://platform.deepseek.com' } } },
    } : undefined,
  }
  const billing = createBilling({ ctx, now: () => 10_000_000, fetchImpl, platformTtlMs: 60_000 })
  await billing.platform({ timezoneOffsetSeconds: 0 })
  await billing.platform({ timezoneOffsetSeconds: 0 })
  assert.equal(calls, 1)
  await billing.platform({ timezoneOffsetSeconds: 3600 })
  assert.equal(calls, 2)
})

test('a tampered grant issuer cannot redirect the account token', async () => {
  const calls = []
  const ctx = {
    get: (name) => name === 'credentials' ? {
      async readRecord() { return { kind: 'grant', payload: { token: 't', issuer: 'https://evil.example' } } },
    } : undefined,
  }
  const billing = createBilling({
    ctx,
    now: () => 1,
    fetchImpl: async (url) => {
      calls.push(String(url))
      return { ok: true, async json() { return { code: 0, data: { biz_code: 0, biz_data: { data: [] } } } } }
    },
  })
  await billing.platform({ timezoneOffsetSeconds: 0 })
  assert.equal(new URL(calls[0]).origin, 'https://platform.deepseek.com')
})

test('all unreadable Sessions report failure instead of a fake zero', async () => {
  const ctx = {
    get: (name) => name === 'sessionPersistence' ? {
      async list() { return [{ header: { id: 'bad' } }] },
      async open() { throw new Error('corrupt') },
    } : undefined,
  }
  const billing = createBilling({ ctx, now: () => 1 })
  const usage = await billing.usage()
  assert.equal(usage.status, 'failed')
  assert.equal(usage.totalTokens, 0)
  assert.equal(usage.keys.length, 0)
})

test('Platform day windows follow the UI offset and roll at local midnight', () => {
  const stamp = Date.parse('2026-11-14T06:00:00Z')
  const plus8 = platformDayWindow(stamp, 28_800)
  assert.equal(plus8.startMs, Date.parse('2026-11-13T16:00:00Z'))
  assert.equal(plus8.endMs, plus8.startMs + 86_400_000)
  assert.equal(plus8.startSeconds, Date.parse('2026-11-13T16:00:00Z') / 1000)
  assert.equal(plus8.endSeconds, Date.parse('2026-11-14T16:00:00Z') / 1000)

  const utc = platformDayWindow(stamp, 0)
  assert.equal(utc.startMs, Date.parse('2026-11-14T00:00:00Z'))

  const minus8 = platformDayWindow(stamp, -28_800)
  assert.equal(minus8.startMs, Date.parse('2026-11-13T08:00:00Z'))

  const late = platformDayWindow(Date.parse('2026-11-14T15:30:00Z'), 28_800) // 23:30 +8
  assert.equal(late.startMs, Date.parse('2026-11-13T16:00:00Z'))
  const midnight = platformDayWindow(Date.parse('2026-11-14T16:00:00Z'), 28_800) // 00:00 next day +8
  assert.equal(midnight.startMs, Date.parse('2026-11-14T16:00:00Z'))
})

test('Platform parser tolerates zero keys and derives labels without key material', async () => {
  const ctx = {
    get: (name) => name === 'credentials' ? {
      async readRecord() { return { kind: 'grant', payload: { token: 't', issuer: 'https://platform.deepseek.com' } } },
    } : undefined,
  }
  const empty = createBilling({
    ctx,
    now: () => 1,
    fetchImpl: async () => ({ ok: true, async json() { return { code: 0, data: { biz_code: 0, biz_data: { data: [] } } } } }),
  })
  const emptyResult = await empty.platform({ timezoneOffsetSeconds: 0 })
  assert.equal(emptyResult.status, 'ready')
  assert.deepEqual(emptyResult.keys, [])
  assert.deepEqual(emptyResult.totals, [])

  const unnamed = createBilling({
    ctx,
    now: () => 1,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          code: 0,
          data: {
            biz_code: 0,
            biz_data: {
              data: [{
                currency: 'CNY',
                series: [{
                  api_key: { tracking_id: 'tracking-secret-value', key_type: 'NORMAL', sensitive_id: 'sk-hidden' },
                  model: 'deepseek-flash',
                  buckets: [{ time: 0, cost: '1' }],
                }],
              }],
            },
          },
        }
      },
    }),
  })
  const unnamedResult = await unnamed.platform({ timezoneOffsetSeconds: 0 })
  assert.equal(unnamedResult.status, 'ready')
  assert.match(unnamedResult.keys[0].label, /^key-[0-9a-f]{6}$/)
  assert.equal(JSON.stringify(unnamedResult).includes('tracking-secret-value'), false)
  assert.equal(JSON.stringify(unnamedResult).includes('sk-hidden'), false)
})

test('Platform spend fails closed on biz_code, schema, or malformed buckets', async () => {
  const grant = {
    get: (name) => name === 'credentials' ? {
      async readRecord() { return { kind: 'grant', payload: { token: 't', issuer: 'https://platform.deepseek.com' } } },
    } : undefined,
  }
  const run = async (payload) => {
    const billing = createBilling({
      ctx: grant,
      now: () => 1,
      fetchImpl: async () => ({ ok: true, async json() { return payload } }),
    })
    return billing.platform({ timezoneOffsetSeconds: 0 })
  }
  assert.equal((await run({ code: 0, data: { biz_code: 1, biz_data: null } })).status, 'failed')
  assert.equal((await run({ code: 0, data: { biz_code: 0, biz_data: {} } })).status, 'failed')
  assert.equal((await run({ code: 0, data: { biz_code: 0, biz_data: { data: [{ currency: 'CNY' }] } } })).status, 'failed')
  assert.equal((await run({ code: 0, data: { biz_code: 0, biz_data: { data: [{
    currency: 'CNY',
    series: [{ api_key: { name: 'A' }, model: 'm', buckets: [{ time: 0 }] }],
  }] } } })).status, 'failed')
})

test('Platform spend kill switch disables the private endpoint entirely', async () => {
  let fetched = 0
  const billing = createBilling({
    ctx: {
      get: (name) => name === 'credentials' ? {
        async readRecord() { throw new Error('must not read credentials when disabled') },
      } : undefined,
    },
    now: () => 1,
    platformSpend: false,
    fetchImpl: async () => { fetched += 1; throw new Error('must not fetch') },
  })
  const result = await billing.platform({ timezoneOffsetSeconds: 0 })
  assert.equal(result.status, 'disabled')
  assert.equal(fetched, 0)
  const summary = await billing.summary({ timezoneOffsetSeconds: 0 })
  assert.equal(summary.platform.status, 'disabled')
})

test('Platform money cache is keyed by day and timezone', async () => {
  let stamp = Date.parse('2026-11-14T06:00:00Z')
  let calls = 0
  const ctx = {
    get: (name) => name === 'credentials' ? {
      async readRecord() { return { kind: 'grant', payload: { token: 't', issuer: 'https://platform.deepseek.com' } } },
    } : undefined,
  }
  const billing = createBilling({
    ctx,
    now: () => stamp,
    platformTtlMs: 60 * 60_000,
    fetchImpl: async () => {
      calls += 1
      return { ok: true, async json() { return { code: 0, data: { biz_code: 0, biz_data: { data: [] } } } } }
    },
  })
  await billing.platform({ timezoneOffsetSeconds: 28_800 })
  await billing.platform({ timezoneOffsetSeconds: 28_800 })
  assert.equal(calls, 1)
  await billing.platform({ timezoneOffsetSeconds: 0 })
  assert.equal(calls, 2)
  stamp += 86_400_000
  await billing.platform({ timezoneOffsetSeconds: 28_800 })
  assert.equal(calls, 3)
})

test('serialized summary never contains sensitive key or tracking values', async () => {
  const now = Date.parse('2026-11-14T06:00:00Z')
  const ctx = {
    get(name) {
      if (name === 'deepseekAccount') {
        return { async getBalance() { return { status: 'ready', value: [{ currency: 'CNY', balance: '1.00' }], bonusWallets: [] } } }
      }
      if (name === 'sessionPersistence') {
        return { async list() { return [] } }
      }
      if (name === 'credentials') {
        return {
          async readRecord() { return { kind: 'grant', payload: { token: 'grant-secret', issuer: 'https://platform.deepseek.com' } } },
        }
      }
      return undefined
    },
  }
  const billing = createBilling({
    ctx,
    now: () => now,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          code: 0,
          data: {
            biz_code: 0,
            biz_data: {
              data: [{
                currency: 'CNY',
                series: [{
                  api_key: {
                    tracking_id: 'tracking-secret-value-1234567890',
                    name: 'Harness',
                    key_type: 'DSH',
                    sensitive_id: 'sk-super-secret',
                    valid: true,
                  },
                  model: 'deepseek-flash',
                  buckets: [{ time: Math.floor(now / 1000), cost: '1.25' }],
                }],
              }],
            },
          },
        }
      },
    }),
  })
  const summary = await billing.summary({ locale: 'zh-CN', timezoneOffsetSeconds: 28_800 })
  assert.equal(summary.platform.status, 'ready')
  const text = JSON.stringify(summary)
  for (const forbidden of ['sensitive_id', 'sk-super-secret', 'tracking-secret-value', 'grant-secret', 'tracking_id']) {
    assert.equal(text.includes(forbidden), false, forbidden)
  }
  assert.match(text, /Harness/)
  assert.match(text, /1\.25/)
})

test('the key list includes a recently active key with zero spend today', async () => {
  const now = Date.parse('2026-11-14T06:00:00Z')
  const today = Math.floor(now / 1000)
  const yesterday = today - 86_400
  const ctx = {
    get: (name) => name === 'credentials' ? {
      async readRecord() { return { kind: 'grant', payload: { token: 't', issuer: 'https://platform.deepseek.com' } } },
    } : undefined,
  }
  const billing = createBilling({
    ctx,
    now: () => now,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          code: 0,
          data: {
            biz_code: 0,
            biz_data: {
              data: [{
                currency: 'CNY',
                series: [
                  { api_key: { tracking_id: 'a', name: 'Active' }, model: 'deepseek-flash', buckets: [{ time: today, cost: '2' }] },
                  { api_key: { tracking_id: 'b', name: 'YesterdayOnly' }, model: 'deepseek-flash', buckets: [{ time: yesterday, cost: '9' }] },
                ],
              }],
            },
          },
        }
      },
    }),
  })
  const result = await billing.platform({ timezoneOffsetSeconds: 28_800 })
  assert.equal(result.status, 'ready')
  assert.deepEqual(result.keys.map((key) => key.label), ['Active', 'YesterdayOnly'])
  assert.equal(result.keys[0].cost, 2)
  assert.equal(result.keys[1].cost, 0)
  assert.deepEqual(result.totals, [{ currency: 'CNY', cost: 2 }])
})

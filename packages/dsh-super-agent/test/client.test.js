import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'

/** Load the browser module and return its plugin object. */
async function loadPlugin({ markdown = true, openWidget = false } = {}) {
  const code = await readFile(join(import.meta.dirname, '..', 'client.js'), 'utf8')
  let definition
  const window = { __ModuleLoader__: { load(value) { definition = value } } }
  vm.runInNewContext(code, { window, console, Date, Math, JSON, Array, Object, String, Number, RegExp, Intl }, { filename: 'client.js' })
  assert.ok(definition, 'client.js registered a module')
  assert.equal(definition.id, '@local/dsh-super-agent')
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [openWidget ? true : typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
    Component: class {
      constructor(props) { this.props = props; this.state = {} }
      setState(value) { this.state = { ...this.state, ...value } }
    },
    Fragment: 'Fragment',
  }
  const MarkdownText = function MarkdownText(props) {
    return { type: 'MarkdownText', props, children: [] }
  }
  const plugin = definition.factory((name) => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      if (markdown) return { MarkdownText }
      throw new Error('markdown primitive unavailable')
    }
    throw new Error(`unexpected require: ${name}`)
  })
  return plugin
}

const event = (type, data, time = 1) => ({ type: 'event', event: { type, data, time, seq: time } })

test('the client registers a main panel and a sidebar entry above Plugins', async () => {
  const plugin = await loadPlugin()
  const registered = []
  const effectCleanups = []
  const ctx = {
    effect(callback) { effectCleanups.push(callback()); return () => {} },
    locale: {
      register(namespace, dictionaries) { registered.push({ kind: 'locale', namespace, dictionaries }) },
      bind() { return (key) => key },
    },
    slots: {
      inject(name, callback) { callback(); return () => {} },
      register(options, component) { registered.push({ kind: 'slot', options, component }); return () => {} },
    },
  }
  plugin.apply(ctx)
  const locale = registered.find((item) => item.kind === 'locale')
  assert.equal(locale.namespace, 'dshSuperAgent')
  assert.ok(locale.dictionaries.zh.title)
  assert.ok(locale.dictionaries.en.title)
  const main = registered.find((item) => item.kind === 'slot' && item.options.name === 'main')
  assert.equal(main.options.key, 'superagent')
  const child = main.options.children['superagent.conversation']
  assert.equal(child.kind, 'single')
  assert.equal(child.scope, 'session')
  const embedded = registered.find((item) => item.kind === 'slot' && item.options.name === 'superagent.conversation')
  assert.ok(embedded, 'the embedded stock conversation slot is registered')
  assert.equal(typeof embedded.component, 'function')
  const sidebar = registered.find((item) => item.kind === 'slot' && item.options.name === 'sidebar.panellist')
  assert.equal(sidebar.options.id, 'superagent')
  assert.equal(sidebar.options.order, -10)
  assert.equal(sidebar.options.label(), 'title')
  assert.equal(typeof sidebar.component, 'function')
})

test('every locale has the same visible keys', async () => {
  const plugin = await loadPlugin()
  const { zh, en } = plugin.__internals.DICT
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  for (const [key, value] of Object.entries(zh)) assert.equal(typeof value, 'string', key)
})

test('message text extraction ignores non-text blocks', async () => {
  const plugin = await loadPlugin()
  const { textOfMessage } = plugin.__internals
  assert.equal(textOfMessage({ content: [{ type: 'text', text: 'a' }, { type: 'tool-call', name: 'x' }, { type: 'text', text: 'b' }] }), 'a\nb')
  assert.equal(textOfMessage(undefined), '')
})

test('transcriptRows turns events into user, notice, assistant, tool, and error rows', async () => {
  const plugin = await loadPlugin()
  const { transcriptRows } = plugin.__internals
  const entries = [
    event('system/message', { message: { content: [{ type: 'text', text: 'system' }] } }),
    event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }, 2),
    event('user/message', { source: { kind: 'plugin', plugin: 'dsh-super-agent', form: 'notice', summary: 'Worker finished' }, content: [{ type: 'text', text: 'done' }] }, 3),
    event('assistant/message', { message: { content: [{ type: 'text', text: 'on it' }] } }, 4),
    event('tool/call', { callId: 'c1', name: 'superagent_dispatch_task', arguments: JSON.stringify({ title: 'Write hello', workspace: '/tmp/x' }) }, 5),
    event('tool/result', { message: { toolCallId: 'c1', content: [{ type: 'text', text: '{"ok":true}' }] } }, 6),
    event('turn/end', { reason: { kind: 'error', error: { message: 'boom' } } }, 7),
    event('turn/end', { reason: { kind: 'aborted' } }, 8),
  ]
  const rows = transcriptRows(entries, (key) => key === 'failedTurn' ? 'failed' : key === 'stoppedTurn' ? 'stopped' : key)
  assert.deepEqual(Array.from(rows, (row) => row.kind), ['user', 'notice', 'assistant', 'tool', 'error', 'notice'])
  assert.equal(rows[0].text, 'hello')
  assert.equal(rows[1].summary, 'Worker finished')
  assert.equal(rows[2].text, 'on it')
  assert.equal(rows[3].name, 'superagent_dispatch_task')
  assert.match(rows[3].detail, /Write hello/)
  assert.equal(rows[3].status, 'done')
  assert.equal(rows[3].output, '{"ok":true}')
  assert.equal(rows[4].text, 'boom')
  assert.equal(rows[5].summary, 'stopped')
})

test('history groups workers under their parent and keeps orphans separate', async () => {
  const plugin = await loadPlugin()
  const { groupConversations } = plugin.__internals
  const conversations = [
    { id: 's1', kind: 'super', updatedAt: 10 },
    { id: 's2', kind: 'super', updatedAt: 20 },
    { id: 'w1', kind: 'worker', parentId: 's1', updatedAt: 30 },
    { id: 'w2', kind: 'worker', parentId: 's1', updatedAt: 40 },
    { id: 'w3', kind: 'worker', parentId: 'missing', updatedAt: 50 },
  ]
  const { groups, orphans } = groupConversations(conversations)
  assert.deepEqual(groups.map((group) => group.parent.id), ['s2', 's1'])
  assert.deepEqual(groups[0].workers, [])
  assert.deepEqual(groups[1].workers.map((worker) => worker.id), ['w2', 'w1'])
  assert.deepEqual(orphans.map((worker) => worker.id), ['w3'])
})

test('usage formatting is compact, currency-aware, and honest about missing data', async () => {
  const plugin = await loadPlugin()
  const { formatTokens, formatWallet, balanceText, totalUsageTokens, usageKeyRows, usageBreakdown } = plugin.__internals

  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(942), '942')
  assert.equal(formatTokens(12_345), '12.3k')
  assert.equal(formatTokens(4_500_000), '4.5M')
  assert.equal(formatTokens(2_000_000_000), '2B')

  assert.equal(formatWallet({ currency: 'CNY', balance: '12.34' }), '¥12.34')
  assert.equal(formatWallet({ currency: 'USD', balance: '1200.5' }), '$1,200.50')
  assert.equal(formatWallet({ currency: 'EUR', balance: '3' }), 'EUR 3.00')
  assert.equal(formatWallet(null), '—')

  assert.equal(balanceText(undefined), '—')
  assert.equal(balanceText({ status: 'signed-out' }), '—')
  assert.equal(balanceText({ status: 'failed' }), '—')
  assert.equal(balanceText({ status: 'ready', wallets: [] }), '—')
  assert.equal(balanceText({ status: 'ready', wallets: [{ currency: 'CNY', balance: '12.34' }] }), '¥12.34')

  assert.equal(totalUsageTokens(undefined), 0)
  assert.equal(totalUsageTokens({ status: 'failed' }), 0)
  assert.equal(totalUsageTokens({ status: 'ready', totalTokens: 0, keys: [{ totalTokens: 7 }, { totalTokens: 5 }] }), 12)

  const rows = usageKeyRows({
    status: 'ready',
    keys: [
      { provider: 'small', totalTokens: 5, requests: 1, inputTokens: 5 },
      { provider: 'large', providerName: 'DeepSeek', kind: 'account', totalTokens: 50, requests: 2, inputTokens: 25, outputTokens: 25, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ],
  })
  assert.deepEqual(rows.map((row) => row.provider), ['large', 'small'])
  assert.equal(rows[0].kind, 'account')
  assert.equal(rows[0].providerName, 'DeepSeek')

  const t = (key, values) => values && values.count !== undefined ? `${key}:${values.count}` : key
  assert.equal(
    usageBreakdown({ inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 2 }, t),
    'inputTokens 1.2k · outputTokens 300 · usageRequests:2',
  )
})

test('platform spend rows keep only names, opaque ids, and amounts', async () => {
  const plugin = await loadPlugin()
  const { formatMoney, platformRows, platformTotal } = plugin.__internals
  assert.equal(formatMoney(1.7, 'CNY'), '¥1.70')
  assert.equal(formatMoney(2, 'USD'), '$2.00')
  assert.equal(formatMoney(3, 'EUR'), 'EUR 3.00')
  assert.equal(formatMoney(null, 'CNY'), '—')

  const platform = {
    status: 'ready',
    totals: [
      { currency: 'CNY', cost: 3.7 },
      { currency: 'USD', cost: 0.5 },
    ],
    keys: [
      { id: 'b', label: 'Laptop', keyType: 'NORMAL', currency: 'CNY', cost: 2, models: ['deepseek-flash'], sensitive_id: 'sk-secret' },
      { id: 'a', label: 'Harness', keyType: 'DSH', currency: 'CNY', cost: 1.7, models: ['deepseek-flash'] },
    ],
  }
  const rows = platformRows(platform)
  assert.deepEqual(rows.map((row) => row.label), ['Laptop', 'Harness'])
  assert.equal(Object.hasOwn(rows[0], 'sensitive_id'), false)
  const total = platformTotal(platform)
  assert.equal(total.currency, 'CNY')
  assert.equal(total.cost, 3.7)
  assert.equal(platformTotal({ status: 'ready', totals: [], keys: [{ id: 'x', currency: 'USD', cost: 1 }] }).currency, 'USD')
  assert.equal(platformTotal({ status: 'signed-out' }), undefined)

  assert.deepEqual(platformRows({ status: 'ready', keys: [], totals: [] }), [])
  assert.equal(platformRows({ status: 'ready', keys: [{ id: 'one', label: 'Only', currency: 'CNY', cost: 1 }], totals: [] }).length, 1)
  assert.equal(platformRows({ status: 'ready', keys: [
    { id: '1', label: 'A', currency: 'CNY', cost: 1 },
    { id: '2', label: 'B', currency: 'CNY', cost: 2 },
    { id: '3', label: 'C', currency: 'CNY', cost: 3 },
  ], totals: [] }).length, 3)
})

test('the usage widget renders em dashes without data and a compact total with data', async () => {
  const plugin = await loadPlugin()
  const { UsageWidget } = plugin.__internals
  const t = (key) => key

  const empty = UsageWidget({ t, usage: { status: 'error', data: undefined }, now: 1 })
  assert.equal(empty.props.className, 'sa-usage')
  assert.equal(empty.children[0].props.className, 'sa-chip sa-usage-chip sa-usage-balance')
  assert.equal(empty.children[0].children[0].children[0], '—')
  assert.equal(empty.children[1].children[1].children[0], '—')

  const ready = UsageWidget({
    t,
    now: 2,
    usage: {
      status: 'ready',
      data: {
        balance: { status: 'ready', wallets: [{ currency: 'CNY', balance: '12.34' }], bonusWallets: [], fetchedAt: 1 },
        usage: { status: 'ready', totalTokens: 1500, keys: [{ provider: 'deepseek-official', providerName: 'DeepSeek', kind: 'api-key', totalTokens: 1500 }] },
        platform: {
          status: 'ready',
          totals: [{ currency: 'CNY', cost: 3.73 }],
          keys: [{ id: 'k', label: 'Harness', keyType: 'DSH', currency: 'CNY', cost: 3.73, models: ['deepseek-flash'] }],
        },
        generatedAt: 2,
      },
    },
  })
  assert.equal(ready.children[0].children[0].children[0], '¥12.34')
  assert.equal(ready.children[1].children[0].children[0], 'today')
  assert.equal(ready.children[1].children[1].children[0], '¥3.73')

  const tokensOnly = UsageWidget({
    t,
    now: 2,
    usage: {
      status: 'ready',
      data: {
        balance: { status: 'failed', wallets: [], bonusWallets: [], fetchedAt: 1 },
        usage: { status: 'ready', totalTokens: 1500, keys: [] },
        platform: { status: 'unavailable', keys: [], totals: [] },
        generatedAt: 2,
      },
    },
  })
  assert.equal(tokensOnly.children[0].children[0].children[0], '—')
  assert.equal(tokensOnly.children[1].children[0].children[0], 'last24h')
  assert.equal(tokensOnly.children[1].children[1].children[0], '1.5k')
})

test('relative time and tool details are localizable and compact', async () => {
  const plugin = await loadPlugin()
  const { relativeTime, toolDetail, basename } = plugin.__internals
  const t = (key, values) => values && values.count !== undefined ? `${key}:${values.count}` : key
  assert.equal(relativeTime(Date.now(), t, Date.now() + 1000), 'justNow')
  assert.equal(relativeTime(Date.now() - 5 * 60_000, t, Date.now()), 'minutesAgo:5')
  assert.equal(relativeTime(Date.now() - 3 * 3_600_000, t, Date.now()), 'hoursAgo:3')
  assert.equal(toolDetail('superagent_dispatch_task', { title: 'Write hello', workspace: '/tmp/x' }), 'Write hello · /tmp/x')
  assert.equal(toolDetail('superagent_report_progress', { summary: 'Tests pass' }), 'Tests pass')
  assert.equal(basename('/Users/me/Projects/dsh'), 'dsh')
  assert.equal(basename('C:\\Users\\me\\project'), 'project')
})

test('assistant Markdown reuses the stock primitive with localized chrome labels', async () => {
  const plugin = await loadPlugin()
  const { renderMarkdown, markdownLabels } = plugin.__internals
  const t = (key) => key
  const source = '# Title\n\n**bold** and `code`\n\n- one\n- two\n\n[link](https://example.com)\n\n```js\nconst x = 1\n```'
  const element = renderMarkdown(t, source)
  assert.equal(element.type.name, 'MarkdownText')
  assert.equal(element.props.text, source)
  assert.equal(element.props.variant, 'body')
  assert.equal(element.props.streaming, false)
  assert.deepEqual(element.props.labels, markdownLabels(t))
  assert.equal(element.props.labels.code.copyLabel, 'copy')
  assert.equal(element.props.labels.code.copiedLabel, 'copied')
  assert.equal(element.props.labels.code.toolbarLabels.codeLabel, 'codeBlock')
  assert.equal(element.props.labels.footnotes, 'footnotes')
  assert.equal(Object.hasOwn(element.props, 'dangerouslySetInnerHTML'), false)
  assert.equal(renderMarkdown(t, 'progress', { variant: 'compact' }).props.variant, 'compact')
})

test('the Markdown fallback keeps fenced code intact and model text as React children', async () => {
  const plugin = await loadPlugin({ markdown: false })
  assert.equal(plugin.__internals.hasMarkdownRenderer, false)
  const parts = plugin.__internals.renderMarkdown((key) => key, 'before\n```js\n<script>alert(1)</script>\n```\nafter')
  assert.ok(Array.isArray(parts))
  const code = parts.find((part) => part.type === 'pre')
  assert.ok(code)
  assert.equal(code.children[0], '<script>alert(1)</script>')
  assert.equal(Object.hasOwn(code.props, 'dangerouslySetInnerHTML'), false)
  for (const part of parts) assert.equal(Object.hasOwn(part.props || {}, 'dangerouslySetInnerHTML'), false)
})

test('the client has no raw HTML sink for model text', async () => {
  const source = await readFile(join(import.meta.dirname, '..', 'client.js'), 'utf8')
  assert.equal(/dangerouslySetInnerHTML/.test(source), false)
  assert.equal(/\.innerHTML\s*=/.test(source), false)
  assert.match(source, /require\('@deepseek-ai\/dsh-client-ui-primitives'\)/)
})

test('the stock chat flag defaults on and only explicit 0 disables it', async () => {
  const plugin = await loadPlugin()
  const { resolveStockChatFlag, STOCK_CHAT_KEY } = plugin.__internals
  assert.equal(STOCK_CHAT_KEY, 'dsh-super-agent:stock-chat')
  assert.equal(resolveStockChatFlag(null), true)
  assert.equal(resolveStockChatFlag('1'), true)
  assert.equal(resolveStockChatFlag('0'), false)
})

test('surface selection falls back for workers, loading, and missing stock props', async () => {
  const plugin = await loadPlugin()
  const { selectConversationSurface, SURFACE_STOCK, SURFACE_CUSTOM } = plugin.__internals
  const base = { flag: true, status: 'ready', kind: 'super', sessionId: 's1', chatSessionId: 's1', reference: {}, SessionProvider: () => {}, renderSlot: () => {} }
  assert.equal(selectConversationSurface(base), SURFACE_STOCK)
  assert.equal(selectConversationSurface({ ...base, flag: false }), SURFACE_CUSTOM)
  assert.equal(selectConversationSurface({ ...base, kind: 'worker' }), SURFACE_CUSTOM)
  assert.equal(selectConversationSurface({ ...base, status: 'loading' }), SURFACE_CUSTOM)
  assert.equal(selectConversationSurface({ ...base, status: 'error' }), SURFACE_CUSTOM)
  assert.equal(selectConversationSurface({ ...base, chatSessionId: 's2' }), SURFACE_CUSTOM)
  assert.equal(selectConversationSurface({ ...base, reference: undefined }), SURFACE_CUSTOM)
  assert.equal(selectConversationSurface({ ...base, SessionProvider: undefined }), SURFACE_CUSTOM)
  assert.equal(selectConversationSurface({ ...base, renderSlot: undefined }), SURFACE_CUSTOM)
})

test('worker activity summarizes active workers and latest progress', async () => {
  const plugin = await loadPlugin()
  const { workerActivity, clipText } = plugin.__internals
  const conversations = [
    { id: 's1', kind: 'super', parentId: null },
    { id: 'w1', kind: 'worker', parentId: 's1', title: 'Build', status: 'running', running: true, progress: [{ at: 10, text: 'compiling' }] },
    { id: 'w2', kind: 'worker', parentId: 's1', title: 'Tests', status: 'waiting', progress: [{ at: 20, text: 'all tests passed' }] },
    { id: 'w3', kind: 'worker', parentId: 'other', title: 'Other', status: 'running', running: true, progress: [{ at: 30, text: 'ignore me' }] },
  ]
  const activity = workerActivity(conversations, 's1')
  assert.deepEqual(activity.workers.map((worker) => worker.id), ['w1', 'w2'])
  assert.deepEqual(activity.active.map((worker) => worker.id), ['w1'])
  assert.equal(activity.latest.text, 'all tests passed')
  assert.equal(activity.latest.title, 'Tests')
  assert.equal(clipText('a\n  b'), 'a b')
  assert.equal(clipText('abcdef', 4), 'abc…')
})

test('the package injects the official stock conversation client packages', async () => {
  const plugin = await loadPlugin()
  const pkg = JSON.parse(await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8'))
  const inject = pkg.dsh.client.inject
  for (const name of [
    '@deepseek-ai/dsh-api-session-controller',
    '@deepseek-ai/dsh-client-ui-chat',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-session',
  ]) assert.ok(inject.includes(name), `${name} is injected`)
  assert.equal(plugin.__internals.resolveStockChatFlag('0'), false)
})

test('the embedded conversation calls the stock content factory with the embedded Chat view', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const result = plugin.__internals.EmbeddedConversation({
    sessionId: 's1',
    fallback: 'fallback',
    useSession: () => ({ blank: false, awaitingFirstTurn: false, running: true, openState: 'open' }),
    useConversation: () => ({ activeTargets: new Set() }),
    useSessions: () => ({ byId: { s1: { blank: false } } }),
    renderFactorySlot: (...args) => { calls.push(args); return 'rendered' },
  })
  assert.equal(result, 'rendered')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'conversation.content')
  assert.equal(calls[0][1].variant, 'embedded')
  assert.equal(typeof calls[0][2].slots.views, 'function')
  assert.equal(calls[0][2].fallback, 'fallback')
})

test('pending helpers keep only unanswered decisions and persist section collapse state', async () => {
  const plugin = await loadPlugin()
  const { unresolvedPending, answeredCardAfterDismiss, readRailExpanded, writeRailExpanded, RAIL_SECTION_KEYS, RAIL_VISIBLE_KEY, PENDING_ANSWER_DISMISS_MS } = plugin.__internals
  const pending = [
    { id: 'old', question: 'Old?', created_at: 10, resolved_at: null },
    { id: 'done', question: 'Done?', created_at: 20, resolved_at: 30, answer: 'yes' },
    { id: 'new', question: 'New?', created_at: 40, resolved_at: undefined },
    { id: '', question: 'No id', created_at: 50 },
  ]
  assert.deepEqual(unresolvedPending(pending).map((item) => item.id), ['new', 'old'])
  assert.equal(unresolvedPending(undefined).length, 0)
  assert.equal(answeredCardAfterDismiss('item-a', 'item-a'), '')
  assert.equal(answeredCardAfterDismiss('item-b', 'item-a'), 'item-b')
  assert.equal(answeredCardAfterDismiss('', 'item-a'), '')
  assert.ok(PENDING_ANSWER_DISMISS_MS >= 500 && PENDING_ANSWER_DISMISS_MS <= 5000)

  assert.equal(RAIL_SECTION_KEYS.conversations, 'dsh-super-agent:rail:conversations')
  assert.equal(RAIL_SECTION_KEYS.pending, 'dsh-super-agent:rail:pending')
  assert.notEqual(RAIL_SECTION_KEYS.conversations, RAIL_SECTION_KEYS.pending)
  assert.equal(RAIL_VISIBLE_KEY, 'dsh-super-agent:rail')

  const values = new Map()
  const storage = { getItem: (key) => values.has(key) ? values.get(key) : null, setItem: (key, value) => values.set(key, value) }
  assert.equal(readRailExpanded(storage, RAIL_SECTION_KEYS.conversations), true)
  assert.equal(readRailExpanded(storage, RAIL_SECTION_KEYS.pending), true)
  writeRailExpanded(storage, RAIL_SECTION_KEYS.pending, false)
  assert.equal(values.get(RAIL_SECTION_KEYS.pending), '0')
  assert.equal(readRailExpanded(storage, RAIL_SECTION_KEYS.pending), false)
  assert.equal(readRailExpanded(storage, RAIL_SECTION_KEYS.conversations), true)
  writeRailExpanded(storage, RAIL_SECTION_KEYS.pending, true)
  assert.equal(readRailExpanded(storage, RAIL_SECTION_KEYS.pending), true)

  const broken = { getItem() { throw new Error('closed') }, setItem() { throw new Error('closed') } }
  assert.equal(readRailExpanded(broken, RAIL_SECTION_KEYS.pending), true)
  assert.doesNotThrow(() => writeRailExpanded(broken, RAIL_SECTION_KEYS.pending, false))
})

test('the rail renders conversations above the pending section and collapses them independently', async () => {
  const plugin = await loadPlugin()
  const { HistoryRail } = plugin.__internals
  const t = (key, values) => values && values.count !== undefined ? `${key}:${values.count}` : key
  const data = { conversations: [{ id: 's1', kind: 'super', title: 'Super Agent', workspacePath: '/tmp/x', status: 'idle', updatedAt: 1 }] }
  const pending = [
    { id: 'p1', conversation_id: 's1', question: 'Choose?', context: 'Context', options: ['A', 'B'], created_at: 2, resolved_at: null },
    { id: 'p2', conversation_id: 's1', question: 'Answered?', created_at: 3, resolved_at: 4, answer: 'yes' },
  ]
  const base = {
    t, data, selectedId: 's1', now: 10, onSelect: () => {}, onNew: () => {}, onRefresh: () => {}, onClose: () => {},
    pending, pendingExpandedId: '', onOpenPending: () => {},
  }
  const tree = HistoryRail({ ...base, expanded: {} })
  const sections = tree.children[1].children
  assert.deepEqual(sections.map((section) => section.props['data-rail-section']), ['conversations', 'pending'])
  assert.equal(sections[0].props.className.includes('conversations'), true)
  assert.equal(sections[1].props.className.includes('pending'), true)
  const pendingSection = sections[1]
  assert.equal(pendingSection.props.className.includes('expanded'), true)
  const pendingHead = pendingSection.children[0]
  assert.equal(pendingHead.props.section, 'pending')
  assert.equal(pendingHead.props.expanded, true)
  assert.equal(pendingHead.props.count, 1, 'answered items are removed from the pending count')
  const pendingRows = pendingSection.children[1].children[1]
  assert.equal(pendingRows.length, 1)
  assert.equal(pendingRows[0].props.item.id, 'p1')
  assert.equal(pendingRows[0].props.item.question, 'Choose?')
  assert.equal(pendingRows[0].props.item.resolved_at, null)
  const text = JSON.stringify(pendingSection)
  assert.equal(text.includes('Answered?'), false, 'answered items disappear from the rail')

  const collapsedConversations = HistoryRail({ ...base, expanded: { conversations: false } })
  const both = collapsedConversations.children[1].children
  assert.equal(both[0].props.className.includes('collapsed'), true)
  assert.equal(both[0].children.some((child) => child && child.props && child.props.className === 'sa-rail-section-list'), false,
    'only the section header remains when collapsed')
  assert.equal(both[1].props.className.includes('expanded'), true, 'pending stays independent')
  assert.equal(both[0].children[0].props.section, 'conversations', 'the section header stays visible')
  assert.equal(both[0].children[0].props.expanded, false)
  assert.equal(JSON.stringify(both[0]).includes('"sa-rail-section-list"'), false)

  const collapsedPending = HistoryRail({ ...base, expanded: { pending: false } })
  const pendingCollapsed = collapsedPending.children[1].children
  assert.equal(pendingCollapsed[1].props.className.includes('collapsed'), true)
  assert.equal(pendingCollapsed[1].children.some((child) => child && child.props && child.props.className === 'sa-rail-section-list'), false)
  assert.equal(JSON.stringify(pendingCollapsed[1]).includes('Choose?'), false)
})

test('the inline pending card renders options, free text, and an answered state', async () => {
  const plugin = await loadPlugin()
  const { PendingQuestionCard, toolDetail } = plugin.__internals
  const t = (key, values) => values && values.count !== undefined ? `${key}:${values.count}` : key
  const item = { id: 'p1', question: 'Which channel?', context: 'Both builds exist.', options: ['stable', 'beta'] }

  const open = PendingQuestionCard({ t, item, answer: '', onAnswer: async () => {}, onDismiss: () => {} })
  assert.equal(open.props['data-sa-pending-card'], 'p1')
  assert.equal(open.props['data-state'], 'open')
  const openText = JSON.stringify(open)
  assert.match(openText, /Which channel\?/)
  assert.match(openText, /Both builds exist\./)
  assert.match(openText, /stable/)
  assert.match(openText, /beta/)
  assert.match(openText, /textarea/)
  assert.match(openText, /pendingSubmit/)
  assert.match(openText, /pendingDismiss/)

  const answered = PendingQuestionCard({ t, item, answer: 'beta', onAnswer: async () => {}, onDismiss: () => {} })
  assert.equal(answered.props['data-state'], 'answered')
  const answeredText = JSON.stringify(answered)
  assert.match(answeredText, /pendingAnswered/)
  assert.match(answeredText, /beta/)
  assert.equal(answeredText.includes('textarea'), false)
  assert.equal(answeredText.includes('sa-pending-options'), false)
  assert.equal(answeredText.includes('pendingDismiss'), false, 'the X is only for unanswered cards')

  assert.equal(toolDetail('superagent_pending_decision', { action: 'create', question: 'Which channel?' }), 'create · Which channel?')
  assert.equal(toolDetail('superagent_pending_decision', { action: 'resolve', id: 'p1' }), 'resolve · p1')
})

test('the usage request carries the active locale and a numeric timezone offset', async () => {
  const plugin = await loadPlugin()
  const { usageRequestPath } = plugin.__internals
  const path = usageRequestPath({ locale: { getSnapshot: () => ({ active: 'zh-CN' }) } })
  assert.match(path, /^\/usage\?locale=zh-CN&tz=-?\d+$/)
  assert.match(usageRequestPath({}), /^\/usage\?locale=en&tz=-?\d+$/)
  assert.match(usageRequestPath({ locale: { getSnapshot() { throw new Error('closed') } } }), /^\/usage\?locale=en&tz=-?\d+$/)
})

test('the open usage popover renders Platform and local rows without throwing', async () => {
  const plugin = await loadPlugin({ openWidget: true })
  const t = (key, values) => values && values.count !== undefined ? `${key}:${values.count}` : key
  const tree = plugin.__internals.UsageWidget({
    t,
    now: Date.now(),
    usage: {
      status: 'ready',
      data: {
        balance: { status: 'ready', wallets: [{ currency: 'CNY', balance: '12.34' }], bonusWallets: [{ currency: 'CNY', balance: '1' }] },
        usage: {
          status: 'ready',
          partial: true,
          totalTokens: 273_194_717,
          keys: [{
            provider: 'deepseek-official', providerName: 'DeepSeek', kind: 'api-key',
            totalTokens: 273_194_717, inputTokens: 593_488, outputTokens: 703_629,
            cacheReadTokens: 271_897_600, requests: 773, lastAt: Date.now() - 1_000,
            models: ['deepseek-flash'],
          }],
        },
        platform: {
          status: 'ready',
          totals: [{ currency: 'CNY', cost: 3.0591 }],
          keys: [
            { id: 'abc', label: 'MacClaudeCode', keyType: 'NORMAL', currency: 'CNY', cost: 2.4242, models: ['deepseek-flash'] },
            { id: 'def', label: 'AutoQuant', keyType: 'NORMAL', currency: 'CNY', cost: 0.6349, models: ['deepseek-flash'] },
            { id: 'ghi', label: 'DeepSeek Harness', keyType: 'DSH', currency: 'CNY', cost: 0, models: ['deepseek-flash'] },
          ],
        },
        generatedAt: Date.now(),
      },
    },
  })
  assert.equal(tree.children[2].props.className, 'sa-usage-pop')
  const text = JSON.stringify(tree)
  assert.match(text, /MacClaudeCode/)
  assert.match(text, /AutoQuant/)
  assert.match(text, /DeepSeek Harness/)
  assert.match(text, /platformPrivateTag/)
  assert.match(text, /rollingLabel/)
  assert.match(text, /differentWindows/)
  assert.match(text, /apiKeysTitle/)
  assert.equal(text.includes('sensitive_id'), false)
  assert.equal(text.includes('tracking_id'), false)
  assert.match(text, /273M/)
  assert.match(text, /DeepSeek/)
  assert.match(text, /usagePartial/)
  assert.equal(text.includes('sk-'), false)
})

test('a disabled Platform endpoint falls back to the token chip and explains why', async () => {
  const plugin = await loadPlugin({ openWidget: true })
  const t = (key) => key
  const tree = plugin.__internals.UsageWidget({
    t,
    now: 1,
    usage: {
      status: 'ready',
      data: {
        balance: { status: 'ready', wallets: [{ currency: 'CNY', balance: '1.00' }], bonusWallets: [] },
        usage: { status: 'ready', totalTokens: 1000, keys: [] },
        platform: { status: 'disabled', keys: [], totals: [] },
        generatedAt: 1,
      },
    },
  })
  assert.equal(tree.children[1].children[0].children[0], 'last24h')
  assert.equal(tree.children[1].children[1].children[0], '1k')
  const text = JSON.stringify(tree)
  assert.match(text, /platformDisabled/)
  assert.match(text, /rollingLabel/)
  assert.match(text, /differentWindows/)
})

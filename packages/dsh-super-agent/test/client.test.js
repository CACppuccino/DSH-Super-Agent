import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'

/** Load the browser module and return its plugin object. */
async function loadPlugin({ markdown = true } = {}) {
  const code = await readFile(join(import.meta.dirname, '..', 'client.js'), 'utf8')
  let definition
  const window = { __ModuleLoader__: { load(value) { definition = value } } }
  vm.runInNewContext(code, { window, console, Date, Math, JSON, Array, Object, String, Number, RegExp, Intl }, { filename: 'client.js' })
  assert.ok(definition, 'client.js registered a module')
  assert.equal(definition.id, '@local/dsh-super-agent')
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
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

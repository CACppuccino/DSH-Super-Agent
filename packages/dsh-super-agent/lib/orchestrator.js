/**
 * Super Agent orchestration: create conversations and workspaces, dispatch
 * persistent worker sessions, and relay worker progress back into the Super
 * Agent conversation.
 *
 * The class receives every host dependency through its constructor so the
 * workflow can be tested without a running Harness. The host half in
 * `index.js` wires the real Cordis services in.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { PendingStore } from './pending.js'
import { MAX_TAG_CHARS, MAX_WORKER_TAGS, normalizeTags } from './state.js'

export const PLUGIN_NAME = 'dsh-super-agent'
const PROGRESS_LIMIT = 80
const MAX_NOTICE_CHARS = 4000

/** The Super Agent's fixed system prompt. */
export const SUPER_PROMPT = `You are the Super Agent: a persistent orchestrator. You do not operate the computer yourself.

Your job is to understand the request, plan, split it into worker tasks, dispatch, relay progress, and decide what to do next. Every host action belongs to a worker: shell commands, reading/writing/editing files, searching, builds, tests, git, scripts, browsing, log inspection, scheduling, and document or office work. Only pure conversation stays here: answering, clarifying, summarizing worker output, and dispatching follow-ups.

Tools:
- superagent_dispatch_task: start a new worker conversation. Always give it a short title, a complete self-contained brief, and either an existing workspace or a new workspace request. The worker persists after the task and can receive follow-ups.
- superagent_send_message: send a follow-up to an existing worker.
- superagent_list_workers: list workers and their live status.
- superagent_worker_output: read a worker's latest output and recent progress.
- superagent_worker_tags: set, add, remove, or list short tags on workers (up to ${MAX_WORKER_TAGS} per worker). Tags persist and help the user group and filter related work.
- superagent_stop_worker: stop a worker that is no longer needed.
- superagent_create_workspace: create a workspace without starting a worker. Prefer theme reuse; register a new workspace with superagent_workspaces assign.
- superagent_workspaces: inventory workspaces and proposed theme groups (action "list"), list the persisted theme registry (action "themes"), assign a theme to an existing workspace (action "assign"), or classify a task description into the best theme/workspace (action "suggest").
- superagent_create_conversation: open another Super Agent conversation for a separate long-running thread.
- superagent_list_conversations: list Super Agent conversations and workers.
- superagent_pending_decision: register a question the user must decide (action "create"), list unanswered decisions (action "list"), or mark one resolved (action "resolve"). The panel shows each unresolved decision inline with option buttons and a free-text answer, and returns the user's answer as a user message in this conversation.

Planning tools such as todo_write and the goal tools stay available; they do not touch the host.

Working rules:
1. Converse in the user's language. Greetings, explanations, and questions you can answer from context need no tools.
2. If a request needs any host action, dispatch a worker. Do not do it yourself, even when it looks small or faster.
3. Dispatch brief: give the worker a short title, a complete self-contained brief, and an existing workspace or a new workspace request. Include the goal, relevant paths, constraints, expected output, and how to report completion.
4. Workspace discipline: classify every task into one theme before dispatching (quant-research, dsh-plugin, infra-ops, memory, windows-node, backup, or a more specific theme). When unsure, call superagent_workspaces with action "suggest" or "themes". If suggest returns a proposed workspace for a known but unassigned theme, pass that workspace id to dispatch (or assign it first) instead of creating a directory. Always pass theme to superagent_dispatch_task. A theme with a registered workspace is reused automatically for a new worker conversation. Only request new_workspace when the work is a genuinely separate deliverable or the theme's workspace cannot hold it; if the theme is unknown or has no registered workspace, include a justification explaining why a new directory is needed. Never create a workspace silently: report the dispatch result's theme and workspace_created fields to the user.
5. After dispatch, tell the user which worker you started and what happens next. Do not claim work is done before a worker reports it.
6. Worker progress arrives as notices in this conversation. Relay only meaningful updates: a result, a blocker, a decision the user must make, or a notable milestone. Combine multiple notices into one short update.
7. If a worker asks a question, either answer it from the conversation context, send a follow-up, or ask the user. Do not invent an answer.
8. Keep the main conversation concise. Use superagent_worker_output when you need detail, and summarize it for the user.
9. A worker is a persistent conversation, not a subagent. It can receive multiple assignments.
10. Do not create a new Super Agent conversation unless the user asks for a separate thread or the work is clearly unrelated and long-running.
11. Delegation always goes through superagent_dispatch_task. One-shot subagent, workflow, teammate, and team-task tools are unavailable; those bypass the persistent worker conversation that this panel tracks.
12. You do not have an ask_user_question tool and its built-in cards are unavailable. When the user must choose, call superagent_pending_decision with action "create" plus the question, optional context, and options. Do not just write the question and any options as text and stop: the pending decision card is the interactive path, and the user's answer arrives as a user message in this conversation.
13. Use superagent_worker_tags to keep related workers organized when the user names a project, theme, or workstream. Tags are short (for example "quant", "dsh", "infra"); set or replace with action "set", append with "add", and list the current assignments with "list". The user can also edit them in the panel, and filters apply to the conversation list.`

/** The fixed system prompt for worker conversations. */
export const WORKER_PROMPT = `You are a worker agent launched by the Super Agent.

Work autonomously in the workspace you were given. The Super Agent, not the user, is your immediate audience.

- Use superagent_report_progress for meaningful progress, a blocker, a question, or a final result. Keep each report short and concrete.
- Work on the assignment in the conversation. Inspect the workspace before changing it, follow existing conventions, and verify your changes.
- If the assignment is ambiguous, make the smallest reasonable assumption and state it in your report. Ask the Super Agent only when the answer changes the work materially, using superagent_report_progress with status "question".
- Your final assistant message is relayed to the Super Agent. Include what changed, where, and what you verified; do not paste whole logs.
- Do not ask the user directly and do not use ask_user_question; it is unavailable in this conversation. Do not start unrelated work.`

/** Human-readable statuses used by the UI and notices. */
const STATUS = new Set(['dispatching', 'running', 'waiting', 'needs_input', 'failed', 'stopped', 'paused'])

/** Default classification when no theme is supplied or nothing matches. */
export const DEFAULT_THEME = 'misc'

/**
 * The proposed theme taxonomy. These are discovery defaults, not a closed
 * enum: `superagent_workspaces assign` can register any other theme id.
 *
 * Order matters for the keyword suggestion fallback: more specific themes
 * (memory, windows, backup) come before the broad research/plugin/ops groups.
 */
export const THEME_CATALOG = [
  {
    id: 'memory',
    title: 'Memory systems',
    description: 'Project memory, summaries, notes, Cloudflare sync, and second-Mac memory deployment.',
    keywords: ['memory', 'memories', 'cloudflare', 'sync', 'summary', 'summaries', 'notes', 'smartwork', 'phase4'],
  },
  {
    id: 'windows-node',
    title: 'Windows / node machine',
    description: 'Windows desktop, WSL/node feasibility, reachability, and cross-machine checks.',
    keywords: ['windows', 'win11', 'win10', 'powershell', 'wsl', 'cross-machine', 'reachability'],
  },
  {
    id: 'backup',
    title: 'Backup and recovery',
    description: 'Backups, archives, retention, restore checks, and rollback plans.',
    keywords: ['backup', 'restore', 'archive', 'retention', 'snapshot', 'rollback'],
  },
  {
    id: 'quant-research',
    title: 'Quant research',
    description: 'Quant strategies, data analysis, research pipelines, backtests, and market studies.',
    keywords: ['quant', 'quantresearch', 'backtest', 'strategy', 'alpha', 'market', 'trading', 'factor', 'sharpe', 'qr-'],
  },
  {
    id: 'dsh-plugin',
    title: 'DSH plugin development',
    description: 'DeepSeek Harness plugins, Super Agent panel, dsh-remote, iOS client, and plugin packaging.',
    keywords: ['dsh', 'superagent', 'super-agent', 'super agent', 'plugin', 'panel', 'harness', 'remote', 'ios'],
  },
  {
    id: 'infra-ops',
    title: 'Infrastructure and ops',
    description: 'Servers, networks, storage, health checks, deployment, and diagnostics.',
    keywords: ['infra', 'ops', 'network', 'wifi', 'lan', 'disk', 'storage', 'kioxia', 'runner', 'health', 'deploy', 'server', 'diagnosis'],
  },
  {
    id: DEFAULT_THEME,
    title: 'Miscellaneous',
    description: 'One-off tasks that do not belong to another theme.',
    keywords: [],
  },
]

/** Stop words ignored by the description-to-theme matcher. */
const THEME_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'task', 'work', 'worker', 'workers',
  'new', 'user', 'please', 'should', 'would', 'could', 'about', 'using', 'use', 'make', 'add', 'fix', 'project', 'projects', 'system', 'systems',
])

/** Match a free-form task text against the proposed taxonomy. */
export function suggestedThemeForText(text) {
  const haystack = String(text ?? '').toLowerCase()
  for (const theme of THEME_CATALOG) {
    if (theme.id === DEFAULT_THEME) continue
    if (theme.keywords.some((keyword) => keyword.length > 0 && haystack.includes(keyword))) return theme
  }
  return THEME_CATALOG.find((theme) => theme.id === DEFAULT_THEME)
}

/** A known taxonomy definition by id. */
export function themeDefinition(id) {
  return THEME_CATALOG.find((theme) => theme.id === id)
}

/** Normalize a free-form theme label to its stable registry id. */
export function normalizeThemeId(value, fallback = DEFAULT_THEME) {
  const text = String(value ?? '').trim()
  if (text.length === 0) return fallback
  return slugify(text, fallback)
}

/** Split text into meaningful lowercase matching terms. */
function themeTerms(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((term) => term.length >= 3 && !THEME_STOPWORDS.has(term))
}

/** Score one registered theme/workspace pair against a task description. */
function themeMatchScore(record, text) {
  const haystack = String(text ?? '').toLowerCase()
  let score = 0
  for (const [value, weight] of [
    [record.id, 5],
    [record.title, 3],
    [record.description, 2],
    [record.workspace?.title, 2],
    [basename(String(record.workspace?.path ?? '')), 1],
  ]) {
    for (const term of new Set(themeTerms(value))) {
      if (haystack.includes(term)) score += weight
    }
  }
  if (haystack.includes(String(record.id ?? '').toLowerCase())) score += 5
  return score
}

/**
 * Built-in tools the Super Agent must not call.
 *
 * The Super Agent is orchestration-only: every host action goes to a worker.
 * The list names this build's built-in execution and investigation tools;
 * names absent from the current preset are skipped by `denyTools`, and names
 * that appear later are denied by its `tools/change` retry.
 *
 * Deliberately not denied: the plugin's own `superagent_*` tools (scoped, so
 * restrictions do not apply) and planning/session tools that do not touch the
 * host: todo_write, create_goal, get_goal, update_goal, exit_plan_mode.
 */
export const SUPER_DENY = [
  // One-shot delegation and teams bypass the tracked worker sessions.
  'subagent', 'subagent_fork', 'send_message', 'list_agents', 'interrupt_agent', 'wait_agent',
  'workflow', 'ralph', 'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  // Shell and terminal execution.
  'bash', 'pwsh', 'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
  // Filesystem read, write, and patch.
  'read', 'write', 'edit', 'apply_patch', 'str_replace_editor', 'read_image',
  // Filesystem search.
  'glob', 'grep',
  // Background jobs.
  'job_list', 'job_output', 'job_kill',
  // Web browsing and fetching.
  'web_search', 'web_fetch',
  // Host state, environment, plugin, and runtime inspection.
  'working_directory', 'load_workspace_dependencies', 'plugin_manager',
  'cordis_inspect_list', 'cordis_inspect_query', 'create_worktree',
  // Session-log inspection.
  'session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read',
  // Scheduling mutates or inspects host state.
  'schedule_create', 'schedule_edit', 'schedule_delete', 'schedule_update', 'schedule_list', 'schedule_view',
  // Skills load host instructions; document and office work runs through them.
  'skill',
  // File presentation belongs to the worker that produced the files.
  'present',
  // The panel cannot render question cards; ask in plain text.
  'ask_user_question',
]

/** Workers report open questions to the Super Agent instead of asking the user directly. */
const WORKER_DENY = ['ask_user_question']

/** Short random suffix for session ids and directory names. */
const shortId = (length = 12) => randomUUID().replaceAll('-', '').slice(0, length)

/** A filesystem-safe slug. */
export function slugify(value, fallback = 'workspace') {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || fallback
}

/** Expand `~` and resolve a relative path against `base`. */
export function expandPath(value, base) {
  const text = String(value ?? '').trim()
  const expanded = text === '~' || text.startsWith('~/') ? join(homedir(), text.slice(1)) : text
  return resolve(base, expanded)
}

/** Collapse whitespace and cap a string for a compact notice. */
function clip(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

/** Extract text blocks from a message-like value. */
export function textOfMessage(message) {
  const content = message && typeof message === 'object' && Array.isArray(message.content) ? message.content : []
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** Extract the text of one session event that carries a message. */
function textOfEvent(event) {
  if (!event || typeof event !== 'object') return ''
  if (event.type === 'user/message') return textOfMessage(event.data)
  if (event.type === 'assistant/message') return textOfMessage(event.data?.message)
  return ''
}

/** Whether a worker's last output reads like a question to its caller. */
function looksLikeQuestion(text) {
  const last = String(text ?? '').trim().split('\n').at(-1) ?? ''
  return /[?？]\s*$/.test(last)
}

/** A safe tool output projection. */
const jsonOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

/** Build one tool definition with the shared JSON output projection. */
function tool(name, description, parameters, execute) {
  return { name, description, parameters, output: jsonOutput, execute }
}

/** A non-empty string argument. */
function requireString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} is required`)
  return value.trim()
}

/** Pick the dominant theme from a workspace's worker titles/tags, if any. */
function dominantWorkerTheme(workers) {
  const counts = new Map()
  for (const worker of Array.isArray(workers) ? workers : []) {
    const text = [worker.title, ...(Array.isArray(worker.tags) ? worker.tags : [])].join(' ')
    const theme = suggestedThemeForText(text)
    if (!theme || theme.id === DEFAULT_THEME) continue
    counts.set(theme.id, (counts.get(theme.id) || 0) + 1)
  }
  let winner = DEFAULT_THEME
  let best = 0
  for (const theme of THEME_CATALOG) {
    const count = counts.get(theme.id) || 0
    if (count > best) { best = count; winner = theme.id }
  }
  return winner
}

/**
 * Propose a theme for an inventory workspace. The workspace title and its own
 * basename win first (worker titles often include incidental words from other
 * themes); only a generic workspace falls back to its workers' dominant theme.
 */
function proposedThemeForWorkspace(record, workers, mainWorkspacePath) {
  if (record.path === mainWorkspacePath) return DEFAULT_THEME
  const own = suggestedThemeForText(`${record.title} ${basename(record.path)}`)
  if (own.id !== DEFAULT_THEME) return own.id
  return dominantWorkerTheme(workers)
}

/**
 * Choose a canonical workspace candidate for a proposed theme group.
 * Assigned themes win elsewhere; this is the fallback hint for the dry-run
 * consolidation plan. It prefers workspaces with worker history/artifacts and
 * penalizes shallow external parent directories such as ~/Projects.
 */
function chooseCanonicalWorkspace(items, themeId) {
  const list = Array.isArray(items) ? items : []
  const candidates = list.filter((workspace) => !workspace.protected)
  if (candidates.length === 0) return list[0]?.id
  const tokens = String(themeId ?? '').split('-').filter((token) => token.length >= 3)
  const score = (workspace) => {
    let value = workspace.workerCount * 2 + Math.min(workspace.directoryEntries, 30) / 10 + (workspace.activeWorkers > 0 ? 1 : 0)
    if (workspace.emptyDirectory) value -= 1.5
    if (workspace.missing) value -= 2
    const haystack = `${workspace.title} ${workspace.path}`.toLowerCase()
    if (tokens.some((token) => haystack.includes(token))) value += 1.5
    const depth = String(workspace.path ?? '').split('/').filter(Boolean).length
    if (depth <= 3 && !String(workspace.path ?? '').includes('.dsh')) value -= 6
    if (workspace.theme === themeId) value += 50
    return value
  }
  return candidates
    .slice()
    .sort((left, right) => score(right) - score(left) || right.lastActivity - left.lastActivity)[0]?.id
}

/** The Super Agent tool schemas. */
const DISPATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: 'Short task title shown in the conversation history.' },
    prompt: { type: 'string', description: 'Complete, self-contained brief for the worker. Include goal, workspace, constraints, and expected output.' },
    theme: { type: 'string', description: 'Topic/theme for this task (for example quant-research, dsh-plugin, infra-ops, memory, windows-node, backup). Dispatch reuses the theme\'s registered workspace unless new_workspace is explicit. Call superagent_workspaces first when unsure.' },
    workspace: { type: 'string', description: 'Existing workspace id, absolute path, or workspace title. A registered theme workspace takes precedence unless new_workspace is set.' },
    new_workspace: {
      type: 'object',
      additionalProperties: false,
      description: 'Explicitly request a fresh workspace. Prefer theme reuse; a new workspace for an unknown/unmapped theme also needs justification.',
      properties: {
        path: { type: 'string', description: 'Absolute or ~-relative directory. Omit to create one under the Super Agent state directory.' },
        title: { type: 'string', description: 'Display title for the workspace.' },
      },
    },
    justification: { type: 'string', description: 'Why a new workspace is genuinely needed when the theme is unknown or has no registered workspace. Never create silently.' },
  },
  required: ['title', 'prompt', 'theme'],
}

const CREATE_WORKSPACE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', description: 'Absolute or ~-relative directory to use as the workspace. Omit to create one under the Super Agent state directory.' },
    title: { type: 'string', description: 'Display title for the workspace.' },
  },
}

const CREATE_CONVERSATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: 'Title for the new Super Agent conversation.' },
    workspace_id: { type: 'string', description: 'Existing workspace id to host the conversation.' },
    path: { type: 'string', description: 'Absolute or ~-relative directory for a new workspace hosting the conversation.' },
  },
}

const WORKSPACES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['list', 'themes', 'assign', 'suggest', 'retire', 'reactivate'], description: 'list inventories SA workspaces and proposed groups; themes lists the persisted registry; assign maps a theme to a workspace; suggest matches a task description to the best theme/workspace; retire removes a workspace from the active list (metadata only); reactivate restores it.' },
    theme: { type: 'string', description: 'For assign: theme id or label, e.g. quant-research.' },
    workspace_id: { type: 'string', description: 'For assign: existing workspace id to make canonical for the theme.' },
    title: { type: 'string', description: 'For assign/suggest: optional human-readable theme title or task title.' },
    description: { type: 'string', description: 'For assign: theme description; for suggest: task description to classify.' },
    reason: { type: 'string', description: 'For retire: why the workspace is being removed from the active list (recorded for rollback/audit).' },
  },
  required: ['action'],
}

const LIST_WORKERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', description: 'Optional exact status filter: dispatching, running, waiting, needs_input, failed, stopped, paused.' },
  },
}

const SEND_MESSAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    worker_id: { type: 'string', description: 'Worker id returned by superagent_dispatch_task or superagent_list_workers.' },
    message: { type: 'string', description: 'Follow-up instruction or answer for the worker.' },
  },
  required: ['worker_id', 'message'],
}

const STOP_WORKER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    worker_id: { type: 'string', description: 'Worker id to stop.' },
    reason: { type: 'string', description: 'Optional short reason recorded with the stop.' },
  },
  required: ['worker_id'],
}

const WORKER_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    worker_id: { type: 'string', description: 'Worker id to read.' },
    limit: { type: 'number', description: 'Maximum recent progress entries to return, from 1 to 20. Defaults to 5.' },
  },
  required: ['worker_id'],
}

const WORKER_TAGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['set', 'add', 'remove', 'list'],
      description: 'set replaces a worker\'s tags; add appends; remove deletes the listed tags; list returns assignments without changing them.',
    },
    worker_id: { type: 'string', description: 'Worker id returned by superagent_dispatch_task or superagent_list_workers. Required for set, add, and remove; optional for list.' },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: `Short free-form labels. Trimmed and deduped case-insensitively; at most ${MAX_WORKER_TAGS} per worker and ${MAX_TAG_CHARS} characters each.`,
    },
  },
  required: ['action'],
}

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string', description: 'Short, concrete update for the Super Agent.' },
    status: { type: 'string', description: 'progress, blocked, question, or done. Defaults to progress.' },
  },
  required: ['summary'],
}

const PENDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['create', 'list', 'resolve'], description: 'create registers a question; list returns unanswered decisions; resolve marks one answered.' },
    question: { type: 'string', description: 'For create: the decision or question the user must answer.' },
    context: { type: 'string', description: 'For create: optional background, trade-offs, or details shown under the question.' },
    options: {
      type: 'array',
      items: { type: 'string' },
      description: 'For create: optional answer choices rendered as buttons. Omit for free text only.',
    },
    id: { type: 'string', description: 'For resolve: the pending decision id returned by create or list.' },
    answer: { type: 'string', description: 'For resolve: the answer to record.' },
    include_resolved: { type: 'boolean', description: 'For list: include already answered decisions. Defaults to false.' },
  },
  required: ['action'],
}

const EMPTY_SCHEMA = { type: 'object', additionalProperties: false, properties: {} }

/**
 * Coordinates the Super Agent and worker conversations.
 */
export class Orchestrator {
  /**
   * @param {object} options
   * @param {import('@deepseek-ai/cordis').Context} options.ctx
   * @param {import('./state.js').StateStore} options.store
   * @param {string} options.stateDir
   * @param {import('./pending.js').PendingStore} [options.pendingStore]
   * @param {() => number} [options.now]
   */
  constructor({ ctx, store, stateDir, pendingStore, now = () => Date.now() }) {
    this.ctx = ctx
    this.store = store
    this.stateDir = stateDir
    this.now = now
    this.pending = pendingStore || new PendingStore(join(stateDir, 'pending.json'), { now })
    this.decorated = new WeakSet()
    this.bindings = new Map()
    this.sessionLocks = new Map()
    this.decorationErrors = []
    this.runtimeErrors = []
  }

  /** Load durable state, downgrade orphaned statuses, and re-decorate live agents. */
  async load() {
    await Promise.all([this.store.load(), this.pending.load()])
    let changed = false
    for (const conversation of Object.values(this.store.current.conversations)) {
      if (conversation.status === 'running') {
        conversation.status = 'waiting'
        changed = true
      }
      if (conversation.status === 'dispatching') {
        conversation.status = 'paused'
        changed = true
      }
    }
    // Persist the known taxonomy definitions even before they are assigned a
    // workspace, so descriptions and theme ids survive restarts.
    for (const definition of THEME_CATALOG) {
      if (this.store.theme(definition.id)) continue
      this.store.current.themes[definition.id] = {
        id: definition.id,
        title: definition.title,
        description: definition.description,
        workspaceId: '',
        createdAt: this.now(),
        updatedAt: this.now(),
      }
      changed = true
    }
    if (changed) await this.store.persist()
    for (const conversation of Object.values(this.store.current.conversations)) {
      const agent = this.ctx.agents?.get?.(conversation.id)
      if (agent) this.decorate(agent)
    }
    return this
  }

  /** Release every prompt and tool registration this instance added to live agents. */
  dispose() {
    for (const [agent, disposers] of this.bindings) {
      for (const dispose of disposers) {
        try { dispose() } catch { /* a disposed agent already removed its scope */ }
      }
      this.decorated.delete(agent)
    }
    this.bindings.clear()
  }

  /** Release one agent's registrations when its scope is disposed. */
  onAgentDisposed(agent) {
    const disposers = this.bindings.get(agent)
    if (!disposers) return
    for (const dispose of disposers) {
      try { dispose() } catch { /* ignore a scope that is already gone */ }
    }
    this.bindings.delete(agent)
    this.decorated.delete(agent)
  }

  /** Create the first Super Agent conversation when none exists. */
  async bootstrap() {
    if (!this.store.latestSuper()) await this.createConversation({ title: 'Super Agent' })
    return this.state()
  }

  /** The JSON view consumed by the client and HTTP API. */
  state() {
    const conversations = this.store.conversations().map((record) => this.view(record))
    // Offer every workspace the Harness knows, not only the ones this plugin
    // created, so a new Super Agent conversation can live in an existing project.
    const knownWorkspaces = new Map()
    const retiredIds = new Set(this.store.workspaces().filter((workspace) => workspace.retired).map((workspace) => workspace.id))
    for (const workspace of this.ctx.workspaceRegistry.list()) {
      if (retiredIds.has(workspace.id)) continue
      knownWorkspaces.set(workspace.id, { id: workspace.id, path: workspace.path, title: workspace.title })
    }
    for (const workspace of this.store.workspaces()) {
      if (workspace.retired) continue
      knownWorkspaces.set(workspace.id, { id: workspace.id, path: workspace.path, title: workspace.title })
    }
    const workspaces = [...knownWorkspaces.values()].sort((a, b) => a.title.localeCompare(b.title))
    const latest = this.store.latestSuper()
    return {
      version: 1,
      conversations,
      workspaces,
      themes: this.listThemes(),
      pending: this.pending.list(),
      activeConversationId: latest?.id ?? null,
      diagnostics: {
        decorationErrors: this.decorationErrors.slice(-5),
        runtimeErrors: this.runtimeErrors.slice(-5),
      },
    }
  }

  /** One conversation, with the live agent status layered over durable state. */
  view(record) {
    const agent = this.ctx.agents?.get?.(record.id)
    const running = agent?.status === 'running'
    const status = running ? 'running' : STATUS.has(record.status) ? record.status : 'idle'
    return {
      id: record.id,
      sessionId: record.id,
      kind: record.kind,
      title: record.title,
      workspaceId: record.workspaceId,
      workspacePath: record.workspacePath,
      workspaceTitle: record.workspaceTitle || basename(record.workspacePath || ''),
      parentId: record.parentId,
      status,
      running,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastMessage: record.lastMessage,
      lastOutput: record.lastOutput,
      tags: Array.isArray(record.tags) ? record.tags.slice() : [],
      progress: record.progress.slice(-3),
    }
  }

  /** Find a Super Agent conversation or fail with a useful tool error. */
  requireSuper(id) {
    const record = this.store.conversation(id)
    if (!record || record.kind !== 'super') throw new Error(`Unknown Super Agent conversation: ${id}`)
    return record
  }

  /** Find a worker conversation or fail with a useful tool error. */
  requireWorker(id) {
    const record = this.store.conversation(id)
    if (!record || record.kind !== 'worker') throw new Error(`Unknown worker: ${id}`)
    return record
  }

  /** Remember a Harness workspace in the local catalog. */
  async rememberWorkspace(workspace) {
    const existing = this.store.workspace(workspace.id)
    const record = {
      id: workspace.id,
      path: workspace.path,
      title: workspace.title || basename(workspace.path),
      createdAt: workspace.createdAt ? Date.parse(workspace.createdAt) : (existing?.createdAt || this.now()),
      retired: existing?.retired === true,
      retiredAt: existing?.retiredAt ?? null,
      retiredReason: existing?.retiredReason ?? '',
    }
    if (!existing || existing.path !== record.path || existing.title !== record.title) {
      await this.store.update((state) => { state.workspaces[record.id] = record })
    }
    return record
  }

  /** Ensure a directory exists and return its Harness workspace record. */
  async ensureWorkspace({ id, path, title }) {
    if (id) {
      const workspace = this.ctx.workspaceRegistry.get(id)
      if (!workspace) throw new Error(`Workspace not found: ${id}`)
      return this.rememberWorkspace(workspace)
    }
    if (path) {
      const directory = expandPath(path, this.stateDir)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const workspace = await this.ctx.workspaceRegistry.create(directory, title || basename(directory))
      return this.rememberWorkspace(workspace)
    }
    const directory = join(this.stateDir, 'workspaces', `${slugify(title || 'workspace')}-${shortId(6)}`)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const workspace = await this.ctx.workspaceRegistry.create(directory, title || 'Super Agent')
    return this.rememberWorkspace(workspace)
  }

  /** The long-lived workspace for the first Super Agent conversation. */
  async ensureDefaultWorkspace() {
    return this.ensureWorkspace({ path: join(this.stateDir, 'workspaces', 'main'), title: 'Super Agent' })
  }

  /**
   * Resolve a workspace argument: id, known title, or path. A bare unknown
   * name becomes a new workspace title under the state directory.
   */
  async resolveWorkspace(value, fallbackTitle) {
    if (typeof value !== 'string' || value.trim().length === 0) return this.ensureWorkspace({ title: fallbackTitle })
    const text = value.trim()
    const byId = this.ctx.workspaceRegistry.get(text)
    if (byId) return this.rememberWorkspace(byId)
    const byTitle = this.ctx.workspaceRegistry.list().find((workspace) => workspace.title === text)
    if (byTitle) return this.rememberWorkspace(byTitle)
    if (text === '.' || text === '..' || text.startsWith('~') || text.includes('/') || text.includes('\\')) {
      return this.ensureWorkspace({ path: text, title: fallbackTitle || basename(text) })
    }
    return this.ensureWorkspace({ title: text })
  }

  /** Resolve or create the live agent for a conversation record. */
  async ensureAgent(record) {
    const existing = this.ctx.agents.get(record.id)
    if (existing) {
      this.decorate(existing)
      this.applyPermissions(existing)
      return existing
    }
    const lockKey = record.id
    const previous = this.sessionLocks.get(lockKey)
    if (previous) return previous
    const run = (async () => {
      const resolved = await this.ctx.sessionController.resolveAgent(record.id)
      if (resolved && !('error' in resolved)) {
        this.decorate(resolved.agent)
        this.applyPermissions(resolved.agent)
        return resolved.agent
      }
      const workspace = this.ctx.workspaceRegistry.get(record.workspaceId)
      if (!workspace) throw new Error(`Workspace not found: ${record.workspaceId}`)
      await this.ctx.sessionController.create({ sessionId: record.id, workspaceId: record.workspaceId })
      const created = await this.ctx.sessionController.resolveAgent(record.id)
      if (!created || 'error' in created) {
        throw new Error(`Could not resolve the Session that was just created: ${record.id}`)
      }
      this.decorate(created.agent)
      this.applyPermissions(created.agent)
      await this.ctx.sessionController.rename({ sessionId: record.id, title: record.title })
      return created.agent
    })()
    this.sessionLocks.set(lockKey, run)
    try {
      return await run
    } finally {
      this.sessionLocks.delete(lockKey)
    }
  }

  /** Managed sessions run with full access so a remote client never has to answer tool approvals. */
  applyPermissions(agent) {
    try {
      this.ctx.permissionPresets?.set?.(agent.session, 'danger-full-access')
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-super-agent: could not set permissions for ${agent.id}: ${String(error)}`)
    }
  }

  /** Create a new Super Agent conversation. */
  async createConversation({ title, workspaceId, path, newWorkspace } = {}) {
    const supers = this.store.conversations().filter((conversation) => conversation.kind === 'super')
    const requested = typeof title === 'string' && title.trim() ? title.trim() : supers.length === 0 ? 'Super Agent' : `Super Agent ${supers.length + 1}`
    const workspace = workspaceId
      ? await this.ensureWorkspace({ id: workspaceId })
      : path || newWorkspace
        ? await this.ensureWorkspace({ path, title: requested })
        : await this.ensureDefaultWorkspace()
    const id = `superagent-${randomUUID()}`
    const now = this.now()
    const record = {
      id,
      kind: 'super',
      title: requested,
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      workspaceTitle: workspace.title,
      parentId: null,
      createdAt: now,
      updatedAt: now,
      status: 'idle',
      lastMessage: '',
      lastOutput: '',
      tags: [],
      turnReportedDone: false,
      progress: [],
    }
    await this.store.update((state) => { state.conversations[id] = record })
    try {
      await this.ensureAgent(record)
    } catch (error) {
      await this.store.update((state) => {
        const stored = state.conversations[id]
        if (stored) stored.status = 'failed'
      })
      throw error
    }
    return this.view(this.store.conversation(id))
  }

  /** Create a workspace and return its catalog entry. */
  async createWorkspace({ title, path } = {}) {
    const workspace = path
      ? await this.ensureWorkspace({ path, title })
      : await this.ensureWorkspace({ title: title || 'Workspace' })
    return { id: workspace.id, path: workspace.path, title: workspace.title }
  }

  /** One workspace with retirement metadata, workers, and theme mapping. */
  workspaceDetail(workspaceId) {
    const id = requireString(workspaceId, 'workspace_id')
    const stored = this.store.workspace(id)
    const registry = this.ctx.workspaceRegistry.get(id)
    if (!stored && !registry) throw new Error(`Workspace not found: ${id}`)
    const record = stored || {
      id: registry.id,
      path: registry.path,
      title: registry.title || basename(registry.path),
      createdAt: registry.createdAt ? Date.parse(registry.createdAt) : this.now(),
      retired: false,
      retiredAt: null,
      retiredReason: '',
    }
    const workers = this.store.conversations().filter((conversation) => conversation.kind === 'worker' && conversation.workspaceId === id)
    const theme = this.store.themes().find((entry) => entry.workspaceId === id)
    return {
      id: record.id,
      title: record.title,
      path: record.path,
      retired: record.retired === true,
      retiredAt: record.retiredAt ?? null,
      retiredReason: record.retiredReason ?? '',
      theme: theme?.id || null,
      workerCount: workers.length,
      workerIds: workers.map((worker) => worker.id),
      statusCounts: workers.reduce((counts, worker) => {
        counts[worker.status] = (counts[worker.status] || 0) + 1
        return counts
      }, {}),
    }
  }

  /**
   * Retire a workspace from the active list without deleting its directory,
   * workspace record, or worker conversations. Reversible with reactivate.
   */
  async retireWorkspace({ workspaceId, reason } = {}) {
    const detail = this.workspaceDetail(workspaceId)
    const mainPath = join(this.stateDir, 'workspaces', 'main')
    if (detail.path === mainPath) throw new Error('The Super Agent home workspace is protected and cannot be retired')
    const assigned = this.store.themes().find((theme) => theme.workspaceId === detail.id)
    if (assigned) throw new Error(`Workspace is canonical for theme "${assigned.id}"; reassign the theme before retiring it`)
    if (!this.store.workspace(detail.id)) {
      const registry = this.ctx.workspaceRegistry.get(detail.id)
      if (registry) await this.rememberWorkspace(registry)
    }
    const now = this.now()
    const text = typeof reason === 'string' && reason.trim().length > 0 ? reason.trim().slice(0, 500) : 'Retired by user'
    await this.store.update((state) => {
      const stored = state.workspaces[detail.id]
      if (!stored) return
      stored.retired = true
      stored.retiredAt = now
      stored.retiredReason = text
    })
    return this.workspaceDetail(detail.id)
  }

  /** Re-activate a retired workspace; no files or conversations were moved. */
  async reactivateWorkspace({ workspaceId } = {}) {
    const detail = this.workspaceDetail(workspaceId)
    if (!this.store.workspace(detail.id)) {
      const registry = this.ctx.workspaceRegistry.get(detail.id)
      if (registry) await this.rememberWorkspace(registry)
    }
    await this.store.update((state) => {
      const stored = state.workspaces[detail.id]
      if (!stored) return
      stored.retired = false
      stored.retiredAt = null
      stored.retiredReason = ''
    })
    return this.workspaceDetail(detail.id)
  }

  /** A theme registry record enriched with its canonical workspace. */
  themeView(record) {
    if (!record) return undefined
    const workspace = record.workspaceId
      ? (this.ctx.workspaceRegistry.get(record.workspaceId) || this.store.workspace(record.workspaceId))
      : undefined
    return {
      ...record,
      workspace: workspace ? { id: workspace.id, title: workspace.title || basename(workspace.path), path: workspace.path } : null,
    }
  }

  /** All persisted theme registry records, newest first. */
  listThemes() {
    return this.store.themes().map((record) => this.themeView(record))
  }

  /**
   * Persist `theme -> workspaceId`. Assigning a theme is metadata only: no
   * directory is moved or removed, and every existing worker keeps its
   * conversation and workspace record.
   */
  async assignTheme({ theme, workspaceId, title, description } = {}) {
    const id = normalizeThemeId(requireString(theme, 'theme'))
    const targetId = requireString(workspaceId, 'workspace_id')
    const storedWorkspace = this.store.workspace(targetId)
    const workspace = this.ctx.workspaceRegistry.get(targetId) || storedWorkspace
    if (!workspace) throw new Error(`Workspace not found: ${targetId}`)
    if (storedWorkspace?.retired === true) throw new Error(`Workspace is retired: ${targetId}; reactivate it before assigning a theme`)
    await this.rememberWorkspace(workspace)
    const existing = this.store.theme(id)
    const definition = themeDefinition(id)
    const now = this.now()
    const record = {
      id,
      title: typeof title === 'string' && title.trim().length > 0
        ? title.trim()
        : existing?.title || definition?.title || id,
      description: typeof description === 'string'
        ? description.trim()
        : existing?.description || definition?.description || '',
      workspaceId: workspace.id,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    }
    await this.store.update((state) => { state.themes[id] = record })
    return this.themeView(record)
  }

  /** Directory emptiness without failing the inventory on a missing path. */
  async directoryInfo(path) {
    try {
      const entries = await readdir(path)
      return { entries: entries.length, empty: entries.length === 0, missing: false }
    } catch (error) {
      return { entries: 0, empty: true, missing: error?.code === 'ENOENT' }
    }
  }

  /**
   * Every workspace this plugin created or references, with worker activity,
   * directory emptiness, registry assignment, and a proposed theme. The group
   * view is a proposal only; no workspace is modified.
   */
  async workspaceInventory() {
    const records = new Map()
    for (const workspace of this.store.workspaces()) records.set(workspace.id, workspace)
    for (const conversation of this.store.conversations()) {
      if (!conversation.workspaceId || records.has(conversation.workspaceId)) continue
      const workspace = this.ctx.workspaceRegistry.get(conversation.workspaceId)
      if (workspace) {
        records.set(workspace.id, {
          id: workspace.id,
          path: workspace.path,
          title: workspace.title || basename(workspace.path),
          createdAt: workspace.createdAt ? Date.parse(workspace.createdAt) : this.now(),
        })
      }
    }
    const workers = this.store.conversations().filter((conversation) => conversation.kind === 'worker')
    const registryThemes = this.store.themes()
    const mainWorkspacePath = join(this.stateDir, 'workspaces', 'main')
    const workspaces = []
    for (const record of records.values()) {
      const workspaceWorkers = workers.filter((worker) => worker.workspaceId === record.id)
      const byStatus = {}
      for (const worker of workspaceWorkers) byStatus[worker.status] = (byStatus[worker.status] || 0) + 1
      const activeWorkers = workspaceWorkers.filter((worker) => worker.running === true || worker.status === 'running' || worker.status === 'dispatching').length
      const idleWorkers = workspaceWorkers.filter((worker) => worker.status === 'waiting' || worker.status === 'needs_input').length
      const stoppedWorkers = workspaceWorkers.filter((worker) => worker.status === 'stopped' || worker.status === 'failed' || worker.status === 'paused').length
      const lastActivity = Math.max(
        record.createdAt || 0,
        ...workspaceWorkers.map((worker) => Number(worker.updatedAt) || Number(worker.createdAt) || 0),
      )
      const directory = await this.directoryInfo(record.path)
      const assigned = registryThemes.find((theme) => theme.workspaceId === record.id)
      const proposed = assigned?.id || proposedThemeForWorkspace(record, workspaceWorkers, mainWorkspacePath)
      workspaces.push({
        id: record.id,
        title: record.title,
        path: record.path,
        retired: record.retired === true,
        retiredAt: record.retiredAt ?? null,
        retiredReason: record.retiredReason ?? '',
        workerCount: workspaceWorkers.length,
        activeWorkers,
        idleWorkers,
        stoppedWorkers,
        statusCounts: byStatus,
        lastActivity,
        lastActivityAt: new Date(lastActivity).toISOString(),
        directoryEntries: directory.entries,
        emptyDirectory: directory.empty,
        missing: directory.missing,
        empty: workspaceWorkers.length === 0 && directory.empty && !directory.missing,
        protected: record.path === mainWorkspacePath,
        theme: assigned?.id || null,
        proposedTheme: proposed,
      })
    }
    workspaces.sort((left, right) => right.lastActivity - left.lastActivity)
    const activeWorkspaces = workspaces.filter((workspace) => !workspace.retired)
    const retiredWorkspaces = workspaces.filter((workspace) => workspace.retired)
    const groupsById = new Map()
    for (const workspace of activeWorkspaces) {
      const themeId = workspace.theme || workspace.proposedTheme
      const definition = themeDefinition(themeId)
      if (!groupsById.has(themeId)) {
        groupsById.set(themeId, {
          theme: {
            id: themeId,
            title: definition?.title || themeId,
            description: definition?.description || '',
          },
          workspaceIds: [],
        })
      }
      groupsById.get(themeId).workspaceIds.push(workspace.id)
    }
    const groups = [...groupsById.values()].map((group) => {
      const items = group.workspaceIds.map((id) => activeWorkspaces.find((workspace) => workspace.id === id))
      const assigned = registryThemes.find((theme) => theme.id === group.theme.id && theme.workspaceId)
      const canonicalId = assigned && group.workspaceIds.includes(assigned.workspaceId)
        ? assigned.workspaceId
        : chooseCanonicalWorkspace(items, group.theme.id)
      return {
        theme: group.theme,
        workspaceIds: group.workspaceIds,
        canonicalId: canonicalId || null,
        duplicateIds: canonicalId ? group.workspaceIds.filter((id) => id !== canonicalId) : group.workspaceIds.slice(1),
        emptyIds: items.filter((workspace) => workspace.empty).map((workspace) => workspace.id),
        emptyDirectoryIds: items.filter((workspace) => workspace.emptyDirectory).map((workspace) => workspace.id),
        workerCount: items.reduce((sum, workspace) => sum + workspace.workerCount, 0),
        activeWorkers: items.reduce((sum, workspace) => sum + workspace.activeWorkers, 0),
        idleWorkers: items.reduce((sum, workspace) => sum + workspace.idleWorkers, 0),
      }
    })
    return { workspaces: activeWorkspaces, retired: retiredWorkspaces, groups, themes: this.listThemes() }
  }

  /** Find an existing workspace by id, exact title, or expanded path; never create. */
  async findExistingWorkspace(value) {
    const text = String(value ?? '').trim()
    if (text.length === 0) return undefined
    const direct = this.ctx.workspaceRegistry.get(text) || this.store.workspace(text)
    if (direct) return this.rememberWorkspace(direct)
    const candidates = [...this.ctx.workspaceRegistry.list(), ...this.store.workspaces()]
    const byTitle = candidates.find((workspace) => workspace.title === text)
    if (byTitle) return this.rememberWorkspace(byTitle)
    const path = expandPath(text, this.stateDir)
    const byPath = candidates.find((workspace) => workspace.path === path)
    return byPath ? this.rememberWorkspace(byPath) : undefined
  }

  /** Refuse silent workspace creation for a theme. */
  requireThemeJustification(themeId, justification) {
    if (typeof justification === 'string' && justification.trim().length > 0) return justification.trim()
    throw new Error(`Theme "${themeId}" has no registered workspace. Reuse an existing workspace, or pass new_workspace/justification; workspace creation is never silent.`)
  }

  /** Resolve the workspace for one dispatch, honoring theme reuse first. */
  async resolveDispatchWorkspace({ themeId, themeRecord, workspace, newWorkspace, justification, taskTitle }) {
    const mappedStore = themeRecord?.workspaceId ? this.store.workspace(themeRecord.workspaceId) : undefined
    const themeWorkspace = themeRecord?.workspaceId && mappedStore?.retired !== true
      ? (this.ctx.workspaceRegistry.get(themeRecord.workspaceId) || mappedStore)
      : undefined
    if (themeId && themeWorkspace && !newWorkspace) return this.rememberWorkspace(themeWorkspace)
    if (newWorkspace) {
      if (themeId && !(themeRecord?.workspaceId && themeWorkspace)) this.requireThemeJustification(themeId, justification)
      return this.ensureWorkspace({ path: newWorkspace.path, title: newWorkspace.title || taskTitle })
    }
    if (!themeId) return this.resolveWorkspace(workspace, taskTitle)
    if (typeof workspace === 'string' && workspace.trim().length > 0) {
      const existing = await this.findExistingWorkspace(workspace)
      if (existing) return existing
      const text = workspace.trim()
      if (text === '.' || text === '..' || text.startsWith('~') || text.includes('/') || text.includes('\\')) {
        this.requireThemeJustification(themeId, justification)
        return this.ensureWorkspace({ path: text, title: taskTitle })
      }
      this.requireThemeJustification(themeId, justification)
      return this.ensureWorkspace({ title: text })
    }
    this.requireThemeJustification(themeId, justification)
    return this.ensureWorkspace({ title: themeRecord?.title || themeId })
  }

  /** Register a newly resolved workspace for a theme that had none. */
  async registerDispatchTheme(themeId, target) {
    if (!themeId) return
    const record = this.store.theme(themeId)
    const mapped = record?.workspaceId
      ? (this.ctx.workspaceRegistry.get(record.workspaceId) || this.store.workspace(record.workspaceId))
      : undefined
    if (mapped) return
    await this.assignTheme({ theme: themeId, workspaceId: target.id, title: record?.title, description: record?.description })
  }

  /** Match a free-form description to a registered theme or a proposal. */
  async suggestTheme({ description, title } = {}) {
    const text = [title, description].filter((value) => typeof value === 'string' && value.trim().length > 0).join('\n')
    const registered = this.listThemes()
      .map((theme) => ({ theme, score: themeMatchScore(theme, text) }))
      .sort((left, right) => right.score - left.score || left.theme.id.localeCompare(right.theme.id))
    if (text.length > 0 && registered.length > 0 && registered[0].score > 0) {
      const top = registered[0]
      if (top.theme.workspace) {
        return {
          ok: true,
          theme: top.theme,
          workspace: top.theme.workspace,
          score: top.score,
          registered: true,
          candidates: registered.slice(0, 5).map((entry) => ({ id: entry.theme.id, title: entry.theme.title, score: entry.score })),
        }
      }
      // The theme is known but has no canonical workspace yet. Return the
      // inventory's proposed canonical as a hint rather than no suggestion.
      const inventory = await this.workspaceInventory()
      const group = inventory.groups.find((entry) => entry.theme.id === top.theme.id)
      const candidate = group?.canonicalId
        ? inventory.workspaces.find((entry) => entry.id === group.canonicalId)
        : undefined
      if (candidate) {
        return {
          ok: true,
          theme: { ...top.theme, workspaceId: candidate.id },
          workspace: { id: candidate.id, title: candidate.title, path: candidate.path },
          score: top.score,
          registered: false,
          candidates: registered.slice(0, 5).map((entry) => ({ id: entry.theme.id, title: entry.theme.title, score: entry.score })),
        }
      }
    }
    const proposal = suggestedThemeForText(text)
    const inventory = await this.workspaceInventory()
    const group = inventory.groups.find((entry) => entry.theme.id === proposal.id)
    const workspace = group?.canonicalId
      ? inventory.workspaces.find((entry) => entry.id === group.canonicalId)
      : undefined
    return {
      ok: true,
      theme: { id: proposal.id, title: proposal.title, description: proposal.description, workspaceId: workspace?.id || '' },
      workspace: workspace ? { id: workspace.id, title: workspace.title, path: workspace.path } : null,
      score: proposal.id === DEFAULT_THEME ? 0 : 1,
      registered: false,
      candidates: registered.slice(0, 5).map((entry) => ({ id: entry.theme.id, title: entry.theme.title, score: entry.score })),
    }
  }

  /** The `superagent_workspaces` tool implementation. */
  async workspacesTool({ action = 'list', theme, workspaceId, title, description, reason } = {}) {
    switch (action) {
      case 'list': {
        const inventory = await this.workspaceInventory()
        return { ok: true, workspaces: inventory.workspaces, retired: inventory.retired, groups: inventory.groups, themes: inventory.themes }
      }
      case 'themes':
        return { ok: true, themes: this.listThemes() }
      case 'assign': {
        const assigned = await this.assignTheme({ theme, workspaceId, title, description })
        return { ok: true, theme: assigned }
      }
      case 'suggest':
        return this.suggestTheme({ description, title })
      case 'retire':
        return { ok: true, workspace: await this.retireWorkspace({ workspaceId, reason }) }
      case 'reactivate':
        return { ok: true, workspace: await this.reactivateWorkspace({ workspaceId }) }
      default:
        throw new Error('action must be list, themes, assign, suggest, retire, or reactivate')
    }
  }

  /** Start a worker conversation and hand it the task assignment. */
  async dispatchTask({ parentId, title, prompt, workspace, newWorkspace, theme, justification }) {
    const parent = this.requireSuper(parentId)
    const taskTitle = requireString(title, 'title')
    const assignment = requireString(prompt, 'prompt')
    const themeId = typeof theme === 'string' && theme.trim().length > 0 ? normalizeThemeId(theme) : ''
    const themeRecord = themeId ? this.store.theme(themeId) : undefined
    const knownWorkspaceIds = new Set(this.ctx.workspaceRegistry.list().map((workspace) => workspace.id))
    const target = await this.resolveDispatchWorkspace({
      themeId,
      themeRecord,
      workspace,
      newWorkspace,
      justification,
      taskTitle,
    })
    const workspaceCreated = !knownWorkspaceIds.has(target.id)
    const workspaceReused = !workspaceCreated
    await this.registerDispatchTheme(themeId, target)
    const id = `superagent-worker-${randomUUID()}`
    const now = this.now()
    const record = {
      id,
      kind: 'worker',
      title: taskTitle,
      workspaceId: target.id,
      workspacePath: target.path,
      workspaceTitle: target.title,
      parentId: parent.id,
      createdAt: now,
      updatedAt: now,
      status: 'dispatching',
      lastMessage: '',
      lastOutput: '',
      tags: [],
      turnReportedDone: false,
      progress: [],
    }
    await this.store.update((state) => { state.conversations[id] = record })
    try {
      const agent = await this.ensureAgent(record)
      await this.sendToAgent(agent, this.assignmentText(parent, record, assignment), { form: 'relay' })
      await this.store.update((state) => {
        const stored = state.conversations[id]
        const owner = state.conversations[parent.id]
        if (stored) {
          stored.status = 'running'
          stored.updatedAt = this.now()
          stored.lastMessage = 'Dispatched'
        }
        if (owner) {
          owner.updatedAt = this.now()
          owner.lastMessage = `Dispatched worker: ${taskTitle}${themeId ? ` (${themeId})` : ''}`
        }
      })
      return {
        ...this.view(this.store.conversation(id)),
        theme: themeId || null,
        workspace_created: workspaceCreated,
        workspace_reused: workspaceReused,
        workspace_theme: themeId ? (this.store.theme(themeId)?.workspaceId || target.id) : null,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.runtimeErrors.push({ scope: 'dispatch', workerId: id, message, stack: error instanceof Error ? error.stack : undefined, at: this.now() })
      if (this.runtimeErrors.length > 20) this.runtimeErrors.shift()
      await this.store.update((state) => {
        const stored = state.conversations[id]
        if (stored) {
          stored.status = 'failed'
          stored.updatedAt = this.now()
          stored.lastMessage = `Dispatch failed: ${message}`
        }
      })
      throw new Error(`Failed to dispatch worker "${taskTitle}": ${message}`)
    }
  }

  /** The first message a worker receives. */
  assignmentText(parent, worker, assignment) {
    return [
      `You were dispatched by the Super Agent conversation "${parent.title}" (${parent.id}).`,
      '',
      `Task: ${worker.title}`,
      `Workspace: ${worker.workspacePath}`,
      '',
      assignment,
      '',
      'Report meaningful progress with superagent_report_progress. Your final assistant message is relayed to the Super Agent, so end with a concise result and what you verified.',
    ].join('\n')
  }

  /** Send a follow-up to a worker. */
  async sendWorkerMessage({ workerId, message }) {
    const worker = this.requireWorker(workerId)
    const text = requireString(message, 'message')
    const agent = await this.ensureAgent(worker)
    await this.sendToAgent(agent, text, { form: 'relay' })
    await this.store.update((state) => {
      const stored = state.conversations[workerId]
      const parent = stored?.parentId ? state.conversations[stored.parentId] : undefined
      if (stored) {
        stored.status = 'running'
        stored.updatedAt = this.now()
        stored.lastMessage = 'Follow-up sent'
      }
      if (parent) parent.updatedAt = this.now()
    })
    return this.view(this.store.conversation(workerId))
  }

  /** Ask a worker to stop its current turn. */
  async stopWorker({ workerId, reason = 'Stopped by the Super Agent' }) {
    const worker = this.requireWorker(workerId)
    const agent = this.ctx.agents.get(workerId)
    if (agent) agent.cancel({ kind: 'user' })
    await this.store.update((state) => {
      const stored = state.conversations[workerId]
      if (stored) {
        stored.status = 'stopped'
        stored.updatedAt = this.now()
        stored.lastMessage = reason
        stored.progress.push({ at: this.now(), status: 'stopped', text: reason })
        if (stored.progress.length > PROGRESS_LIMIT) stored.progress = stored.progress.slice(-PROGRESS_LIMIT)
      }
    })
    return this.view(this.store.conversation(workerId))
  }

  /** Stop a Super Agent conversation's current turn. */
  async stopConversation({ conversationId, reason = 'Stopped by the user' }) {
    const conversation = this.store.conversation(conversationId)
    if (!conversation) throw new Error(`Unknown conversation: ${conversationId}`)
    const agent = this.ctx.agents.get(conversationId)
    if (agent) agent.cancel({ kind: 'user' })
    await this.store.update((state) => {
      const stored = state.conversations[conversationId]
      if (stored) {
        stored.updatedAt = this.now()
        stored.lastMessage = reason
      }
    })
    return this.view(this.store.conversation(conversationId))
  }

  /** Read a worker's latest output and progress. */
  workerOutput({ workerId, limit = 5 }) {
    const worker = this.requireWorker(workerId)
    const count = Number.isFinite(limit) ? Math.max(1, Math.min(20, Math.trunc(limit))) : 5
    return {
      worker: this.view(worker),
      last_output: worker.lastOutput,
      progress: worker.progress.slice(-count),
    }
  }

  /** List workers, optionally filtered by status. */
  listWorkers({ status } = {}) {
    const workers = this.store.conversations()
      .filter((conversation) => conversation.kind === 'worker')
      .filter((conversation) => !status || this.view(conversation).status === status)
      .map((conversation) => this.view(conversation))
    return { workers }
  }

  /**
   * The many-to-many tag index: one entry per tag with the workers carrying it.
   * Tags are case-insensitive keys; the first spelling encountered wins.
   */
  workerTagIndex() {
    const byTag = new Map()
    for (const record of this.store.conversations()) {
      if (record.kind !== 'worker') continue
      for (const tag of normalizeTags(record.tags)) {
        const key = tag.toLocaleLowerCase()
        const entry = byTag.get(key) || { tag, workerIds: [] }
        if (!entry.workerIds.includes(record.id)) entry.workerIds.push(record.id)
        byTag.set(key, entry)
      }
    }
    return [...byTag.values()]
      .sort((left, right) => left.tag.localeCompare(right.tag))
      .map((entry) => ({ tag: entry.tag, workerIds: entry.workerIds, count: entry.workerIds.length }))
  }

  /** Worker tag assignments, all workers or one worker. */
  listWorkerTags({ workerId } = {}) {
    if (typeof workerId === 'string' && workerId.trim().length > 0) {
      const worker = this.requireWorker(workerId.trim())
      return { ok: true, worker: this.view(worker), tags: normalizeTags(worker.tags) }
    }
    const workers = this.store.conversations()
      .filter((record) => record.kind === 'worker')
      .map((record) => this.view(record))
    return { ok: true, workers, tags: this.workerTagIndex() }
  }

  /**
   * Set, add, or remove tags on one worker. The list is normalized and bounded
   * before it is persisted; editing tags leaves the worker's sort timestamp
   * alone so the history rail does not jump while the user edits.
   */
  async setWorkerTags({ workerId, tags, action = 'set' } = {}) {
    const worker = this.requireWorker(requireString(workerId, 'worker_id'))
    const requested = normalizeTags(tags)
    const current = normalizeTags(worker.tags)
    let next
    if (action === 'set') {
      next = requested
    } else if (action === 'add') {
      next = normalizeTags([...current, ...requested])
    } else if (action === 'remove') {
      const removing = new Set(requested.map((tag) => tag.toLocaleLowerCase()))
      next = current.filter((tag) => !removing.has(tag.toLocaleLowerCase()))
    } else {
      throw new Error('action must be set, add, remove, or list')
    }
    await this.store.update((state) => {
      const stored = state.conversations[worker.id]
      if (stored) stored.tags = next.slice()
    })
    return { ok: true, worker: this.view(this.store.conversation(worker.id)) }
  }

  /** The `superagent_worker_tags` tool implementation. */
  async workerTags({ workerId, action = 'list', tags } = {}) {
    const name = typeof action === 'string' ? action.trim() : 'list'
    if (name === 'list') return this.listWorkerTags({ workerId })
    if (name === 'set' || name === 'add' || name === 'remove') {
      return this.setWorkerTags({ workerId, tags, action: name })
    }
    throw new Error('action must be set, add, remove, or list')
  }

  /** List every conversation in the catalog. */
  listConversations() {
    return {
      conversations: this.store.conversations().map((conversation) => this.view(conversation)),
    }
  }

  /** Resolve the Super Agent conversation that owns a pending decision. */
  pendingOwner(conversationId) {
    if (typeof conversationId === 'string' && conversationId.length > 0) return this.requireSuper(conversationId)
    const latest = this.store.latestSuper()
    if (!latest) throw new Error('No Super Agent conversation exists yet; open the panel first')
    return latest
  }

  /** Register one pending decision for a Super Agent conversation. */
  async createPendingDecision({ conversationId, question, context, options } = {}) {
    const owner = this.pendingOwner(conversationId)
    const item = await this.pending.create({ conversationId: owner.id, question, context, options })
    await this.store.update((state) => {
      const stored = state.conversations[owner.id]
      if (stored) {
        stored.updatedAt = this.now()
        stored.lastMessage = `Pending decision: ${clip(item.question, 120)}`
      }
    })
    return item
  }

  /** List durable decisions; unresolved only unless asked otherwise. */
  listPendingDecisions({ conversationId, includeResolved = false } = {}) {
    return this.pending.list({ conversationId, includeResolved: includeResolved === true })
  }

  /** Resolve one decision without delivering a message (the tool's own path). */
  async resolvePendingDecision({ id, answer, conversationId } = {}) {
    const scoped = typeof conversationId === 'string' && conversationId.length > 0 ? conversationId : undefined
    const { item, changed } = await this.pending.resolve({ id, answer, conversationId: scoped })
    return { ok: true, item, changed }
  }

  /**
   * Answer one decision from the panel: persist it, then deliver the answer to
   * the owning Super Agent as an ordinary user message so it can act.
   */
  async answerPendingDecision({ id, answer } = {}) {
    const existing = this.pending.get(typeof id === 'string' ? id : '')
    if (!existing) throw new Error(`Unknown pending decision: ${id ?? '(missing id)'}`)
    if (existing.resolved_at !== null) {
      return { item: { ...existing, options: existing.options.slice() }, delivered: false, conversationId: existing.conversation_id }
    }
    const conversation = this.requireSuper(existing.conversation_id)
    if (typeof answer !== 'string' || answer.trim().length === 0) throw new Error('answer is required')
    const { item, changed } = await this.pending.resolve({ id: existing.id, answer, conversationId: conversation.id })
    if (!changed) {
      return { item, delivered: false, conversationId: conversation.id }
    }
    try {
      await this.store.update((state) => {
        const stored = state.conversations[conversation.id]
        if (stored) {
          stored.updatedAt = this.now()
          stored.lastMessage = `Decision answered: ${clip(item.question, 120)}`
        }
      })
      const agent = await this.ensureAgent(conversation)
      const body = [
        `You asked the user a pending decision: ${item.question}`,
        item.context ? `Context: ${clip(item.context, 2000)}` : '',
        `The user answered: ${item.answer}`,
      ].filter(Boolean).join('\n\n')
      await this.sendToAgent(agent, body, { form: 'user' })
    } catch (error) {
      // Put the decision back so the user can retry instead of losing it.
      await this.pending.update((pending) => {
        const stored = pending.items[item.id]
        if (stored) {
          stored.resolved_at = null
          stored.answer = ''
        }
      }).catch(() => {})
      throw error
    }
    return { item, delivered: true, conversationId: conversation.id }
  }

  /** The `superagent_pending_decision` tool implementation. */
  async pendingDecision({ conversationId, action, question, context, options, id, answer, includeResolved } = {}) {
    switch (action) {
      case 'create': {
        const item = await this.createPendingDecision({ conversationId, question, context, options })
        return { ok: true, item }
      }
      case 'list':
        return {
          ok: true,
          items: this.listPendingDecisions({ conversationId, includeResolved }),
        }
      case 'resolve': {
        const outcome = await this.resolvePendingDecision({ id, answer, conversationId })
        return outcome
      }
      default:
        throw new Error('action must be create, list, or resolve')
    }
  }

  /** Deliver a message to an already-live or resumable agent. */
  async sendToAgent(agent, text, { form = 'relay', summary } = {}) {
    const body = String(text ?? '')
    if (body.length === 0) return
    // A plugin-sourced user message turns relays and notices into compact
    // transcript rows. A pending-decision answer is the human's own message:
    // it carries only `source.kind: 'user'`, never the plugin source, so DSH's
    // agent loop and transcript treat it exactly like a typed message.
    const source = form === 'notice'
      ? { kind: PLUGIN_NAME, plugin: PLUGIN_NAME, form: 'notice', summary: clip(summary ?? body, 120) }
      : form === 'relay'
        ? { kind: PLUGIN_NAME, plugin: PLUGIN_NAME, form: 'relay' }
        : { kind: 'user' }
    const message = {
      id: `superagent-${randomUUID()}`,
      role: 'user',
      content: [{ type: 'text', text: body }],
      source,
    }
    if (typeof agent.followup === 'function') {
      try {
        agent.followup(message)
        return
      } catch { /* fall back to the Remote prompt path below */ }
    }
    const result = await this.ctx.sessionController.prompt({
      sessionId: agent.id,
      mode: 'queue',
      content: [{ type: 'text', text: body }],
      requestId: randomUUID(),
    }, new AbortController().signal)
    if (result && typeof result === 'object' && 'error' in result) {
      throw new Error(result.error?.message ?? 'The Harness refused the message')
    }
  }

  /** Relay a progress notice into a parent Super Agent conversation. */
  async notifyParent(parentId, text, summary) {
    if (!parentId) return
    const parent = this.store.conversation(parentId)
    if (!parent || parent.kind !== 'super') return
    try {
      const agent = await this.ensureAgent(parent)
      await this.sendToAgent(agent, clip(text, MAX_NOTICE_CHARS), { form: 'notice', summary })
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-super-agent: could not notify ${parentId}: ${String(error)}`)
    }
  }

  /** Decorate an agent when its conversation is known. */
  decorate(agent) {
    if (!agent || this.decorated.has(agent)) return
    const conversation = this.store.conversation(agent.id)
    if (!conversation) return
    this.decorated.add(agent)
    const disposers = []
    try {
      if (conversation.kind === 'super') this.decorateSuper(agent, conversation, disposers)
      else this.decorateWorker(agent, conversation, disposers)
      this.bindings.set(agent, disposers)
    } catch (error) {
      for (const dispose of disposers) {
        try { dispose() } catch { /* ignore partial cleanup */ }
      }
      this.decorated.delete(agent)
      this.ctx.logger?.warn?.(`dsh-super-agent: could not decorate ${agent.id}: ${String(error)}`)
      this.decorationErrors.push({ agentId: agent.id, message: error instanceof Error ? error.message : String(error), at: this.now() })
      if (this.decorationErrors.length > 20) this.decorationErrors.shift()
    }
  }

  /** Register the Super Agent prompt and tools on one agent scope. */
  decorateSuper(agent, conversation, disposers) {
    disposers.push(agent.ctx.systemPrompt.section({ name: 'dsh-super-agent:role', order: 9999, interpolate: false, text: SUPER_PROMPT }))
    const definitions = this.superTools(conversation.id)
    for (const definition of definitions) disposers.push(agent.ctx.tools.register(definition))
    // Remove the built-in one-shot delegation tools that would otherwise
    // bypass the tracked worker conversations, plus the question-card tool the
    // panel cannot render. Scoped plugin tools (ours) are exempt from
    // restrictions, so only inherited names are denied.
    const deny = this.denyTools(agent, SUPER_DENY)
    if (deny) disposers.push(deny)
  }

  /** Register the worker prompt and reporting tool on one agent scope. */
  decorateWorker(agent, conversation, disposers) {
    disposers.push(agent.ctx.systemPrompt.section({ name: 'dsh-super-agent:worker', order: 9999, interpolate: false, text: WORKER_PROMPT }))
    for (const definition of this.workerTools(conversation.id)) disposers.push(agent.ctx.tools.register(definition))
    const deny = this.denyTools(agent, WORKER_DENY)
    if (deny) disposers.push(deny)
  }

  /**
   * Deny inherited tool names on one agent scope.
   *
   * Capabilities come from the agent-preset ancestor scope rather than the
   * global registry, so a name can be restrictable while `tools.get(name)`
   * (the global view) reports it missing. `tools.restrict()` also rejects a
   * name it does not know yet, so one unknown name must not discard the whole
   * list. Restrict one name at a time and retry the misses on `tools/change`,
   * which covers preset activation and any later registration.
   */
  denyTools(agent, names) {
    const tools = agent.ctx.tools
    if (typeof tools?.restrict !== 'function') return undefined
    const denied = new Set()
    const disposers = []
    let applying = false
    let disposed = false
    const apply = () => {
      if (disposed || applying) return
      applying = true
      try {
        for (const name of names) {
          if (denied.has(name)) continue
          try {
            disposers.push(tools.restrict({ deny: [name] }))
            denied.add(name)
          } catch (error) {
            // Not in this agent's scope chain yet; keep it for the next change.
            if (!/unknown global tool/.test(String(error?.message))) throw error
          }
        }
      } catch (error) {
        this.ctx.logger?.warn?.(`dsh-super-agent: could not deny tools for ${agent.id}: ${String(error)}`)
      } finally {
        applying = false
      }
    }
    const off = typeof agent.ctx.on === 'function' ? agent.ctx.on('tools/change', apply) : undefined
    apply()
    return () => {
      disposed = true
      if (off) off()
      for (const dispose of disposers) {
        try { dispose() } catch { /* ignore cleanup */ }
      }
    }
  }

  /**
   * Fail-fast guard for a denied built-in call in a managed conversation.
   *
   * The deny restrictions keep these tools out of the model schema. This
   * backstop covers a stray call anyway: a Super Agent host tool would run
   * work in the main conversation, and a question-card request without a
   * rendered card would hang until abort. Both become a normal tool error.
   */
  deniedToolReason(exec) {
    if (!exec || typeof exec.name !== 'string') return undefined
    const id = exec.agent && typeof exec.agent === 'object' ? exec.agent.id : undefined
    if (id === undefined) return undefined
    const conversation = this.store.conversation(id)
    if (conversation === undefined) return undefined
    const denied = conversation.kind === 'super' ? SUPER_DENY : WORKER_DENY
    if (!denied.includes(exec.name)) return undefined
    if (exec.name === 'ask_user_question') {
      return 'ask_user_question is unavailable here: ask in a normal message or use superagent_pending_decision.'
    }
    return conversation.kind === 'super'
      ? `${exec.name} is unavailable in the Super Agent conversation; dispatch a worker for host work.`
      : `${exec.name} is unavailable in worker conversations.`
  }

  /** The tool set exposed to a Super Agent conversation. */
  superTools(conversationId) {
    const orchestrator = this
    return [
      tool('superagent_dispatch_task',
        'Start a new persistent worker conversation and give it a complete task brief. Use this for substantial or long-running work. Returns the worker id, workspace, and status.',
        DISPATCH_SCHEMA,
        async (args) => orchestrator.dispatchTask({
          parentId: conversationId,
          title: args.title,
          prompt: args.prompt,
          workspace: args.workspace,
          newWorkspace: args.new_workspace,
          theme: args.theme,
          justification: args.justification,
        })),
      tool('superagent_list_workers',
        'List worker conversations with their live status, workspace, and latest result.',
        LIST_WORKERS_SCHEMA,
        async (args) => orchestrator.listWorkers(args)),
      tool('superagent_worker_output',
        'Read one worker\'s latest output and recent progress notices. Use this when a notice is too short or you need detail before answering the user.',
        WORKER_OUTPUT_SCHEMA,
        async (args) => orchestrator.workerOutput({ workerId: requireString(args.worker_id, 'worker_id'), limit: args.limit })),
      tool('superagent_worker_tags',
        `Organize workers with short persistent tags (at most ${MAX_WORKER_TAGS} per worker). Action "set" replaces a worker's tags, "add" appends, "remove" deletes the listed tags, and "list" returns current assignments as a tag-to-worker index.`,
        WORKER_TAGS_SCHEMA,
        async (args) => orchestrator.workerTags({
          workerId: args.worker_id,
          action: typeof args.action === 'string' ? args.action : 'list',
          tags: args.tags,
        })),
      tool('superagent_send_message',
        'Send a follow-up instruction or answer to an existing worker conversation.',
        SEND_MESSAGE_SCHEMA,
        async (args) => orchestrator.sendWorkerMessage({ workerId: requireString(args.worker_id, 'worker_id'), message: requireString(args.message, 'message') })),
      tool('superagent_stop_worker',
        'Stop a worker\'s current turn when its work is no longer needed. The worker conversation remains available.',
        STOP_WORKER_SCHEMA,
        async (args) => orchestrator.stopWorker({ workerId: requireString(args.worker_id, 'worker_id'), reason: args.reason })),
      tool('superagent_create_workspace',
        'Create a workspace without starting work. Use it when the user wants a directory prepared for several future tasks. Prefer theme reuse; register the new workspace with superagent_workspaces assign.',
        CREATE_WORKSPACE_SCHEMA,
        async (args) => orchestrator.createWorkspace({ path: args.path, title: args.title })),
      tool('superagent_workspaces',
        'Workspace discovery and theme registry. action "list" returns every SA workspace with worker counts, activity, emptiness and proposed theme groups; "themes" lists persisted theme-to-workspace assignments; "assign" maps a theme to an existing workspace; "suggest" classifies a task description into the best theme and workspace. Use before dispatch when the theme is unclear.',
        WORKSPACES_SCHEMA,
        async (args) => orchestrator.workspacesTool({
          action: requireString(args.action, 'action'),
          theme: args.theme,
          workspaceId: args.workspace_id,
          title: args.title,
          description: args.description,
          reason: args.reason,
        })),
      tool('superagent_create_conversation',
        'Open another Super Agent conversation, optionally in a different workspace, for a separate long-running thread. The new conversation appears in the conversation history.',
        CREATE_CONVERSATION_SCHEMA,
        async (args) => orchestrator.createConversation({ title: args.title, workspaceId: args.workspace_id, path: args.path })),
      tool('superagent_list_conversations',
        'List every Super Agent conversation and worker conversation.',
        EMPTY_SCHEMA,
        async () => orchestrator.listConversations()),
      tool('superagent_pending_decision',
        'Ask the user to decide something without a round trip: action "create" registers an inline question card (optional context and option buttons) for this Super Agent conversation. Action "list" returns unanswered decisions; action "resolve" records an answer. The panel delivers the user\'s answer back to this conversation as a user message.',
        PENDING_SCHEMA,
        async (args) => orchestrator.pendingDecision({
          conversationId,
          action: requireString(args.action, 'action'),
          question: args.question,
          context: args.context,
          options: args.options,
          id: args.id,
          answer: args.answer,
          includeResolved: args.include_resolved === true,
        })),
    ]
  }

  /** The tool set exposed to a worker conversation. */
  workerTools(workerId) {
    const orchestrator = this
    return [
      tool('superagent_report_progress',
        'Report a short, concrete update to the Super Agent: progress, a blocker, a question, or a completed result. Use this instead of waiting.',
        REPORT_SCHEMA,
        async (args, exec) => orchestrator.reportProgress({
          workerId,
          agentId: exec?.agent?.id ?? workerId,
          summary: requireString(args.summary, 'summary'),
          status: typeof args.status === 'string' ? args.status : 'progress',
        })),
    ]
  }

  /** Record and relay a worker report. */
  async reportProgress({ workerId, summary, status }) {
    const worker = this.requireWorker(workerId)
    const normalized = ['progress', 'blocked', 'question', 'done'].includes(status) ? status : 'progress'
    const nextStatus = normalized === 'blocked' || normalized === 'question'
      ? 'needs_input'
      : normalized === 'done' ? 'waiting' : 'running'
    const text = clip(summary, MAX_NOTICE_CHARS)
    await this.store.update((state) => {
      const stored = state.conversations[workerId]
      const parent = stored?.parentId ? state.conversations[stored.parentId] : undefined
      if (stored) {
        stored.status = nextStatus
        stored.updatedAt = this.now()
        stored.lastMessage = text
        stored.turnReportedDone = normalized === 'done'
        stored.progress.push({ at: this.now(), status: normalized, text })
        if (stored.progress.length > PROGRESS_LIMIT) stored.progress = stored.progress.slice(-PROGRESS_LIMIT)
      }
      if (parent) {
        parent.updatedAt = this.now()
        parent.lastMessage = `Worker update: ${clip(summary, 120)}`
      }
    })
    const label = normalized === 'done' ? 'completed' : normalized
    await this.notifyParent(worker.parentId, `Worker "${worker.title}" reported ${label}:\n${text}`, `Worker ${label}: ${worker.title}`)
    return { ok: true, worker_id: workerId, recorded: true }
  }

  /** Observe a live Agent creation and decorate it when it belongs to this plugin. */
  onAgentCreated(agent) {
    this.decorate(agent)
    this.applyPermissions(agent)
  }

  /** Observe Session events for worker progress and turn completion. */
  async onSessionEvent(session, event) {
    const conversation = this.store.conversation(session.id)
    if (!conversation || !event || typeof event.type !== 'string') return
    if (conversation.kind === 'super') {
      if (event.type === 'turn/start') {
        conversation.status = 'running'
        conversation.updatedAt = this.now()
      } else if (event.type === 'turn/end') {
        await this.store.update((state) => {
          const stored = state.conversations[conversation.id]
          if (stored) {
            stored.status = 'waiting'
            stored.updatedAt = this.now()
          }
        })
      }
      return
    }

    if (event.type === 'assistant/message') {
      const text = textOfEvent(event)
      if (text) conversation.lastOutput = text
      return
    }
    if (event.type === 'turn/start') {
      conversation.status = 'running'
      conversation.updatedAt = this.now()
      conversation.turnReportedDone = false
      return
    }
    if (event.type !== 'turn/end') return

    const finished = this.lastTurnOutput(session, event.data?.turn)
    const output = finished || conversation.lastOutput
    const reason = event.data?.reason
    const error = reason?.kind === 'error' ? reason.error?.message ?? 'Worker turn failed' : ''
    const aborted = reason?.kind === 'aborted'
    const status = error ? 'failed' : aborted ? 'stopped' : looksLikeQuestion(output) ? 'needs_input' : 'waiting'
    // A worker that already reported `done` during this turn has told the
    // Super Agent the result; do not repeat it from the turn boundary.
    const reportedDone = !error && !aborted && conversation.turnReportedDone === true
    await this.store.update((state) => {
      const stored = state.conversations[conversation.id]
      const parent = stored?.parentId ? state.conversations[stored.parentId] : undefined
      if (stored) {
        stored.status = status
        stored.updatedAt = this.now()
        stored.lastOutput = output
        stored.lastMessage = error || clip(output, 200) || (aborted ? 'Stopped' : 'Turn finished')
        stored.turnReportedDone = false
        stored.progress.push({
          at: this.now(),
          status: error ? 'error' : aborted ? 'stopped' : 'turn-end',
          text: clip(output || error || 'Turn finished', 1000),
        })
        if (stored.progress.length > PROGRESS_LIMIT) stored.progress = stored.progress.slice(-PROGRESS_LIMIT)
      }
      if (parent) {
        parent.updatedAt = this.now()
        parent.lastMessage = `Worker ${status}: ${conversation.title}`
      }
    })
    if (error) {
      await this.notifyParent(conversation.parentId, `Worker "${conversation.title}" failed:\n${error}`, `Worker failed: ${conversation.title}`)
      return
    }
    if (aborted) {
      await this.notifyParent(conversation.parentId, `Worker "${conversation.title}" stopped its turn.`, `Worker stopped: ${conversation.title}`)
      return
    }
    if (reportedDone) return
    const body = output || 'The worker finished its turn without text output.'
    await this.notifyParent(conversation.parentId,
      `Worker "${conversation.title}" finished a turn.\n${clip(body, MAX_NOTICE_CHARS)}\n\nStatus: ${status}. Use superagent_worker_output for the worker's progress log.`,
      `Worker finished: ${conversation.title}`)
  }

  /** The last assistant text within one turn, read from the live session log. */
  lastTurnOutput(session, turn) {
    try {
      const events = session.snapshotEvents()
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]
        if (event?.type !== 'assistant/message') continue
        if (turn !== undefined && event.data?.turn !== turn) continue
        const text = textOfEvent(event)
        if (text) return text
      }
    } catch { /* a session may not expose a log in every test harness */ }
    return ''
  }
}

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
import { mkdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { homedir } from 'node:os'

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
- superagent_stop_worker: stop a worker that is no longer needed.
- superagent_create_workspace: create a workspace without starting a worker.
- superagent_create_conversation: open another Super Agent conversation for a separate long-running thread.
- superagent_list_conversations: list Super Agent conversations and workers.

Planning tools such as todo_write and the goal tools stay available; they do not touch the host.

Working rules:
1. Converse in the user's language. Greetings, explanations, and questions you can answer from context need no tools.
2. If a request needs any host action, dispatch a worker. Do not do it yourself, even when it looks small or faster.
3. Dispatch brief: give the worker a short title, a complete self-contained brief, and an existing workspace or a new workspace request. Include the goal, relevant paths, constraints, expected output, and how to report completion.
4. Prefer an existing workspace when the task belongs to it. Use new_workspace when the task deserves its own directory. Never guess a user's project path; ask or use the requested path.
5. After dispatch, tell the user which worker you started and what happens next. Do not claim work is done before a worker reports it.
6. Worker progress arrives as notices in this conversation. Relay only meaningful updates: a result, a blocker, a decision the user must make, or a notable milestone. Combine multiple notices into one short update.
7. If a worker asks a question, either answer it from the conversation context, send a follow-up, or ask the user. Do not invent an answer.
8. Keep the main conversation concise. Use superagent_worker_output when you need detail, and summarize it for the user.
9. A worker is a persistent conversation, not a subagent. It can receive multiple assignments.
10. Do not create a new Super Agent conversation unless the user asks for a separate thread or the work is clearly unrelated and long-running.
11. Delegation always goes through superagent_dispatch_task. One-shot subagent, workflow, teammate, and team-task tools are unavailable; those bypass the persistent worker conversation that this panel tracks.
12. You do not have an ask_user_question tool and this panel cannot render question cards. Ask in a normal assistant message: write the question and any options as text, then wait for the user's reply.`

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

/** The Super Agent tool schemas. */
const DISPATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: 'Short task title shown in the conversation history.' },
    prompt: { type: 'string', description: 'Complete, self-contained brief for the worker. Include goal, workspace, constraints, and expected output.' },
    workspace: { type: 'string', description: 'Existing workspace id, absolute path, or workspace title. Omit to create a new workspace for this task.' },
    new_workspace: {
      type: 'object',
      additionalProperties: false,
      description: 'Create a fresh workspace for this task instead of reusing one.',
      properties: {
        path: { type: 'string', description: 'Absolute or ~-relative directory. Omit to create one under the Super Agent state directory.' },
        title: { type: 'string', description: 'Display title for the workspace.' },
      },
    },
  },
  required: ['title', 'prompt'],
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

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string', description: 'Short, concrete update for the Super Agent.' },
    status: { type: 'string', description: 'progress, blocked, question, or done. Defaults to progress.' },
  },
  required: ['summary'],
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
   * @param {() => number} [options.now]
   */
  constructor({ ctx, store, stateDir, now = () => Date.now() }) {
    this.ctx = ctx
    this.store = store
    this.stateDir = stateDir
    this.now = now
    this.decorated = new WeakSet()
    this.bindings = new Map()
    this.sessionLocks = new Map()
    this.decorationErrors = []
    this.runtimeErrors = []
  }

  /** Load durable state, downgrade orphaned statuses, and re-decorate live agents. */
  async load() {
    await this.store.load()
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
    for (const workspace of this.ctx.workspaceRegistry.list()) {
      knownWorkspaces.set(workspace.id, { id: workspace.id, path: workspace.path, title: workspace.title })
    }
    for (const workspace of this.store.workspaces()) {
      knownWorkspaces.set(workspace.id, { id: workspace.id, path: workspace.path, title: workspace.title })
    }
    const workspaces = [...knownWorkspaces.values()].sort((a, b) => a.title.localeCompare(b.title))
    const latest = this.store.latestSuper()
    return {
      version: 1,
      conversations,
      workspaces,
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
    const record = {
      id: workspace.id,
      path: workspace.path,
      title: workspace.title || basename(workspace.path),
      createdAt: workspace.createdAt ? Date.parse(workspace.createdAt) : this.now(),
    }
    const existing = this.store.workspace(record.id)
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

  /** Start a worker conversation and hand it the task assignment. */
  async dispatchTask({ parentId, title, prompt, workspace, newWorkspace }) {
    const parent = this.requireSuper(parentId)
    const taskTitle = requireString(title, 'title')
    const assignment = requireString(prompt, 'prompt')
    const target = newWorkspace
      ? await this.ensureWorkspace({ path: newWorkspace.path, title: newWorkspace.title || taskTitle })
      : await this.resolveWorkspace(workspace, taskTitle)
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
          owner.lastMessage = `Dispatched worker: ${taskTitle}`
        }
      })
      return this.view(this.store.conversation(id))
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

  /** List every conversation in the catalog. */
  listConversations() {
    return {
      conversations: this.store.conversations().map((conversation) => this.view(conversation)),
    }
  }

  /** Deliver a message to an already-live or resumable agent. */
  async sendToAgent(agent, text, { form = 'relay', summary } = {}) {
    const body = String(text ?? '')
    if (body.length === 0) return
    // A plugin-sourced user message turns these relays and notices into
    // compact transcript rows instead of messages from the human user.
    const source = form === 'notice'
      ? { kind: PLUGIN_NAME, plugin: PLUGIN_NAME, form: 'notice', summary: clip(summary ?? body, 120) }
      : { kind: PLUGIN_NAME, plugin: PLUGIN_NAME, form: 'relay' }
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
      return 'ask_user_question is unavailable here: ask in a normal message.'
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
        })),
      tool('superagent_list_workers',
        'List worker conversations with their live status, workspace, and latest result.',
        LIST_WORKERS_SCHEMA,
        async (args) => orchestrator.listWorkers(args)),
      tool('superagent_worker_output',
        'Read one worker\'s latest output and recent progress notices. Use this when a notice is too short or you need detail before answering the user.',
        WORKER_OUTPUT_SCHEMA,
        async (args) => orchestrator.workerOutput({ workerId: requireString(args.worker_id, 'worker_id'), limit: args.limit })),
      tool('superagent_send_message',
        'Send a follow-up instruction or answer to an existing worker conversation.',
        SEND_MESSAGE_SCHEMA,
        async (args) => orchestrator.sendWorkerMessage({ workerId: requireString(args.worker_id, 'worker_id'), message: requireString(args.message, 'message') })),
      tool('superagent_stop_worker',
        'Stop a worker\'s current turn when its work is no longer needed. The worker conversation remains available.',
        STOP_WORKER_SCHEMA,
        async (args) => orchestrator.stopWorker({ workerId: requireString(args.worker_id, 'worker_id'), reason: args.reason })),
      tool('superagent_create_workspace',
        'Create a workspace without starting work. Use it when the user wants a directory prepared for several future tasks.',
        CREATE_WORKSPACE_SCHEMA,
        async (args) => orchestrator.createWorkspace({ path: args.path, title: args.title })),
      tool('superagent_create_conversation',
        'Open another Super Agent conversation, optionally in a different workspace, for a separate long-running thread. The new conversation appears in the conversation history.',
        CREATE_CONVERSATION_SCHEMA,
        async (args) => orchestrator.createConversation({ title: args.title, workspaceId: args.workspace_id, path: args.path })),
      tool('superagent_list_conversations',
        'List every Super Agent conversation and worker conversation.',
        EMPTY_SCHEMA,
        async () => orchestrator.listConversations()),
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

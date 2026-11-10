/**
 * Durable JSON state for the Super Agent plugin.
 *
 * The store is deliberately small: a map of conversations (Super Agent chats
 * and worker chats), a map of workspaces, and a bounded progress log per
 * worker. It is written atomically and serializes writes so concurrent tool
 * calls cannot interleave a read-modify-write cycle.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const STATE_VERSION = 1
const PROGRESS_LIMIT = 80

/** An empty, valid state document. */
export function emptyState() {
  return { version: STATE_VERSION, conversations: {}, workspaces: {}, updatedAt: null }
}

/** True when `value` is a non-array object. */
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Coerce a finite timestamp; missing or invalid values become `fallback`. */
function timeOf(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** Keep only the fields the UI and orchestrator rely on. */
function normalizeConversation(value) {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0) return undefined
  const kind = value.kind === 'worker' ? 'worker' : 'super'
  const createdAt = timeOf(value.createdAt, Date.now())
  const progress = Array.isArray(value.progress)
    ? value.progress.filter(isRecord).map((entry) => ({
      at: timeOf(entry.at, createdAt),
      status: typeof entry.status === 'string' ? entry.status : 'progress',
      text: typeof entry.text === 'string' ? entry.text : '',
    })).slice(-PROGRESS_LIMIT)
    : []
  return {
    id: value.id,
    kind,
    title: typeof value.title === 'string' && value.title.trim() ? value.title.trim() : kind === 'worker' ? 'Worker' : 'Super Agent',
    workspaceId: typeof value.workspaceId === 'string' ? value.workspaceId : '',
    workspacePath: typeof value.workspacePath === 'string' ? value.workspacePath : '',
    workspaceTitle: typeof value.workspaceTitle === 'string' ? value.workspaceTitle : '',
    parentId: typeof value.parentId === 'string' ? value.parentId : null,
    createdAt,
    updatedAt: timeOf(value.updatedAt, createdAt),
    status: typeof value.status === 'string' ? value.status : 'idle',
    lastMessage: typeof value.lastMessage === 'string' ? value.lastMessage : '',
    lastOutput: typeof value.lastOutput === 'string' ? value.lastOutput : '',
    turnReportedDone: value.turnReportedDone === true,
    progress,
  }
}

/** Keep only the workspace fields the UI needs. */
function normalizeWorkspace(value) {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.path !== 'string') return undefined
  return {
    id: value.id,
    path: value.path,
    title: typeof value.title === 'string' && value.title.trim() ? value.title.trim() : value.path,
    createdAt: timeOf(value.createdAt, Date.now()),
  }
}

/** Validate an on-disk document, dropping records that cannot be trusted. */
export function normalizeState(raw) {
  if (!isRecord(raw)) return emptyState()
  const state = emptyState()
  if (isRecord(raw.conversations)) {
    for (const value of Object.values(raw.conversations)) {
      const conversation = normalizeConversation(value)
      if (conversation) state.conversations[conversation.id] = conversation
    }
  }
  if (isRecord(raw.workspaces)) {
    for (const value of Object.values(raw.workspaces)) {
      const workspace = normalizeWorkspace(value)
      if (workspace) state.workspaces[workspace.id] = workspace
    }
  }
  state.updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : null
  return state
}

/**
 * Owns one state file. Mutations go through {@link update}, which applies the
 * callback and persists the result before resolving.
 */
export class StateStore {
  /** @param {string} file absolute path of the JSON state file */
  constructor(file) {
    this.file = file
    this.state = emptyState()
    this.queue = Promise.resolve()
    this.loaded = false
  }

  /** Read the state file once; a missing or malformed file starts empty. */
  async load() {
    try {
      const text = await readFile(this.file, 'utf8')
      this.state = normalizeState(JSON.parse(text))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // A malformed file must not take down the plugin; keep a copy for
        // post-mortem inspection and start with an empty document.
        try {
          await rename(this.file, `${this.file}.corrupt-${Date.now()}`)
        } catch { /* best effort */ }
      }
      this.state = emptyState()
    }
    this.loaded = true
    return this.state
  }

  /** Persist the current document atomically. */
  async persist() {
    const text = JSON.stringify(this.state, null, 2)
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, text, { mode: 0o600 })
    await rename(temporary, this.file)
  }

  /**
   * Apply a synchronous mutation and persist the result. Calls are serialized.
   * @template T
   * @param {(state: ReturnType<typeof emptyState>) => T} mutate
   * @returns {Promise<T>}
   */
  update(mutate) {
    const run = async () => {
      const result = mutate(this.state)
      this.state.updatedAt = Date.now()
      await this.persist()
      return result
    }
    const next = this.queue.then(run, run)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  /** A JSON-safe copy of the current document. */
  snapshot() {
    return normalizeState(JSON.parse(JSON.stringify(this.state)))
  }

  /** The current document, live. Callers must not mutate it outside `update`. */
  get current() {
    return this.state
  }

  /** One conversation record by session id, if known. */
  conversation(id) {
    return this.state.conversations[id]
  }

  /** All conversation records, newest first. */
  conversations() {
    return Object.values(this.state.conversations).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** One workspace record by id, if known. */
  workspace(id) {
    return this.state.workspaces[id]
  }

  /** All workspace records, newest first. */
  workspaces() {
    return Object.values(this.state.workspaces).sort((a, b) => b.createdAt - a.createdAt)
  }

  /** The most recently updated Super Agent conversation, if any. */
  latestSuper() {
    return this.conversations().find((conversation) => conversation.kind === 'super')
  }
}

/** The profile this process serves, from its environment, CLI flags, or profile path. */
export function profileName(env = process.env, argv = process.argv) {
  const declared = typeof env.DSH_PROFILE === 'string' ? env.DSH_PROFILE.trim() : ''
  if (declared.length > 0) return declared
  const flag = argv.indexOf('--profile')
  if (flag >= 0 && typeof argv[flag + 1] === 'string' && argv[flag + 1].length > 0) return argv[flag + 1]
  for (const argument of argv) {
    if (typeof argument !== 'string') continue
    const match = /(?:^|[\\/])profiles[\\/]([^\\/]+)[\\/]?$/.exec(argument)
    if (match) return match[1]
  }
  return ''
}

/**
 * Default state-file directory under the DSH home directory.
 *
 * Desktop keeps the historical root so its existing catalog upgrades in place;
 * every other profile gets its own subdirectory, because two DSH processes
 * sharing one home must not write the same JSON catalog.
 */
export function defaultStateDir(env = process.env, home = process.env.HOME ?? '', argv = process.argv) {
  const dshHome = env.DSH_HOME && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(home, '.dsh')
  const base = join(dshHome, 'state', 'dsh-super-agent')
  const profile = profileName(env, argv)
  return profile.length > 0 && profile !== 'desktop' ? join(base, 'profiles', profile) : base
}

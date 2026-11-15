import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Profile detection mirrors `dsh-super-agent` so the catalog is found in every profile. */
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

/** Resolve the Super Agent state file exactly as `dsh-super-agent` does. */
export function defaultSuperAgentStateFile(env = process.env, argv = process.argv, home = process.env.HOME ?? '') {
  if (typeof env.DSH_SUPERAGENT_STATE_DIR === 'string' && env.DSH_SUPERAGENT_STATE_DIR.trim().length > 0) {
    return join(env.DSH_SUPERAGENT_STATE_DIR, 'state.json')
  }
  const dshHome = typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0
    ? env.DSH_HOME
    : join(home || homedir(), '.dsh')
  const base = join(dshHome, 'state', 'dsh-super-agent')
  const profile = profileName(env, argv)
  return profile.length > 0 && profile !== 'desktop'
    ? join(base, 'profiles', profile, 'state.json')
    : join(base, 'state.json')
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Keep only fields role detection and workspace lookup need. */
export function normalizeCatalog(raw) {
  const conversations = {}
  const workspaces = {}
  if (isRecord(raw)) {
    if (isRecord(raw.conversations)) {
      for (const value of Object.values(raw.conversations)) {
        if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0) continue
        const kind = value.kind === 'worker' ? 'worker' : 'super'
        conversations[value.id] = {
          id: value.id,
          kind,
          title: typeof value.title === 'string' ? value.title : kind === 'worker' ? 'Worker' : 'Super Agent',
          workspacePath: typeof value.workspacePath === 'string' ? value.workspacePath : '',
          workspaceTitle: typeof value.workspaceTitle === 'string' ? value.workspaceTitle : '',
          workspaceId: typeof value.workspaceId === 'string' ? value.workspaceId : '',
          parentId: typeof value.parentId === 'string' ? value.parentId : null,
        }
      }
    }
    if (isRecord(raw.workspaces)) {
      for (const value of Object.values(raw.workspaces)) {
        if (!isRecord(value) || typeof value.id !== 'string' || typeof value.path !== 'string') continue
        workspaces[value.id] = {
          id: value.id,
          path: value.path,
          title: typeof value.title === 'string' && value.title.trim() ? value.title.trim() : value.path,
        }
      }
    }
  }
  return {
    exists: isRecord(raw),
    conversations,
    workspaces,
    updatedAt: isRecord(raw) && typeof raw.updatedAt === 'number' ? raw.updatedAt : null,
  }
}

const EMPTY = Object.freeze({
  exists: false,
  conversations: Object.freeze({}),
  workspaces: Object.freeze({}),
  updatedAt: null,
})

/**
 * Read the Super Agent catalog with a tiny mtime cache. Reading is synchronous
 * on purpose: tools must be registered during the synchronous
 * `agent/created` listener, before the first prompt is assembled.
 */
export function createCatalogReader({ file = defaultSuperAgentStateFile() } = {}) {
  let cached = EMPTY
  let signature = ''

  const readSync = () => {
    let info
    try {
      // Always stat: a freshly written catalog must be visible on the very
      // next agent creation, including the first Super Agent conversation.
      info = statSync(file)
    } catch (error) {
      cached = EMPTY
      signature = ''
      return cached
    }
    const nextSignature = `${info.mtimeMs}:${info.size}`
    if (nextSignature === signature) return cached
    try {
      const parsed = normalizeCatalog(JSON.parse(readFileSync(file, 'utf8')))
      cached = parsed
      signature = nextSignature
      return cached
    } catch (error) {
      // A torn or malformed catalog must not take memory down. Keep the last
      // good catalog and retry on the next call.
      if (cached.exists) return cached
      cached = EMPTY
      signature = ''
      return cached
    }
  }

  return {
    file,
    readSync,
    async read() {
      return readSync()
    },
    clear() {
      cached = EMPTY
      signature = ''
    },
  }
}

/**
 * Decide one agent's role from the Super Agent catalog.
 *
 * `super` and `worker` conversations get their catalog workspace. Anything
 * else (a plain chat, or an app without `dsh-super-agent`) is the least
 * privileged `worker` role in its own session cwd. That fallback keeps the
 * plugin useful without Super Agent and can never grant summary access.
 */
export function identityForAgent(agent, catalog, { now = Date.now } = {}) {
  const id = typeof agent?.id === 'string' ? agent.id : agent?.session?.id
  const conversation = id && catalog?.conversations ? catalog.conversations[id] : undefined
  const cwd = typeof agent?.session?.header?.cwd === 'string' && agent.session.header.cwd.length > 0
    ? agent.session.header.cwd
    : process.cwd()
  if (conversation?.kind === 'super') {
    return {
      role: 'super',
      agentId: id,
      conversationId: id,
      title: conversation.title,
      ownProjectPath: conversation.workspacePath || cwd,
      ownProjectTitle: conversation.workspaceTitle || conversation.title,
      source: 'catalog',
      catalogExists: catalog.exists === true,
      at: now,
    }
  }
  if (conversation?.kind === 'worker') {
    return {
      role: 'worker',
      agentId: id,
      conversationId: id,
      title: conversation.title,
      ownProjectPath: conversation.workspacePath || cwd,
      ownProjectTitle: conversation.workspaceTitle || conversation.title,
      source: 'catalog',
      catalogExists: catalog.exists === true,
      at: now,
    }
  }
  return {
    role: 'worker',
    agentId: id,
    conversationId: null,
    title: 'Session',
    ownProjectPath: cwd,
    source: 'fallback',
    catalogExists: catalog?.exists === true,
    at: now,
  }
}

/** Find a catalog workspace by id or unique title (used for Super project args). */
export function findCatalogWorkspace(catalog, value) {
  const text = String(value ?? '').trim()
  if (text.length === 0 || !catalog?.workspaces) return undefined
  if (catalog.workspaces[text]) return catalog.workspaces[text]
  const matches = Object.values(catalog.workspaces).filter((workspace) => workspace.title === text || workspace.path === text)
  return matches.length === 1 ? matches[0] : undefined
}

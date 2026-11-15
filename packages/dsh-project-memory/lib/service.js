import { identityForAgent, findCatalogWorkspace } from './catalog.js'
import { MemoryError, skillRequiredMessage } from './errors.js'
import { isSkillLoaded } from './gate.js'
import { canonicalProjectPath, isoTimestamp, projectKeyFor } from './projects.js'
import { isInside, resolveWorkerScope } from './project-root.js'
import { GUIDE_TOOL, SKILL_NAME, loadSkillDefinition } from './skill.js'
import { LIMITS, clip, publicProject } from './store.js'
import { ACCEPTED_TAG_VALUES, normalizeTags } from './tags.js'

/** Capability matrix: the host-side source of truth for every tool. */
const ALLOWED = Object.freeze({
  super: new Set(['guide', 'projects', 'summary:read', 'summary:write', 'notes:read', 'search']),
  worker: new Set(['notes:read', 'notes:write']),
})

const TOOL_DESCRIPTIONS = {
  guide: `Load the project-memory skill. Call this ONCE before the first project_memory_* read/write tool. The Super Agent cannot use the normal skill tool, so this returns the same registered skill body.`,
  projects: `List the project registry (key, path, note count, summary state). Call project_memory_guide first. Before writing, decide which project(s) the content belongs to.`,
  summaryRead: `Read the Super Agent's summary layer. Omit project to list every project's summary metadata and preview. Call project_memory_guide first; results are compact unless full:true.`,
  summaryWrite: `Write the Super Agent's curated summary for one or more projects. Call project_memory_guide first. Use writes:[{project,content,mode?}] when content spans several projects; each project gets its own summary.`,
  notesRead: `Read detail notes (worker-owned). Super Agent may read all projects; a worker sees only its bound project. Call the project-memory skill first (Super Agent: project_memory_guide; worker: skill). If the assigned workspace is a broad parent, pass the actual project path once to bind the session to that project root. Compact by default; full:true returns bodies.`,
  noteAppend: `Append one tagged detail note to the worker's own project. Call skill first. If the assigned workspace is a parent of several projects, pass the actual project path once to bind this session to that project root; a workspace inside a project resolves to the enclosing root. Use ## subheadings and <details> blocks inside body for expandable detail.`,
  search: `Search detail notes by tag, text, or project. Call project_memory_guide first. Text search checks titles/previews and then note bodies; compact by default.`,
}

const jsonOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

/** The guide is a skill load, so render the canonical skill framing instead of JSON. */
const guideOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{
    type: 'text',
    text: `<skill_content name="${SKILL_NAME}">\n${typeof value?.content === 'string' ? value.content : ''}\n</skill_content>`,
  }],
}

function tool(name, description, parameters, execute, output = jsonOutput) {
  return { name, description, parameters, output, execute }
}

function iso(ms) {
  return isoTimestamp(ms)
}

function resultClip(value, maxChars) {
  return clip(value, maxChars)
}

function normalizeSince(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (typeof value === 'string') {
    const text = value.trim()
    if (/^\d+$/.test(text)) return Number(text)
    const parsed = Date.parse(text)
    if (Number.isFinite(parsed)) return parsed
  }
  throw new MemoryError('notes/since-invalid', `since must be an ISO date or epoch milliseconds, got ${JSON.stringify(value)}`)
}

function normalizeLimit(value, fallback, max) {
  if (value === undefined || value === null) return fallback
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MemoryError('read/limit-invalid', `limit must be a positive integer, got ${JSON.stringify(value)}`)
  }
  return Math.min(value, max)
}

function samePath(a, b) {
  return a === b
}

function projectArgSchema(description) {
  return { type: 'string', description }
}

const TAGS_SCHEMA = {
  type: 'array',
  items: { type: 'string', enum: [...ACCEPTED_TAG_VALUES] },
  description: `Tags from the closed vocabulary: ${['经验', '教训', '研究', '工程', '简单执行', '讨论'].join(' / ')}. English aliases are accepted.`,
}

const FULL_SCHEMA = {
  type: 'boolean',
  description: 'Return full stored bodies instead of compact previews. Still bounded by the memory size limits.',
}

/**
 * Project memory service: role-scoped tools, the skill gate, and the two-layer
 * policy. Host tools are registered per agent scope; every execute re-checks
 * the matrix so a mis-wired registration cannot cross a project boundary.
 */
export class ProjectMemoryService {
  /**
   * @param {{
   *   store: import('./store.js').ProjectMemoryStore,
   *   catalog: {readSync: () => Record<string, unknown>},
   *   skills?: {get: (name: string, options: unknown) => Promise<unknown>},
   *   skill: {name: string, description: string, content: string},
   *   logger?: {info?: Function, warn?: Function},
   *   clock?: () => number,
   * }} options
   */
  constructor({ store, catalog, skills, skill, logger, clock = Date.now }) {
    this.store = store
    this.catalog = catalog
    this.skills = skills
    this.skill = skill
    this.logger = logger
    this.clock = clock
    this.agents = new Map()
    this.workerBindings = new Map()
    this.loadedAgents = new Set()
    this.disposed = false
    this.loggedFallback = false
  }

  /** Synchronous role lookup used while an agent scope is being decorated. */
  identityFor(agent) {
    const known = this.agents.get(agent?.id)
    if (known) return known.identity
    let catalog = { exists: false, conversations: {}, workspaces: {} }
    try {
      catalog = this.catalog?.readSync?.() ?? catalog
    } catch (error) {
      this.logger?.warn?.(`dsh-project-memory: could not read the Super Agent catalog: ${String(error)}`)
    }
    return withKey(identityForAgent(agent, catalog, { now: this.clock() }))
  }

  /**
   * Register the role-appropriate tools and a short prompt section on one
   * agent scope. Called synchronously for `agent/created`.
   */
  registerAgent(agent) {
    if (this.disposed) return
    if (!agent || typeof agent.id !== 'string' || this.agents.has(agent.id)) return
    const identity = this.identityFor(agent)
    const definitions = this.definitionsFor(agent, identity)
    const disposers = []
    for (const definition of definitions) {
      try {
        const dispose = agent.ctx?.tools?.register?.(definition)
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        this.logger?.warn?.(`dsh-project-memory: could not register ${definition.name} for ${agent.id}: ${String(error)}`)
      }
    }
    try {
      const section = agent.ctx?.systemPrompt?.section?.({
        name: 'dsh-project-memory:role',
        order: 9998,
        interpolate: false,
        text: identity.role === 'super'
          ? `Project memory is enabled and is an orchestration capability, not host work: use it directly. Load the project-memory skill with project_memory_guide before the first memory tool. You own the summary layer: write one summary per affected project, and read workers' detail notes from any project. Decide which project(s) content belongs to before writing. When dispatching a worker into a broad parent workspace (for example /Users/me/Projects), include the actual project path in the brief and tell the worker to pass it once to its first memory call so it binds to that project root.${this.store?.backendName === 'cloudflare' ? ' Memory is shared across machines: results carry a `sync` block; if it reports stale/offline, say so when relying on old memory and never assume a queued write reached the other machine yet.' : ''}`
          : `Project memory is enabled for your workspace. Load the project-memory skill with the skill tool before the first memory tool. You own tagged detail notes for exactly one bound project; summaries and other projects' notes are not available. If the assigned workspace is a broad parent (for example /Users/me/Projects), pass the actual project path once to bind; a workspace inside a project resolves to that project root.${this.store?.backendName === 'cloudflare' ? ' Memory is shared across machines: results carry a `sync` block, and a queued write may not have reached the cloud yet.' : ''}`,
      })
      if (typeof section === 'function') disposers.push(section)
    } catch (error) {
      this.logger?.warn?.(`dsh-project-memory: could not add the prompt section for ${agent.id}: ${String(error)}`)
    }
    this.agents.set(agent.id, { identity, disposers, tools: definitions.map((definition) => definition.name) })
    if (identity.source === 'fallback' && !this.loggedFallback) {
      this.loggedFallback = true
      this.logger?.info?.('dsh-project-memory: Super Agent catalog not found; running in least-privilege notes-only mode')
    }
  }

  /** Drop one agent's registrations when its scope is disposed. */
  disposeAgent(agent) {
    const record = this.agents.get(agent?.id)
    if (!record) return
    this.agents.delete(agent.id)
    this.loadedAgents.delete(agent.id)
    this.workerBindings.delete(agent.id)
    for (const dispose of record.disposers) {
      try { dispose() } catch { /* the agent scope may already be gone */ }
    }
  }

  /** Drop every registration. */
  dispose() {
    this.disposed = true
    for (const id of [...this.agents.keys()]) this.disposeAgent({ id })
  }

  /** Cloud-sync status attached to tool results, when the backend has one. */
  syncInfo() {
    if (typeof this.store?.syncInfo !== 'function') return undefined
    try {
      const info = this.store.syncInfo()
      return info && info.backend !== 'local' ? info : undefined
    } catch {
      return undefined
    }
  }

  /** Attach sync metadata to a tool result without changing local-mode output. */
  withSync(value) {
    const sync = this.syncInfo()
    return sync === undefined ? value : { ...value, sync }
  }

  /** Tool definitions visible to one role. */
  definitionsFor(agent, identity) {
    const make = (capability, execute) => async (args, exec) => {
      const current = this.identityFor(agent)
      if (!ALLOWED[current.role]?.has(capability)) {
        throw new MemoryError(
          'permission/denied',
          `[project_memory.permission_denied] ${current.role} sessions cannot use ${capability} in this project-memory layer`,
        )
      }
      if (capability !== 'guide') this.assertSkill(agent, current)
      return execute(args ?? {}, exec ?? {}, current)
    }

    if (identity.role === 'super') {
      return [
        tool(GUIDE_TOOL, TOOL_DESCRIPTIONS.guide, { type: 'object', additionalProperties: false, properties: {} }, make('guide', () => this.guide(agent, identity)), guideOutput),
        tool('project_memory_projects', TOOL_DESCRIPTIONS.projects, {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'integer', description: `Maximum projects to list (1-${LIMITS.projectsMax}).` },
            add: projectArgSchema('Optional project path or workspace id to register without writing.'),
            title: { type: 'string', description: 'Optional display title when adding a project.' },
          },
        }, make('projects', (args) => this.listProjects(args, identity, agent))),
        tool('project_memory_summary_read', TOOL_DESCRIPTIONS.summaryRead, {
          type: 'object',
          additionalProperties: false,
          properties: {
            project: projectArgSchema('Project key, workspace id, path, or unique title. Omit to list every summary.'),
            full: FULL_SCHEMA,
            limit: { type: 'integer', description: `Maximum projects when project is omitted (1-${LIMITS.projectsMax}).` },
          },
        }, make('summary:read', (args, exec, current) => this.readSummary(agent, current, args, exec))),
        tool('project_memory_summary_write', TOOL_DESCRIPTIONS.summaryWrite, {
          type: 'object',
          additionalProperties: false,
          properties: {
            writes: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  project: projectArgSchema('Project key, workspace id, path, or unique title.'),
                  content: { type: 'string', description: 'Curated markdown summary for this project.' },
                  mode: { type: 'string', enum: ['replace', 'append'], description: 'replace (default) or append.' },
                },
                required: ['project', 'content'],
              },
              description: 'One entry per affected project. Use this for content that spans several projects.',
            },
            project: projectArgSchema('Single-project shorthand; use with content instead of writes.'),
            content: { type: 'string', description: 'Single-project summary markdown.' },
            mode: { type: 'string', enum: ['replace', 'append'], description: 'replace (default) or append.' },
          },
        }, make('summary:write', (args, exec, current) => this.writeSummaries(agent, current, args, exec))),
        tool('project_memory_notes_read', TOOL_DESCRIPTIONS.notesRead, {
          type: 'object',
          additionalProperties: false,
          properties: {
            project: projectArgSchema('Project key, path, workspace id, or title. Omit to read across every registered project.'),
            tags: TAGS_SCHEMA,
            since: { type: 'string', description: 'ISO date or epoch milliseconds; only newer notes.' },
            limit: { type: 'integer', description: `Maximum notes (1-${LIMITS.readLimitMax}).` },
            full: FULL_SCHEMA,
          },
        }, make('notes:read', (args, exec, current) => this.readNotes(agent, current, args, exec))),
        tool('project_memory_search', TOOL_DESCRIPTIONS.search, {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: { type: 'string', description: 'Case-insensitive text query; searches titles, tags, previews, then bodies.' },
            tags: TAGS_SCHEMA,
            project: projectArgSchema('Limit to one project key/path/workspace id/title.'),
            since: { type: 'string', description: 'ISO date or epoch milliseconds; only newer notes.' },
            limit: { type: 'integer', description: `Maximum matches (1-${LIMITS.searchLimitMax}).` },
            full: FULL_SCHEMA,
          },
        }, make('search', (args, exec, current) => this.search(agent, current, args, exec))),
      ]
    }

    return [
      tool('project_memory_notes_read', TOOL_DESCRIPTIONS.notesRead, {
        type: 'object',
        additionalProperties: false,
        properties: {
          project: projectArgSchema('Your bound project key/path. Omit after binding; on a broad workspace, pass the actual project path once to bind.'),
          tags: TAGS_SCHEMA,
          since: { type: 'string', description: 'ISO date or epoch milliseconds; only newer notes.' },
          limit: { type: 'integer', description: `Maximum notes (1-${LIMITS.readLimitMax}).` },
          full: FULL_SCHEMA,
        },
      }, make('notes:read', (args, exec, current) => this.readNotes(agent, current, args, exec))),
      tool('project_memory_note_append', TOOL_DESCRIPTIONS.noteAppend, {
        type: 'object',
        additionalProperties: false,
        properties: {
          project: projectArgSchema('Your project key/path. Omit after binding; on a broad workspace, pass the actual project path once to bind. Another project is rejected.'),
          title: { type: 'string', description: `Note subheading (max ${LIMITS.titleChars} chars).` },
          body: { type: 'string', description: `Markdown body (max ${LIMITS.bodyChars} chars). Use ## subheadings and <details><summary>…</summary>…</details> for expandable detail.` },
          tags: TAGS_SCHEMA,
        },
        required: ['title', 'body', 'tags'],
      }, make('notes:write', (args, exec, current) => this.appendNote(agent, current, args, exec))),
    ]
  }

  /** Load the skill body through the same registry workers use. */
  async guide(agent, identity) {
    let content = this.skill.content
    let description = this.skill.description
    let provider = 'dsh-project-memory'
    try {
      const loaded = await this.skills?.get?.(SKILL_NAME, {
        cwd: agent?.session?.header?.cwd,
        scope: agent,
      })
      if (loaded && typeof loaded.content === 'string') {
        content = loaded.content
        description = typeof loaded.description === 'string' ? loaded.description : description
        provider = typeof loaded.provider === 'string' ? loaded.provider : provider
      }
    } catch (error) {
      this.logger?.warn?.(`dsh-project-memory: guide fell back to the bundled skill body: ${String(error)}`)
    }
    // Re-read the shipped SKILL.md for the guide. The runtime skill registry
    // captures its body at registration; this keeps the Super Agent's guide
    // current after a documentation edit, without waiting for a reload.
    if (typeof this.skill.path === 'string' && this.skill.path.length > 0) {
      try {
        const latest = loadSkillDefinition(this.skill.path)
        content = latest.content
        description = latest.description
      } catch (error) {
        this.logger?.warn?.(`dsh-project-memory: guide could not re-read the skill file: ${String(error)}`)
      }
    }
    this.loadedAgents.add(agent.id)
    return {
      name: SKILL_NAME,
      description,
      provider,
      content,
      loaded: true,
      role: identity.role,
      next: 'Follow the skill, then call the memory tool you need. This guide call opens the skill gate for this session.',
    }
  }

  assertSkill(agent, identity) {
    if (this.loadedAgents.has(agent.id)) return
    if (isSkillLoaded(agent)) {
      this.loadedAgents.add(agent.id)
      return
    }
    throw new MemoryError('skill/required', skillRequiredMessage(identity.role))
  }

  async listProjects(args, identity, agent) {
    let added
    if (typeof args.add === 'string' && args.add.trim().length > 0) {
      const record = await this.projectFor(identity, args.add, {
        required: true,
        cwd: agentCwd(agent) || identity.ownProjectPath,
        title: args.title,
      })
      added = publicProject(record)
    }
    const { projects, total } = await this.store.listProjects({ limit: args.limit })
    const registeredPaths = new Set(projects.map((project) => project.path))
    let knownWorkspaces = []
    try {
      const catalog = this.catalog?.readSync?.()
      knownWorkspaces = Object.values(catalog?.workspaces ?? {}).slice(0, 50).map((workspace) => ({
        id: workspace.id,
        path: workspace.path,
        title: workspace.title,
        registered: registeredPaths.has(workspace.path),
      }))
    } catch { /* catalog is optional */ }
    return this.withSync({
      projects: projects.map(projectSummary),
      total,
      returned: projects.length,
      truncated: total > projects.length,
      ...(knownWorkspaces.length > 0 ? { knownWorkspaces } : {}),
      ...(added ? { added } : {}),
    })
  }

  async readSummary(agent, identity, args, exec) {
    if (typeof args.project === 'string' && args.project.trim().length > 0) {
      const record = await this.projectFor(identity, args.project, { required: true, cwd: agentCwd(agent), exec })
      return this.withSync(await this.store.readSummary(record, { full: args.full === true }))
    }
    const { projects, total } = await this.store.listProjects({ limit: args.limit ?? 20 })
    const previews = []
    let remaining = LIMITS.resultBudgetChars
    for (const record of projects) {
      const summary = await this.store.readSummary(record, { full: false })
      const preview = resultClip(summary.content, Math.min(2_000, Math.max(0, remaining)))
      remaining -= preview.text.length
      previews.push({ ...projectSummary(record), exists: summary.exists, preview: preview.text, previewTruncated: preview.truncated, chars: summary.chars })
      if (remaining <= 0) break
    }
    return this.withSync({ projects: previews, total, returned: previews.length, truncated: total > previews.length || remaining <= 0 })
  }

  async writeSummaries(agent, identity, args, exec) {
    const writes = normalizeWrites(args)
    const written = []
    for (const write of writes) {
      const record = await this.projectFor(identity, write.project, { required: true, cwd: agentCwd(agent), exec })
      const result = await this.store.writeSummary({ project: record, content: write.content, mode: write.mode })
      written.push({
        key: record.key,
        path: record.path,
        title: record.title,
        mode: result.mode,
        chars: result.chars,
        updatedAt: result.updatedAt,
      })
    }
    return this.withSync({
      saved: true,
      written,
      hint: 'Summaries are the Super Agent layer. Detail notes stay owned by workers.',
    })
  }

  async readNotes(agent, identity, args, exec) {
    const tags = args.tags === undefined ? undefined : normalizeTags(args.tags)
    const since = normalizeSince(args.since)
    const limit = normalizeLimit(args.limit, LIMITS.readLimitDefault, LIMITS.readLimitMax)
    const records = await this.scopeProjects(identity, args.project, { cwd: agentCwd(agent), exec })
    const result = await this.store.readNotes({ projects: records, tags, since, limit, full: args.full === true })
    const formatted = formatNotes(result.notes, { full: args.full === true })
    return this.withSync({
      projects: records.map((record) => projectSummary(record, { includeSummary: identity.role === 'super' })),
      notes: formatted.notes,
      total: result.total,
      returned: formatted.returned,
      truncated: result.truncated || formatted.truncated,
      ...(formatted.omitted > 0 ? { omitted: formatted.omitted } : {}),
    })
  }

  async appendNote(agent, identity, args, exec) {
    const title = args.title
    if (typeof title !== 'string' || title.trim().length === 0) throw new MemoryError('note/title-missing', 'title is required')
    if (typeof args.body !== 'string' || args.body.trim().length === 0) throw new MemoryError('note/body-missing', 'body is required')
    const record = await this.projectFor(identity, args.project, { required: true, cwd: agentCwd(agent), exec })
    const result = await this.store.appendNote({
      project: record,
      title,
      body: args.body,
      tags: args.tags,
      authorRole: 'worker',
      authorId: agent.id,
    })
    return this.withSync({
      saved: true,
      id: result.note.id,
      at: result.note.at,
      projectKey: record.key,
      projectPath: record.path,
      title: result.note.title,
      tags: result.note.tags,
      bodyChars: result.note.bodyChars,
      noteCount: result.noteCount,
      hint: 'Detail note appended. The Super Agent may read it; other workers cannot.',
    })
  }

  async search(agent, identity, args, exec) {
    const tags = args.tags === undefined ? undefined : normalizeTags(args.tags)
    const since = normalizeSince(args.since)
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    if (query.length === 0 && tags === undefined && typeof args.project !== 'string') {
      throw new MemoryError('search/empty', 'provide query, tags, or project')
    }
    const limit = normalizeLimit(args.limit, LIMITS.searchLimitDefault, LIMITS.searchLimitMax)
    const records = await this.scopeProjects(identity, args.project, { cwd: agentCwd(agent), exec })
    const result = await this.store.searchNotes({ projects: records, query, tags, since, limit, full: args.full === true })
    const formatted = formatSearch(result.matches, { full: args.full === true })
    return this.withSync({
      query: query || null,
      tags: tags ?? null,
      matches: formatted.matches,
      total: result.total,
      returned: formatted.returned,
      truncated: result.truncated || formatted.truncated,
      ...(formatted.omitted > 0 ? { omitted: formatted.omitted } : {}),
    })
  }

  /** Resolve the project scope for reads. Super can span projects; workers cannot. */
  async scopeProjects(identity, projectText, { cwd, exec } = {}) {
    if (typeof projectText === 'string' && projectText.trim().length > 0) {
      return [await this.projectFor(identity, projectText, { required: true, cwd, exec })]
    }
    if (identity.role === 'worker') {
      return [await this.projectFor(identity, undefined, { required: true, cwd, exec })]
    }
    const { projects } = await this.store.listProjects({ limit: LIMITS.projectsMax })
    return projects
  }

  /** Resolve a worker's requested project argument to a canonical path (or undefined for "current"). */
  async workerRequestedPath(identity, text, ownCanonical) {
    if (typeof text !== 'string' || text.length === 0 || text === 'current' || text === identity.ownProjectKey) {
      return undefined
    }
    try {
      const record = await this.store.resolveProject({ project: text, cwd: ownCanonical, autoRegister: false })
      return record.path
    } catch (error) {
      if (!(error instanceof MemoryError) || error.code !== 'project/unknown') {
        if (error instanceof MemoryError && error.code === 'project/ambiguous') {
          throw new MemoryError('permission/project', `[project_memory.permission_denied] worker ${identity.agentId} may only access its own project (${ownCanonical})`)
        }
        throw error
      }
    }
    return canonicalProjectPath(text, { cwd: ownCanonical })
  }

  /** Load the persisted immutable worker binding, if it still fits this session. */
  async workerBinding(identity, ownCanonical) {
    if (this.workerBindings.has(identity.agentId)) return this.workerBindings.get(identity.agentId)
    const stored = await this.store.getBinding(identity.agentId)
    if (!stored) return undefined
    const storedWorkspace = typeof stored.workspacePath === 'string' && stored.workspacePath.length > 0
      ? await canonicalProjectPath(stored.workspacePath, { cwd: ownCanonical })
      : undefined
    const workspaceFits = storedWorkspace === undefined
      || samePath(storedWorkspace, ownCanonical)
      || isInside(ownCanonical, storedWorkspace)
      || isInside(storedWorkspace, ownCanonical)
    const pathFits = isInside(stored.path, ownCanonical) || isInside(ownCanonical, stored.path)
    if (!workspaceFits || !pathFits) {
      await this.store.clearBinding(identity.agentId)
      return undefined
    }
    let record
    try {
      record = await this.store.resolveProject({ project: stored.path, cwd: ownCanonical, autoRegister: true, title: stored.title })
    } catch {
      record = await this.store.registerProject({ path: stored.path, title: stored.title })
    }
    this.workerBindings.set(identity.agentId, record)
    return record
  }

  /** Bind an unbound worker to exactly one project root under its assigned workspace. */
  async bindWorkerProject(identity, ownCanonical, requestedPath, title) {
    const catalog = this.catalog?.readSync?.()
    const extraPaths = Object.values(catalog?.workspaces ?? {}).map((workspace) => workspace.path)
    const registeredPaths = await this.store.registeredPaths()
    const scope = await resolveWorkerScope({
      workspacePath: identity.ownProjectPath,
      requestedPath,
      registeredPaths,
      extraPaths,
    })
    if (scope.kind === 'outside') {
      throw new MemoryError(
        'permission/project',
        `[project_memory.permission_denied] worker ${identity.agentId} may only access a project inside its assigned workspace (${scope.workspace}); ${scope.requested} is outside it`,
      )
    }
    if (scope.kind === 'unbound') {
      const examples = scope.candidates.slice(0, 5)
      throw new MemoryError(
        'project/unbound',
        `[project_memory.project_unbound] the assigned workspace "${scope.workspace}" contains several projects. Call the memory tool once with the actual project path (for example project: "${examples[0] ?? ''}") to bind this worker to that project root. The binding is permanent for this session and multi-project writes are reserved for the Super Agent. Candidates: ${examples.join(', ')}`,
      )
    }
    const record = await this.store.registerProject({
      path: scope.root,
      title: samePath(scope.root, ownCanonical) ? (identity.ownProjectTitle || title) : undefined,
    })
    const binding = await this.store.bindWorker(identity.agentId, {
      projectKey: record.key,
      path: record.path,
      title: record.title,
      workspacePath: ownCanonical,
    })
    if (!samePath(binding.path, record.path)) {
      // Another process bound this session first. Honour that binding.
      const existing = await this.store.resolveProject({ project: binding.path, cwd: ownCanonical, autoRegister: true, title: binding.title })
      this.workerBindings.set(identity.agentId, existing)
      if (requestedPath !== undefined && !isInside(requestedPath, existing.path)) {
        throw new MemoryError(
          'permission/project',
          `[project_memory.permission_denied] worker ${identity.agentId} may only access its own project (${existing.path}); ${requestedPath} is outside that project`,
        )
      }
      return existing
    }
    this.workerBindings.set(identity.agentId, record)
    return record
  }

  /**
   * Resolve one project while enforcing the worker's single-project boundary.
   *
   * A worker is bound to exactly one project root for the lifetime of its
   * session. The root is derived from the assigned workspace, not assumed to
   * equal it: a workspace inside a project resolves to that project's root, and
   * a broad parent requires the worker to name one project once. The binding is
   * persisted in `bindings.json`, so resume/reload cannot switch projects.
   */
  async projectFor(identity, projectText, { required = false, cwd, title, exec } = {}) {
    if (identity.role === 'worker') {
      const own = identity.ownProjectPath
      if (!own) throw new MemoryError('project/missing', 'the worker session has no workspace')
      const ownCanonical = await canonicalProjectPath(own, { cwd })
      const requested = typeof projectText === 'string' ? projectText.trim() : ''
      const requestedPath = await this.workerRequestedPath(identity, requested, ownCanonical)

      const bound = await this.workerBinding(identity, ownCanonical)
      if (bound) {
        if (requestedPath !== undefined && !isInside(requestedPath, bound.path)) {
          throw new MemoryError(
            'permission/project',
            `[project_memory.permission_denied] worker ${identity.agentId} may only access its own project (${bound.path}); ${requestedPath} is outside that project`,
          )
        }
        return bound
      }

      return this.bindWorkerProject(identity, ownCanonical, requestedPath, title)
    }

    const text = typeof projectText === 'string' ? projectText.trim() : ''
    if (text.length === 0) {
      if (required) throw new MemoryError('project/required', 'project is required for this write; decide which project(s) the content belongs to first')
      return undefined
    }
    const catalog = this.catalog?.readSync?.()
    const workspace = findCatalogWorkspace(catalog, text)
    if (workspace) return this.store.registerProject({ path: workspace.path, title: workspace.title })
    return this.store.resolveProject({ project: text, cwd, autoRegister: true, title })
  }
}

function withKey(identity) {
  return { ...identity, ownProjectKey: projectKeyFor(identity.ownProjectPath) }
}

function agentCwd(agent) {
  return agent?.session?.header?.cwd || process.cwd()
}

function projectSummary(record, { includeSummary = true } = {}) {
  const result = {
    key: record.key,
    path: record.path,
    title: record.title,
    noteCount: record.noteCount ?? 0,
    lastNoteAt: asIso(record.lastNoteAt),
  }
  if (record.identity) result.identity = record.identity
  if (record.identitySource) result.identitySource = record.identitySource
  if (record.remote === true) result.remote = true
  if (Number.isSafeInteger(record.cloudNoteCount)) result.sharedNoteCount = record.cloudNoteCount
  if (includeSummary) {
    result.summaryUpdatedAt = asIso(record.summaryUpdatedAt)
    result.summaryChars = record.summaryChars ?? 0
    if (Number.isSafeInteger(record.cloudSummaryVersion) && record.cloudSummaryVersion > 0) {
      result.summaryVersion = record.cloudSummaryVersion
    }
  }
  return result
}

function asIso(value) {
  return typeof value === 'string' ? value : iso(value)
}

function normalizeWrites(args) {
  const hasArray = Array.isArray(args.writes)
  const hasSingle = typeof args.project === 'string' || typeof args.content === 'string'
  if (hasArray && hasSingle) throw new MemoryError('summary/shape', 'use either writes[] or project+content, not both')
  let writes
  if (hasArray) {
    writes = args.writes
  } else if (typeof args.project === 'string' && typeof args.content === 'string') {
    writes = [{ project: args.project, content: args.content, mode: args.mode }]
  } else {
    throw new MemoryError('summary/shape', 'provide writes:[{project,content}] or project+content')
  }
  if (writes.length === 0) throw new MemoryError('summary/shape', 'writes must contain at least one project')
  if (writes.length > LIMITS.writesPerCall) {
    throw new MemoryError('summary/shape', `at most ${LIMITS.writesPerCall} project writes are allowed per call`)
  }
  return writes.map((write, index) => {
    if (!write || typeof write !== 'object') throw new MemoryError('summary/shape', `writes[${index}] must be an object`)
    if (typeof write.project !== 'string' || write.project.trim().length === 0) {
      throw new MemoryError('summary/shape', `writes[${index}].project is required`)
    }
    if (typeof write.content !== 'string' || write.content.trim().length === 0) {
      throw new MemoryError('summary/shape', `writes[${index}].content is required`)
    }
    const mode = write.mode === undefined ? 'replace' : write.mode
    if (mode !== 'replace' && mode !== 'append') {
      throw new MemoryError('summary/mode-invalid', `writes[${index}].mode must be "replace" or "append"`)
    }
    return { project: write.project.trim(), content: write.content, mode }
  })
}

function formatNotes(notes, { full = false } = {}) {
  let remaining = LIMITS.resultBudgetChars
  const output = []
  for (const note of notes) {
    if (remaining <= 200) break
    const base = {
      id: note.id,
      at: iso(note.at),
      project: note.projectKey,
      author: note.authorRole,
      title: note.title,
      tags: note.tags,
    }
    let item
    if (full) {
      const clipped = clip(note.body, Math.min(32_000, Math.max(200, remaining - 300)))
      item = { ...base, body: clipped.text, bodyChars: note.bodyChars, truncated: clipped.truncated }
    } else {
      item = { ...base, preview: note.preview ?? '', bodyChars: note.bodyChars ?? 0, truncated: (note.bodyChars ?? 0) > String(note.preview ?? '').length }
    }
    remaining -= JSON.stringify(item).length
    output.push(item)
  }
  return { notes: output, returned: output.length, omitted: notes.length - output.length, truncated: output.length < notes.length }
}

function formatSearch(matches, { full = false } = {}) {
  let remaining = LIMITS.resultBudgetChars
  const output = []
  for (const match of matches) {
    if (remaining <= 200) break
    const base = {
      id: match.id,
      at: iso(match.at),
      project: match.projectKey,
      author: match.authorRole,
      title: match.title,
      tags: match.tags,
      matchedBody: match.matchedBody === true,
    }
    let item
    if (full) {
      const clipped = clip(match.body, Math.min(32_000, Math.max(200, remaining - 300)))
      item = { ...base, body: clipped.text, bodyChars: match.bodyChars, truncated: clipped.truncated }
    } else {
      item = { ...base, preview: match.preview ?? '' }
    }
    remaining -= JSON.stringify(item).length
    output.push(item)
  }
  return { matches: output, returned: output.length, omitted: matches.length - output.length, truncated: output.length < matches.length }
}

export { ALLOWED, TOOL_DESCRIPTIONS, normalizeWrites, formatNotes, formatSearch }

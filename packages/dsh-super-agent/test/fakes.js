/** Minimal Host fakes shared by the orchestrator and API tests. */
import { randomUUID } from 'node:crypto'

export class FakeAgent {
  constructor(id, host) {
    this.id = id
    this.status = 'idle'
    this.events = []
    this.inbox = []
    this.cancelled = []
    this.sections = []
    this.tools = new Map()
    this.restrictions = []
    this.globalTools = new Set(['read', 'bash', 'job_output', 'subagent', 'workflow', 'send_message', 'spawn_teammate'])
    // Tools contributed by the agent-preset ancestor scope are restrictable
    // without being visible through the unscoped (global) tools.get() view.
    this.restrictableTools = new Set([...this.globalTools, ...(host?.presetTools ?? [])])
    this.changeListeners = new Set()
    const agent = this
    this.ctx = {
      systemPrompt: {
        section(section) {
          agent.sections.push(section)
          return () => {}
        },
      },
      on(name, callback) {
        if (name !== 'tools/change') return () => {}
        agent.changeListeners.add(callback)
        return () => agent.changeListeners.delete(callback)
      },
      tools: {
        register(definition) {
          agent.tools.set(definition.name, definition)
          return () => {}
        },
        get(name) {
          return agent.globalTools.has(name) ? { name } : undefined
        },
        restrict(restriction) {
          const names = [...(restriction.allow ?? []), ...(restriction.deny ?? [])]
          const unknown = names.filter((name) => !agent.restrictableTools.has(name))
          if (unknown.length > 0) {
            throw new Error(`tools.restrict() names unknown global tool ${unknown.map((name) => `"${name}"`).join(', ')}`)
          }
          agent.restrictions.push(restriction)
          agent.emitToolsChange()
          return () => {
            const index = agent.restrictions.indexOf(restriction)
            if (index >= 0) agent.restrictions.splice(index, 1)
          }
        },
        guard() { return () => {} },
      },
    }
    this.session = {
      id,
      snapshotEvents: () => agent.events,
    }
  }

  /** Simulate a registry change that makes a tool restrictable and optionally visible. */
  exposeTool(name, { visible = true } = {}) {
    this.restrictableTools.add(name)
    if (visible) this.globalTools.add(name)
    this.emitToolsChange()
  }

  emitToolsChange() {
    for (const callback of [...this.changeListeners]) callback()
  }

  /** Tool names this agent would see after deny restrictions, including its own registrations. */
  visibleToolNames() {
    const denied = new Set(this.restrictions.flatMap((restriction) => restriction.deny ?? []))
    return new Set([...this.restrictableTools, ...this.tools.keys()].filter((name) => !denied.has(name)))
  }

  followup(message) {
    this.inbox.push(message)
    this.status = 'idle'
  }

  cancel(cause) {
    this.cancelled.push(cause)
    this.status = 'idle'
  }
}

export class FakeHost {
  constructor() {
    this.agents = new Map()
    this.sessions = new Map()
    this.workspaces = new Map()
    this.prompts = []
    this.logs = []
    this.renameCalls = []
    this.createdSessions = []
    // Names the fake agent preset contributes to every new agent scope.
    this.presetTools = new Set()
    const host = this
    this.workspaceRegistry = {
      async create(path, title) {
        for (const workspace of host.workspaces.values()) {
          if (workspace.path === path) return workspace
        }
        const workspace = {
          id: `ws-${randomUUID()}`,
          path,
          title: title || path.split('/').at(-1) || path,
          createdAt: new Date().toISOString(),
        }
        host.workspaces.set(workspace.id, workspace)
        return workspace
      },
      get(id) { return host.workspaces.get(id) },
      list() { return [...host.workspaces.values()] },
    }
    this.sessionController = {
      async create({ sessionId, workspaceId }) {
        host.sessions.set(sessionId, { sessionId, workspaceId })
        host.createdSessions.push({ sessionId, workspaceId })
        return { sessionId }
      },
      async resolveAgent(sessionId) {
        const session = host.sessions.get(sessionId)
        if (!session) return { error: { code: 'session/not-found', message: 'not found' } }
        let agent = host.agents.get(sessionId)
        if (!agent) {
          agent = new FakeAgent(sessionId, host)
          host.agents.set(sessionId, agent)
        }
        return { agent }
      },
      async rename({ sessionId, title }) {
        host.renameCalls.push({ sessionId, title })
        return { title, seq: 1 }
      },
      async prompt(request) {
        host.prompts.push(request)
        return { accepted: true }
      },
    }
    this.logger = {
      info: (message) => host.logs.push(['info', message]),
      warn: (message) => host.logs.push(['warn', message]),
    }
  }

  get(id) {
    return this.agents.get(id)
  }
}

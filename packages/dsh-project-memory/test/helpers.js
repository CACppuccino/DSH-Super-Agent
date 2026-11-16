import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectMemoryService } from '../lib/service.js'
import { ProjectMemoryStore } from '../lib/store.js'

export async function tempDir(prefix = 'dsh-project-memory-test-') {
  return mkdtemp(join(tmpdir(), prefix))
}

export async function makeStore() {
  const rootDir = await tempDir()
  const store = new ProjectMemoryStore({ rootDir })
  await store.init()
  return { store, rootDir }
}

export function catalogFor({ superPath, workerPath, otherPath } = {}) {
  const workspaces = {}
  const conversations = {
    'super-1': {
      id: 'super-1', kind: 'super', title: 'Super Agent',
      workspacePath: superPath ?? '/tmp/dsh-super-workspace',
      workspaceTitle: 'Super Agent',
    },
    'worker-1': {
      id: 'worker-1', kind: 'worker', title: 'Task',
      workspacePath: workerPath ?? '/tmp/project-a',
      workspaceTitle: 'Project A',
    },
  }
  if (workerPath) workspaces['ws-a'] = { id: 'ws-a', path: workerPath, title: 'Project A' }
  if (otherPath) workspaces['ws-b'] = { id: 'ws-b', path: otherPath, title: 'Project B' }
  if (superPath) workspaces['ws-super'] = { id: 'ws-super', path: superPath, title: 'Super Agent' }
  return { exists: true, conversations, workspaces, updatedAt: Date.now() }
}

export class FakeAgent {
  constructor(id, { cwd = '/tmp/project-a', catalog = catalogFor({}) } = {}) {
    this.id = id
    this.status = 'idle'
    this.events = []
    this.tools = new Map()
    this.toolDisposers = []
    this.sections = []
    this.session = {
      id,
      header: { cwd },
      snapshotEvents: () => this.events,
    }
    const agent = this
    this.ctx = {
      tools: {
        register(definition) {
          agent.tools.set(definition.name, definition)
          const dispose = () => agent.tools.delete(definition.name)
          agent.toolDisposers.push(dispose)
          return dispose
        },
      },
      systemPrompt: {
        section(section) {
          agent.sections.push(section)
          return () => {}
        },
      },
    }
  }

  addToolCall(name, args, callId = `call-${this.events.length}`) {
    this.events.push({ type: 'tool/call', data: { name, arguments: JSON.stringify(args), callId } })
    return callId
  }

  addToolResult(callId, { isError = false } = {}) {
    this.events.push({
      type: 'tool/result',
      data: { message: { content: [{ toolCallId: callId, isError }] } },
    })
  }

  addUserSkillInvocation(name = 'project-memory') {
    this.events.push({ type: 'user/message', data: { source: { kind: 'skill-invocation', name } } })
  }

  loadSkill(name = 'project-memory', { failed = false } = {}) {
    const callId = this.addToolCall('skill', { name })
    this.addToolResult(callId, { isError: failed })
  }
}

export function makeService({ store, catalog = catalogFor({}), skills, skill } = {}) {
  const service = new ProjectMemoryService({
    store,
    catalog: { readSync: () => catalog },
    skills,
    skill: skill ?? { name: 'project-memory', description: 'test skill', content: '# Project memory test body' },
    logger: { info() {}, warn() {} },
  })
  return service
}

export async function setup({ catalog, cwd } = {}) {
  const { store, rootDir } = await makeStore()
  const service = makeService({ store, catalog })
  const agent = new FakeAgent('worker-1', { cwd, catalog })
  service.registerAgent(agent)
  return { store, rootDir, service, agent }
}

export async function callTool(agent, name, args = {}, exec = {}) {
  const definition = agent.tools.get(name)
  if (!definition) throw new Error(`tool ${name} is not registered`)
  return definition.execute(args, { agent, ...exec })
}

export async function writeCatalog(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2))
}

/** Resolve after `ms`, or reject with the signal's reason as soon as it aborts. */
export function sleepOrAbort(ms, signal) {
  return new Promise((resolve, reject) => {
    if (!signal) {
      setTimeout(resolve, ms)
      return
    }
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** A promise that only settles when the signal aborts (or after `fallbackMs`). */
export function waitForAbort(signal, fallbackMs = 5_000) {
  return new Promise((resolve, reject) => {
    if (!signal) {
      setTimeout(resolve, fallbackMs)
      return
    }
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, fallbackMs)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

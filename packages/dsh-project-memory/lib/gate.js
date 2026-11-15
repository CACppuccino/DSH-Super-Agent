import { SKILL_NAME } from './skill.js'

/** Tool names whose successful call loads the project-memory instructions. */
export const SKILL_LOADER_CALLS = Object.freeze(['skill', 'project_memory_guide'])

function parseArguments(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function eventsOf(agent) {
  try {
    const events = agent?.session?.snapshotEvents?.()
    if (Array.isArray(events)) return events
  } catch { /* a test agent may not expose a log */ }
  try {
    if (Array.isArray(agent?.events)) return agent.events
  } catch { /* ignore */ }
  return []
}

/**
 * Whether this exact session has already loaded the project-memory skill.
 *
 * The gate is derived from the durable session log, not from prompt text:
 *   - a successful `skill({name:"project-memory"})` call (workers), or
 *   - a successful `project_memory_guide` call (Super Agent, whose `skill`
 *     tool is denied by dsh-super-agent), or
 *   - a user-explicit skill invocation injected as `{kind:"skill-invocation"}`.
 *
 * A failed loader call does not open the gate.
 * @param {{session?: {snapshotEvents?: () => unknown[]}, events?: unknown[]}} agent
 * @returns {boolean}
 */
export function isSkillLoaded(agent) {
  const events = eventsOf(agent)
  const pending = new Map()
  let userInvoked = false
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    if (event.type === 'user/message') {
      const source = event.data?.source
      if (source?.kind === 'skill-invocation' && source?.name === SKILL_NAME) userInvoked = true
      continue
    }
    if (event.type === 'tool/call') {
      const name = event.data?.name
      if (typeof name !== 'string' || !SKILL_LOADER_CALLS.includes(name)) continue
      if (name === 'skill') {
        const args = parseArguments(event.data?.arguments)
        if (args?.name !== SKILL_NAME) continue
      }
      const callId = event.data?.callId
      if (typeof callId === 'string') pending.set(callId, name)
      continue
    }
    if (event.type === 'tool/result') {
      const block = event.data?.message?.content?.[0]
      const callId = block?.toolCallId ?? event.data?.message?.source?.callId
      if (typeof callId !== 'string' || !pending.has(callId)) continue
      if (block?.isError === true) {
        pending.delete(callId)
        continue
      }
      return true
    }
  }
  return userInvoked
}

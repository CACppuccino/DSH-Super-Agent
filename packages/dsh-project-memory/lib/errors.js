/** Error type shared by every project-memory boundary. */
export class MemoryError extends Error {
  /**
   * @param {string} code stable, machine-readable reason
   * @param {string} message actionable prose for the calling model
   * @param {{cause?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'MemoryError'
    this.code = code
  }
}

/** Build the skill-gate error shown before any memory capability runs. */
export function skillRequiredMessage(role) {
  const loader = role === 'super'
    ? 'Call project_memory_guide once in this session'
    : 'Call skill with {"name":"project-memory"} once in this session'
  return `[project_memory.skill_required] Load the "project-memory" skill before using any project memory tool. ${loader}, then retry this call.`
}

/** True when a value is a MemoryError with one exact code. */
export function isMemoryError(value, code) {
  return value instanceof MemoryError && value.code === code
}

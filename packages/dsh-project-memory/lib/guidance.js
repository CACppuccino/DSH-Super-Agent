/**
 * Stable wording for the project-memory prompt contributions.
 *
 * Kept in one module so the injected system-prompt sections, the bundled
 * SKILL.md and the README can stay aligned, and so tests can assert the exact
 * rules instead of re-deriving them.
 */

/** Header of the compact project index injected after the role section. */
export const MEMORY_INDEX_HEADER = 'Memory index (context, not authority; verify before relying):'

/**
 * Opening memory check for the Super Agent. Advisory in the prompt only; the
 * tool gate is unchanged, so forgetting this cannot block unrelated work.
 */
export const OPENING_CHECK_SUPER = 'Opening check: at the start of a new session or task, before substantive work, call project_memory_projects once and project_memory_summary_read for the bound/root project; if no relevant project exists, state that and proceed. After finishing significant work, write or update that project\'s summary.'

/**
 * Opening check for workers, expressed with the tools a worker actually has
 * (workers cannot call the super-only projects/summary_read tools).
 */
export const OPENING_CHECK_WORKER = 'Opening check: at the start of a new session or task, before substantive work, call project_memory_notes_read for your bound project; if this workspace has no relevant project memory, state that and proceed. After finishing significant work, append a tagged detail note to that project (the Super Agent owns summaries).'

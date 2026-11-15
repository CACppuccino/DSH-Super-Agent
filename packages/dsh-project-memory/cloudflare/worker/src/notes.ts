import type { RouteContext } from './types.ts'
import { HttpError } from './errors.ts'
import { json } from './http.ts'
import { execute, projectDto, projectRowById } from './db.ts'
import { resolveMachineId } from './identity.ts'
import { MAX_NOTES_PER_REQUEST, assertNoteInput, readJsonBody } from './validate.ts'

const INSERT_NOTE_SQL = `INSERT OR IGNORE INTO notes
  (id, project_id, at, author_role, author_id, machine_id, title, tags, body, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

/**
 * `POST /v1/projects/:id/notes` — append one note or a batch, idempotent by
 * the globally unique note id. A note id owned by a different project is
 * reported as `existing` and is never moved or overwritten.
 */
export async function appendNotes({ request, env, params }: RouteContext): Promise<Response> {
  const machineId = resolveMachineId(request)

  const project = await projectRowById(env.DB, params.id)
  if (project === null) {
    return json({ error: { code: 'project_not_found', message: `project ${params.id} not found` } }, 404)
  }

  const body = await readJsonBody(request)
  let inputs: unknown[]
  if (body.note !== undefined) {
    inputs = [body.note]
  } else if (Array.isArray(body.notes)) {
    inputs = body.notes
  } else if (body.notes !== undefined) {
    throw new HttpError(400, 'notes_invalid', '"notes" must be an array')
  } else {
    throw new HttpError(400, 'note_invalid', 'request body must contain "note" or "notes"')
  }

  if (inputs.length > MAX_NOTES_PER_REQUEST) {
    throw new HttpError(400, 'notes_too_many', `at most ${MAX_NOTES_PER_REQUEST} notes may be appended per request`)
  }

  const now = Date.now()
  const seen = new Set<string>()
  const notes = []
  for (const input of inputs) {
    const note = assertNoteInput(input, now)
    if (seen.has(note.id)) {
      throw new HttpError(400, 'note_duplicate', `duplicate note id in request: ${note.id}`)
    }
    seen.add(note.id)
    notes.push(note)
  }

  const inserted: string[] = []
  const existing: string[] = []
  for (const note of notes) {
    const result = await execute(
      env.DB,
      INSERT_NOTE_SQL,
      note.id,
      project.id,
      note.at,
      note.authorRole,
      note.authorId,
      machineId,
      note.title,
      JSON.stringify(note.tags),
      note.body,
      now,
      now,
    )
    if (Number(result.meta?.changes ?? 0) > 0) inserted.push(note.id)
    else existing.push(note.id)
  }

  if (inserted.length > 0) {
    // Bump the project counters once per accepted append, using only notes
    // that were actually inserted (a collision/replay must not attribute
    // another project's note to this one).
    const insertedIds = new Set(inserted)
    const maxAt = notes
      .filter((note) => insertedIds.has(note.id))
      .reduce((max, note) => Math.max(max, note.at), 0)
    await execute(
      env.DB,
      `UPDATE projects
         SET updated_at = ?, last_note_at = MAX(COALESCE(last_note_at, 0), ?)
       WHERE id = ?`,
      now,
      maxAt,
      project.id,
    )
  }

  const updatedProject = await projectRowById(env.DB, project.id)
  if (updatedProject === null) throw new Error(`project ${project.id} disappeared while appending notes`)

  return json({
    inserted,
    existing,
    project: projectDto(updatedProject),
    paging: { nextSinceSeq: Number(updatedProject.last_seq ?? 0) },
  })
}

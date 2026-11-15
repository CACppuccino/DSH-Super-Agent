import type { NoteRow, RouteContext } from './types.ts'
import { json } from './http.ts'
import {
  execute,
  listProjectRows,
  mergePathHints,
  noteDto,
  parsePathHints,
  projectDto,
  projectRowById,
  projectRowByIdentity,
  queryAll,
  queryFirst,
  summaryDto,
  summaryRow,
} from './db.ts'
import { assertIdentity, assertIdentitySource, projectIdFor, resolveMachineId } from './identity.ts'
import {
  MAX_LIST_LIMIT,
  assertPathHint,
  assertTitle,
  intParam,
  readJsonBody,
  seqParam,
  sinceAtParam,
} from './validate.ts'

/** `GET /v1/projects?limit=` — registry ordered by most recently updated. */
export async function listProjects({ env, url }: RouteContext): Promise<Response> {
  const limit = intParam(url.searchParams.get('limit'), 50, 1, MAX_LIST_LIMIT, 'limit_invalid', 'limit')
  const rows = await listProjectRows(env.DB, limit)
  const total = await queryFirst<{ total: number | null }>(env.DB, 'SELECT COUNT(*) AS total FROM projects')
  return json({
    projects: rows.map(projectDto),
    total: Number(total?.total ?? 0),
  })
}

/** `POST /v1/projects` — idempotent registration/upsert keyed by identity. */
export async function registerProject({ request, env }: RouteContext): Promise<Response> {
  const body = await readJsonBody(request)
  const machineId = resolveMachineId(request, body)

  const identity = assertIdentity(body.identity)
  const identitySource = assertIdentitySource(body.identitySource, identity)
  const title = assertTitle(body.title)
  const pathHint = body.pathHint === undefined ? undefined : assertPathHint(body.pathHint)

  const now = Date.now()
  const hint = pathHint === undefined ? undefined : { machineId, path: pathHint, at: now }

  const existing = await projectRowByIdentity(env.DB, identity)
  const initialHints = mergePathHints(parsePathHints(existing?.path_hints), hint)
  let created = false

  if (existing === null) {
    const id = await projectIdFor(identity)
    const result = await execute(
      env.DB,
      `INSERT OR IGNORE INTO projects
         (id, identity, identity_source, title, created_at, updated_at, last_note_at,
          summary_version, summary_updated_at, summary_updated_by, summary_chars, path_hints)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL, 0, ?)`,
      id,
      identity,
      identitySource,
      title,
      now,
      now,
      JSON.stringify(initialHints),
    )
    created = Number(result.meta?.changes ?? 0) > 0
  }

  if (!created) {
    // Either the identity already existed or a concurrent request won the
    // insert race; recompute the merged hints from the stored row.
    const current = existing ?? (await projectRowByIdentity(env.DB, identity))
    if (current === null) throw new Error(`failed to register project identity ${identity}`)
    const hints = mergePathHints(parsePathHints(current.path_hints), hint)
    await execute(
      env.DB,
      'UPDATE projects SET title = ?, updated_at = ?, path_hints = ? WHERE identity = ?',
      title,
      now,
      JSON.stringify(hints),
      identity,
    )
  }

  const row = await projectRowByIdentity(env.DB, identity)
  if (row === null) throw new Error(`failed to read registered project identity ${identity}`)
  return json({ project: projectDto(row), created })
}

/** `GET /v1/projects/:id` — project, current summary and a notes page. */
export async function getProject({ env, url, params }: RouteContext): Promise<Response> {
  const project = await projectRowById(env.DB, params.id)
  if (project === null) {
    return json({ error: { code: 'project_not_found', message: `project ${params.id} not found` } }, 404)
  }

  const notesSinceSeq = seqParam(url.searchParams.get('notesSinceSeq'))
  const notesLimit = intParam(
    url.searchParams.get('notesLimit'),
    100,
    1,
    200,
    'notes_limit_invalid',
    'notesLimit',
  )
  const sinceAt = sinceAtParam(url.searchParams.get('sinceAt'))
  const includeSummaryRaw = url.searchParams.get('includeSummary')
  const includeSummary =
    includeSummaryRaw === null ||
    !(includeSummaryRaw === '0' || includeSummaryRaw.toLowerCase() === 'false')

  let sql = 'SELECT * FROM notes WHERE project_id = ? AND seq > ?'
  const bindings: unknown[] = [project.id, notesSinceSeq]
  if (sinceAt !== undefined) {
    sql += ' AND at >= ?'
    bindings.push(sinceAt)
  }
  sql += ' ORDER BY seq ASC LIMIT ?'
  bindings.push(notesLimit + 1)

  const noteRows = await queryAll<NoteRow>(env.DB, sql, ...bindings)
  const hasMore = noteRows.length > notesLimit
  const page = hasMore ? noteRows.slice(0, notesLimit) : noteRows
  const nextSinceSeq = page.length > 0 ? Number(page[page.length - 1].seq) : notesSinceSeq

  let summary = null
  if (includeSummary) {
    const row = await summaryRow(env.DB, project.id)
    summary = row === null ? null : summaryDto(row)
  }

  return json({
    project: projectDto(project),
    summary,
    notes: page.map(noteDto),
    paging: { nextSinceSeq, hasMore, limit: notesLimit },
  })
}

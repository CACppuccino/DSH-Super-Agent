import type { RouteContext, SummaryMetaDto, SummaryRow } from './types.ts'
import { json } from './http.ts'
import { projectRowById, queryAll, queryFirst, summaryRow } from './db.ts'
import { resolveMachineId } from './identity.ts'
import { MAX_LIST_LIMIT, assertSummaryInput, intParam, readJsonBody } from './validate.ts'

const ARCHIVE_SUMMARY_SQL = `INSERT INTO summary_versions
    (project_id, version, content, chars, updated_at, updated_by, client_op_id)
  SELECT project_id, version, content, chars, updated_at, updated_by, client_op_id
  FROM summaries
  WHERE project_id = ? AND client_op_id IS NOT ?`

const UPSERT_SUMMARY_SQL = `INSERT INTO summaries
    (project_id, content, chars, version, updated_at, updated_by, client_op_id)
  VALUES (?, ?, ?, 1, ?, ?, ?)
  ON CONFLICT(project_id) DO UPDATE SET
    content = excluded.content,
    chars = excluded.chars,
    version = summaries.version + 1,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by,
    client_op_id = excluded.client_op_id
  WHERE summaries.client_op_id IS NOT excluded.client_op_id`

const UPDATE_PROJECT_SUMMARY_SQL = `UPDATE projects
  SET summary_version = (SELECT version FROM summaries WHERE project_id = ?),
      summary_updated_at = ?,
      summary_updated_by = ?,
      summary_chars = ?,
      updated_at = ?
  WHERE id = ?`

function notFound(projectId: string): Response {
  return json({ error: { code: 'project_not_found', message: `project ${projectId} not found` } }, 404)
}

/**
 * `PUT /v1/projects/:id/summary` — last-write-wins summary replacement.
 *
 * One atomic D1 batch archives the previous summary, upserts the new one
 * (version + 1, guarded by clientOpId for idempotent replay) and mirrors the
 * counters onto the project row.
 */
export async function putSummary({ request, env, params }: RouteContext): Promise<Response> {
  const machineId = resolveMachineId(request)

  const project = await projectRowById(env.DB, params.id)
  if (project === null) return notFound(params.id)

  const body = await readJsonBody(request)
  const { content, clientOpId, baseVersion } = assertSummaryInput(body)
  const now = Date.now()

  const current = await summaryRow(env.DB, project.id)
  const previousVersion = current === null ? 0 : Number(current.version)
  const idempotent = current !== null && current.client_op_id === clientOpId
  const conflict = baseVersion !== undefined && baseVersion !== previousVersion

  await env.DB.batch([
    env.DB.prepare(ARCHIVE_SUMMARY_SQL).bind(project.id, clientOpId),
    env.DB.prepare(UPSERT_SUMMARY_SQL).bind(project.id, content, content.length, now, machineId, clientOpId),
    env.DB
      .prepare(UPDATE_PROJECT_SUMMARY_SQL)
      .bind(project.id, now, machineId, content.length, now, project.id),
  ])

  const stored = await summaryRow(env.DB, project.id)
  if (stored === null) throw new Error(`summary for project ${project.id} missing after write`)

  return json({
    summary: {
      version: Number(stored.version),
      chars: Number(stored.chars),
      updatedAt: Number(stored.updated_at),
      updatedBy: stored.updated_by,
      clientOpId: stored.client_op_id,
    },
    previousVersion,
    conflict,
    idempotent,
    archivedVersion: previousVersion > 0 && !idempotent ? previousVersion : null,
  })
}

/**
 * `GET /v1/projects/:id/summary/versions` — version metadata, newest first.
 * The current summary is included (marked `current: true`) so the list is a
 * complete version index and `currentVersion` always names a listed entry.
 */
export async function listSummaryVersions({ env, url, params }: RouteContext): Promise<Response> {
  const project = await projectRowById(env.DB, params.id)
  if (project === null) return notFound(params.id)

  const limit = intParam(url.searchParams.get('limit'), 50, 1, MAX_LIST_LIMIT, 'limit_invalid', 'limit')
  const current = await summaryRow(env.DB, project.id)
  const currentVersion = current === null ? 0 : Number(current.version)

  const history = await queryAll<SummaryRow>(
    env.DB,
    'SELECT * FROM summary_versions WHERE project_id = ? ORDER BY version DESC LIMIT ?',
    project.id,
    limit,
  )

  const versions: SummaryMetaDto[] = []
  const seen = new Set<number>()
  for (const row of history) {
    const version = Number(row.version)
    if (seen.has(version)) continue
    seen.add(version)
    versions.push({
      version,
      chars: Number(row.chars),
      updatedAt: Number(row.updated_at),
      updatedBy: row.updated_by,
      clientOpId: row.client_op_id,
      current: version === currentVersion,
    })
  }
  if (current !== null && !seen.has(currentVersion)) {
    versions.push({
      version: currentVersion,
      chars: Number(current.chars),
      updatedAt: Number(current.updated_at),
      updatedBy: current.updated_by,
      clientOpId: current.client_op_id,
      current: true,
    })
  }
  versions.sort((left, right) => right.version - left.version)

  return json({ versions: versions.slice(0, limit), currentVersion })
}

/** `GET /v1/projects/:id/summary/versions/:version` — one summary body. */
export async function getSummaryVersion({ env, params }: RouteContext): Promise<Response> {
  const project = await projectRowById(env.DB, params.id)
  if (project === null) return notFound(params.id)

  const raw = params.version
  const version = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(version) || version < 1) {
    return json(
      { error: { code: 'summary_version_not_found', message: `summary version ${raw} not found` } },
      404,
    )
  }

  const archived = await queryFirst<SummaryRow>(
    env.DB,
    'SELECT * FROM summary_versions WHERE project_id = ? AND version = ?',
    project.id,
    version,
  )
  const row =
    archived ??
    (await queryFirst<SummaryRow>(
      env.DB,
      'SELECT * FROM summaries WHERE project_id = ? AND version = ?',
      project.id,
      version,
    ))
  if (row === null) {
    return json(
      { error: { code: 'summary_version_not_found', message: `summary version ${version} not found` } },
      404,
    )
  }

  return json({
    version: Number(row.version),
    content: row.content,
    chars: Number(row.chars),
    updatedAt: Number(row.updated_at),
    updatedBy: row.updated_by,
    clientOpId: row.client_op_id,
  })
}

import type {
  NoteDto,
  NoteRow,
  PathHint,
  ProjectDto,
  ProjectRow,
  SummaryDto,
  SummaryRow,
} from './types.ts'
import { isRecord } from './validate.ts'

/** Project columns plus the computed counters required by the API. */
export const PROJECT_SELECT = `SELECT p.*,
  (SELECT COUNT(*) FROM notes n WHERE n.project_id = p.id) AS note_count,
  (SELECT COALESCE(MAX(n.seq), 0) FROM notes n WHERE n.project_id = p.id) AS last_seq
FROM projects p`

const MAX_PATH_HINTS = 20

/** Run a query and return the first row (or null). */
export async function queryFirst<T>(db: D1Database, sql: string, ...args: unknown[]): Promise<T | null> {
  const statement = args.length === 0 ? db.prepare(sql) : db.prepare(sql).bind(...args)
  const row = await statement.first<T>()
  return row ?? null
}

/** Run a query and return every row. */
export async function queryAll<T>(db: D1Database, sql: string, ...args: unknown[]): Promise<T[]> {
  const statement = args.length === 0 ? db.prepare(sql) : db.prepare(sql).bind(...args)
  const result = await statement.all<T>()
  return result.results ?? []
}

/** Execute a write and return the D1 result (meta.changes etc.). */
export async function execute(db: D1Database, sql: string, ...args: unknown[]) {
  const statement = args.length === 0 ? db.prepare(sql) : db.prepare(sql).bind(...args)
  return statement.run()
}

export async function projectRowById(db: D1Database, id: string): Promise<ProjectRow | null> {
  return queryFirst<ProjectRow>(db, `${PROJECT_SELECT} WHERE p.id = ?`, id)
}

export async function projectRowByIdentity(db: D1Database, identity: string): Promise<ProjectRow | null> {
  return queryFirst<ProjectRow>(db, `${PROJECT_SELECT} WHERE p.identity = ?`, identity)
}

export async function listProjectRows(db: D1Database, limit: number): Promise<ProjectRow[]> {
  return queryAll<ProjectRow>(db, `${PROJECT_SELECT} ORDER BY p.updated_at DESC LIMIT ?`, limit)
}

export async function summaryRow(db: D1Database, projectId: string): Promise<SummaryRow | null> {
  return queryFirst<SummaryRow>(db, 'SELECT * FROM summaries WHERE project_id = ?', projectId)
}

export function parsePathHints(raw: unknown): PathHint[] {
  if (typeof raw !== 'string') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const hints: PathHint[] = []
  for (const value of parsed) {
    if (!isRecord(value)) continue
    if (typeof value.machineId !== 'string' || typeof value.path !== 'string') continue
    hints.push({
      machineId: value.machineId,
      path: value.path,
      at: typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : 0,
    })
  }
  return hints
}

/**
 * Prepend one path hint, dedupe by (machineId, path), newest first, cap 20.
 */
export function mergePathHints(current: PathHint[], hint: PathHint | undefined): PathHint[] {
  const ordered = hint === undefined ? current.slice() : [hint, ...current]
  const seen = new Set<string>()
  const merged: PathHint[] = []
  for (const item of ordered) {
    const key = `${item.machineId}\u0000${item.path}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(item)
    if (merged.length >= MAX_PATH_HINTS) break
  }
  return merged
}

export function projectDto(row: ProjectRow): ProjectDto {
  return {
    id: row.id,
    identity: row.identity,
    identitySource: row.identity_source,
    title: row.title,
    noteCount: Number(row.note_count ?? 0),
    lastSeq: Number(row.last_seq ?? 0),
    summaryVersion: Number(row.summary_version ?? 0),
    summaryUpdatedAt: row.summary_updated_at === null ? null : Number(row.summary_updated_at),
    summaryChars: Number(row.summary_chars ?? 0),
    summaryUpdatedBy: row.summary_updated_by,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastNoteAt: row.last_note_at === null ? null : Number(row.last_note_at),
    pathHints: parsePathHints(row.path_hints),
  }
}

export function summaryDto(row: SummaryRow): SummaryDto {
  return {
    content: row.content,
    chars: Number(row.chars),
    version: Number(row.version),
    updatedAt: Number(row.updated_at),
    updatedBy: row.updated_by,
    clientOpId: row.client_op_id,
  }
}

export function noteDto(row: NoteRow): NoteDto {
  let tags: string[] = []
  try {
    const parsed: unknown = JSON.parse(row.tags)
    if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === 'string')
  } catch {
    tags = []
  }
  const body = row.body
  return {
    id: row.id,
    seq: Number(row.seq),
    at: Number(row.at),
    authorRole: row.author_role,
    authorId: row.author_id,
    machineId: row.machine_id,
    title: row.title,
    tags,
    body,
    chars: body.length,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

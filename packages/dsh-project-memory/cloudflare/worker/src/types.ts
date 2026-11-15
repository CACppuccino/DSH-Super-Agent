/**
 * Shared types for the DSH project-memory Cloudflare Worker.
 *
 * Only erasable TypeScript syntax is used here so the files run directly under
 * `node --experimental-strip-types` (no enums, namespaces or parameter
 * properties). `D1Database` is an ambient type from
 * `@cloudflare/workers-types` and disappears at runtime.
 */

export interface Env {
  DB: D1Database
  MEMORY_TOKEN: string
}

export interface RouteContext {
  request: Request
  env: Env
  url: URL
  params: Record<string, string>
}

export interface PathHint {
  machineId: string
  path: string
  at: number
}

export interface ProjectRow {
  id: string
  identity: string
  identity_source: string
  title: string
  created_at: number
  updated_at: number
  last_note_at: number | null
  summary_version: number
  summary_updated_at: number | null
  summary_updated_by: string | null
  summary_chars: number
  path_hints: string
  note_count?: number | null
  last_seq?: number | null
}

export interface NoteRow {
  seq: number
  id: string
  project_id: string
  at: number
  author_role: string
  author_id: string | null
  machine_id: string
  title: string
  tags: string
  body: string
  created_at: number
  updated_at: number
}

export interface SummaryRow {
  project_id: string
  content: string
  chars: number
  version: number
  updated_at: number
  updated_by: string
  client_op_id: string
}

export interface ProjectDto {
  id: string
  identity: string
  identitySource: string
  title: string
  noteCount: number
  lastSeq: number
  summaryVersion: number
  summaryUpdatedAt: number | null
  summaryChars: number
  summaryUpdatedBy: string | null
  createdAt: number
  updatedAt: number
  lastNoteAt: number | null
  pathHints: PathHint[]
}

export interface SummaryDto {
  content: string
  chars: number
  version: number
  updatedAt: number
  updatedBy: string
  clientOpId: string
}

export interface SummaryMetaDto {
  version: number
  chars: number
  updatedAt: number
  updatedBy: string
  clientOpId: string
  current: boolean
}

export interface NoteDto {
  id: string
  seq: number
  at: number
  authorRole: string
  authorId: string | null
  machineId: string
  title: string
  tags: string[]
  body: string
  chars: number
  createdAt: number
  updatedAt: number
}

export interface NormalizedNote {
  id: string
  at: number
  title: string
  tags: string[]
  body: string
  authorRole: string
  authorId: string | null
}

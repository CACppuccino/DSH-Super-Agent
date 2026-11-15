import { HttpError } from './errors.ts'
import type { NormalizedNote } from './types.ts'

/** Hard input limits mirrored from the local project-memory store. */
export const TITLE_MAX = 200
export const BODY_MAX = 65_536
export const SUMMARY_MAX = 32_768
export const PATH_HINT_MAX = 1_024
export const AUTHOR_ID_MAX = 200
export const MAX_NOTES_PER_REQUEST = 50
export const MAX_NOTES_PER_PAGE = 200
export const MAX_LIST_LIMIT = 200
export const NOTE_TAG_VOCABULARY: readonly string[] = Object.freeze([
  '经验',
  '教训',
  '研究',
  '工程',
  '简单执行',
  '讨论',
])
const NOTE_TAG_SET = new Set(NOTE_TAG_VOCABULARY)

export const NOTE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
export const CLIENT_OP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/

const MAX_REQUEST_CHARS = 8 * 1024 * 1024
const MAX_CLOCK_SKEW_MS = 7 * 24 * 60 * 60 * 1_000

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse a JSON object request body. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await request.text()
  } catch {
    throw new HttpError(400, 'invalid_json', 'request body must be readable JSON')
  }
  if (text.length > MAX_REQUEST_CHARS) {
    throw new HttpError(413, 'payload_too_large', 'request body is too large')
  }
  if (text.trim().length === 0) {
    throw new HttpError(400, 'invalid_json', 'request body must be a JSON object')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'invalid_json', 'request body must be valid JSON')
  }
  if (!isRecord(value)) {
    throw new HttpError(400, 'invalid_json', 'request body must be a JSON object')
  }
  return value
}

/** Parse a positive integer query parameter with a default and an inclusive max. */
export function intParam(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
  code: string,
  label: string,
): number {
  if (raw === null) return fallback
  if (!/^[0-9]+$/.test(raw)) {
    throw new HttpError(400, code, `${label} must be an integer between ${min} and ${max}`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new HttpError(400, code, `${label} must be an integer between ${min} and ${max}`)
  }
  return value
}

/** Parse `notesSinceSeq`: a non-negative safe integer, default 0. */
export function seqParam(raw: string | null): number {
  if (raw === null) return 0
  if (!/^[0-9]+$/.test(raw)) {
    throw new HttpError(400, 'notes_since_invalid', 'notesSinceSeq must be a non-negative integer')
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(400, 'notes_since_invalid', 'notesSinceSeq must be a non-negative integer')
  }
  return value
}

/** Parse the optional `sinceAt` millisecond filter. */
export function sinceAtParam(raw: string | null): number | undefined {
  if (raw === null) return undefined
  if (!/^[0-9]+$/.test(raw)) {
    throw new HttpError(400, 'since_at_invalid', 'sinceAt must be a non-negative integer (Unix milliseconds)')
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(400, 'since_at_invalid', 'sinceAt must be a non-negative integer (Unix milliseconds)')
  }
  return value
}

export function assertTitle(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > TITLE_MAX) {
    throw new HttpError(400, 'title_invalid', `title must be a string of 1..${TITLE_MAX} characters`)
  }
  return value
}

export function assertPathHint(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > PATH_HINT_MAX) {
    throw new HttpError(400, 'path_hint_invalid', `pathHint must be a string of 1..${PATH_HINT_MAX} characters`)
  }
  return value
}

export function assertNoteInput(value: unknown, now: number): NormalizedNote {
  if (!isRecord(value)) {
    throw new HttpError(400, 'note_invalid', 'each note must be a JSON object')
  }

  const id = value.id
  if (typeof id !== 'string' || !NOTE_ID_RE.test(id)) {
    throw new HttpError(
      400,
      'note_id_invalid',
      'note id must start with a letter or digit and contain only letters, digits, ".", "_", ":" or "-" (max 120)',
    )
  }

  const at = value.at
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0 || at > now + MAX_CLOCK_SKEW_MS) {
    throw new HttpError(400, 'note_at_invalid', 'note at must be an integer Unix-millisecond timestamp within 7 days of now')
  }

  const title = value.title
  if (typeof title !== 'string' || title.length < 1 || title.length > TITLE_MAX) {
    throw new HttpError(400, 'note_title_invalid', `note title must be a string of 1..${TITLE_MAX} characters`)
  }

  const body = value.body
  if (typeof body !== 'string' || body.length < 1 || body.length > BODY_MAX) {
    throw new HttpError(400, 'note_body_invalid', `note body must be a string of 1..${BODY_MAX} characters`)
  }

  const rawTags = value.tags
  if (!Array.isArray(rawTags) || rawTags.length < 1 || rawTags.length > NOTE_TAG_VOCABULARY.length) {
    throw new HttpError(
      400,
      'note_tags_invalid',
      `tags must be an array of 1..${NOTE_TAG_VOCABULARY.length} strings from the closed vocabulary: ${NOTE_TAG_VOCABULARY.join(' / ')}`,
    )
  }
  const tags: string[] = []
  for (const tag of rawTags) {
    if (typeof tag !== 'string' || !NOTE_TAG_SET.has(tag)) {
      throw new HttpError(
        400,
        'note_tags_invalid',
        `tags must come from the closed vocabulary: ${NOTE_TAG_VOCABULARY.join(' / ')}`,
      )
    }
    tags.push(tag)
  }

  const authorRole = value.authorRole === undefined ? 'worker' : value.authorRole
  if (authorRole !== 'worker' && authorRole !== 'super') {
    throw new HttpError(400, 'note_author_role_invalid', 'authorRole must be "worker" or "super"')
  }

  const rawAuthorId = value.authorId
  let authorId: string | null = null
  if (rawAuthorId !== undefined && rawAuthorId !== null) {
    if (typeof rawAuthorId !== 'string' || rawAuthorId.length > AUTHOR_ID_MAX) {
      throw new HttpError(400, 'note_author_id_invalid', `authorId must be a string of at most ${AUTHOR_ID_MAX} characters`)
    }
    authorId = rawAuthorId
  }

  return { id, at, title, tags, body, authorRole, authorId }
}

export interface SummaryInput {
  content: string
  clientOpId: string
  baseVersion: number | undefined
}

export function assertSummaryInput(body: Record<string, unknown>): SummaryInput {
  const content = body.content
  if (typeof content !== 'string' || content.length < 1 || content.length > SUMMARY_MAX) {
    throw new HttpError(400, 'summary_content_invalid', `summary content must be a string of 1..${SUMMARY_MAX} characters`)
  }

  const clientOpId = body.clientOpId
  if (typeof clientOpId !== 'string' || !CLIENT_OP_ID_RE.test(clientOpId)) {
    throw new HttpError(
      400,
      'summary_op_invalid',
      'clientOpId must start with a letter or digit and contain only letters, digits, ".", "_", ":" or "-" (max 120)',
    )
  }

  const baseVersion = body.baseVersion
  if (baseVersion !== undefined) {
    if (typeof baseVersion !== 'number' || !Number.isSafeInteger(baseVersion) || baseVersion < 0) {
      throw new HttpError(400, 'summary_base_invalid', 'baseVersion must be a non-negative integer')
    }
  }

  return { content, clientOpId, baseVersion }
}

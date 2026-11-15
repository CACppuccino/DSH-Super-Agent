/**
 * Minimal D1 shim over Node's built-in `node:sqlite` for local Worker tests.
 *
 * Implements the subset used by the Worker and its tests:
 *   db.prepare(sql) -> statement.bind(...) -> statement.first()/all()/run()
 *   db.batch(statements) (atomic BEGIN/COMMIT/ROLLBACK)
 *   db.exec(sql)
 *
 * Result shapes mirror D1: `.all()` returns {results, success, meta},
 * `.first()` returns a row or null and `.run()` returns {success, meta}.
 * Prepared statements are reusable: `.bind()` returns a new bound statement
 * and never mutates the statement it was called on.
 */

import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

type BindValue = string | number | bigint | null | Uint8Array

interface ShimMeta {
  duration: number
  changes: number
  last_row_id: number
  changed_db: boolean
  rows_read: number
  rows_written: number
}

interface ShimResult<T> {
  results: T[]
  success: true
  meta: ShimMeta
}

interface RawStatementResult {
  changes: number | bigint
  lastInsertRowid: number | bigint
}

function normalizeBindValue(value: unknown): BindValue {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  throw new TypeError(`D1 shim: unsupported bind value of type ${typeof value}`)
}

function readMeta(rowCount: number): ShimMeta {
  return {
    duration: 0,
    changes: 0,
    last_row_id: 0,
    changed_db: false,
    rows_read: rowCount,
    rows_written: 0,
  }
}

function mutationMeta(result: RawStatementResult): ShimMeta {
  const changes = Number(result.changes ?? 0)
  return {
    duration: 0,
    changes,
    last_row_id: Number(result.lastInsertRowid ?? 0),
    changed_db: changes > 0,
    rows_read: 0,
    rows_written: changes,
  }
}

function returnsRows(sql: string): boolean {
  return /^(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(sql.trimStart())
}

export class TestD1Statement {
  database: TestD1Database
  sql: string
  args: unknown[]

  constructor(database: TestD1Database, sql: string, args: unknown[] = []) {
    this.database = database
    this.sql = sql
    this.args = args
  }

  /** D1 semantics: binding returns a new statement, the original is reusable. */
  bind(...values: unknown[]): TestD1Statement {
    return new TestD1Statement(this.database, this.sql, values)
  }

  _rows(): Record<string, unknown>[] {
    const statement = this.database.raw.prepare(this.sql)
    const rows = statement.all(...this.args.map(normalizeBindValue)) as Record<string, unknown>[]
    return rows.map((row) => ({ ...row }))
  }

  _run(): RawStatementResult {
    const statement = this.database.raw.prepare(this.sql)
    const result = statement.run(...this.args.map(normalizeBindValue))
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid }
  }

  async first<T = unknown>(column?: string): Promise<T | null> {
    const rows = this._rows()
    if (rows.length === 0) return null
    const row = rows[0]
    if (column !== undefined) {
      const value = row[column]
      return value === undefined ? null : (value as T)
    }
    return row as T
  }

  async all<T = unknown>(): Promise<ShimResult<T>> {
    const rows = this._rows()
    return { results: rows as T[], success: true, meta: readMeta(rows.length) }
  }

  async run(): Promise<ShimResult<unknown>> {
    const meta = mutationMeta(this._run())
    return { results: [], success: true, meta }
  }

  _batchResult(): ShimResult<unknown> {
    if (returnsRows(this.sql)) {
      const rows = this._rows()
      return { results: rows, success: true, meta: readMeta(rows.length) }
    }
    const meta = mutationMeta(this._run())
    return { results: [], success: true, meta }
  }
}

export class TestD1Database {
  raw: DatabaseSync

  constructor(raw: DatabaseSync) {
    this.raw = raw
  }

  prepare(sql: string): TestD1Statement {
    return new TestD1Statement(this, sql)
  }

  /** Execute several prepared statements atomically, like D1 `batch()`. */
  async batch(statements: TestD1Statement[]): Promise<ShimResult<unknown>[]> {
    this.raw.exec('BEGIN')
    try {
      const results: ShimResult<unknown>[] = []
      for (const statement of statements) {
        if (!(statement instanceof TestD1Statement)) {
          throw new TypeError('D1 shim: batch() expects statements created by db.prepare()')
        }
        results.push(statement._batchResult())
      }
      this.raw.exec('COMMIT')
      return results
    } catch (error) {
      try {
        this.raw.exec('ROLLBACK')
      } catch {
        // Rolling back can itself fail if SQLite already aborted the
        // transaction; the original error is the useful one.
      }
      throw error
    }
  }

  exec(sql: string): { count: number; duration: number } {
    const started = Date.now()
    this.raw.exec(sql)
    return { count: 1, duration: Date.now() - started }
  }

  close(): void {
    this.raw.close()
  }
}

export interface TestD1 {
  db: TestD1Database
  exec(sql: string): { count: number; duration: number }
  close(): void
}

const MIGRATION_PATH = fileURLToPath(new URL('../../migrations/0001_init.sql', import.meta.url))

/**
 * Create an in-memory D1-compatible database and apply the initial migration.
 * Tests may call `exec()` themselves as well; the migration is idempotent.
 */
export function createTestD1(): TestD1 {
  const raw = new DatabaseSync(':memory:')
  const db = new TestD1Database(raw)
  try {
    const migration = readFileSync(MIGRATION_PATH, 'utf8')
    db.exec(migration)
  } catch {
    // No migration file next to the tests (for example when the shim is
    // copied elsewhere): the caller is responsible for creating the schema.
  }
  return {
    db,
    exec: (sql: string) => db.exec(sql),
    close: () => db.close(),
  }
}

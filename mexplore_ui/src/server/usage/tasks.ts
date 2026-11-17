// Read-only access to `<stateDir>/memory-agent.sqlite` (SEC-004).
//
// Rules, all of them load-bearing for the live WAL database:
//   * open with `{ readonly: true }`, `PRAGMA busy_timeout = 2000`, `PRAGMA query_only = 1`;
//   * one SELECT of the five columns we may see — never request_json/result_json;
//   * open -> query -> close per refresh, so no cursor is held across async ticks
//     (a held reader pins WAL frames and starves the service's checkpoint);
//   * never `immutable=1`, never `PRAGMA journal_mode`, never a checkpoint, never
//     a schema statement, and never the service's `SqliteStore`.
//
// SEC-003: the database file is lstat'd and refused when it is a symlink or not a
// regular file, so a `memory-agent.sqlite` pointing out of stateDir is never
// opened. (A symlinked PARENT directory is legitimate — that is how a user's
// `~/state` link works — so containment is judged on the file itself.)

import fs from 'node:fs'
import path from 'node:path'

import type { Authority } from '../../shared/types.ts'
import { isValidTaskId } from '../guard.ts'

/**
 * The one `bun:sqlite` member this module uses.
 *
 * Declared structurally instead of `import type { Database } from 'bun:sqlite'`:
 * `import type` is erased by tsc, but a bundler or Bun's resolver may still
 * RESOLVE the module specifier, and the plugin path must never touch it.
 */
interface SqliteDatabase {
  exec(sql: string): void
  query(sql: string): { all(): unknown[] }
  close(): void
}

export interface TaskRow {
  taskId: string
  authority: Authority
  lifecycle: string
  createdAt: string
  finishedAt: string | null
  updatedAt: string | null
  /** finished_at - created_at in ms; null when the task is not terminal or a stamp is missing. */
  latencyMs: number | null
  terminal: boolean
}

export interface TasksRead {
  available: boolean
  rows: TaskRow[]
  /** Non-null when the database could not be opened or read. */
  error: string | null
  /** Rows skipped because their task_id was not a safe UUID. */
  rejectedTaskIds: number
}

export const TASKS_DB_FILE = 'memory-agent.sqlite'

/**
 * The ONLY projection this process may run. Tests assert this string is what
 * reaches SQLite, and that request_json/result_json never appear in it.
 */
export const TASKS_SQL =
  'SELECT task_id, effective_authority, lifecycle, created_at, finished_at, updated_at FROM tasks'

/** Statements this module is allowed to execute on the read connection. */
export const ALLOWED_PRAGMAS = ['PRAGMA busy_timeout = 2000', 'PRAGMA query_only = 1'] as const

/**
 * `bun:sqlite`, loaded on first use.
 *
 * The plugin deployment (`mexplore-ui/plugin`) never reads SQLite — its history
 * is the usage JSONL — so the import must not happen at module scope on that
 * path. A top-level `import` would bind it as soon as `store.ts` loads this
 * module, which is exactly what the contract forbids.
 */
function loadDatabase(): new (file: string, options: { readonly: boolean }) => SqliteDatabase {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('bun:sqlite') as { Database: new (file: string, options: { readonly: boolean }) => SqliteDatabase }
  return mod.Database
}

export type SqlAudit = (sql: string) => void

let sqlAudit: SqlAudit | null = null

/** Install a SQL trace hook (tests). Production leaves it null. */
export function setSqlAudit(hook: SqlAudit | null): void {
  sqlAudit = hook
}

function isAuthority(value: unknown): value is Authority {
  return value === 'read' || value === 'manage'
}

export function latencyOf(createdAt: string, finishedAt: string | null): number | null {
  if (finishedAt === null) return null
  const created = Date.parse(createdAt)
  const finished = Date.parse(finishedAt)
  if (Number.isNaN(created) || Number.isNaN(finished)) return null
  return finished - created
}

/** Read every task row. Never throws; an unopenable DB reports `available: false`. */
export function readTasks(stateDir: string): TasksRead {
  const file = path.join(stateDir, TASKS_DB_FILE)
  const unavailable = (error: string): TasksRead => ({
    available: false,
    rows: [],
    error,
    rejectedTaskIds: 0,
  })

  let info: fs.Stats
  try {
    info = fs.lstatSync(file)
  } catch {
    return unavailable(`task database not found: ${file}`)
  }
  // A symlinked database can point at any file on the machine; refuse it.
  if (info.isSymbolicLink()) return unavailable(`task database is a symlink; refused: ${file}`)
  if (!info.isFile()) return unavailable(`task database is not a file: ${file}`)

  let db: SqliteDatabase | null = null
  try {
    const DatabaseCtor = loadDatabase()
    db = new DatabaseCtor(file, { readonly: true })
    for (const pragma of ALLOWED_PRAGMAS) {
      sqlAudit?.(pragma)
      db.exec(pragma)
    }
    sqlAudit?.(TASKS_SQL)
    const raw = db.query(TASKS_SQL).all() as {
      task_id: string
      effective_authority: string
      lifecycle: string
      created_at: string
      finished_at: string | null
      updated_at: string | null
    }[]
    const rows: TaskRow[] = []
    let rejectedTaskIds = 0
    for (const row of raw) {
      // Run directories are joined from this value, so it is validated before
      // it can ever become a path component.
      if (typeof row.task_id !== 'string' || !isValidTaskId(row.task_id)) {
        rejectedTaskIds += 1
        continue
      }
      if (!isAuthority(row.effective_authority)) continue
      const lifecycle = row.lifecycle ?? ''
      rows.push({
        taskId: row.task_id,
        authority: row.effective_authority,
        lifecycle,
        createdAt: row.created_at,
        finishedAt: row.finished_at,
        updatedAt: row.updated_at ?? null,
        latencyMs: latencyOf(row.created_at, row.finished_at),
        terminal: lifecycle === 'terminal',
      })
    }
    return { available: true, rows, error: null, rejectedTaskIds }
  } catch (error) {
    return unavailable((error as Error).message)
  } finally {
    try {
      db?.close()
    } catch {
      // closing a read-only connection cannot fail in a way we can act on
    }
  }
}

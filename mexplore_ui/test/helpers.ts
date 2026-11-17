// Fixture builders for the mexplore_ui test suite.
//
// Every fixture lives in its own `fs.mkdtempSync` directory and is built with
// the REAL graph helpers (`memory_fs/bin/node-new`, `edge-add`), so the on-disk
// formats under test are the formats production actually writes. Nothing here
// ever touches the production graph or state directory.

import { Database } from 'bun:sqlite'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const REPO_ROOT = path.resolve(import.meta.dir, '..', '..')
export const MEMORY_FS_BIN = path.join(REPO_ROOT, 'memory_fs', 'bin')
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

/**
 * A deterministic UUID for a readable label. The service writes UUID task ids
 * and the server validates them before joining paths, so fixtures must use
 * realistic ids rather than `read-1`.
 */
export function taskUuid(label: string): string {
  const digest = crypto.createHash('sha256').update(label).digest('hex')
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-')
}

const temps: string[] = []

/** A fresh temp dir, cleaned up by `cleanupTemps()`. */
export function tempDir(prefix = 'mexplore-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temps.push(dir)
  return dir
}

export function cleanupTemps(): void {
  for (const dir of temps.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
}

function runHelper(command: string[], env: Record<string, string>): string {
  const result = Bun.spawnSync(command, {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if ((result.exitCode ?? 1) !== 0) {
    throw new Error(`helper failed: ${command.join(' ')}\n${result.stderr.toString()}`)
  }
  return result.stdout.toString().trim()
}

export interface NodeOptions {
  type?: string
  body?: string
  created?: string
  updated?: string
  /** Extra raw frontmatter lines inserted before the closing delimiter. */
  extraFrontmatter?: string[]
  /** Replace node.md entirely (for malformed-frontmatter cases). */
  raw?: string
}

/** Create a Node with the real `node-new`, then optionally rewrite its node.md. */
export function newNode(graphRoot: string, description: string, options: NodeOptions = {}): string {
  const args = [path.join(MEMORY_FS_BIN, 'node-new'), description]
  if (options.type !== undefined) args.push(options.type)
  const id = runHelper(args, { GRAPH_ROOT: graphRoot })
  if (!ULID_RE.test(id)) throw new Error(`node-new returned a non-ULID: ${id}`)

  if (options.raw !== undefined) {
    fs.writeFileSync(path.join(graphRoot, id, 'node.md'), options.raw, 'utf8')
    return id
  }
  const needsRewrite =
    options.body !== undefined ||
    options.created !== undefined ||
    options.updated !== undefined ||
    (options.extraFrontmatter?.length ?? 0) > 0
  if (needsRewrite) {
    const lines = ['---', `description: ${description}`]
    lines.push(`created: ${options.created ?? '2026-10-01'}`)
    if (options.updated !== undefined) lines.push(`updated: ${options.updated}`)
    if (options.type !== undefined) lines.push(`type: ${options.type}`)
    for (const extra of options.extraFrontmatter ?? []) lines.push(extra)
    lines.push('---', '')
    if (options.body !== undefined) lines.push(options.body)
    fs.writeFileSync(path.join(graphRoot, id, 'node.md'), `${lines.join('\n')}\n`, 'utf8')
  }
  return id
}

export function edgeAdd(graphRoot: string, src: string, dst: string, type?: string): void {
  const args = [path.join(MEMORY_FS_BIN, 'edge-add'), src, dst]
  if (type !== undefined) args.push(type)
  runHelper(args, { GRAPH_ROOT: graphRoot })
}

export function appendAccess(graphRoot: string, owner: string, dst: string, at: string, legacy = false): void {
  if (legacy) {
    fs.appendFileSync(path.join(graphRoot, owner, 'accessed.log'), `${dst} ${at}\n`, 'utf8')
    return
  }
  const dir = path.join(graphRoot, '.access')
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(path.join(dir, `${owner}.log`), `${dst} ${at}\n`, 'utf8')
}

export function writeAttachment(graphRoot: string, id: string, name: string, content: string | Buffer): void {
  const file = path.join(graphRoot, id, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

export function writeMap(graphRoot: string, lines: string[]): void {
  fs.writeFileSync(path.join(graphRoot, 'MAP.md'), `${lines.join('\n')}\n`, 'utf8')
}

// ---- state dir -----------------------------------------------------------

export interface TaskSeed {
  taskId: string
  authority?: 'read' | 'manage'
  lifecycle?: string
  createdAt: string
  finishedAt?: string | null
  updatedAt?: string
  /** Written into request_json — a canary lives here for AC-011. */
  requestJson?: string
  /** Create `<runs>/<taskId>/run-<taskId>-<uuid>/` even without observation. */
  runDir?: boolean
  /** observation.jsonl content. */
  observation?: string
  /** Extra run directories (for the >1-run warning). */
  extraRunDirs?: number
}

const TASKS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    context_id TEXT NOT NULL,
    graph_registration_id TEXT NOT NULL,
    request_json TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    config_fingerprint TEXT NOT NULL,
    effective_authority TEXT NOT NULL,
    lifecycle TEXT NOT NULL,
    cancellation TEXT NOT NULL,
    canceled INTEGER NOT NULL DEFAULT 0,
    outcome TEXT,
    quarantine_reason TEXT,
    quarantine_cause TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    result_json TEXT
  );
  CREATE INDEX IF NOT EXISTS tasks_lifecycle_idx ON tasks(lifecycle, created_at);
`

/** A WAL-mode tasks database matching memory_service's schema (sqlite-store.ts:260-281). */
export function writeTasksDb(stateDir: string, tasks: readonly TaskSeed[]): string {
  fs.mkdirSync(stateDir, { recursive: true })
  const file = path.join(stateDir, 'memory-agent.sqlite')
  const db = new Database(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(TASKS_SCHEMA)
  const insert = db.query(
    `INSERT OR REPLACE INTO tasks (
       task_id, context_id, graph_registration_id, request_json, payload_hash,
       config_fingerprint, effective_authority, lifecycle, cancellation, canceled,
       created_at, updated_at, started_at, finished_at, result_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'none', 0, ?, ?, ?, ?, ?)`,
  )
  for (const task of tasks) {
    const finished = task.finishedAt === undefined ? task.createdAt : task.finishedAt
    insert.run(
      task.taskId,
      'ctx-fixture',
      'graph-fixture',
      task.requestJson ?? '{"message":"fixture request"}',
      'payload-hash',
      'config-fingerprint',
      task.authority ?? 'read',
      task.lifecycle ?? 'terminal',
      task.createdAt,
      task.updatedAt ?? finished ?? task.createdAt,
      task.createdAt,
      finished,
      '{"reply":"fixture result"}',
    )
  }
  db.close()
  return file
}

export interface RunSeed {
  taskId: string
  observation?: string
  /** Suffix for the run directory name (defaults to a stable uuid-ish value). */
  uuid?: string
}

export function writeRunDir(stateDir: string, seed: RunSeed, index = 0): string {
  const uuid = seed.uuid ?? `0000${index}`
  const dir = path.join(stateDir, 'runs', seed.taskId, `run-${seed.taskId}-${uuid}`)
  fs.mkdirSync(dir, { recursive: true })
  if (seed.observation !== undefined) fs.writeFileSync(path.join(dir, 'observation.jsonl'), seed.observation, 'utf8')
  return dir
}

// ---- observation JSONL ---------------------------------------------------

export interface ObsEvent {
  seq?: number
  type: string
  requestId?: string
  usage?: Record<string, number>
  [key: string]: unknown
}

export function jsonl(events: readonly ObsEvent[]): string {
  return events.map((event) => `${JSON.stringify({ v: 1, tMs: 100, ...event })}\n`).join('')
}

/** A clean capture: one request, one usage-bearing request_end. */
export function completeObservation(input = 1000, output = 100, total = 1100, cacheRead = 50): string {
  return jsonl([
    { seq: 1, type: 'request_start', requestId: 'r1' },
    {
      seq: 2,
      type: 'request_end',
      requestId: 'r1',
      outcome: 'finish',
      usage: { inputTokens: input, outputTokens: output, totalTokens: total, cacheReadTokens: cacheRead },
    },
  ])
}

/** A full config JSON for a fixture graph + state dir. */
export function writeConfig(file: string, graphRoot: string, stateDir: string, port = 43120): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const raw = {
    host: '127.0.0.1',
    port,
    stateDir,
    graph: { id: 'fixture', handle: 'fixture', root: graphRoot },
    maxAuthority: 'manage',
    defaults: { requestedAuthority: 'read' },
    runtime: {
      adapter: 'dsh',
      executable: '/bin/true',
      profile: 'memory-agent',
      plugin: '/bin/true',
    },
    limits: { taskTimeoutMs: 300000, maxQueuedTasks: 8 },
  }
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
  return file
}

/** Recursive (path, mtimeMs, size, hash) snapshot of a tree, for read-only proofs. */
export function treeSignature(root: string): string {
  const parts: string[] = []
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name)
      const rel = `${prefix}${entry.name}`
      let info: fs.Stats
      try {
        info = fs.lstatSync(full)
      } catch {
        parts.push(`${rel}:gone`)
        continue
      }
      if (info.isSymbolicLink()) {
        parts.push(`${rel}:link:${fs.readlinkSync(full)}`)
        continue
      }
      if (info.isDirectory()) {
        parts.push(`${rel}:dir:${info.mtimeMs}`)
        walk(full, `${rel}/`)
        continue
      }
      const digest = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16)
      parts.push(`${rel}:file:${info.mtimeMs}:${info.size}:${digest}`)
    }
  }
  walk(root, '')
  return parts.join('\n')
}

/**
 * Content+metadata snapshot of a state dir for read-only proofs. SQLite readers
 * legitimately map `-wal`/`-shm`, so those two are excluded (§10's manual-check
 * rule); everything else — including every task row's bytes — must be unchanged.
 */
export function stateSnapshot(stateDir: string): string {
  return treeSignature(stateDir)
    .split('\n')
    .filter((line) => !line.includes('memory-agent.sqlite-wal') && !line.includes('memory-agent.sqlite-shm'))
    .join('\n')
}

/** Wait until `predicate` is true or the budget runs out. */
export async function waitFor(predicate: () => boolean, timeoutMs = 3000, stepMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  return predicate()
}

/**
 * Bind a `Bun.serve` for an app that had to be constructed before its port was
 * known.
 *
 * `createApp` FAILS CLOSED until it is told the port it actually listens on
 * (an unknown port must never mean "any Host is fine"), so every harness must
 * follow `Bun.serve({ port: 0 })` with `setListeningPort(server.port)`. This
 * helper makes that the single obvious path.
 */
export function serveOnEphemeralPort(
  app: { handle(request: Request): Promise<Response>; setListeningPort(port: number): void },
  options: { idleTimeout?: number } = {},
): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: options.idleTimeout ?? 60,
    fetch: (request) => app.handle(request),
  })
  app.setListeningPort(server.port as number)
  return server
}

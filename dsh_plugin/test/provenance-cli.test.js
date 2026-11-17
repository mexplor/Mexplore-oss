/**
 * `bin/provenance` — the read side of the write-provenance sidecar (#317).
 *
 * The contract this suite pins:
 *
 *   - lines print oldest-first as a table: ts, op, host, actor, session (or
 *     `— <reason>`), peer/file/type when present, and the call id;
 *   - `--json` prints the raw lines, `-n N` the last N;
 *   - a missing file is a normal answer (`no provenance recorded`, exit 0) —
 *     an untouched node and a `bin/`-written node both look like that;
 *   - a torn or unparseable line is skipped with a warning, never fatal;
 *   - the id is validated as a ULID, and a symlinked `.provenance` folder or
 *     file is refused instead of followed;
 *   - the sidecar stays at graph level, so an ARCHIVED node id still reads;
 *   - it writes nothing and never touches `.access/`.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { after, before, test } from 'node:test'
import { ULID_RE } from '../lib/graph.js'

const run = promisify(execFile)
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'bin')
const CLI = path.join(BIN, 'provenance')

let root
before(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-provenance-cli-')) })
after(async () => { await fsp.rm(root, { recursive: true, force: true }) })

/** Run the helper against `graphRoot`; resolve stdout/stderr/code rather than throw. */
async function cli(args, graphRoot = root, options = {}) {
  try {
    const { stdout, stderr } = await run(CLI, args, { env: { ...process.env, GRAPH_ROOT: graphRoot }, ...options })
    return { stdout, stderr, code: 0 }
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code ?? 1 }
  }
}

/** A fresh graph root with one sidecar planted; returns [graphRoot, id]. */
async function planted(lines, id = '01J00000000000000000000014') {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-provcli-'))
  await fsp.mkdir(path.join(fresh, '.provenance'), { recursive: true })
  await fsp.writeFile(path.join(fresh, '.provenance', `${id}.jsonl`), lines.map((line) => `${line}\n`).join(''))
  return [fresh, id]
}

const line = (overrides = {}) => JSON.stringify({
  v: 1,
  ts: '2026-11-10T09:00:00.000Z',
  op: 'create',
  actor: 'chat',
  host: 'dsh',
  session: 'session-root1',
  ...overrides,
})

test('the table prints oldest-first with every column, and `— <reason>` for an unproven session', async () => {
  const [fresh, id] = await planted([
    line({ ts: '2026-11-10T09:00:02.000Z', op: 'update', call: 'call-b' }),
    line({ ts: '2026-11-10T09:00:00.000Z', op: 'create', call: 'call-a' }),
    line({ ts: '2026-11-10T09:00:04.000Z', op: 'attach', session: null, reason: 'walk-failed', file: 'notes.md' }),
    line({
      ts: '2026-11-10T09:00:04.000Z',
      op: 'edge',
      host: 'opencode',
      peer: '01J00000000000000000000015',
      type: 'supersedes',
    }),
  ])
  const { stdout, stderr, code } = await cli([id], fresh)
  assert.equal(code, 0)
  assert.equal(stderr, '')
  const rows = stdout.trim().split('\n')
  assert.match(rows[0], /^ts\s+op\s+host\s+actor\s+session/)
  // Oldest first: create, update, then the two ts-04 rows in file order.
  assert.match(rows[1], /2026-11-10T09:00:00\.000Z\s+create\s+dsh\s+chat\s+session-root1/)
  assert.match(rows[1], /call-a$/)
  assert.match(rows[2], /\bupdate\b/)
  assert.match(rows[2], /call-b$/)
  assert.match(rows[3], /attach\s+dsh\s+chat\s+— walk-failed/)
  assert.match(rows[3], /file=notes\.md/)
  assert.match(rows[4], /edge\s+opencode.*peer=01J00000000000000000000015 type=supersedes/)
  assert.equal(rows.length, 5)
})

test('--json prints the raw lines verbatim, and -n keeps the last N', async () => {
  const [fresh, id] = await planted([
    line({ ts: '2026-11-10T09:00:00.000Z', op: 'create' }),
    line({ ts: '2026-11-10T09:00:01.000Z', op: 'update' }),
    line({ ts: '2026-11-10T09:00:02.000Z', op: 'edge', peer: '01J00000000000000000000015' }),
  ])
  const all = await cli([id, '--json'], fresh)
  assert.equal(all.code, 0)
  const parsed = all.stdout.trim().split('\n').map((entry) => JSON.parse(entry))
  assert.deepEqual(parsed.map((record) => record.op), ['create', 'update', 'edge'])
  // Byte-for-byte: the helper never re-serializes.
  for (const entry of all.stdout.trim().split('\n')) assert.match(entry, /^\{"v":1,"ts":/)

  const last = await cli([id, '--json', '-n', '2'], fresh)
  assert.equal(last.code, 0)
  assert.deepEqual(
    last.stdout.trim().split('\n').map((entry) => JSON.parse(entry).op),
    ['update', 'edge'],
  )

  const table = await cli([id, '-n', '1'], fresh)
  const rows = table.stdout.trim().split('\n')
  assert.equal(rows.length, 2, 'the header plus one row')
  assert.match(rows[1], /\bedge\b.*peer=/)
})

test('a missing file is "no provenance recorded" and exit 0 — as is a graph root that does not exist', async () => {
  const [fresh] = await planted([line()])
  const absent = await cli(['01J00000000000000000000016'], fresh)
  assert.equal(absent.code, 0)
  assert.equal(absent.stdout.trim(), 'no provenance recorded')

  const emptyDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-provcli-empty-'))
  const noDir = await cli(['01J00000000000000000000014'], emptyDir)
  assert.equal(noDir.code, 0)
  assert.equal(noDir.stdout.trim(), 'no provenance recorded')

  const noRoot = await cli(['01J00000000000000000000014'], path.join(fresh, 'does', 'not', 'exist'))
  assert.equal(noRoot.code, 0)
  assert.equal(noRoot.stdout.trim(), 'no provenance recorded')

  await fsp.rm(emptyDir, { recursive: true, force: true })
})

test('a torn line is skipped with a stderr warning; the healthy lines still print', async () => {
  const [fresh, id] = await planted([
    line({ op: 'create' }),
    '{"v":1,"ts":"2026-11-10T09:00:01.000Z","op":"upd', // a crash mid-append
    line({ ts: '2026-11-10T09:00:02.000Z', op: 'attach', file: 'a.md' }),
  ])
  const { stdout, stderr, code } = await cli([id], fresh)
  assert.equal(code, 0)
  assert.match(stderr, /warning: skipping unparseable line 2/)
  const rows = stdout.trim().split('\n')
  assert.equal(rows.length, 3, 'header + the two parseable lines')
  assert.match(rows[1], /\bcreate\b/)
  assert.match(rows[2], /\battach\b.*file=a\.md/)

  // The same tolerance in --json: the raw healthy lines only.
  const json = await cli([id, '--json'], fresh)
  assert.equal(json.code, 0)
  assert.equal(json.stdout.trim().split('\n').length, 2)
})

test('an invalid id is refused before any path is built', async () => {
  for (const bad of ['../etc/passwd', 'not-a-ulid', '01j00000000000000000000014', '01J00000000000000000000014X']) {
    const result = await cli([bad])
    assert.equal(result.code, 1, `${bad} must be refused`)
    assert.match(result.stderr, /invalid Node ID/)
  }
  const missing = await cli([])
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /usage: provenance <node-id> \[--json\] \[-n N\]/)
  assert.ok(ULID_RE.test('01J00000000000000000000014'), 'the test id is a well-formed ULID')
})

test('a symlinked .provenance folder or file is refused, never followed', async () => {
  // The FOLDER.
  const [dirRoot, dirId] = await planted([line()])
  const elsewhere = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-provcli-elsewhere-'))
  await fsp.rename(path.join(dirRoot, '.provenance'), path.join(elsewhere, 'real'))
  await fsp.symlink(path.join(elsewhere, 'real'), path.join(dirRoot, '.provenance'))
  const viaFolder = await cli([dirId], dirRoot)
  assert.equal(viaFolder.code, 1)
  assert.match(viaFolder.stderr, /refusing to follow a symlinked provenance folder/)
  // The planted lines are still there: nothing was followed, nothing consumed.
  assert.equal((await fsp.readFile(path.join(elsewhere, 'real', `${dirId}.jsonl`), 'utf8')).trim().length > 0, true)

  // The FILE.
  const [fileRoot, fileId] = await planted([line()])
  const sidecar = path.join(fileRoot, '.provenance', `${fileId}.jsonl`)
  await fsp.rename(sidecar, path.join(fileRoot, '.provenance', 'real.jsonl'))
  await fsp.symlink('real.jsonl', sidecar)
  const viaFile = await cli([fileId], fileRoot)
  assert.equal(viaFile.code, 1)
  assert.match(viaFile.stderr, /refusing to read a non-regular provenance file/)

  await fsp.rm(dirRoot, { recursive: true, force: true })
  await fsp.rm(elsewhere, { recursive: true, force: true })
  await fsp.rm(fileRoot, { recursive: true, force: true })
})

test('an archived node id still reads: the sidecar stays at graph level', async () => {
  const [fresh, id] = await planted([line({ op: 'restore' })])
  // Archiving moves the node DIRECTORY only; the sidecar does not move with it.
  await fsp.mkdir(path.join(fresh, '.archive'), { recursive: true })
  await fsp.mkdir(path.join(fresh, id), { recursive: true })
  await fsp.writeFile(path.join(fresh, id, 'node.md'), '---\ndescription: archived\n---\n\nbody\n')
  await fsp.rename(path.join(fresh, id), path.join(fresh, '.archive', id))
  const { stdout, code } = await cli([id], fresh)
  assert.equal(code, 0)
  assert.match(stdout, /\brestore\b/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('it is read-only: neither the graph nor .access/ changes', async () => {
  const [fresh, id] = await planted([
    line({ op: 'create' }),
    line({ ts: '2026-11-10T09:00:01.000Z', op: 'edge', peer: '01J00000000000000000000015' }),
  ])
  const before = await snapshot(fresh)
  assert.equal((await cli([id], fresh)).code, 0)
  assert.equal((await cli([id, '--json', '-n', '1'], fresh)).code, 0)
  assert.equal((await cli(['01J00000000000000000000016'], fresh)).code, 0)
  assert.deepEqual(await snapshot(fresh), before)
  // Nothing named .access was created at all.
  await assert.rejects(fsp.access(path.join(fresh, '.access')))
  await fsp.rm(fresh, { recursive: true, force: true })
})

/** Every path under `dir` with its size and mtime — a read must leave it identical. */
test('control characters in a field are escaped, so a row cannot be forged and a terminal sequence cannot run', async () => {
  // An attachment filename may hold a newline and an escape sequence — these
  // are exactly what the engine copies from a tool argument. Printing them raw
  // would let one line become two rows, and run `\x1b[31m`.
  const [fresh, id] = await planted([
    line({ ts: '2026-11-10T09:00:00.000Z', op: 'create' }),
    line({
      ts: '2026-11-10T09:00:01.000Z',
      op: 'attach',
      file: 'a\nfake-row\tX\x1b[31mred\x1b[0m\r.md',
      call: 'call\u0007bell',
    }),
    line({ ts: '2026-11-10T09:00:02.000Z', op: 'edge', session: null, reason: 'walk\nfailed', peer: '01J00000000000000000000015' }),
  ])
  const { stdout, code } = await cli([id], fresh)
  assert.equal(code, 0)

  // Not one byte of the output is a real control character: the header, the
  // three rows and the final newline are all that reach the terminal.
  assert.equal(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(stdout), false, 'no raw control character survives')
  assert.equal(stdout.split('\n').length, 5, 'header + 3 rows + the trailing newline — nothing forged a row')

  const rows = stdout.split('\n')
  // Escaped BEFORE truncation and width calc, so the row is still one row and
  // still aligned with the others.
  assert.match(rows[2], /file=a\\nfake-row\\tX\\x1b\[31mred\\x1b\[0m\\r\.md/)
  assert.match(rows[2], /call\\x07bell$/)
  assert.match(rows[3], /— walk\\nfailed/)
  // Widths were computed over the ESCAPED text, so the detail column starts at
  // the same index on both rows that have one (a raw `\n` would have counted
  // as nothing, and the escape as one character).
  assert.equal(rows[2].indexOf('file='), rows[3].indexOf('peer='))

  // --json stays raw: a JSON consumer gets the bytes the engine wrote.
  const json = await cli([id, '--json'], fresh)
  assert.equal(json.code, 0)
  const second = JSON.parse(json.stdout.split('\n')[1])
  assert.equal(second.file, 'a\nfake-row\tX\x1b[31mred\x1b[0m\r.md')
  assert.equal(second.call, 'call\u0007bell')
})

test('a field of the wrong type renders as ? and never crashes the table', async () => {
  // The engine writes strings, but the file is on disk: a malformed record must
  // cost one cell, not the whole view — `String()` on some values throws.
  const [fresh, id] = await planted([
    line({ ts: '2026-11-10T09:00:00.000Z', op: 'create' }),
    line({
      ts: '2026-11-10T09:00:01.000Z',
      op: 'edge',
      peer: { evil: true },
      file: ['nope'],
      type: true,
      call: 42,
    }),
  ])
  const { stdout, code } = await cli([id], fresh)
  assert.equal(code, 0)
  const rows = stdout.trim().split('\n')
  assert.equal(rows.length, 3, 'the healthy line is not lost to the malformed one')
  assert.match(rows[2], /peer=\? file=\? type=\?/)
  assert.match(rows[2], /\s42$/, 'a number is printable, so it keeps its value')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a very large history prints: widths are computed without spreading the rows', async () => {
  // A retained history is append-only and unpruned. `Math.max(...lengths)`
  // throws RangeError past the engine's argument limit, so this must be a loop.
  // 200k lines is ~29 MB and prints in well under a second.
  const count = 200_000
  const records = []
  for (let index = 0; index < count; index++) {
    records.push(
      line({
        ts: `2026-11-10T09:${String(Math.floor(index / 60000)).padStart(2, '0')}:${String(Math.floor(index / 1000) % 60).padStart(2, '0')}.${String(index % 1000).padStart(3, '0')}Z`,
        op: 'update',
        session: 'session-root-plus-a-fairly-long-id',
        call: `call_${index}`,
      }),
    )
  }
  const [fresh, id] = await planted(records)
  // The whole history in one table is the call that died on the argument
  // limit; a ~30 MB stdout needs `maxBuffer` raised past execFile's 1 MB.
  const all = await cli([id], fresh, { maxBuffer: 64 * 1024 * 1024 })
  assert.equal(all.code, 0, `the table printed instead of throwing: ${all.stderr}`)
  const rows = all.stdout.split('\n')
  assert.equal(rows.length, count + 2, 'header + every line + the trailing newline')
  assert.match(rows[1], /2026-11-10T09:00:00\.000Z\s+update\s+dsh\s+chat\s+session-root-plus-a-fairly-long-id\s+call_0$/)
  assert.match(rows[count], /call_199999$/)
  // Column widths still line every row up — computed over 200k rows without
  // passing them as arguments.
  assert.equal(rows[0].indexOf('call'), rows[count].indexOf('call_199999'))
  assert.equal(rows[1].indexOf('call_0'), rows[count].indexOf('call_199999'))

  await fsp.rm(fresh, { recursive: true, force: true })
})

async function snapshot(dir) {
  const out = []
  const walk = async (current) => {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      const stat = await fsp.lstat(full)
      out.push(`${path.relative(dir, full)} ${stat.size} ${stat.mtimeMs}`)
      if (entry.isDirectory()) await walk(full)
    }
  }
  await walk(dir)
  return out.sort()
}

test('the vendored helper is executable (byte-identity is interop.test.js)', async () => {
  const stat = await fsp.stat(CLI)
  assert.ok((stat.mode & 0o111) !== 0, 'fixtures/bin/provenance must be executable')
})

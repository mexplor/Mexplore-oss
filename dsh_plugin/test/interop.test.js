/**
 * The JS graph layer and the graph's own `bin/` shell helpers must stay
 * interchangeable: whatever one writes, the other must read and extend.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { after, before, test } from 'node:test'
import { ULID_RE, addEdge, createNode, edgeSidecarOwners, loadNode, openHandoffs, outEdges, readNode, touchEdge, updateNode, withNodeLocks } from '../lib/graph.js'

const run = promisify(execFile)
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'bin')

let root
before(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-interop-'))
})
after(async () => { await fsp.rm(root, { recursive: true, force: true }) })

test('the vendored fixtures/bin helpers are byte-identical to memory_fs/bin', async (t) => {
  // This suite proves the two writers interoperate — which proves nothing if
  // the vendored copy drifts from the real CLI. It had: the pre-F54 fixture
  // edge-add was the pre-typed-edges version, so interop ran against a stale
  // binary. Fail loudly instead (opus review of F54, #90). Skipped only where
  // the real CLI is not present at all — the live server plugin dir is synced
  // standalone; the repo and the deploy stage both carry memory_fs/.
  const real = path.join(BIN, '..', '..', '..', 'memory_fs', 'bin')
  try {
    await fsp.access(real)
  } catch {
    t.skip('memory_fs/bin not present (standalone plugin checkout)')
    return
  }
  for (const script of ['edge-add', 'graph-maintain', 'lib/lock.sh', 'node-new', 'provenance', 'touch-edge']) {
    assert.equal(
      await fsp.readFile(path.join(BIN, script), 'utf8'),
      await fsp.readFile(path.join(real, script), 'utf8'),
      `fixtures/bin/${script} has drifted from memory_fs/bin/${script} — re-sync the vendored copy`,
    )
  }
})

/** Invoke one shell helper against the shared graph root. */
async function sh(script, ...args) {
  const { stdout } = await run(path.join(BIN, script), args, { env: { ...process.env, GRAPH_ROOT: root } })
  return stdout.trim()
}

test('a node the shell helper created reads back through the JS layer', async () => {
  const id = await sh('node-new', 'created by the shell helper')
  assert.match(id, ULID_RE)
  const node = await loadNode(root, id)
  assert.equal(node.description, 'created by the shell helper')
  assert.match(node.created, /^\d{4}-\d{2}-\d{2}$/)
})

test('a node the JS layer created is a valid edge target for the shell helper', async () => {
  const fromShell = await sh('node-new', 'shell side')
  const fromJs = await createNode(root, { description: 'js side', body: 'body' })
  await sh('edge-add', fromShell, fromJs)
  assert.deepEqual(await outEdges(root, fromShell), [fromJs])
  // The CLI writes the same one-logical-edge-two-symlinks contract the JS
  // layer does (F54, #90): the JS read side sees the pair from either end.
  assert.deepEqual(await outEdges(root, fromJs), [fromShell])
  const view = await readNode(root, fromShell)
  assert.deepEqual(view.edges, [{ id: fromJs, description: 'js side' }])
  // The shell helper refuses to touch an edge it considers malformed, so a
  // successful touch-edge is proof the JS-written node resolves correctly.
  await sh('touch-edge', fromShell, fromJs)
  const log = await fsp.readFile(path.join(root, '.access', `${fromShell}.log`), 'utf8')
  assert.match(log, new RegExp(`^${fromJs} \\d{4}-\\d{2}-\\d{2}T`, 'm'))
})

test('an edge the JS layer wrote satisfies the shell helper too', async () => {
  const a = await createNode(root, { description: 'js source' })
  const b = await sh('node-new', 'shell target')
  await addEdge(root, a, b)
  await touchEdge(root, a, b)
  // edge-add is idempotent over the JS-written PAIR — from either direction —
  // a silent no-op rather than the "wrong target" error, and never a second
  // logical edge (the reverse-dup class, F54, #90).
  await sh('edge-add', a, b)
  await sh('edge-add', b, a)
  assert.deepEqual(await outEdges(root, a), [b])
  assert.deepEqual(await outEdges(root, b), [a])
  await sh('touch-edge', a, b)
  const log = await fsp.readFile(path.join(root, '.access', `${a}.log`), 'utf8')
  assert.equal(log.trimEnd().split('\n').length, 2)
  // The pair is one edge: the CLI can touch it from the other side too.
  await sh('touch-edge', b, a)
  assert.match(await fsp.readFile(path.join(root, '.access', `${b}.log`), 'utf8'), new RegExp(`^${a} `, 'm'))
})

test('a typed edge round-trips between writers: relates-to symmetric on the canonical side, supersedes one-way (F54, #90)', async () => {
  const a = await createNode(root, { description: 'typed js side' })
  const b = await sh('node-new', 'typed shell side')
  await sh('edge-add', a, b, 'relates-to')
  // Both symlinks exist; the sidecar line sits on the lexicographically
  // smaller id only — the JS reader resolves the type from either view.
  const [lo, hi] = a < b ? [a, b] : [b, a]
  assert.equal(await fsp.readFile(path.join(root, lo, '__edges__', '.edge-types'), 'utf8'), `${hi} relates-to\n`)
  await assert.rejects(fsp.access(path.join(root, hi, '__edges__', '.edge-types')), 'no line on the larger side')
  assert.deepEqual((await readNode(root, a)).edges.find((e) => e.id === b), { id: b, description: 'typed shell side', type: 'relates-to' })
  assert.deepEqual((await readNode(root, b)).edges.find((e) => e.id === a), { id: a, description: 'typed js side', type: 'relates-to' })
  // A JS-written relates-to reads identically through the CLI's contract: a
  // shell re-add of either direction is a no-op, not a wrong-target error.
  await sh('edge-add', b, a, 'relates-to')
  assert.equal(await fsp.readFile(path.join(root, lo, '__edges__', '.edge-types'), 'utf8'), `${hi} relates-to\n`)
  // Directed types stay one-way from both writers.
  const oldNode = await sh('node-new', 'old, superseded')
  const newNode = await sh('node-new', 'the successor')
  await sh('edge-add', newNode, oldNode, 'supersedes')
  assert.deepEqual(await outEdges(root, oldNode), [], 'the CLI never symmetrizes supersedes')
  assert.equal((await readNode(root, newNode)).edges[0].type, 'supersedes')
})

test('shell and JS Writers serialize same-Node updates through one lock protocol (F68, #126)', async () => {
  const id = await createNode(root, { description: 'shared lock target', body: 'before' })
  const peer = await createNode(root, { description: 'typed edge peer' })
  let signalHeld
  const held = new Promise((resolve) => { signalHeld = resolve })
  const pluginWrite = withNodeLocks(root, [id], async () => {
    signalHeld()
    await new Promise((resolve) => setTimeout(resolve, 75))
    return updateNode(root, id, { body: 'complete plugin body' })
  })
  await held
  const shellWrite = sh('edge-add', id, peer, 'supersedes')
  await Promise.all([pluginWrite, shellWrite])

  const node = await loadNode(root, id)
  assert.equal(node.body, 'complete plugin body')
  assert.equal(node.description, 'shared lock target')
  assert.equal(
    await fsp.readFile(path.join(root, id, '__edges__', '.edge-types'), 'utf8'),
    `${peer} supersedes\n`,
  )
  await assert.rejects(fsp.access(path.join(root, '.locks', `${id}.lock`)), 'both Writers released the shared lock')
})

test('shell and JS typed-edge writers serialize sidecar RMW through one lock protocol (F68, #130)', async () => {
  const source = await createNode(root, { description: 'shared sidecar source' })
  const shellPeer = await createNode(root, { description: 'shell sidecar peer' })
  const pluginPeer = await createNode(root, { description: 'plugin sidecar peer' })
  let signalHeld
  let release
  const held = new Promise((resolve) => { signalHeld = resolve })
  const released = new Promise((resolve) => { release = resolve })
  const pluginWrite = withNodeLocks(root, edgeSidecarOwners(source, pluginPeer, 'follows-from'), async () => {
    signalHeld()
    await released
    return addEdge(root, source, pluginPeer, { type: 'follows-from' })
  })
  await held
  const shellWrite = sh('edge-add', source, shellPeer, 'supersedes')
  const early = await Promise.race([
    shellWrite.then(() => 'finished'),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 75)),
  ])
  assert.equal(early, 'blocked', 'the shell writer waits for the plugin-owned sidecar lock')
  release()
  await Promise.all([pluginWrite, shellWrite])

  assert.equal(
    await fsp.readFile(path.join(root, source, '__edges__', '.edge-types'), 'utf8'),
    `${[shellPeer, pluginPeer].sort().map((id) => `${id} ${id === shellPeer ? 'supersedes' : 'follows-from'}`).join('\n')}\n`,
  )
  assert.deepEqual(await fsp.readdir(path.join(root, '.locks')), [], 'both sidecar writers released every lock')
})

test('graph-maintain --apply symmetrizes a legacy graph the JS layer then reads whole (F54, #90)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-symmetrize-'))
  const a = await createNode(fresh, { description: 'legacy a' })
  const b = await createNode(fresh, { description: 'legacy b' })
  const c = await createNode(fresh, { description: 'legacy c' })
  // A v2-style graph: a single-direction plain edge and a reverse-dup pair,
  // planted exactly as the old writers stored them.
  await fsp.symlink(`../../${b}`, path.join(fresh, a, '__edges__', b))
  await fsp.symlink(`../../${c}`, path.join(fresh, b, '__edges__', c))
  await fsp.symlink(`../../${b}`, path.join(fresh, c, '__edges__', b))
  const env = { ...process.env, GRAPH_ROOT: fresh }
  // Mid-migration, the read side already tolerates both forms: the half-edge
  // is visible from its source, the reverse-dup pair reads as ONE edge.
  assert.deepEqual((await readNode(fresh, a)).edges, [{ id: b, description: 'legacy b' }])
  assert.equal((await readNode(fresh, b)).edges.length, 1, 'the pair is one logical edge, not two')
  const { stdout: report } = await run(path.join(BIN, 'graph-maintain'), [], { env })
  assert.match(report, new RegExp(`half edge: ${a} -> ${b} \\(--apply completes the pair\\)`))
  assert.doesNotMatch(report, new RegExp(`half edge: (${b} -> ${c}|${c} -> ${b})`), 'a reverse-dup pair is already whole')
  assert.match(report, /integrity_issues=0/, 'a pre-F54 graph is healthy, just not yet migrated')
  assert.match(report, /edges=2\b/, 'the summary counts logical edges — a pair once')
  assert.match(report, /half_edges=1\b/)
  await assert.rejects(fsp.access(path.join(fresh, b, '__edges__', a)), 'report-only completes nothing')
  const { stdout: applied } = await run(path.join(BIN, 'graph-maintain'), ['--apply'], { env })
  assert.match(applied, new RegExp(`completed half edge: ${b} -> ${a}`))
  assert.equal(await fsp.readlink(path.join(fresh, b, '__edges__', a)), `../../${a}`)
  // The JS layer now sees the full neighborhood from every side.
  assert.deepEqual(new Set((await readNode(fresh, b)).edges.map((e) => e.id)), new Set([a, c]))
  // Idempotent: a second pass finds nothing left to migrate.
  const { stdout: rerun } = await run(path.join(BIN, 'graph-maintain'), [], { env })
  assert.doesNotMatch(rerun, /half edge:/)
  assert.match(rerun, /half_edges=0\b/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('graph-maintain --apply turns an empty directory "edge" into a symmetric edge the JS layer reads, and leaves a non-empty one', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-nonsymlink-'))
  const a = await createNode(fresh, { description: 'hand edge a' })
  const b = await createNode(fresh, { description: 'hand edge b' })
  const c = await createNode(fresh, { description: 'hand edge c' })
  // What an agent's own script left: os.makedirs(<graph>/<a>/__edges__/<b>).
  await fsp.mkdir(path.join(fresh, a, '__edges__', b))
  await fsp.mkdir(path.join(fresh, a, '__edges__', c))
  await fsp.writeFile(path.join(fresh, a, '__edges__', c, 'note'), 'keep me')
  const env = { ...process.env, GRAPH_ROOT: fresh }
  assert.deepEqual(await outEdges(fresh, a), [], 'neither entry is an edge to the JS layer')
  const { stdout: report } = await run(path.join(BIN, 'graph-maintain'), [], { env })
  assert.match(report, new RegExp(`integrity: non-symlink in __edges__: ${a}/__edges__/${b} \\(empty directory; not an edge; --apply replaces it`))
  assert.match(report, new RegExp(`integrity: non-symlink in __edges__: ${a}/__edges__/${c} \\(directory; not an edge; not empty: review it by hand`))
  assert.match(report, /edges=0 .*non_symlink_edges=2 /)
  const { stdout: applied } = await run(path.join(BIN, 'graph-maintain'), ['--apply'], { env })
  assert.match(applied, new RegExp(`repaired edge entry: ${a}/__edges__/${b} -> \\.\\./\\.\\./${b}`))
  assert.match(applied, new RegExp(`completed half edge: ${b} -> ${a}`))
  assert.equal(await fsp.readlink(path.join(fresh, a, '__edges__', b)), `../../${b}`)
  assert.equal(await fsp.readlink(path.join(fresh, b, '__edges__', a)), `../../${a}`)
  assert.equal(await fsp.readFile(path.join(fresh, a, '__edges__', c, 'note'), 'utf8'), 'keep me')
  assert.deepEqual(await outEdges(fresh, a), [b])
  assert.deepEqual((await readNode(fresh, b)).edges.map((e) => e.id), [a])
  const { stdout: rerun } = await run(path.join(BIN, 'graph-maintain'), [], { env })
  assert.match(rerun, /edges=1 .*half_edges=0 .*non_symlink_edges=1 /)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('graph-maintain accepts a graph the JS layer built and indexes it', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-maintain-'))
  const hub = await createNode(fresh, { description: 'maintained hub' })
  const leaf = await createNode(fresh, { description: 'maintained leaf' })
  await addEdge(fresh, hub, leaf)
  await touchEdge(fresh, hub, leaf)
  const { stdout } = await run(path.join(BIN, 'graph-maintain'), [], { env: { ...process.env, GRAPH_ROOT: fresh } })
  const map = await fsp.readFile(path.join(fresh, 'MAP.md'), 'utf8')
  assert.match(map, new RegExp(`^${leaf} — maintained leaf$`, 'm'))
  assert.match(map, new RegExp(`^${hub} — maintained hub$`, 'm'))
  // The JS-recorded traversal ranks the leaf first — proof the shell maintainer
  // reads the access history the JS layer wrote (F57, #93: .access/<id>.log).
  assert.match(map.split('\n').find((line) => ULID_RE.test(line.slice(0, 26))), new RegExp(`^${leaf} `))
  // The hub has no incoming edge, so a stale-archive suggestion is expected;
  // what must hold is that the JS-written graph passes integrity untouched.
  assert.match(stdout, /integrity_issues=0/)
  assert.match(stdout, /dangling_edges=0/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('graph-maintain --apply folds a legacy in-node accessed.log into .access/ (F57, #93)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-migrate-'))
  const src = await createNode(fresh, { description: 'pre-move source' })
  const dst = await createNode(fresh, { description: 'pre-move target, twice traversed' })
  await addEdge(fresh, src, dst)
  // History written where the pre-F57 writers put it: inside the node dir.
  await fsp.writeFile(path.join(fresh, src, 'accessed.log'), `${dst} 2026-08-01T00:00:00Z\n`)
  // New history keeps arriving at the current location before any migration.
  await touchEdge(fresh, src, dst)

  const env = { ...process.env, GRAPH_ROOT: fresh }
  // Report-only: the legacy file is named but untouched.
  const { stdout: report } = await run(path.join(BIN, 'graph-maintain'), [], { env })
  assert.match(report, new RegExp(`legacy access log: ${src}/accessed.log`))
  assert.match(report, /integrity_issues=0/, 'a legacy log is a migration candidate, not an integrity issue')
  await fsp.access(path.join(fresh, src, 'accessed.log'))

  // --apply consolidates: legacy gone, both lines in .access/, nothing lost.
  const { stdout: applied } = await run(path.join(BIN, 'graph-maintain'), ['--apply'], { env })
  assert.match(applied, new RegExp(`migrated access log: ${src}/accessed.log`))
  await assert.rejects(fsp.access(path.join(fresh, src, 'accessed.log')), 'the legacy file is gone')
  const merged = await fsp.readFile(path.join(fresh, '.access', `${src}.log`), 'utf8')
  assert.equal(merged.trimEnd().split('\n').filter((line) => line.startsWith(dst)).length, 2, 'legacy and current lines merged')
  // The consolidated history still ranks the graph: the traversed node leads MAP.md.
  const map = await fsp.readFile(path.join(fresh, 'MAP.md'), 'utf8')
  assert.match(map.split('\n')[0], new RegExp(`^${dst} `), 'the twice-traversed node ranks first after migration')
  // A re-run finds nothing left to migrate.
  const { stdout: rerun } = await run(path.join(BIN, 'graph-maintain'), [], { env })
  assert.doesNotMatch(rerun, /legacy access log:/)

  // Retry-idempotence: simulate the crash window between rename and unlink —
  // the legacy file reappears holding records the target already carries. A
  // retry must converge (dedupe) rather than re-append and inflate counts.
  await fsp.writeFile(path.join(fresh, src, 'accessed.log'), merged)
  await run(path.join(BIN, 'graph-maintain'), ['--apply'], { env })
  await assert.rejects(fsp.access(path.join(fresh, src, 'accessed.log')), 'the resurrected legacy file is consumed again')
  const converged = await fsp.readFile(path.join(fresh, '.access', `${src}.log`), 'utf8')
  assert.equal(converged, merged, 'a retry over already-migrated records changes nothing — no double counts')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a handoff the shell helper created is pinned by the JS layer (F38, #58)', async () => {
  // The fixture is the shell writer's contract: both writers must accept the
  // same type enum, and a handoff left via the bash CLI must surface exactly
  // like one written through the plugin.
  const id = await sh('node-new', 'deploy half done, blocked on approval', 'handoff')
  const open = openHandoffs(root)
  assert.ok(open.some((h) => h.id === id && h.description === 'deploy half done, blocked on approval'))
  // And the shell helper still rejects an unknown type, naming the full enum.
  await assert.rejects(() => sh('node-new', 'bad', 'nonsense'), /identity\|preference\|decision\|gotcha\|journal\|thread\|trivia\|handoff/)
})

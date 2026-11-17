// The suite asserts calendar dates against fixed instants, so it pins its own
// timezone: date stamps are local now (see today()), and an unpinned runner
// would flip those assertions by its UTC offset. The local-vs-UTC behaviour of
// today() itself is covered by a dedicated test that forks with TZ set.
process.env.TZ = 'UTC'

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import {
  ACCESS_DIR, ARCHIVE_DIR, ATTACH_MAX_BYTES, DEFAULT_RANK_WEIGHTS, ATTACH_SCAN_TOTAL_BYTES, ATTACH_SEARCH_BYTES, EDGE_TYPES, MAX_AGENT_ATTACHMENT_NAME_BYTES, OBSERVATION_FILENAME, PREV_NODE_FILE, STALE_LOCK_MS, ULID_RE, accessCounts, addEdge, agentAttachmentNameViolation, assertAttachmentName, assertEdgeType, attach, attachFromPath, attachmentNameKey, attachments, compareIdsNewestFirst, createNode, edgeSidecarOwners, edgeTypes, extraFiles, indexLines, inspectFileBytes, listIds,
  edgeTypeOf, indexLinesSync, loadNode, mergeNodes, normalizeBody, openHandoffs, openWorkState, orphanCensus, outEdges, parseNode, prevAttachmentFile, readAttachment, readAttachmentWithHash, readNode, renderNode, restoreNode, search, setEdgeType, parseCalendarDate, supersede, supersededBy, today, touchEdge, touchRead, ulid, updateNode,
  weekdayName, withNodeLocks,
} from '../lib/graph.js'

let root
before(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-test-')) })
after(async () => { await fsp.rm(root, { recursive: true, force: true }) })

describe('withNodeLocks (F68, #126)', () => {
  const ids = [
    '01J00000000000000000000001',
    '01J00000000000000000000002',
    '01J00000000000000000000003',
  ]
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const exists = async (file) => fsp.access(file).then(() => true, () => false)

  test('serializes concurrent critical sections for the same Node', async () => {
    const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-lock-exclusive-'))
    const events = []
    let active = 0
    let maxActive = 0
    const run = (label) => withNodeLocks(fresh, [ids[0]], async () => {
      events.push(`${label}:start`)
      maxActive = Math.max(maxActive, ++active)
      await delay(40)
      active--
      events.push(`${label}:end`)
    })
    await Promise.all([run('a'), run('b')])
    assert.equal(maxActive, 1)
    assert.ok(
      events.join(',') === 'a:start,a:end,b:start,b:end'
      || events.join(',') === 'b:start,b:end,a:start,a:end',
      `critical sections interleaved: ${events.join(',')}`,
    )
    await fsp.rm(fresh, { recursive: true, force: true })
  })

  test('serializes a read against a write on the same Node', async () => {
    const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-lock-read-write-'))
    const id = await createNode(fresh, { description: 'read-write target', body: 'before' })
    const events = []
    let active = 0
    let maxActive = 0
    const run = (label, fn) => withNodeLocks(fresh, [id], async () => {
      events.push(`${label}:start`)
      maxActive = Math.max(maxActive, ++active)
      await delay(40)
      const result = await fn()
      active--
      events.push(`${label}:end`)
      return result
    })
    const [, view] = await Promise.all([
      run('write', () => updateNode(fresh, id, { body: 'after' })),
      run('read', () => readNode(fresh, id)),
    ])
    assert.equal(maxActive, 1)
    assert.ok(
      events.join(',') === 'write:start,write:end,read:start,read:end'
      || events.join(',') === 'read:start,read:end,write:start,write:end',
      `read and write interleaved: ${events.join(',')}`,
    )
    assert.ok(['before', 'after'].includes(view.body), `read saw an incomplete body: ${JSON.stringify(view.body)}`)
    assert.equal((await readNode(fresh, id)).body, 'after')
    await fsp.rm(fresh, { recursive: true, force: true })
  })

  test('steals a stale lock by mtime', async () => {
    const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-lock-stale-'))
    const lockDir = path.join(fresh, '.locks', `${ids[0]}.lock`)
    await fsp.mkdir(lockDir, { recursive: true })
    const stale = new Date(Date.now() - STALE_LOCK_MS - 1_000)
    await fsp.utimes(lockDir, stale, stale)
    assert.equal(await withNodeLocks(fresh, [ids[0]], async () => 'stolen'), 'stolen')
    assert.equal(await exists(lockDir), false, 'the replacement lock is released')
    await fsp.rm(fresh, { recursive: true, force: true })
  })

  test('releases every lock when the critical section throws', async () => {
    const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-lock-error-'))
    await assert.rejects(
      withNodeLocks(fresh, [ids[0], ids[1]], async () => { throw new Error('boom') }),
      /boom/,
    )
    for (const id of ids.slice(0, 2)) {
      assert.equal(await exists(path.join(fresh, '.locks', `${id}.lock`)), false)
    }
    await fsp.rm(fresh, { recursive: true, force: true })
  })

  test('acquires multiple Node locks in sorted order before running', async () => {
    const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-lock-order-'))
    const lockRoot = path.join(fresh, '.locks')
    await fsp.mkdir(lockRoot, { recursive: true })
    const firstLock = path.join(lockRoot, `${ids[0]}.lock`)
    await fsp.mkdir(firstLock)
    let ran = false
    const pending = withNodeLocks(fresh, [...ids].reverse(), async () => {
      ran = true
      for (const id of ids) await fsp.access(path.join(lockRoot, `${id}.lock`))
    })
    await delay(75)
    const laterLocks = await Promise.all(ids.slice(1).map((id) => exists(path.join(lockRoot, `${id}.lock`))))
    assert.equal(ran, false, 'the critical section waits for the first sorted id')
    assert.deepEqual(laterLocks, [false, false], 'no later id is acquired ahead of the blocked first id')
    await fsp.rmdir(firstLock)
    await pending
    assert.equal(ran, true)
    await fsp.rm(fresh, { recursive: true, force: true })
  })
})

test('edgeSidecarOwners mirrors the sidecars addEdge may rewrite (F68, #130)', () => {
  const a = '01J00000000000000000000001'
  const b = '01J00000000000000000000002'
  assert.deepEqual(edgeSidecarOwners(a, b, undefined), [])
  assert.deepEqual(edgeSidecarOwners(a, b, 'supersedes'), [a, b])
  assert.deepEqual(edgeSidecarOwners(b, a, 'follows-from'), [b, a])
  assert.deepEqual(edgeSidecarOwners(a, b, 'relates-to'), [a])
  assert.deepEqual(edgeSidecarOwners(b, a, 'relates-to'), [a])
})

test('today() formats the machine calendar day, not a UTC slice (ledger #20)', () => {
  // 2026-08-20T20:00:00Z is already the 21st in Tokyo and still the 20th in Los
  // Angeles. A UTC slice answers "2026-08-20" for both, so this fails the moment
  // the formatter goes back to UTC — which the TZ-pinned rest of this suite cannot see.
  const instant = Date.UTC(2026, 7, 20, 20, 0, 0)
  const lib = new URL('../lib/graph.js', import.meta.url).href
  const ask = (tz) => execFileSync(
    process.execPath,
    ['--input-type=module', '-e', `import { today } from ${JSON.stringify(lib)}; process.stdout.write(today(${instant}))`],
    { env: { ...process.env, TZ: tz }, encoding: 'utf8' },
  ).trim()
  assert.equal(ask('Asia/Tokyo'), '2026-08-21')
  assert.equal(ask('America/Los_Angeles'), '2026-08-20')
  // Recency scoring must read a stamp back on the same calendar it was written
  // on: under the suite's UTC pin local == UTC, so this only bites in a fork.
  const roundTrip = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', `import { parseCalendarDate } from ${JSON.stringify(lib)}; process.stdout.write(String(parseCalendarDate('2026-08-20') === new Date(2026, 7, 20).getTime()))`],
    { env: { ...process.env, TZ: 'Asia/Tokyo' }, encoding: 'utf8' },
  ).trim()
  assert.equal(roundTrip, 'true', 'a stamp parses back to local midnight, not UTC midnight')
  // Four-digit years under 100 must not land in the 1900s on either side.
  assert.equal(parseCalendarDate('0001-07-01'), (() => { const d = new Date(2000, 6, 1); d.setFullYear(1); return d.getTime() })())
  assert.ok(Number.isNaN(parseCalendarDate('not a date')))
  // A timestamp that cannot be a date must still fail loud rather than persist NaN.
  assert.throws(() => today(Number.NaN), /invalid timestamp/)
  // Year 1 (suite TZ is pinned to UTC, so local == UTC here): a bare
  // `getFullYear()` would render `1-07-01` and fail graph-maintain's date regex.
  assert.equal(today(Date.parse('0001-07-01T12:00:00Z')), '0001-07-01')
})

test('ulid is 26 Crockford characters and sorts by time', () => {
  const early = ulid(1000)
  const late = ulid(1_000_000_000_000)
  assert.match(early, ULID_RE)
  assert.match(late, ULID_RE)
  assert.ok(early < late, 'timestamp prefix must sort chronologically')
  assert.notEqual(ulid(5), ulid(5), 'the random suffix must differ')
})

test('node.md round-trips through parse and render', () => {
  const text = renderNode({ description: 'a fact', created: '2026-08-18', body: 'body line\nsecond' })
  const parsed = parseNode(text)
  assert.equal(parsed.description, 'a fact')
  assert.equal(parsed.created, '2026-08-18')
  assert.equal(parsed.body, 'body line\nsecond')
})

test('parse tolerates a file with no frontmatter', () => {
  const parsed = parseNode('just prose\n')
  assert.equal(parsed.description, '')
  assert.equal(parsed.body, 'just prose\n')
})

test('node.md carries `updated` when set and omits it when absent', () => {
  const revised = renderNode({ description: 'd', created: '2026-08-18', updated: '2026-08-20', body: 'x' })
  assert.match(revised, /^---\ndescription: d\ncreated: 2026-08-18\nupdated: 2026-08-20\n---/)
  assert.equal(parseNode(revised).updated, '2026-08-20')
  const pristine = renderNode({ description: 'd', created: '2026-08-18', body: 'x' })
  assert.doesNotMatch(pristine, /updated:/, 'an unset updated is never rendered as an empty field')
  assert.equal(parseNode(pristine).updated, '', 'a node without updated stays valid')
})

test('updateNode preserves unknown frontmatter keys an external writer added', async () => {
  // An agent or shell writes a custom frontmatter key straight into node.md.
  const id = await createNode(root, { description: 'has a custom key', body: 'v1' })
  const raw = `---\ndescription: has a custom key\ncreated: 2026-08-18\ncustom: some value with spaces\n---\n\nv1\n`
  await fsp.writeFile(path.join(root, id, 'node.md'), raw, 'utf8')
  // A later updateNode that knows nothing about `custom:` must round-trip it.
  await updateNode(root, id, { body: 'v2' }, Date.parse('2026-08-20'))
  const reread = await fsp.readFile(path.join(root, id, 'node.md'), 'utf8')
  assert.match(reread, /^custom: some value with spaces$/m, 'the unknown key survived the update')
  assert.match(reread, /\nupdated: 2026-08-20\n/, 'the update still stamped `updated`')
  assert.match(reread, /\nv2$/, 'the new body was written')
  assert.deepEqual(parseNode(reread).extra, [['custom', 'some value with spaces']])
})

test('an optional `type` round-trips through create, parse, render, and update', async () => {
  const id = await createNode(root, { description: 'my name is Alex', body: 'x', type: 'identity' })
  const node = await loadNode(root, id)
  assert.equal(node.type, 'identity')
  const raw = await fsp.readFile(path.join(root, id, 'node.md'), 'utf8')
  assert.match(raw, /^type: identity$/m)
  // render/parse round-trip
  assert.equal(parseNode(renderNode(node)).type, 'identity')
  // a node created without a type carries none, and none is rendered
  const bare = await loadNode(root, await createNode(root, { description: 'untyped fact' }))
  assert.equal(bare.type, '')
  assert.doesNotMatch(renderNode(bare), /type:/)
  // update can set a type on a previously untyped node …
  await updateNode(root, id, { type: 'preference' })
  assert.equal((await loadNode(root, id)).type, 'preference')
  // … and clear it with an empty string
  await updateNode(root, id, { type: '' })
  assert.equal((await loadNode(root, id)).type, '')
})

test('an invalid `type` is rejected on both create and update', async () => {
  await assert.rejects(() => createNode(root, { description: 'bad type', type: 'nonsense' }), /type must be one of/)
  const id = await createNode(root, { description: 'good node' })
  await assert.rejects(() => updateNode(root, id, { type: 'whatever' }), /type must be one of/)
})

test('createNode writes a complete node and rejects a multiline description', async () => {
  const id = await createNode(root, { description: 'Plaud Note is a card recorder', body: 'detail' })
  assert.match(id, ULID_RE)
  const node = await loadNode(root, id)
  assert.equal(node.description, 'Plaud Note is a card recorder')
  assert.equal(node.body, 'detail')
  assert.deepEqual(await outEdges(root, id), [])
  await assert.rejects(() => createNode(root, { description: 'two\nlines' }), /single line/)
  await assert.rejects(() => createNode(root, { description: '  ' }), /non-empty/)
  const staged = (await fsp.readdir(root)).filter((n) => n.startsWith('.staging-'))
  assert.deepEqual(staged, [], 'a rejected create must leave no staging directory')
})

test('an escaped single-line body is unescaped once at write (F63, #108)', async () => {
  // The live defect: the model emitted the whole body as an escaped string, so
  // every read since rendered literal backslash-n where the paragraph break was.
  const escaped = '原话："导出很慢"\\n\\n- 最卡的是\\t导出这一步'
  const id = await createNode(root, { description: '客户反馈：导出慢', body: escaped })
  assert.equal((await loadNode(root, id)).body, '原话："导出很慢"\n\n- 最卡的是\t导出这一步')
  const raw = await fsp.readFile(path.join(root, id, 'node.md'), 'utf8')
  assert.doesNotMatch(raw, /\\n/, 'nothing reaches disk still carrying the escape')
  // The update path is the same choke point.
  await updateNode(root, id, { body: 'line one\\nline two' })
  assert.equal((await loadNode(root, id)).body, 'line one\nline two')
  // A trailing real newline is whitespace the caller's string carried, not
  // structure — it must not shield the escapes from the repair.
  assert.equal(normalizeBody('line one\\nline two\n'), 'line one\nline two\n')
})

test('a body discussing \\n as text is stored verbatim (F63 regression)', async () => {
  // Real line breaks of its own: this is prose ABOUT the escape, never an
  // escaped string, so it must survive character for character.
  const prose = 'Escape rule:\n\n- write \\n in the config file, never a real break\n- \\t works the same way'
  const id = await createNode(root, { description: 'config escape rule' })
  await updateNode(root, id, { body: prose })
  assert.equal((await loadNode(root, id)).body, prose)
  // Tabs alone are no evidence: one line either way, so a gotcha about `\t`
  // keeps its two characters.
  const tabs = 'a Makefile recipe needs a real tab, not \\t'
  assert.equal((await loadNode(root, await createNode(root, { description: 'makefile tabs', body: tabs }))).body, tabs)
  // Exactly one layer: a doubly-escaped body lands on the literal `\n`, and a
  // pair this never owned (`\d` in a regex) passes through untouched.
  assert.equal(normalizeBody('regex \\\\n and \\d, then \\nend'), 'regex \\n and \\d, then \nend')
  // A line break is a line break whatever character made it (codex review of
  // #111): a body separated by bare CRs — or by U+2028/2029 — is multi-line
  // prose already, so the literal `\n` it discusses is text, not a payload.
  const cr = 'Escape rule:\r\r- write \\n in the config file\r- never a real break'
  assert.equal(normalizeBody(cr), cr)
  const separated = 'Escape rule:\u2028- write \\n in the config file\u2029- never a real break'
  assert.equal(normalizeBody(separated), separated)
  assert.equal((await loadNode(root, await createNode(root, { description: 'CR-separated escape rule', body: cr }))).body, cr)
})

test('normalizeBody touches the incoming body only, never what is already stored', async () => {
  const id = await createNode(root, { description: 'legacy escaped node' })
  // A node whose escape predates this guard: re-rendering it under an
  // unrelated update would falsify `updated` and burn the one-deep snapshot.
  await fsp.writeFile(path.join(root, id, 'node.md'), '---\ndescription: legacy escaped node\ncreated: 2026-08-24\n---\n\nline one\\nline two\n', 'utf8')
  await updateNode(root, id, { type: 'gotcha' }, Date.parse('2026-08-25'))
  assert.equal((await loadNode(root, id)).body.trim(), 'line one\\nline two')
  await assert.rejects(() => fsp.access(path.join(root, id, PREV_NODE_FILE)), 'a type-only update is not a body change')
})

test('a description carrying a literal escape sequence is rejected (F63, #108)', async () => {
  // A one-line field has no real newline to weigh the escape against, so there
  // is nothing to normalize on — this fails loudly and the model resends.
  await assert.rejects(() => createNode(root, { description: 'two\\nlines, escaped' }), /literal escape sequence/)
  // A real CR splits the frontmatter line for half of node.md's readers, so it
  // is rejected exactly like an LF.
  await assert.rejects(() => createNode(root, { description: 'carriage\rreturn' }), /single line/)
  const id = await createNode(root, { description: 'clean line', body: 'kept' })
  await assert.rejects(() => updateNode(root, id, { description: 'still\\nescaped', body: 'new body' }), /literal escape sequence/)
  const node = await loadNode(root, id)
  assert.equal(node.description, 'clean line')
  assert.equal(node.body, 'kept', 'a rejected update writes nothing at all')
})

test('addEdge stores one logical edge as two symlinks, idempotent from either side (F54, #90)', async () => {
  const a = await createNode(root, { description: 'node a' })
  const b = await createNode(root, { description: 'node b' })
  assert.equal(await addEdge(root, a, b), 'created')
  assert.equal(await addEdge(root, a, b), 'exists')
  // The reverse-duplicate class dies by construction: writing the reverse of
  // an existing edge completes/no-ops rather than minting a second edge.
  assert.equal(await addEdge(root, b, a), 'exists')
  assert.deepEqual(await outEdges(root, a), [b])
  assert.deepEqual(await outEdges(root, b), [a], 'the reverse symlink is the same logical edge, seen from the peer')
  for (const [from, to] of [[a, b], [b, a]]) {
    const link = path.join(root, from, '__edges__', to)
    assert.equal(await fsp.readlink(link), `../../${to}`)
    assert.ok((await fsp.stat(link)).isDirectory(), 'each half must resolve to its target node')
  }
  await assert.rejects(() => addEdge(root, a, a), /itself/)
  await assert.rejects(() => addEdge(root, a, 'ZZZ'), /invalid target node id/)
  await assert.rejects(() => addEdge(root, a, '01J00000000000000000000001'), /target node does not exist/)
  await assert.rejects(() => addEdge(root, '../../etc', b), /invalid source node id/)
})

test('addEdge completes a legacy single-direction edge and reports it as existing (F54, #90)', async () => {
  const a = await createNode(root, { description: 'legacy half source' })
  const b = await createNode(root, { description: 'legacy half target' })
  // A v2-style single-direction edge, as an un-migrated graph stores it.
  await fsp.symlink(`../../${b}`, path.join(root, a, '__edges__', b))
  assert.equal(await addEdge(root, b, a), 'exists', 'the logical edge already existed — completing the pair is not a new edge')
  assert.equal(await fsp.readlink(path.join(root, b, '__edges__', a)), `../../${a}`, 'the missing half was healed in passing')
})

test('touchEdge records traversals and refuses edges that do not exist', async () => {
  const a = await createNode(root, { description: 'traversal source' })
  const b = await createNode(root, { description: 'traversal target' })
  const c = await createNode(root, { description: 'never linked' })
  await addEdge(root, a, b)
  await touchEdge(root, a, b, 1_700_000_000_000)
  await touchEdge(root, a, b, 1_700_000_060_000)
  // The log lives at graph level (F57, #93), never inside the node dir.
  const log = await fsp.readFile(path.join(root, ACCESS_DIR, `${a}.log`), 'utf8')
  assert.equal(log.trimEnd().split('\n').length, 2)
  assert.match(log, new RegExp(`^${b} 2023-11-14T22:13:20Z$`, 'm'))
  assert.equal((await accessCounts(root)).get(b), 2)
  // The pair is one logical edge: traversing it the other way logs against b.
  await touchEdge(root, b, a, 1_700_000_120_000)
  assert.match(await fsp.readFile(path.join(root, ACCESS_DIR, `${b}.log`), 'utf8'), new RegExp(`^${a} `, 'm'))
  await assert.rejects(() => touchEdge(root, a, c), /no such edge/)
})

test('touchRead logs a direct read against the node itself, wiring no edge', async () => {
  const a = await createNode(root, { description: 'read directly, never traversed into' })
  await touchRead(root, a, 1_700_000_000_000)
  const log = await fsp.readFile(path.join(root, ACCESS_DIR, `${a}.log`), 'utf8')
  // the self-reference is the reserved direct-read marker; same <target> <ts> shape
  assert.match(log, new RegExp(`^${a} 2023-11-14T22:13:20Z$`, 'm'))
  assert.equal((await accessCounts(root)).get(a), 1, 'a direct read counts toward the node own rank')
  assert.deepEqual(await outEdges(root, a), [], 'a direct read must not wire a self-edge')
})

test('a legacy in-node accessed.log still ranks and never lists as an attachment (F57, #93)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-legacy-'))
  const now = Date.parse('2026-08-24T12:00:00Z')
  const mk = (d) => createNode(fresh, { description: d, now: Date.parse('2020-01-01') })
  const src = await mk('legacy traffic source')
  const hot = await mk('hot: reached twice under the old layout')
  const warm = await mk('warm: reached once under the new layout')
  // Pre-move history: lines in the node's OWN dir, exactly where the old writers put them.
  await fsp.writeFile(path.join(fresh, src, 'accessed.log'), `${hot} 2020-01-02T00:00:00Z\n${hot} 2020-01-03T00:00:00Z\n`)
  // Post-move history for the same source, in the current location.
  await fsp.mkdir(path.join(fresh, ACCESS_DIR), { recursive: true })
  await fsp.appendFile(path.join(fresh, ACCESS_DIR, `${src}.log`), `${warm} 2020-01-04T00:00:00Z\n`)

  // Both locations feed the same signals: two legacy traversals outrank one current.
  const counts = await accessCounts(fresh)
  assert.equal(counts.get(hot), 2, 'legacy lines still count')
  assert.equal(counts.get(warm), 1, 'current lines count alongside them')
  const order = (await indexLines(fresh, 10, undefined, now)).map((line) => line.slice(0, 26))
  assert.ok(order.indexOf(hot) < order.indexOf(warm), 'ranking blends legacy and current history')
  assert.deepEqual(order, indexLinesSync(fresh, 10, undefined, now).map((line) => line.slice(0, 26)), 'the sync index agrees')

  // And the log is bookkeeping, never an attachment: no listing shows it on
  // either layout (src carries a legacy file AND a current .access log).
  assert.deepEqual(await extraFiles(fresh, src), [], 'extraFiles hides the legacy log')
  assert.deepEqual((await readNode(fresh, src)).files, [], 'the node view lists no files')
  const found = await search(fresh, 'legacy traffic', 10)
  assert.equal(found.matches[0].id, src)
  assert.equal(found.matches[0].files, undefined, 'a search row advertises no files')
  // The hot id appears verbatim inside the legacy log; only an excluded scan keeps it out.
  const byId = await search(fresh, hot, 10)
  assert.ok(byId.matches.every((m) => !(m.matched_in ?? []).includes('accessed.log')), 'the attachment scan never opens the legacy log')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('updateNode replaces content and keeps created and edges', async () => {
  const a = await createNode(root, { description: 'before', body: 'old' })
  const b = await createNode(root, { description: 'neighbor' })
  await addEdge(root, a, b)
  const created = (await loadNode(root, a)).created
  await updateNode(root, a, { description: 'after', body: 'new' })
  const node = await loadNode(root, a)
  assert.equal(node.description, 'after')
  assert.equal(node.body, 'new')
  assert.equal(node.created, created)
  assert.deepEqual(await outEdges(root, a), [b])
  await updateNode(root, a, { body: 'newer' })
  assert.equal((await loadNode(root, a)).description, 'after', 'an omitted field must be left alone')
  await assert.rejects(() => updateNode(root, '01J00000000000000000000001', { body: 'x' }), /does not exist/)
})

test('updateNode stamps `updated` on a content change but not on a links-only call', async () => {
  const a = await createNode(root, { description: 'evolving', body: 'v1' })
  assert.equal((await loadNode(root, a)).updated, '', 'a freshly created node carries no updated')
  await updateNode(root, a, { body: 'v2' }, Date.parse('2026-08-20T09:00:00Z'))
  assert.equal((await loadNode(root, a)).updated, '2026-08-20', 'a body change stamps updated')
  await updateNode(root, a, { description: 'evolving fact' }, Date.parse('2026-09-01T09:00:00Z'))
  assert.equal((await loadNode(root, a)).updated, '2026-09-01', 'a description change re-stamps updated')
  // memory_write with only id + links reaches updateNode with neither field —
  // that must leave the last content-change date alone.
  await updateNode(root, a, {}, Date.parse('2027-01-01T00:00:00Z'))
  assert.equal((await loadNode(root, a)).updated, '2026-09-01', 'a links-only call does not bump updated')
  // An idempotent replay — same content passed again — must not falsify the date.
  await updateNode(root, a, { description: 'evolving fact', body: 'v2' }, Date.parse('2027-02-02T00:00:00Z'))
  assert.equal((await loadNode(root, a)).updated, '2026-09-01', 'rewriting identical content does not bump updated')
})

test('readNode reports each logical edge once as a peer, plus attached files (F54, #90)', async () => {
  const hub = await createNode(root, { description: 'hub node', body: 'hub body' })
  const out = await createNode(root, { description: 'downstream' })
  const back = await createNode(root, { description: 'upstream' })
  await addEdge(root, hub, out)
  // An edge written FROM the other side is the same logical edge: the hub sees
  // it in its own __edges__/ — "what points here" is now a directory read, not
  // the O(n) whole-graph scan a separate backlinks list used to need.
  await addEdge(root, back, hub)
  await fsp.writeFile(path.join(root, hub, 'data.json'), '{}')
  const view = await readNode(root, hub)
  assert.deepEqual(new Set(view.edges.map((e) => e.id)), new Set([out, back]), 'peers from both write directions, each once')
  assert.equal(view.edges.length, 2, 'one row per logical edge — never one per symlink direction')
  assert.equal('backlinks' in view, false, 'the scan-backed backlinks list is gone — the peers list is it')
  assert.deepEqual(view.files, [{ name: 'data.json', size: 2, summary: '{}' }])
  await assert.rejects(() => readNode(root, '01J00000000000000000000001'), /does not exist/)
})

test('readNode still lists a legacy single-direction out-edge, mid-migration (F54, #90)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-legacyedge-'))
  const a = await createNode(fresh, { description: 'legacy source' })
  const b = await createNode(fresh, { description: 'legacy target' })
  // A v2-style half-edge, as the live graph stores it until graph-maintain
  // --apply symmetrizes: the source still sees the edge, the target sees
  // nothing until migration — read-side tolerates both forms.
  await fsp.symlink(`../../${b}`, path.join(fresh, a, '__edges__', b))
  assert.deepEqual((await readNode(fresh, a)).edges, [{ id: b, description: 'legacy target' }])
  assert.deepEqual((await readNode(fresh, b)).edges, [])
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('attach writes an agent-space file, reports created vs overwritten, and rejects a missing node', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-attach-'))
  const id = await createNode(fresh, { description: 'has attachments' })
  const first = await attach(fresh, id, 'summary.md', 'first line\nsecond line\n')
  assert.deepEqual(first, { file: 'summary.md', bytes: Buffer.byteLength('first line\nsecond line\n'), status: 'created' })
  assert.equal(await fsp.readFile(path.join(fresh, id, 'summary.md'), 'utf8'), 'first line\nsecond line\n')
  // Re-attaching the same name overwrites in place and says so.
  const again = await attach(fresh, id, 'summary.md', 'replaced')
  assert.equal(again.status, 'overwritten')
  assert.equal(await fsp.readFile(path.join(fresh, id, 'summary.md'), 'utf8'), 'replaced')
  // A missing node is an error — no orphan directory is created.
  await assert.rejects(() => attach(fresh, '01J00000000000000000000001', 'x.md', 'y'), /node does not exist/)
  assert.deepEqual(await listIds(fresh), [id])
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('attach rejects reserved, traversal, and dotfile names, each as its own case', () => {
  for (const name of ['node.md', 'accessed.log', '__edges__', 'MAP.md']) {
    assert.throws(() => assertAttachmentName(name), /reserved/, `reserved: ${name}`)
  }
  // Case variants alias the real file on case-insensitive filesystems (APFS).
  for (const name of ['NODE.md', 'Node.MD', 'ACCESSED.LOG', '__EDGES__', 'map.md']) {
    assert.throws(() => assertAttachmentName(name), /reserved/, `reserved case variant: ${name}`)
  }
  for (const name of ['a/b', '../escape', '..\\escape', 'sub/dir/file']) {
    assert.throws(() => assertAttachmentName(name), /path separators/, `separator: ${name}`)
  }
  assert.throws(() => assertAttachmentName('..'), /"\." or "\.\."/)
  assert.throws(() => assertAttachmentName('.hidden'), /start with a dot/)
  assert.throws(() => assertAttachmentName(''), /non-empty/)
  // A plain name survives.
  assert.equal(assertAttachmentName('transcript.md'), 'transcript.md')
})

test('attach refuses to empty out an existing attachment (ledger #21)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-empty-'))
  const id = await createNode(fresh, { description: 'holds a transcript' })
  await attach(fresh, id, 'transcript.md', 'the whole meeting, 1248 bytes of it')
  // A read-shaped call — content omitted, hoping the tool hands the file back —
  // used to succeed and destroy the file.
  await assert.rejects(() => attach(fresh, id, 'transcript.md', ''), /refusing to replace transcript\.md \(35 bytes\) with empty content/)
  assert.equal(await fsp.readFile(path.join(fresh, id, 'transcript.md'), 'utf8'), 'the whole meeting, 1248 bytes of it')
  // A deliberate empty *new* file loses nothing, and a real replacement still works.
  assert.equal((await attach(fresh, id, 'blank.md', '')).status, 'created')
  assert.equal((await attach(fresh, id, 'transcript.md', 'revised')).status, 'overwritten')
  // An already-empty file may be overwritten with empty content: nothing to lose.
  assert.equal((await attach(fresh, id, 'blank.md', '')).status, 'overwritten')
  await fsp.rm(fresh, { recursive: true, force: true })
})

// #247: the overwrite keeps what it replaces. `.node.md.prev` protects the body
// only, so an attachment replaced in place was gone for good — the A2A incident
// took a 1,696-byte report to 11 bytes, then 2. The snapshot lives beside its
// file (`.report.md.prev`), is written atomically BEFORE the replacement, and
// aborts the overwrite if it cannot be written.
test('attach snapshots the prior bytes to .<name>.prev before replacing them (#247)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-attach-prev-'))
  const id = await createNode(fresh, { description: 'holds a report' })
  const prev = path.join(fresh, id, '.report.md.prev')
  const prior = Buffer.from('| 列 | 含义 |\n| 1 | 总额 |\n')
  await attach(fresh, id, 'report.md', prior.toString('utf8'))
  // A create writes no snapshot: there is no prior to protect.
  await assert.rejects(() => fsp.lstat(prev))
  await attach(fresh, id, 'report.md', 'short\n')
  assert.ok((await fsp.readFile(prev)).equals(prior), 'the prior bytes, byte for byte')
  // One deep: the next overwrite replaces the snapshot with the newer prior.
  await attach(fresh, id, 'report.md', 'third\n')
  assert.equal(await fsp.readFile(prev, 'utf8'), 'short\n')
  // Identical bytes destroy nothing, so they write no snapshot.
  await fsp.rm(prev)
  await attach(fresh, id, 'report.md', 'third\n')
  await assert.rejects(() => fsp.lstat(prev), 'an identical overwrite keeps no snapshot')
  // `snapshot: false` is the session-anchored switch the tool layer passes when
  // this Session wrote the bytes now on disk.
  await attach(fresh, id, 'report.md', 'fourth\n', { snapshot: false })
  await assert.rejects(() => fsp.lstat(prev), 'snapshot: false writes nothing')
  // A new filename has nothing to snapshot.
  await attach(fresh, id, 'fresh.md', 'new file\n')
  await assert.rejects(() => fsp.lstat(path.join(fresh, id, '.fresh.md.prev')))
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the snapshot is a byte copy, never a decode — invalid UTF-8 survives (#247)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-attach-prev-bytes-'))
  const id = await createNode(fresh, { description: 'holds a binary file' })
  // 0xC3 0x28 is not valid UTF-8: a decode round-trip would mint U+FFFD and the
  // damaged original would survive in NEITHER file.
  const evil = Buffer.concat([Buffer.from('header '), Buffer.from([0xc3, 0x28, 0x00]), Buffer.from('\n')])
  await fsp.writeFile(path.join(fresh, id, 'binary.bin'), evil)
  await attach(fresh, id, 'binary.bin', 'text now\n')
  assert.ok((await fsp.readFile(path.join(fresh, id, '.binary.bin.prev'))).equals(evil))
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a snapshot that cannot be written aborts the overwrite, target untouched (#247)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-attach-prev-fail-'))
  const id = await createNode(fresh, { description: 'holds a report' })
  await attach(fresh, id, 'report.md', 'the original\n')
  // `.report.md.prev` as a DIRECTORY is a snapshot rename that must fail.
  await fsp.mkdir(path.join(fresh, id, '.report.md.prev'))
  await assert.rejects(() => attach(fresh, id, 'report.md', 'the replacement\n'))
  assert.equal(await fsp.readFile(path.join(fresh, id, 'report.md'), 'utf8'), 'the original\n')
  // `writeAtomic` stages as `.<basename>.tmp-…`, and the snapshot's basename is
  // already `.report.md.prev` — so the real staging name starts with TWO dots.
  // Checking the single-dot prefix would pass while a real temp file sat there
  // (review finding 6).
  assert.deepEqual((await fsp.readdir(path.join(fresh, id))).filter((name) => name.startsWith('..report.md.prev.tmp-')), [], 'no staging debris')
  // The WRITE half of the same property: with the node directory read-only the
  // snapshot's temp file cannot even be created, so the failure happens before
  // the rename — and the target is still untouched, with nothing staged.
  await fsp.chmod(path.join(fresh, id), 0o555)
  try {
    await assert.rejects(() => attach(fresh, id, 'report.md', 'while read-only\n'))
  } finally {
    await fsp.chmod(path.join(fresh, id), 0o755)
  }
  assert.equal(await fsp.readFile(path.join(fresh, id, 'report.md'), 'utf8'), 'the original\n', 'a failed snapshot write leaves the target untouched')
  assert.deepEqual((await fsp.readdir(path.join(fresh, id))).filter((name) => name.startsWith('..report.md.prev.tmp-')), [], 'a failed snapshot write stages nothing')
  // A symlink under the name is not a regular file: replacing it would destroy
  // whatever it points at, so it is refused rather than snapshotted.
  await fsp.symlink(path.join(fresh, id, 'report.md'), path.join(fresh, id, 'link.md'))
  await assert.rejects(() => attach(fresh, id, 'link.md', 'x\n'), /not a regular file/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

// #255: what an AGENT may name a write. `observation.txt` is the framework's
// F79 capture — an agent-authored one is recorded as this Session's own bytes,
// so the next qualifying write's autosave passes `snapshot: false` and NO copy
// of the agent's content survives. The refusal lives in a pure helper the tools
// run in their trusted preparation, deliberately NOT in RESERVED_FILES (that
// also gates the read path and the autosave itself).
test('agentAttachmentNameViolation refuses observation.txt and over-long names, and nothing else (#255)', () => {
  const observation = agentAttachmentNameViolation(OBSERVATION_FILENAME)
  assert.match(observation, /reserved/)
  assert.match(observation, /framework's own capture/)
  // Case-insensitive: on default APFS `Observation.txt` IS `observation.txt`.
  assert.match(agentAttachmentNameViolation('Observation.TXT'), /reserved/)
  // Byte cap, not character cap: 200 ASCII bytes fit, 201 do not, and 67
  // three-byte characters are 201 bytes though only 67 characters.
  assert.equal(agentAttachmentNameViolation('a'.repeat(MAX_AGENT_ATTACHMENT_NAME_BYTES)), undefined)
  assert.match(agentAttachmentNameViolation('a'.repeat(MAX_AGENT_ATTACHMENT_NAME_BYTES + 1)), /over the 200-byte limit/)
  assert.equal(agentAttachmentNameViolation('周'.repeat(66)), undefined, '198 bytes')
  assert.match(agentAttachmentNameViolation('周'.repeat(67)), /201 UTF-8 bytes/)
  // Everything an agent legitimately writes is untouched.
  for (const name of ['report.md', '周报-2026W32.md', 'observation.md', 'my-observation.txt', 'notes.txt']) {
    assert.equal(agentAttachmentNameViolation(name), undefined, `${name} is allowed`)
  }
})

// #255 review 1 (blocker): `toLowerCase()` is not the fold a case-insensitive
// filesystem uses. `obſervation.txt` (LONG S, U+017F) is a different string but
// the SAME inode as `observation.txt` on default APFS, so it slipped past both
// validators — and an agent write then marked the framework's file authored,
// making the next F79 capture skip its snapshot and destroy the agent's bytes.
test('the observation guard folds names the way a case-insensitive filesystem does (#255 review 1)', () => {
  // The key two spellings share when the filesystem resolves them to one file.
  assert.equal(attachmentNameKey('obſervation.txt'), attachmentNameKey(OBSERVATION_FILENAME))
  assert.equal(attachmentNameKey('OBSERVATION.TXT'), attachmentNameKey(OBSERVATION_FILENAME))
  // KELVIN SIGN (U+212A) canonically decomposes to 'K', so it folds to 'k'.
  assert.equal(attachmentNameKey('\u212A'), attachmentNameKey('k'))
  // Canonical equivalence: composed and decomposed spellings are one name, so
  // APFS treats them as one file and the guard must too.
  assert.equal(attachmentNameKey('résumé.txt'), attachmentNameKey('re\u0301sume\u0301.txt'))
  assert.equal(attachmentNameKey('e\u0301'.normalize('NFC')), attachmentNameKey('e\u0301'))

  // Every alias of the framework's capture is refused, whichever spelling.
  for (const alias of ['observation.txt', 'OBSERVATION.TXT', 'Observation.Txt', 'obſervation.txt', 'obſervation.TXT']) {
    assert.match(agentAttachmentNameViolation(alias), /reserved/, `${JSON.stringify(alias)} is the same inode as observation.txt on APFS`)
  }
  // An NFD spelling of a user name stays admitted: the reserved name is ASCII, so
  // normalization must not turn an unrelated decomposed name into a refusal.
  assert.equal(agentAttachmentNameViolation('re\u0301sume\u0301.txt'), undefined)
  assert.equal(agentAttachmentNameViolation('résumé.txt'), undefined)
  // Nor does an embedded KELVIN sign make a new alias of a name that is not the
  // framework's: folding is applied to compare, not to reject everything exotic.
  assert.equal(agentAttachmentNameViolation('observa\u212Aion.txt'), undefined)

  // The same fold closes the mirror-image gap on the WRITE side only (#255
  // review 2): LONG S aliases the legacy in-node access log, so an agent may not
  // create it — but the read path keeps its narrow comparison, because on a
  // case-sensitive filesystem that name is a legitimate, separate file.
  assert.match(agentAttachmentNameViolation('acceſſed.log'), /reserved by the framework/)
  assert.match(agentAttachmentNameViolation('NODE.MD'), /reserved by the framework/)
  assert.doesNotThrow(() => assertAttachmentName('acceſſed.log'), 'a read of that legacy name must not be refused')
  assert.throws(() => assertAttachmentName('NODE.MD'), /reserved by the framework/)
})

test('a legacy name that folds onto a reserved one stays readable and listable (#255 review 2)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-legacy-alias-'))
  const id = await createNode(fresh, { description: 'holds a legacy alias' })
  // A file an earlier version accepted: on a case-insensitive filesystem it is a
  // plain attachment, on Linux it is its own file. Either way it is readable.
  const name = 'acceſſed.log'
  await fsp.writeFile(path.join(fresh, id, name), 'legacy alias content\n')
  assert.deepEqual(await extraFiles(fresh, id), [name], 'it is listed as an attachment')
  assert.equal((await readAttachment(fresh, id, name)).content, 'legacy alias content\n')
  assert.equal((await readAttachmentWithHash(fresh, id, name)).content, 'legacy alias content\n')
  // …while an agent may not create one, and the framework's own reserved name is
  // refused on both sides.
  assert.match(agentAttachmentNameViolation(name), /reserved by the framework/)
  assert.throws(() => assertAttachmentName('node.md'), /reserved by the framework/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('an existing attachment at the filesystem name limit is still overwritable, snapshot and all (#255)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-long-name-'))
  const id = await createNode(fresh, { description: 'holds a long-named file' })
  // Exactly 255 bytes — the filesystem's own NAME_MAX, and only reachable out
  // of band or from a pre-#255 graph, because agent writes are capped at 200.
  // Before #255 `.prev` (261 bytes) and staging (`.<name>.tmp-…`) both failed with
  // ENAMETOOLONG, so the one file that most needs a snapshot could not have one.
  const name = `${'l'.repeat(251)}.txt`
  assert.equal(Buffer.byteLength(name, 'utf8'), 255)
  const original = 'the original bytes\n'
  await attach(fresh, id, name, original)
  assert.equal(await fsp.readFile(path.join(fresh, id, name), 'utf8'), original)

  const prev = prevAttachmentFile(name)
  assert.ok(Buffer.byteLength(prev, 'utf8') <= 200, `the snapshot name is bounded: ${Buffer.byteLength(prev, 'utf8')} bytes`)
  assert.notEqual(prev, `.${name}.prev`, 'the unbounded derivation would be 261 bytes')
  // The bounded form lives in the two-dot namespace, which no plain derivation
  // (`.<name>…`) can produce — see the disjointness test below.
  assert.ok(prev.startsWith('..attach-prev-'), prev)
  // Distinct long names sharing a prefix never share one snapshot.
  const other = `${'l'.repeat(251)}.mdx`
  assert.notEqual(prevAttachmentFile(other), prev)
  // A short name keeps the readable form every operator and test expects.
  assert.equal(prevAttachmentFile('report.md'), '.report.md.prev')

  const replaced = await attach(fresh, id, name, 'the replacement\n')
  assert.equal(replaced.status, 'overwritten')
  assert.equal(await fsp.readFile(path.join(fresh, id, name), 'utf8'), 'the replacement\n')
  assert.equal(await fsp.readFile(path.join(fresh, id, prev), 'utf8'), original, 'the prior bytes are recoverable')
  // No staging debris either: the temp name is bounded by the same rule.
  assert.deepEqual((await fsp.readdir(path.join(fresh, id))).filter((entry) => entry.includes('.tmp-')), [])
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a bounded snapshot name can never collide with a plain one (#255 review 1)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-prev-disjoint-'))
  const id = await createNode(fresh, { description: 'holds two long-named files' })
  // The review's exact construction. `a` is 196 bytes, so it needs a bounded
  // snapshot name; the PRE-FIX derivation was `.` + head + `~` + hash + `.prev`,
  // and stripping the dot and `.prev` off it yields `b`, a legal 194-byte name
  // whose PLAIN `.<b>.prev` was byte-identical to that hashed path. Overwriting
  // a and then b therefore replaced a's recovery copy with b's prior bytes.
  const a = 'l'.repeat(196)
  const legacyHashed = `.${'l'.repeat(177)}~${createHash('sha256').update(a, 'utf8').digest('hex').slice(0, 16)}.prev`
  const b = legacyHashed.slice(1, -5)
  assert.equal(Buffer.byteLength(a, 'utf8'), 196)
  assert.equal(Buffer.byteLength(b, 'utf8'), 194)
  // That legacy path really is b's plain derivation — the collision, stated.
  assert.equal(`.${b}.prev`, legacyHashed)
  assert.equal(prevAttachmentFile(b), legacyHashed, 'b takes the plain form')
  // Both are names an agent may legally write, so the collision was reachable…
  assert.equal(agentAttachmentNameViolation(a), undefined)
  assert.equal(agentAttachmentNameViolation(b), undefined)
  // …and the bounded form no longer meets it: it lives in the two-dot namespace,
  // and the name a plain derivation would need to reach it starts with a dot,
  // which assertAttachmentName forbids.
  assert.notEqual(prevAttachmentFile(a), legacyHashed)
  assert.ok(prevAttachmentFile(a).startsWith('..attach-prev-'), prevAttachmentFile(a))
  assert.throws(() => assertAttachmentName(prevAttachmentFile(a).slice(1, -5)), /start with a dot/)

  await attach(fresh, id, a, 'A original\n')
  await attach(fresh, id, b, 'B original\n')
  await attach(fresh, id, a, 'A second\n')
  await attach(fresh, id, b, 'B second\n')
  // Each recovery copy holds ITS OWN prior bytes; under the collision the second
  // pair of writes would have left one of these holding the other file's prior.
  assert.equal(await fsp.readFile(path.join(fresh, id, prevAttachmentFile(a)), 'utf8'), 'A original\n')
  assert.equal(await fsp.readFile(path.join(fresh, id, prevAttachmentFile(b)), 'utf8'), 'B original\n')
  assert.equal(await fsp.readFile(path.join(fresh, id, a), 'utf8'), 'A second\n')
  assert.equal(await fsp.readFile(path.join(fresh, id, b), 'utf8'), 'B second\n')

  // The bounded STAGING name is disjoint for the same reason. Capture the
  // pre-rename source of a long-named write.
  const staged = []
  const realRename = fsp.rename
  fsp.rename = async (from, to) => {
    staged.push(path.basename(from))
    return realRename.call(fsp, from, to)
  }
  try {
    await attach(fresh, id, a, 'A third\n')
  } finally {
    fsp.rename = realRename
  }
  const targetStage = staged.find((entry) => entry.startsWith('..attach-tmp-'))
  assert.ok(targetStage, `a long name stages in the two-dot namespace; got ${staged.join(', ')}`)
  // No staged name takes the single-dot `.` + name form of a plain derivation.
  assert.throws(() => assertAttachmentName(targetStage.slice(1)), /start with a dot/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('writeAtomic stages inside its cleanup scope, so a refused write leaves no temp behind (#255)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-atomic-debris-'))
  const id = await createNode(fresh, { description: 'atomic write target', body: 'body before\n' })
  const before = (await loadNode(fresh, id)).body
  const realWriteFile = fsp.writeFile
  // The staging write itself fails — the case that used to sit OUTSIDE the
  // cleanup try (ENOSPC / ENAMETOOLONG), leaving a partial `.node.md.tmp-…`.
  fsp.writeFile = async (file, ...rest) => {
    if (typeof file === 'string' && path.basename(file).startsWith('.node.md.tmp-')) {
      await realWriteFile.call(fsp, file, 'partial', 'utf8')
      const error = new Error('simulated ENOSPC while staging')
      error.code = 'ENOSPC'
      throw error
    }
    return realWriteFile.call(fsp, file, ...rest)
  }
  try {
    await assert.rejects(() => updateNode(fresh, id, { body: 'body after\n' }), /simulated ENOSPC/)
  } finally {
    fsp.writeFile = realWriteFile
  }
  assert.deepEqual((await fsp.readdir(path.join(fresh, id))).filter((entry) => entry.includes('.tmp-')), [], 'the partial staging file was cleaned up')
  assert.equal((await loadNode(fresh, id)).body, before, 'the refused write changed nothing')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('inspectFileBytes reports a file that shrank mid-read as shortRead, and the hash read withholds authorization (#255)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-short-read-'))
  const id = await createNode(fresh, { description: 'holds a file that shrinks' })
  const name = 'report.md'
  const file = path.join(fresh, id, name)
  await attach(fresh, id, name, 'a full report with several lines\n')

  const realOpen = fsp.open
  // Realistic shape: another writer truncates the file between the guard's
  // fstat and its read. The handle is the real one; only `read` truncates first.
  fsp.open = async (target, ...rest) => {
    const handle = await realOpen.call(fsp, target, ...rest)
    if (target !== file) return handle
    return {
      stat: (...args) => handle.stat(...args),
      close: (...args) => handle.close(...args),
      read: async (...args) => {
        await fsp.truncate(file, 5)
        return handle.read(...args)
      },
    }
  }
  try {
    const evidence = await inspectFileBytes(file)
    assert.equal(evidence.state, 'shortRead', 'an explicit state, never ok with a rewritten size')
    assert.equal(evidence.size, 5, 'what was actually read')
    assert.equal(evidence.expected, Buffer.byteLength('a full report with several lines\n'), 'what the fstat promised')
    assert.equal(evidence.bytes, undefined, 'no partial byte view is handed back as the file')

    // The read path serves the window from a fresh read and withholds the
    // hash: an authorization that could never be honoured must never be
    // recorded as if it were. Grow the file back first, so the truncation
    // happens inside THIS read rather than before it.
    await fsp.writeFile(file, 'a full report with several lines\n')
    const page = await readAttachmentWithHash(fresh, id, name)
    assert.equal(page.sha, undefined, 'sha is withheld')
    assert.equal(page.content, 'a ful', 'the window describes the bytes that actually exist now')

    // And the snapshot layer refuses rather than replacing a file it could not
    // copy aside. Grow the file back first, so the truncation happens INSIDE the
    // snapshot's read rather than before it.
    await fsp.writeFile(file, 'a full report again, longer\n')
    await assert.rejects(() => attach(fresh, id, name, 'replacement\n'), /shrank while its prior content was being read/)
    // The refusal lands before the replacement: the harness's own truncation is
    // what shortened the file, never this writer's payload.
    assert.notEqual(await fsp.readFile(file, 'utf8'), 'replacement\n', 'the refused overwrite wrote nothing')
  } finally {
    fsp.open = realOpen
  }
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('attachFromPath snapshots the prior bytes too, and honours snapshot: false (#247)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-attach-prev-path-'))
  const source = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-attach-prev-source-'))
  const id = await createNode(fresh, { description: 'holds a copied report' })
  await attach(fresh, id, 'notes.md', 'typed first\n')
  await fsp.writeFile(path.join(source, 'notes.md'), 'copied second\n')
  const opts = { allowedRoots: [source] }
  await attachFromPath(fresh, id, path.join(source, 'notes.md'), 'notes.md', opts)
  assert.equal(await fsp.readFile(path.join(fresh, id, '.notes.md.prev'), 'utf8'), 'typed first\n')
  // The session-anchored switch applies here as well.
  await fsp.writeFile(path.join(source, 'notes.md'), 'copied third\n')
  await attachFromPath(fresh, id, path.join(source, 'notes.md'), 'notes.md', { ...opts, snapshot: false })
  assert.equal(await fsp.readFile(path.join(fresh, id, '.notes.md.prev'), 'utf8'), 'typed first\n')
  assert.equal(await fsp.readFile(path.join(fresh, id, 'notes.md'), 'utf8'), 'copied third\n')
  await fsp.rm(fresh, { recursive: true, force: true })
  await fsp.rm(source, { recursive: true, force: true })
})

test('readAttachment returns a file back, pages an oversized one, and refuses what it cannot read (F22, #42)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-readfile-'))
  const id = await createNode(fresh, { description: 'holds a transcript' })
  await attach(fresh, id, 'transcript.md', 'who wanted 10000-row pages: Priya did\nthe counter-argument was cursor expiry\n')
  const whole = await readAttachment(fresh, id, 'transcript.md')
  assert.match(whole.content, /Priya did/)
  assert.equal(whole.offset, 0)
  assert.equal(whole.bytes, whole.size)
  assert.ok(!('next_offset' in whole), 'a file read in full reports no continuation')

  // A window smaller than the file pages: next_offset is exactly where to resume.
  const head = await readAttachment(fresh, id, 'transcript.md', { maxBytes: 10 })
  assert.equal(head.content, 'who wanted')
  assert.equal(head.next_offset, 10)
  const tail = await readAttachment(fresh, id, 'transcript.md', { offset: head.next_offset })
  assert.match(tail.content, /^ 10000-row/)
  assert.ok(!('next_offset' in tail))
  // Reassembling the pages reproduces the file byte for byte.
  assert.equal(head.content + tail.content, await fsp.readFile(path.join(fresh, id, 'transcript.md'), 'utf8'))
  // An offset past the end is empty, not an error — the caller has read it all.
  assert.equal((await readAttachment(fresh, id, 'transcript.md', { offset: 9999 })).bytes, 0)

  await assert.rejects(() => readAttachment(fresh, id, 'missing.md'), /no such file on node/)
  await assert.rejects(() => readAttachment(fresh, id, 'node.md'), /reserved/)
  await assert.rejects(() => readAttachment(fresh, id, '../escape'), /path separators/)
  await assert.rejects(() => readAttachment(fresh, id, 'transcript.md', { offset: -1 }), /offset must be a non-negative integer/)
  // Not a regular file: a symlink may point anywhere, so O_NOFOLLOW refuses to
  // open it at all — the read never reaches whatever it targets.
  await fsp.symlink('/etc/hosts', path.join(fresh, id, 'link.md'))
  await assert.rejects(() => readAttachment(fresh, id, 'link.md'), /not a regular file/)
  // An empty attachment reads as empty, not as an error or a continuation.
  await attach(fresh, id, 'blank.md', '')
  const blank = await readAttachment(fresh, id, 'blank.md')
  assert.deepEqual({ ...blank }, { file: 'blank.md', size: 0, offset: 0, bytes: 0, content: '' })
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('readAttachment ends a page on a character boundary so pages rejoin exactly (F22, #42)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-utf8-'))
  const id = await createNode(fresh, { description: 'multibyte transcript' })
  // Each of these is 3 bytes in UTF-8, so every window size that is not a
  // multiple of 3 lands mid-character.
  const text = '决定用中文写会议纪要'
  await attach(fresh, id, 'notes.md', text)

  for (const maxBytes of [4, 5, 7, 8]) {
    const pages = []
    let offset = 0
    for (;;) {
      const page = await readAttachment(fresh, id, 'notes.md', { offset, maxBytes })
      // No page ever carries a replacement character from a split sequence.
      assert.ok(!page.content.includes('\uFFFD'), `window ${maxBytes} split a character at offset ${offset}`)
      pages.push(page.content)
      if (page.next_offset === undefined) break
      assert.ok(page.next_offset > offset, 'a page must advance or a paging caller loops forever')
      offset = page.next_offset
    }
    assert.equal(pages.join(''), text, `window ${maxBytes} did not rejoin exactly`)
  }

  // A window too small to hold one character must still make progress, even
  // though it cannot avoid splitting: stalling is worse than one U+FFFD.
  const tiny = await readAttachment(fresh, id, 'notes.md', { maxBytes: 2 })
  assert.equal(tiny.next_offset, 2)

  // At EOF nothing is deferred: a file that genuinely ends mid-sequence is
  // returned as it is, not held back forever.
  await fsp.writeFile(path.join(fresh, id, 'truncated.md'), Buffer.from([0xe4, 0xbd]))
  const broken = await readAttachment(fresh, id, 'truncated.md')
  assert.equal(broken.bytes, 2)
  assert.ok(!('next_offset' in broken))
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('attach enforces the size cap on content', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-cap-'))
  const id = await createNode(fresh, { description: 'cap test' })
  // A tiny cap makes the boundary cheap to probe; the real default is ATTACH_MAX_BYTES.
  await assert.rejects(() => attach(fresh, id, 'big.txt', 'x'.repeat(11), { maxBytes: 10 }), /content too large/)
  const ok = await attach(fresh, id, 'ok.txt', 'x'.repeat(10), { maxBytes: 10 })
  assert.equal(ok.bytes, 10)
  assert.ok(ATTACH_MAX_BYTES > 50000, 'the default cap is above the 50k render window so attachments can hold more than a body')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('attachments summarizes a text first line but falls back to name+size for binary and oversized lines', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-summary-'))
  const id = await createNode(fresh, { description: 'summaries' })
  await fsp.writeFile(path.join(fresh, id, 'text.md'), '# Heading line\nrest of the body\n')
  // A leading NUL byte marks this as non-text — no summary, just name + size.
  await fsp.writeFile(path.join(fresh, id, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x41, 0x42]))
  // A first line longer than the 200-byte read window is oversized — no summary.
  await fsp.writeFile(path.join(fresh, id, 'wide.txt'), 'z'.repeat(500))
  const meta = await attachments(fresh, id)
  const byName = Object.fromEntries(meta.map((f) => [f.name, f]))
  assert.equal(byName['text.md'].summary, '# Heading line')
  assert.equal(byName['text.md'].size, Buffer.byteLength('# Heading line\nrest of the body\n'))
  assert.equal(byName['blob.bin'].summary, undefined)
  assert.equal(byName['blob.bin'].size, 5)
  assert.equal(byName['wide.txt'].summary, undefined)
  assert.equal(byName['wide.txt'].size, 500)
  // Non-regular entries are never opened: a FIFO would block the read forever
  // and a symlink may point out of the node dir. Metadata only.
  await fsp.symlink('text.md', path.join(fresh, id, 'alias.md'))
  const withLink = Object.fromEntries((await attachments(fresh, id)).map((f) => [f.name, f]))
  assert.equal(withLink['alias.md'].summary, undefined, 'a symlink gets no first-line summary')
  assert.equal(typeof withLink['alias.md'].size, 'number')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('search reports which terms each row matched and which matched nothing (F36, #56)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-matched-'))
  const store = await createNode(fresh, { description: 'clickhouse transcript store', body: 'columnar, fast for dashboards' })
  const db = await createNode(fresh, { description: 'postgres primary database', body: 'relational joins' })

  const hits = await search(fresh, 'clickhouse postgres resumability', 20)
  const byId = Object.fromEntries(hits.matches.map((m) => [m.id, m]))
  assert.deepEqual(byId[store].matched, ['clickhouse'])
  assert.deepEqual(byId[db].matched, ['postgres'])
  // The term no node in the graph carried — the one word to reword.
  assert.deepEqual(hits.unmatched, ['resumability'])

  // A row matching several terms lists them in query order, deduped.
  const both = await search(fresh, 'postgres relational postgres', 20)
  assert.deepEqual(both.matches[0].matched, ['postgres', 'relational'])
  assert.ok(!('unmatched' in both), 'a query where every term hit reports no unmatched list')

  // A total miss still names every term, so the retry is not blind.
  const miss = await search(fresh, 'kafka resumability', 20)
  assert.equal(miss.total, 0)
  assert.deepEqual(miss.unmatched, ['kafka', 'resumability'])

  // A repeated term is one term on the row, but `full` still counts every
  // query token — so a query repeating a term it matched is still a full match.
  const repeated = await search(fresh, 'postgres postgres', 20)
  assert.equal(repeated.tokens, 2)
  assert.equal(repeated.full, 1)
  assert.deepEqual(repeated.matches[0].matched, ['postgres'])
  // A term that is a substring of another matches on its own — search() is
  // substring-based, and `matched` reports exactly what scored.
  const substring = await search(fresh, 'post postgres', 20)
  assert.deepEqual(substring.matches[0].matched, ['post', 'postgres'])

  // A whole-graph listing has no terms to report on either surface.
  const all = await search(fresh, '', 20)
  assert.ok(!('unmatched' in all))
  assert.ok(all.matches.every((m) => !('matched' in m)))

  // A term is "unmatched" only if NO node carried it, not merely none returned.
  const narrow = await search(fresh, 'clickhouse postgres', 1)
  assert.equal(narrow.matches.length, 1)
  assert.ok(!('unmatched' in narrow), 'a term matched by a node past the limit is not unmatched')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('an exact scoring tie goes to the newest node, not the oldest (F83 follow-up, #198)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-tietiebreak-'))
  // Identical text, so every scoring signal ties: same token score, same
  // `full`, neither superseded, and no access log means `uses` is 0 on both.
  // Only the id clause is left to decide — and a ULID's leading 10 chars are
  // its creation time, so 1000 ms apart makes the order deterministic without
  // leaning on the random suffix.
  const day = Date.parse('2026-04-01T09:00:00Z')
  const older = await createNode(fresh, { description: 'quorum handoff plan', now: day })
  const newer = await createNode(fresh, { description: 'quorum handoff plan', now: day + 1000 })
  assert.ok(newer > older, 'the later `now` must produce the higher id for this test to mean anything')

  // The pathology this fixes: on a tie the oldest node took the last slot and
  // the newest fell off the result set entirely.
  const one = await search(fresh, 'quorum', 1)
  assert.equal(one.total, 2, 'both nodes tie on score')
  assert.equal(one.matches.length, 1)
  assert.equal(one.matches[0].id, newer, 'the newer of two tied nodes wins the single slot')

  const two = await search(fresh, 'quorum', 2)
  assert.deepEqual(two.matches.map((m) => m.id), [newer, older], 'tied rows come back newest first')
  assert.equal(two.matches[0].score, two.matches[1].score, 'the two rows really are tied on score')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('CJK query terms are reported like any other (F36, #56)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-matchedcjk-'))
  await createNode(fresh, { description: '数据库迁移计划', body: '分三期完成' })
  // tokenize() keeps a CJK run as one token, so a prefix matches by substring
  // while an unrelated run matches nothing — and the row says which was which.
  const hits = await search(fresh, '数据库 资料库', 20)
  assert.equal(hits.total, 1)
  assert.deepEqual(hits.matches[0].matched, ['数据库'])
  assert.deepEqual(hits.unmatched, ['资料库'])
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a term matched only inside an attachment counts as matched (F36, #56 + F29, #49)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-matchedfile-'))
  const id = await createNode(fresh, { description: 'pagination design', body: 'cursor pagination' })
  await attach(fresh, id, 'full-discussion.md', 'Priya argued for 10000-row pages\n')
  const hits = await search(fresh, 'pagination priya', 20)
  assert.deepEqual(hits.matches[0].matched, ['pagination', 'priya'])
  assert.deepEqual(hits.matches[0].matched_in, ['full-discussion.md'])
  assert.ok(!('unmatched' in hits))
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a superseded node is marked and deranked in search and in the index (F24, #44)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-superseded-'))
  const old = await createNode(fresh, { description: 'pagination design: projection and cursor expiry remain open', body: 'offset pagination for now' })
  const current = await createNode(fresh, { description: 'pagination design settled on cursor pagination', body: 'cursor pagination, expiry 15m' })
  await supersede(fresh, old, current)

  const hits = await search(fresh, 'pagination design', 20)
  assert.equal(hits.matches[0].id, current, 'the current decision outranks the one it replaced')
  assert.equal(hits.matches[1].id, old)
  assert.equal(hits.matches[1].superseded_by, current)
  assert.ok(!('superseded_by' in hits.matches[0]), 'a node nothing replaced carries no marker')
  // Both match every term; the penalty is what separates them.
  assert.equal(hits.full, 2)
  assert.ok(hits.matches[1].score < hits.matches[0].score)

  // The injected index marks it too — that is the surface it competes on in
  // every future prompt.
  const lines = await indexLines(fresh, 10)
  assert.equal(lines[0], `${current} — pagination design settled on cursor pagination`)
  assert.equal(lines[1], `${old} — pagination design: projection and cursor expiry remain open [superseded by ${current}]`)
  assert.deepEqual(indexLinesSync(fresh, 10), lines, 'the sync index agrees with the async one')

  // Reading the superseded node stays possible — keeping it readable is the
  // point of superseding rather than overwriting.
  assert.equal((await readNode(fresh, old)).description, 'pagination design: projection and cursor expiry remain open')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('superseded loses a tie the score cannot settle, in search and in the index (F24, #44)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-supersededtie-'))
  // Distinct `now`s a second apart, so the ULIDs order by creation instead of
  // by their random suffix (same-ms creates would decide this coin-flip style).
  // `old` is the node with recorded use, and `uses` outranks the id tie-break —
  // so the ordering would put it on top. Only the superseded tier can keep the
  // successor above it.
  const base = Date.parse('2026-09-03T00:00:00Z')
  const old = await createNode(fresh, { description: 'deploy target', body: 'ships to staging', now: base })
  const current = await createNode(fresh, { description: 'deploy target', body: 'ships to prod', now: base + 1000 })
  await supersede(fresh, old, current)
  for (let i = 0; i < 3; i++) await touchRead(fresh, old)

  // An empty query scores every node 0, so `uses` decides next — and the
  // superseded node has the higher count. It must still rank second.
  const all = await search(fresh, '', 20)
  assert.equal(all.matches[0].score, 0)
  assert.equal(all.matches[0].id, current, 'a superseded node outranks nothing, however used it is')
  assert.equal(all.matches[1].id, old)
  assert.ok(all.matches[1].uses > all.matches[0].uses, 'and it lost the tie despite more recorded use')

  // In the index, read a graph old enough that recency has decayed to zero for
  // both — the blended score is then 0 and 0.5 * 0 changes nothing.
  const aged = Date.now() + 400 * 86_400_000
  const lines = indexLines(fresh, 10, { traversal: 0, read: 0, recency: 1, recencyWindowDays: 180 }, aged)
  const ranked = (await lines).map((line) => line.slice(0, 26))
  assert.deepEqual(ranked, [current, old], 'the successor leads even when both score zero')
  await fsp.rm(fresh, { recursive: true, force: true })

  // The index breaks ties NEWEST first (F83, #193), so the case above would
  // hold on id alone. Supersede the LATER node with the earlier one to put the
  // two rules in opposition: only the superseded tier can keep the older,
  // lower-id successor on top.
  const other = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-supersededtie2-'))
  const successor = await createNode(other, { description: 'rollout target', body: 'ships to prod', now: base })
  const replaced = await createNode(other, { description: 'rollout target', body: 'ships to staging', now: base + 1000 })
  await supersede(other, replaced, successor)
  const rankedByAge = (await indexLines(other, 10, { traversal: 0, read: 0, recency: 1, recencyWindowDays: 180 }, aged)).map((line) => line.slice(0, 26))
  assert.deepEqual(rankedByAge, [successor, replaced], 'the successor leads even when it is the older id')
  await fsp.rm(other, { recursive: true, force: true })
})

test('supersededBy reads the newest banner, ignores lookalikes, and stops scanning early (F24, #44)', () => {
  const a = '01J00000000000000000000001'
  const b = '01J00000000000000000000002'
  assert.equal(supersededBy(''), undefined)
  assert.equal(supersededBy('a plain body'), undefined)
  assert.equal(supersededBy(`Superseded by ${a} on 2026-08-21.\n\nthe old rationale`), a)
  // Superseded twice: the newest banner sits on top and wins.
  assert.equal(supersededBy(`Superseded by ${b} on 2026-08-22.\n\nSuperseded by ${a} on 2026-08-21.\n\nbody`), b)
  // A merge banner above it does not hide the supersede banner.
  assert.equal(supersededBy(`Merged into ${b} on 2026-08-22.\n\nSuperseded by ${a} on 2026-08-21.\n\nbody`), a)
  // Prose that merely mentions the word is not a banner.
  assert.equal(supersededBy(`this superseded by something vague\nSuperseded by not-an-id on 2026-08-21.`), undefined)
  // Past the scan window, a banner is not found — banners are prepended, so a
  // body that buries one deep did not come from supersede().
  assert.equal(supersededBy(`${'filler\n'.repeat(20)}Superseded by ${a} on 2026-08-21.`), undefined)
})

test('search reads attachment text at a lower weight and names the file it matched (F29, #49)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-attachsearch-'))
  const buried = await createNode(fresh, { description: 'pagination design', body: 'settled on cursor pagination' })
  await attach(fresh, buried, 'full-discussion.md', 'Priya argued for 10000-row pages; the counter was cursor expiry.\n')
  const elsewhere = await createNode(fresh, { description: 'unrelated gardening notes', body: 'tomatoes' })

  // The word exists ONLY in the attachment — before this, the node was invisible.
  const hits = await search(fresh, 'expiry', 20)
  assert.equal(hits.total, 1)
  assert.equal(hits.matches[0].id, buried)
  assert.deepEqual(hits.matches[0].matched_in, ['full-discussion.md'])
  assert.equal(hits.matches[0].score, 0.5, 'an attachment hit is worth less than a body hit (1) or a description hit (3)')
  // The whole point of the finding: the buried answer is reachable at all.
  assert.equal((await search(fresh, '10000-row', 20)).matches[0].id, buried)

  // A description hit still outranks an attachment hit for the same token.
  const named = await createNode(fresh, { description: 'priya onboarding' })
  const both = await search(fresh, 'priya', 20)
  assert.equal(both.matches[0].id, named, 'the node whose description is about the term ranks first')
  assert.equal(both.matches[1].id, buried)
  assert.deepEqual(both.matches[1].matched_in, ['full-discussion.md'])
  // A row that matched only in description/body carries no matched_in field.
  assert.ok(!('matched_in' in both.matches[0]))

  // An empty query lists the whole graph and reads no attachments at all.
  const all = await search(fresh, '', 20)
  assert.equal(all.total, 3)
  assert.ok(all.matches.every((m) => !('matched_in' in m)))
  assert.ok(!(await search(fresh, 'tomatoes', 20)).matches.some((m) => m.id === buried))
  assert.equal(elsewhere.length, 26)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the attachment scan skips binary, symlinked, and dot files and caps how much it reads (F29, #49)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-attachscan-'))
  const id = await createNode(fresh, { description: 'scan bounds' })
  // Binary: a NUL byte means no words to match, whatever bytes follow.
  await fsp.writeFile(path.join(fresh, id, 'blob.bin'), Buffer.concat([Buffer.from([0x00]), Buffer.from('needle')]))
  // A symlink is never followed — the same refusal readAttachment makes.
  await fsp.writeFile(path.join(fresh, 'outside.txt'), 'needle')
  await fsp.symlink(path.join(fresh, 'outside.txt'), path.join(fresh, id, 'link.txt'))
  // A dotfile is agent-invisible space (staging temp files live there).
  await fsp.writeFile(path.join(fresh, id, '.hidden'), 'needle')
  assert.equal((await search(fresh, 'needle', 20)).total, 0)

  // Binary WITHOUT a NUL byte is still binary: it does not decode as text.
  await fsp.writeFile(path.join(fresh, id, 'nonul.bin'), Buffer.from([0xff, 0xfe, 0xff, 0xfe]))
  assert.equal((await search(fresh, 'needle', 20)).total, 0)

  // Over the per-file cap the budget is spent as head + tail (F42, #69): the
  // decision a transcript records at the END is indexed, the middle is not.
  const filler = 'a'.repeat(ATTACH_SEARCH_BYTES)
  await fsp.writeFile(path.join(fresh, id, 'long.md'), `${filler}\nmiddleword\n${filler}\ntailword\n`)
  assert.equal((await search(fresh, 'middleword', 20)).total, 0)
  assert.equal((await search(fresh, 'tailword', 20)).total, 1)
  assert.equal((await search(fresh, 'needle', 20)).total, 0)
  // A multi-byte character split by the tail window's START is dropped, not
  // read as binary — the whole file would otherwise become unsearchable. Sized
  // so the seam lands ON a continuation byte: one ASCII byte then 40000 x 2-byte
  // characters puts the tail's first byte at an even offset inside that run,
  // which is a continuation byte. Drop utf8SafeStart and this must fail.
  const split = Buffer.concat([Buffer.from('x'), Buffer.from('é'.repeat(40000)), Buffer.from('\nsplitword\n')])
  const seam = split.length - (ATTACH_SEARCH_BYTES - (ATTACH_SEARCH_BYTES >> 1))
  assert.equal(split[seam] & 0xc0, 0x80, 'fixture must split a character at the tail window start')
  await fsp.writeFile(path.join(fresh, id, 'multibyte.md'), split)
  assert.equal((await search(fresh, 'splitword', 20)).total, 1)
  await fsp.writeFile(path.join(fresh, id, 'short.md'), 'needle in the first bytes')
  assert.equal((await search(fresh, 'needle', 20)).total, 1)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the head and tail windows join on a newline, and a file at the cap is not split (F42, #69)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-attachseam-'))
  const id = await createNode(fresh, { description: 'a node of edge-case files' })
  // Its own graph: these files sit near the per-node byte budget, and sharing a
  // node with the cap test would starve whatever the scan reached last.
  // The windows never fuse into a word that is in neither of them. Laid out so
  // the head window ENDS in `foo` and the tail window BEGINS with `bar`: the
  // head is the first half of the budget, the tail the second half taken from
  // the end, and the 100 bytes between them are the unread middle.
  //
  // Keyed to the node's whole scan budget, not to ATTACH_SEARCH_BYTES: a node
  // carrying ONE file gives that file the full budget as its window (F81,
  // #182), so the head/tail split only begins past that. This node holds one
  // file at a time throughout.
  const share = ATTACH_SCAN_TOTAL_BYTES
  const head = share >> 1
  await fsp.writeFile(path.join(fresh, id, 'seam.md'), `${'a'.repeat(head - 3)}foo${'m'.repeat(100)}bar${'z'.repeat(share - head - 3)}`)
  assert.equal((await search(fresh, 'foobar', 20)).total, 0)
  // Both windows were read, and the middle was not.
  assert.equal((await search(fresh, 'foo', 20)).total, 1)
  assert.equal((await search(fresh, 'bar', 20)).total, 1)
  assert.equal((await search(fresh, 'mmmm', 20)).total, 0)
  await fsp.rm(path.join(fresh, id, 'seam.md'))
  // A file exactly at the window is read whole, in one window: splitting it
  // would drive the seam through the middle and lose a word straddling it.
  const half = share >> 1
  await fsp.writeFile(path.join(fresh, id, 'atcap.md'), `${'c'.repeat(half - 6)}straddleword${'d'.repeat(half - 6)}`)
  assert.equal((await fsp.stat(path.join(fresh, id, 'atcap.md'))).size, share)
  assert.equal((await search(fresh, 'straddleword', 20)).total, 1)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F81 (#182): a fact in the middle of a lone large attachment is indexed, not lost between head and tail', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f81-middle-'))
  const id = await createNode(fresh, { description: 'Postmill nested comment reply', body: 'Replying to a nested comment shows a blue banner link.' })
  // The synthetic DEMO-V2 regression (qid b2c3d4e5). F79 auto-attaches the raw
  // accessibility tree — 100k+ chars — and the answer sits in the middle of it.
  // Before F81 the scan spent a fixed 64KB per file as a 32KB head plus a 32KB
  // tail, so anything between those windows was invisible: search reported the
  // node's own verbatim words as `unmatched` and told the answer turn to reword
  // the terms that were right.
  const filler = (tag) => `${tag} generic row placeholder content nav sidebar\n`.repeat(2000)
  const observation = `${filler('head')}link 'View all comments'\n${filler('tail')}`
  const bytes = Buffer.byteLength(observation)
  assert.ok(bytes > ATTACH_SEARCH_BYTES * 2, 'the fixture buries the fact past the pre-F81 head AND tail windows')
  assert.ok(bytes <= ATTACH_SCAN_TOTAL_BYTES, 'and inside the budget a node with one file now gives it')
  await attach(fresh, id, 'observation.txt', observation)

  const hit = await search(fresh, 'view all comments', 20)
  assert.equal(hit.unmatched, undefined, 'no term the node carries verbatim comes back as unmatched')
  assert.equal(hit.matches[0].id, id)
  assert.deepEqual(hit.matches[0].matched_in, ['observation.txt'], 'and the row says the match was in the file, not the body')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F81 (#182): a row quotes the passage it matched inside a file, with the byte offset to resume reading at', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f81-quote-'))
  const id = await createNode(fresh, { description: 'Forum account menu', body: 'The avatar opens the account menu, which contains Profile.' })
  // The synthetic DEMO-V2 regression (qid a1b2c3d4): the gold answer is an ENUMERATION
  // on adjacent lines, and the body gist kept one of the six. Naming the file
  // was not enough — 89 of 104 failed answers issued one search and answered
  // from the snippet, which is the gist that dropped the other five.
  const noise = "row 'noise noise noise placeholder toolbar'\n".repeat(2000)
  const menu = "link 'Profile'\nlink 'My account'\nlink 'User settings'\nlink 'Block list'\nlink 'Dark mode'\nlink 'Log out'\n"
  await attach(fresh, id, 'observation.txt', `${noise}${menu}${noise}`)

  const hit = await search(fresh, 'block list dark mode log out', 20)
  assert.equal(hit.matches[0].id, id)
  const [quote] = hit.matches[0].file_matches
  assert.equal(quote.file, 'observation.txt')
  // Every link the question asks for, on one row, from one search.
  for (const link of ["link 'Profile'", "link 'My account'", "link 'User settings'", "link 'Block list'", "link 'Dark mode'", "link 'Log out'"]) {
    assert.ok(quote.excerpt.includes(link), `the quote carries ${link}`)
  }
  // The offset is a FILE byte offset, not a position in the scanned window, so
  // memory_read_file resumes exactly where the quote was cut.
  const page = await readAttachment(fresh, id, 'observation.txt', { offset: quote.offset })
  const bare = quote.excerpt.replace(/^…/, '').replace(/…$/, '')
  assert.ok(page.content.replace(/\s+/g, ' ').trimStart().startsWith(bare), 'the reported offset lands on the first byte the quote came from')

  // A row that matched only in description or body quotes nothing — the field
  // is the attachment-hit signal, so its absence must stay meaningful.
  const body = await search(fresh, 'avatar', 20)
  assert.equal(body.matches[0].file_matches, undefined)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F81 (#182): the quote survives characters that lowercase to a different length, and astral pairs (codex review)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f81-unicode-'))
  // The scan matches against a folded copy of the text and quotes the ORIGINAL
  // at the same index, so the fold must not change the string's length. U+0130
  // lowercases to two code units: with a plain toLowerCase every index past it
  // names a different character, and the row quotes text the query never hit.
  const shifty = await createNode(fresh, { description: 'turkish page' })
  const text = `${'İ '.repeat(300)}NEEDLEALPHA ${'tail '.repeat(300)}`
  await fsp.writeFile(path.join(fresh, shifty, 'f.txt'), text)
  const hit = (await search(fresh, 'needlealpha', 20)).matches[0].file_matches[0]
  assert.ok(hit.excerpt.includes('NEEDLEALPHA'), 'the quote contains the term that matched')
  const page = await readAttachment(fresh, shifty, 'f.txt', { offset: hit.offset, maxBytes: 600 })
  assert.ok(page.content.includes('NEEDLEALPHA'), 'and the reported offset reaches it')

  // A surrogate pair must never be cut in half: the whitespace walk is bounded,
  // so on text with no whitespace it stops wherever the bound runs out. A lone
  // surrogate makes Buffer.byteLength count a replacement char, which would move
  // the offset into the middle of a UTF-8 sequence.
  const astral = await createNode(fresh, { description: 'emoji page' })
  await fsp.writeFile(path.join(fresh, astral, 'f.txt'), `${'\u{1F600}'.repeat(500)}NEEDLEBETA${'\u{1F600}'.repeat(500)}`)
  const pair = (await search(fresh, 'needlebeta', 20)).matches[0].file_matches[0]
  assert.doesNotMatch(pair.excerpt, /�/, 'no replacement character in the quote')
  const at = await readAttachment(fresh, astral, 'f.txt', { offset: pair.offset, maxBytes: 2000 })
  assert.ok(!at.content.startsWith('�'), 'the offset lands on a character boundary')
  assert.ok(at.content.includes('NEEDLEBETA'))
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F81 (#182): the quote is the passage answering the most query terms, not the first term\'s first hit (codex round 2)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f81-cover-'))
  const id = await createNode(fresh, { description: 'team meeting', body: 'notes' })
  // "decision" appears early, alone, in logistics filler — and again at the end
  // beside the three terms that actually answer the query. Quoting the first
  // term's first occurrence pinned the excerpt to the filler, so the row
  // reported four matched terms while showing text that answers none: a row
  // asserting more than its own evidence supports, which is the failure this
  // feature exists to remove one level up.
  await fsp.writeFile(path.join(fresh, id, 'meeting.txt'), [
    'Introductions and logistics. Everyone said hello.',
    'We noted the room booking decision was handled by facilities.',
    'More logistics filler about parking and coffee. '.repeat(40),
    'The real part: we compared the database options and chose postgres',
    'after the benchmark, and recorded that decision as final.',
  ].join('\n'))
  const hit = (await search(fresh, 'decision database postgres benchmark', 20)).matches[0]
  const quote = hit.file_matches[0].excerpt
  assert.ok(quote.includes('postgres'), 'the quote reaches the passage the query is about')
  assert.ok(quote.includes('database'), 'and carries the terms that co-occur there')
  assert.ok(!quote.includes('Everyone said hello'), 'not the unrelated early occurrence')

  // A single-term query has nothing to choose between and keeps its first hit,
  // so the pre-existing behaviour is unchanged where it was already right.
  const lone = (await search(fresh, 'facilities', 20)).matches[0]
  assert.ok(lone.file_matches[0].excerpt.includes('room booking decision'))
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F81 (#182): a matched token longer than the excerpt window does not return the whole token (codex round 2)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f81-bigtoken-'))
  const id = await createNode(fresh, { description: 'a pasted blob', body: 'notes' })
  // tokenize splits on non-alphanumerics, so a pasted URL, a base64 payload or
  // a long hex id is ONE token. A window sized to hold the match whole returned
  // that entire token as the "excerpt" — hundreds of KB per file, three files
  // per row, on every row of the result.
  const giant = 'a1b2c3'.repeat(20000)
  await fsp.writeFile(path.join(fresh, id, 'blob.txt'), `header text\n${giant}\nfooter text\n`)
  const quote = (await search(fresh, giant, 20)).matches[0].file_matches[0].excerpt
  assert.ok(quote.length < 1000, `the quote stays bounded, got ${quote.length} chars`)
  assert.ok(quote.includes(giant.slice(0, 50)), 'and still shows the head of what matched')
  assert.ok(quote.endsWith('…'), 'with the marker that sends the reader to memory_read_file')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F81 (#182): the file cap counts files indexed, so unreadable ones do not hide the text behind them (codex review)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f81-cap-'))
  const id = await createNode(fresh, { description: 'a node of decoys' })
  // Twenty tiny binary files ahead of the real one. F81 needs the file count
  // before it reads anything, to divide the budget by it — but the cap itself
  // must still count files successfully INDEXED, or these twenty would end the
  // scan with the whole byte budget untouched and the answer unindexed.
  for (let i = 0; i < 20; i++) await fsp.writeFile(path.join(fresh, id, `a${String(i).padStart(2, '0')}.bin`), Buffer.from([0x00, 0x01]))
  await fsp.writeFile(path.join(fresh, id, 'zz-real.txt'), 'the buriedmarker is here')
  assert.equal((await search(fresh, 'buriedmarker', 20)).total, 1)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F81 (#182): widening the window for a lone file takes nothing from a node that carries several', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f81-share-'))
  const id = await createNode(fresh, { description: 'four transcripts' })
  // Four files split the node budget four ways, which is exactly the pre-F81
  // per-file window — so a node that was fully indexed before still is, and the
  // per-node byte cost is unchanged. Only the redistribution is new.
  for (let i = 0; i < 4; i++) {
    await fsp.writeFile(path.join(fresh, id, `t${i}.md`), `${'z'.repeat(ATTACH_SEARCH_BYTES - 20)}\nsharemarker${i}\n`)
  }
  for (let i = 0; i < 4; i++) assert.equal((await search(fresh, `sharemarker${i}`, 20)).total, 1, `file ${i} is still indexed`)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the attachment scan spends a bounded budget per node, however many files it carries (F29, #49)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-attachbudget-'))
  const id = await createNode(fresh, { description: 'a hoarder node' })
  // Far past both caps: 40 files of 32KB is 1.25MB, and only the first 20
  // files / 256KB may be read. Numbered so the order is unambiguous.
  for (let i = 0; i < 40; i++) {
    await fsp.writeFile(path.join(fresh, id, `f${String(i).padStart(2, '0')}.md`), `${'z'.repeat(32 * 1024)}\nmarker${i}\n`)
  }
  // Whatever the scan reached, it stopped well before the last file.
  assert.equal((await search(fresh, 'marker39', 20)).total, 0)
  // And the caps never make a node unfindable by its own description.
  assert.equal((await search(fresh, 'hoarder', 20)).matches[0].id, id)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the per-node BYTE budget stops the scan on its own, before the file count does (F29, #49)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-attachbytes-'))
  const id = await createNode(fresh, { description: 'a node of five fat files' })
  // Five full-cap files is 320KB against a 256KB budget, and five is nowhere
  // near the 20-file cap: only the byte budget can exclude the fifth. The
  // marker lives there, so dropping the budget accounting fails this test.
  for (let i = 0; i < 5; i++) {
    await fsp.writeFile(path.join(fresh, id, `fat${i}.md`), `${'z'.repeat(ATTACH_SEARCH_BYTES - 16)}\nfatmarker${i}\n`)
  }
  assert.equal((await search(fresh, 'fatmarker4', 20)).total, 0)
  assert.equal((await search(fresh, 'fatmarker0', 20)).total, 1)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('an archived hit is searched in .archive/ and names its attachment (F29, #49)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-attacharchived-'))
  const id = await createNode(fresh, { description: 'retired thread' })
  await attach(fresh, id, 'transcript.md', 'the deprecated jenkins runner is what broke it\n')
  await fsp.mkdir(path.join(fresh, ARCHIVE_DIR), { recursive: true })
  await fsp.rename(path.join(fresh, id), path.join(fresh, ARCHIVE_DIR, id))

  assert.equal((await search(fresh, 'jenkins', 20)).total, 0, 'the archive is off by default')
  const found = await search(fresh, 'jenkins', 20, { includeArchived: true })
  assert.equal(found.matches[0].id, id)
  assert.equal(found.matches[0].archived, true)
  assert.deepEqual(found.matches[0].matched_in, ['transcript.md'])
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('includeAttachments: false scores description and body only (F29, #49)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-noattach-'))
  const id = await createNode(fresh, { description: 'pagination design', body: 'cursor pagination' })
  await attach(fresh, id, 'transcript.md', 'clickhouse came up and was rejected\n')
  assert.equal((await search(fresh, 'clickhouse', 20)).total, 1)
  assert.equal((await search(fresh, 'clickhouse', 20, { includeAttachments: false })).total, 0)
  // Turning the scan off never hides a node its own body matches.
  assert.equal((await search(fresh, 'cursor', 20, { includeAttachments: false })).matches[0].id, id)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('search advertises attachment names only for matched nodes that carry files', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-searchfiles-'))
  const withFiles = await createNode(fresh, { description: 'configdeck deploy notes', body: 'x' })
  const without = await createNode(fresh, { description: 'configdeck preview notes', body: 'y' })
  await attach(fresh, withFiles, 'transcript.md', 'a long thread\n')
  const hits = await search(fresh, 'configdeck', 10)
  const byId = Object.fromEntries(hits.matches.map((m) => [m.id, m]))
  assert.deepEqual(byId[withFiles].files, ['transcript.md'])
  assert.ok(!('files' in byId[without]), 'a node with no attachments carries no files field')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('search ranks description hits above body hits and honors the limit', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-search-'))
  const inTitle = await createNode(fresh, { description: 'ConfigDeck config preview', body: 'unrelated' })
  const inBody = await createNode(fresh, { description: 'unrelated title', body: 'always run configdeck preview first' })
  await createNode(fresh, { description: 'nothing to do with it', body: 'nope' })
  const hits = await search(fresh, 'configdeck', 10)
  assert.equal(hits.total, 2)
  assert.equal(hits.matches[0].id, inTitle)
  assert.equal(hits.matches[1].id, inBody)
  assert.ok(hits.matches[0].score > hits.matches[1].score)
  assert.equal((await search(fresh, 'configdeck', 1)).matches.length, 1)
  assert.equal((await search(fresh, 'configdeck', 1)).total, 2, 'total must count beyond the limit')
  assert.equal((await search(fresh, '', 10)).total, 3, 'an empty query lists everything')
  assert.equal((await search(fresh, 'nonexistentterm', 10)).total, 0)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the index ranks by recorded use and truncates with a pointer', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-index-'))
  const cold = await createNode(fresh, { description: 'rarely used' })
  const hot = await createNode(fresh, { description: 'often used' })
  await addEdge(fresh, cold, hot)
  await touchEdge(fresh, cold, hot)
  const lines = await indexLines(fresh, 10)
  assert.equal(lines[0], `${hot} — often used`)
  assert.equal(lines[1], `${cold} — rarely used`)
  const truncated = await indexLines(fresh, 1)
  assert.equal(truncated.length, 2)
  assert.match(truncated[1], /1 more nodes; call memory_search/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the blended index scorer separates traversals, reads, and recency and flips order when the softer signals dominate', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-rank-'))
  const now = Date.parse('2026-08-20T12:00:00Z')
  // Every node is born old so recency starts at 0 for all; C is bumped fresh later.
  const mk = (d) => createNode(fresh, { description: d, now: Date.parse('2020-01-01') })
  const src = await mk('traffic source')          // hosts the traversal lines
  const a = await mk('A: one traversal, old')
  const b = await mk('B: one traversal + one read, old')
  const c = await mk('C: one traversal, freshly updated')
  // One traversal landing on each of A, B, C — a line in SRC's log whose dst != src.
  await fsp.mkdir(path.join(fresh, ACCESS_DIR), { recursive: true })
  for (const dst of [a, b, c]) await fsp.appendFile(path.join(fresh, ACCESS_DIR, `${src}.log`), `${dst} 2020-01-02T00:00:00Z\n`)
  // One direct read of B — a self-line in B's OWN log (F10).
  await fsp.appendFile(path.join(fresh, ACCESS_DIR, `${b}.log`), `${b} 2020-01-03T00:00:00Z\n`)
  // Make C recent: an update stamps `updated` to `now`'s date, so latest≈today.
  await updateNode(fresh, c, { body: 'touched' }, now)

  // Default weights (traversal 3, read 2, recency 1) at a fixed `now`:
  //   A = 3·1              = 3
  //   B = 3·1 + 2·1        = 5
  //   C = 3·1 + 1·recency  ≈ 4   (recency≈1, node updated today)
  //   src = 0 (no line targets it)
  const order = (await indexLines(fresh, 10, undefined, now)).map((line) => line.slice(0, 26))
  assert.deepEqual(order, [b, c, a, src], 'reads lift B over A and recency lifts C over A, all at equal traversal')

  // Crank recency: the freshly-updated node jumps to the very top.
  const recencyHeavy = await indexLines(fresh, 10, { traversal: 3, read: 2, recency: 100, recencyWindowDays: 180 }, now)
  assert.equal(recencyHeavy[0].slice(0, 26), c, 'a dominant recency weight lifts the fresh node first')

  // Crank reads: the directly-read node jumps to the top instead.
  const readHeavy = await indexLines(fresh, 10, { traversal: 1, read: 100, recency: 0, recencyWindowDays: 180 }, now)
  assert.equal(readHeavy[0].slice(0, 26), b, 'a dominant read weight lifts the directly-read node first')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('listIds ignores non-node entries and a missing root', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-list-'))
  await createNode(fresh, { description: 'real node' })
  await fsp.mkdir(path.join(fresh, '.archive'))
  await fsp.writeFile(path.join(fresh, 'MAP.md'), 'x')
  assert.equal((await listIds(fresh)).length, 1)
  assert.deepEqual(await listIds(path.join(fresh, 'nope')), [])
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a root dotfile is invisible to every whole-graph scan (F57 convention, F64 journal)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-rootdot-'))
  const id = await createNode(fresh, { description: 'the only node here', type: 'handoff' })
  // The bookkeeping files the graph root accumulates: the F64 advisory journal
  // alongside its F46/F57 siblings. Every root scan filters on `isDirectory()`
  // + a ULID name, so a new dotfile joins them without touching the walkers —
  // this pins that, because a scan that grew a dot-entry would show the census
  // and the index a file where a node belongs.
  await fsp.writeFile(path.join(fresh, '.advisories'), `2026-08-25T00:00:00.000Z turn=s1 similar ${id} whatever\n`)
  await fsp.writeFile(path.join(fresh, '.zero-write-turns'), '2026-08-25T00:00:00.000Z pid=1 zero memory_write calls\n')
  await fsp.writeFile(path.join(fresh, '.duplicates'), `${id} ${id}\n`)
  assert.deepEqual(await listIds(fresh), [id])
  assert.deepEqual(indexLinesSync(fresh, 10).length, 1)
  assert.deepEqual((await indexLines(fresh, 10)).length, 1)
  assert.deepEqual(orphanCensus(fresh, 3), { total: 1, shown: [{ id, description: 'the only node here' }] })
  assert.deepEqual(openHandoffs(fresh), [{ id, description: 'the only node here' }])
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('descriptions are capped at write and truncated in the index', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-cap-'))
  await assert.rejects(createNode(fresh, { description: 'x'.repeat(501) }), /too long/)
  // external writers bypass the cap — the index must still bound the line
  const id = await createNode(fresh, { description: 'placeholder' })
  const raw = await fsp.readFile(path.join(fresh, id, 'node.md'), 'utf8')
  await fsp.writeFile(path.join(fresh, id, 'node.md'), raw.replace('placeholder', 'y'.repeat(2000)))
  const lines = await indexLines(fresh, 10)
  assert.ok(lines[0].length < 600, `index line stays bounded, got ${lines[0].length}`)
  assert.match(lines[0], /…$/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('archived nodes are invisible by default, joinable and flagged under the flag, and restorable', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-archive-'))
  const live = await createNode(fresh, { description: 'live configdeck note' })
  const gone = await createNode(fresh, { description: 'archived configdeck note', body: 'the pruned detail' })
  const neighbor = await createNode(fresh, { description: 'configdeck neighbor' })
  await addEdge(fresh, gone, neighbor) // an outgoing edge that must survive the roundtrip
  await touchRead(fresh, gone) // pre-archive history that must keep counting under the flag
  // Archive `gone` the way graph-maintain --apply does: mv into .archive/.
  await fsp.mkdir(path.join(fresh, ARCHIVE_DIR), { recursive: true })
  await fsp.rename(path.join(fresh, gone), path.join(fresh, ARCHIVE_DIR, gone))

  // Default: the archived node is absent, and no match carries the flag.
  const base = await search(fresh, 'configdeck', 10)
  assert.ok(!base.matches.some((m) => m.id === gone), 'archived node absent from a default search')
  assert.ok(base.matches.every((m) => m.archived === undefined), 'no live match is flagged archived')
  assert.equal(await loadNode(fresh, gone), undefined, 'the archived node is gone from the live root')

  // include_archived: the node reappears, flagged; live hits stay unflagged.
  const withArchived = await search(fresh, 'configdeck', 10, { includeArchived: true })
  const hit = withArchived.matches.find((m) => m.id === gone)
  assert.ok(hit, 'archived node joins the scan under the flag')
  assert.equal(hit.archived, true, 'the archived hit is flagged')
  assert.equal(withArchived.matches.find((m) => m.id === live).archived, undefined, 'the live hit stays unflagged')
  // Its pre-archive access history still counts — not a false zero.
  assert.equal(hit.uses, 1, 'an archived hit ranks on its pre-archive history')

  // Restore roundtrip: search finds it by default again, edges intact.
  await restoreNode(fresh, gone)
  // The restore itself counts as a fresh visit, so the next `graph-maintain
  // --apply` (staleness keyed on access recency) cannot re-archive it at once.
  const restoredLog = await fsp.readFile(path.join(fresh, ACCESS_DIR, `${gone}.log`), 'utf8')
  assert.match(restoredLog.trim().split('\n').at(-1), new RegExp(`^${gone} `), 'restore records a self-access')
  await assert.rejects(fsp.access(path.join(fresh, ARCHIVE_DIR, gone)), 'the node left the archive')
  const afterRestore = await search(fresh, 'configdeck', 10)
  assert.ok(afterRestore.matches.some((m) => m.id === gone), 'a restored node is found by a default search')
  assert.deepEqual(await outEdges(fresh, gone), [neighbor], 'its outgoing edge survived')
  assert.deepEqual((await readNode(fresh, gone)).edges, [{ id: neighbor, description: 'configdeck neighbor' }], 'and resolves through readNode')

  // Restore errors: an active id, an unknown id, and a traversal attempt.
  await assert.rejects(() => restoreNode(fresh, live), /not archived/)
  await assert.rejects(() => restoreNode(fresh, '01J00000000000000000000001'), /not archived/)
  await assert.rejects(() => restoreNode(fresh, '../evil'), /invalid node id/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('supersede prepends a dated banner and leaves the old body and its stamp intact', async () => {
  const oldId = await createNode(root, { description: 'Chose Postgres for transcripts', body: 'relational joins for diarization\nteam knows SQL' }, Date.parse('2026-08-18'))
  const newId = await createNode(root, { description: 'Chose ClickHouse for transcripts' })
  const { status, files_moved, oldNode } = await supersede(root, oldId, newId, Date.parse('2026-08-20'))
  assert.equal(status, 'banner-added')
  assert.equal(files_moved, 0, 'no attachments on the old node, none moved')
  const node = await loadNode(root, oldId)
  assert.deepEqual(oldNode, node, 'the result exposes the exact node written for race-free hashing')
  // The banner is the first body line, the original text survives verbatim below it.
  assert.equal(node.body, `Superseded by ${newId} on 2026-08-20.\n\nrelational joins for diarization\nteam knows SQL`)
  // The banner date is the same date the body change stamps into `updated:`.
  assert.equal(node.updated, '2026-08-20')
})

test('supersede is idempotent on a pair but records a second, different successor', async () => {
  const oldId = await createNode(root, { description: 'original decision', body: 'the why' })
  const firstNew = await createNode(root, { description: 'first replacement' })
  const secondNew = await createNode(root, { description: 'second replacement' })
  assert.equal((await supersede(root, oldId, firstNew, Date.parse('2026-08-20'))).status, 'banner-added')
  // Re-superseding the SAME pair, even on a later day, adds no second banner.
  assert.equal((await supersede(root, oldId, firstNew, Date.parse('2026-09-01'))).status, 'already')
  let body = (await loadNode(root, oldId)).body
  assert.equal(body.split('\n').filter((line) => line.startsWith(`Superseded by ${firstNew} `)).length, 1)
  // A different successor still lands its own banner — a node can be superseded twice.
  assert.equal((await supersede(root, oldId, secondNew, Date.parse('2026-09-02'))).status, 'banner-added')
  body = (await loadNode(root, oldId)).body
  assert.match(body, new RegExp(`^Superseded by ${secondNew} on 2026-09-02\\.`))
  assert.match(body, new RegExp(`Superseded by ${firstNew} on 2026-08-20\\.`))
  assert.match(body, /the why/, 'the original body is still present under both banners')
})

test('supersede preserves unknown frontmatter an external writer added to the old node', async () => {
  const oldId = await createNode(root, { description: 'has a custom key', body: 'v1' })
  const raw = `---\ndescription: has a custom key\ncreated: 2026-08-18\ncustom: keep me\n---\n\nv1\n`
  await fsp.writeFile(path.join(root, oldId, 'node.md'), raw, 'utf8')
  const newId = await createNode(root, { description: 'replacement' })
  await supersede(root, oldId, newId, Date.parse('2026-08-20'))
  const reread = await fsp.readFile(path.join(root, oldId, 'node.md'), 'utf8')
  assert.match(reread, /^custom: keep me$/m, 'the unknown frontmatter key survived the banner write')
  assert.match(reread, /\nupdated: 2026-08-20\n/, 'the banner write stamped `updated`')
  assert.match(reread, new RegExp(`Superseded by ${newId} on 2026-08-20\\.`))
  assert.match(reread, /v1/, 'the original body survived')
})

test('supersede rejects a malformed id and errors on a missing old node', async () => {
  const newId = await createNode(root, { description: 'a successor' })
  await assert.rejects(() => supersede(root, '../evil', newId), /invalid superseded node id/)
  await assert.rejects(() => supersede(root, '01J00000000000000000000001', newId), /node does not exist/)
  // Direct callers get the same guarantees memory_write enforces: a banner
  // never points at a missing successor, and a node never supersedes itself.
  const oldId = await createNode(root, { description: 'a predecessor' })
  await assert.rejects(() => supersede(root, oldId, '01J00000000000000000000002'), /successor does not exist/)
  await assert.rejects(() => supersede(root, oldId, oldId), /cannot supersede itself/)
})

test('supersede moves the old node\'s attachments to the successor, collision-safe (F41, #61)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-supersede-files-'))
  const oldId = await createNode(fresh, { description: 'export decision, first cut', body: 'gist' })
  await attach(fresh, oldId, 'full-discussion.md', 'zqxsuperseded term lives only here')
  await attach(fresh, oldId, 'notes.md', 'old notes body')
  const newId = await createNode(fresh, { description: 'export decision, revised' })
  await attach(fresh, newId, 'notes.md', 'the successor already had notes.md')
  const { status, files_moved } = await supersede(fresh, oldId, newId, Date.parse('2026-08-24'))
  assert.equal(status, 'banner-added')
  assert.equal(files_moved, 2)
  // Both files left the old node; the collision landed under a prefixed name
  // and clobbered nothing.
  assert.deepEqual(await extraFiles(fresh, oldId), [])
  const onNew = await extraFiles(fresh, newId)
  assert.ok(onNew.includes('full-discussion.md'), JSON.stringify(onNew))
  assert.ok(onNew.includes(`${oldId.slice(0, 8)}_notes.md`), JSON.stringify(onNew))
  assert.equal((await readAttachment(fresh, newId, 'notes.md')).content, 'the successor already had notes.md')
  assert.equal((await readAttachment(fresh, newId, `${oldId.slice(0, 8)}_notes.md`)).content, 'old notes body')
  // The whole point: the moved file is searchable and readable on the LIVE
  // head, not stranded behind the deranked [superseded by …] node.
  const hit = await search(fresh, 'zqxsuperseded', 5)
  assert.equal(hit.matches[0]?.id, newId)
  assert.deepEqual(hit.matches[0]?.matched_in, ['full-discussion.md'])
  assert.equal((await readAttachment(fresh, newId, 'full-discussion.md')).content, 'zqxsuperseded term lives only here')
  // A file attached to the old node AFTER its banner catches up on the next
  // call — the 'already' path sweeps too.
  await attach(fresh, oldId, 'late.md', 'landed after the banner')
  const again = await supersede(fresh, oldId, newId, Date.parse('2026-08-25'))
  assert.equal(again.status, 'already')
  assert.equal(again.files_moved, 1)
  assert.equal((await readAttachment(fresh, newId, 'late.md')).content, 'landed after the banner')

  // Late files chase only the LIVE head: after a second supersession, re-running
  // the OLD pair moves nothing; re-running the newest pair sweeps.
  const newest = await createNode(fresh, { description: 'export decision, third cut' })
  assert.equal((await supersede(fresh, oldId, newest, Date.parse('2026-08-26'))).status, 'banner-added')
  await attach(fresh, oldId, 'later-still.md', 'attached after the second banner')
  const stale = await supersede(fresh, oldId, newId, Date.parse('2026-08-27'))
  assert.deepEqual(stale, { status: 'already', files_moved: 0 })
  assert.deepEqual(await extraFiles(fresh, oldId), ['later-still.md'], 'the stale successor took nothing')
  const live = await supersede(fresh, oldId, newest, Date.parse('2026-08-27'))
  assert.deepEqual(live, { status: 'already', files_moved: 1 })
  assert.equal((await readAttachment(fresh, newest, 'later-still.md')).content, 'attached after the second banner')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a mid-move failure rolls the already-moved files back onto the old node (F41, #61)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-supersede-rollback-'))
  const oldId = await createNode(fresh, { description: 'rollback victim' })
  await attach(fresh, oldId, 'a-first.md', 'first file')
  await attach(fresh, oldId, 'b-second.md', 'second file')
  const newId = await createNode(fresh, { description: 'rollback successor' })
  // Fail the SECOND file's move: patch the fs/promises singleton graph.js
  // imports, keyed on the destination path so the injection is deterministic.
  const realRename = fsp.rename
  fsp.rename = (from, to) => {
    if (typeof to === 'string' && to.endsWith('b-second.md')) throw new Error('injected rename failure')
    return realRename.call(fsp, from, to)
  }
  try {
    await assert.rejects(() => supersede(fresh, oldId, newId, Date.parse('2026-08-24')), /injected rename failure/)
  } finally {
    fsp.rename = realRename
  }
  // Both files are back (or still) on the old node; the successor took nothing.
  assert.deepEqual((await extraFiles(fresh, oldId)).sort(), ['a-first.md', 'b-second.md'])
  assert.deepEqual(await extraFiles(fresh, newId), [])
  assert.equal((await readAttachment(fresh, oldId, 'a-first.md')).content, 'first file')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('typed edges round-trip through setEdgeType, edgeTypes, and addEdge, and untyped edges stay type-free', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-edgetype-'))
  const a = await createNode(fresh, { description: 'source' })
  const b = await createNode(fresh, { description: 'target b' })
  const c = await createNode(fresh, { description: 'target c' })
  // A node with no typed edges has no sidecar: edgeTypes is empty, not an error.
  assert.deepEqual([...(await edgeTypes(fresh, a))], [])
  // addEdge with a type creates the edge and records the sidecar line.
  assert.equal(await addEdge(fresh, a, b, { type: 'supersedes' }), 'created')
  assert.equal((await edgeTypes(fresh, a)).get(b), 'supersedes')
  // A plain addEdge leaves its edge untyped — no sidecar entry for it.
  assert.equal(await addEdge(fresh, a, c), 'created')
  assert.equal((await edgeTypes(fresh, a)).get(c), undefined)
  // setEdgeType upserts: re-typing b replaces its line in place; c gains one.
  await setEdgeType(fresh, a, b, 'relates-to')
  await setEdgeType(fresh, a, c, 'follows-from')
  const map = await edgeTypes(fresh, a)
  assert.equal(map.get(b), 'relates-to')
  assert.equal(map.get(c), 'follows-from')
  // The sidecar is a sorted dotfile beside the symlinks, invisible to outEdges.
  assert.deepEqual([...(await outEdges(fresh, a))].sort(), [b, c].sort())
  const raw = await fsp.readFile(path.join(fresh, a, '__edges__', '.edge-types'), 'utf8')
  assert.equal(raw, `${[b, c].sort().map((id) => `${id} ${map.get(id)}`).join('\n')}\n`, 'sidecar is sorted by dst, one line per typed edge')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('assertEdgeType and addEdge reject a non-enum type without leaving an edge behind', async () => {
  assert.deepEqual(EDGE_TYPES, ['supersedes', 'relates-to', 'follows-from'])
  assert.equal(assertEdgeType('relates-to'), 'relates-to')
  assert.throws(() => assertEdgeType('nonsense'), /edge type must be one of/)
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-edgetype-bad-'))
  const a = await createNode(fresh, { description: 'a' })
  const b = await createNode(fresh, { description: 'b' })
  await assert.rejects(() => addEdge(fresh, a, b, { type: 'bogus' }), /edge type must be one of/)
  // Validated up front: no symlink and no sidecar were created.
  assert.deepEqual(await outEdges(fresh, a), [])
  await assert.rejects(fsp.access(path.join(fresh, a, '__edges__', '.edge-types')))
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a directed retype from the larger side clears the pair\'s canonical relates-to line (codex review of #119)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-retype-'))
  const a = await createNode(fresh, { description: 'retype a' })
  const b = await createNode(fresh, { description: 'retype b' })
  const [lo, hi] = a < b ? [a, b] : [b, a]
  await addEdge(fresh, lo, hi, { type: 'relates-to' })
  assert.equal((await edgeTypes(fresh, lo)).get(hi), 'relates-to')
  // Retype the SAME pair to a directed type, written from the LARGER side —
  // the one write path where the upsert alone cannot reach the canonical
  // line. Leaving it would make the two endpoints report different types for
  // one edge while maintain says clean.
  await addEdge(fresh, hi, lo, { type: 'supersedes' })
  assert.equal((await edgeTypes(fresh, hi)).get(lo), 'supersedes', 'the directed line lives on its source')
  assert.equal((await edgeTypes(fresh, lo)).get(hi), undefined, 'the supplanted canonical relates-to line is gone')
  assert.deepEqual((await readNode(fresh, hi)).edges, [{ id: lo, description: a < b ? 'retype a' : 'retype b', type: 'supersedes' }])
  const loView = (await readNode(fresh, lo)).edges.find((e) => e.id === hi)
  assert.ok(!('type' in loView), 'the smaller side shows the plain pair — a directed type is never inverted')
  // The clear is type-aware: a REVERSE directed line is a separate edge and
  // survives a directed write from the other side.
  await addEdge(fresh, lo, hi, { type: 'follows-from' })
  assert.equal((await edgeTypes(fresh, hi)).get(lo), 'supersedes', 'the reverse directed edge keeps its own line')
  assert.equal((await edgeTypes(fresh, lo)).get(hi), 'follows-from')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('merge keeps the symmetric type on the archived node when absorb is the larger id (codex review of #119)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-merge-larger-'))
  const n1 = await createNode(fresh, { description: 'endpoint one' })
  const n2 = await createNode(fresh, { description: 'endpoint two' })
  // Force the reported layout: absorb is the LARGER id, so the pair's
  // canonical relates-to line lives on the surviving NEIGHBOR — exactly the
  // line the merge detaches. Without the copy, the archived node would hold
  // no type record at all and restore would return the edge untyped.
  const [peer, absorb] = n1 < n2 ? [n1, n2] : [n2, n1]
  const keep = await createNode(fresh, { description: 'the keeper' })
  await addEdge(fresh, absorb, peer, { type: 'relates-to' })
  assert.equal((await edgeTypes(fresh, peer)).get(absorb), 'relates-to', 'precondition: the canonical line is on the neighbor')
  await mergeNodes(fresh, keep, absorb)
  // The inherited keep—peer edge kept the type (the standing promise) …
  assert.equal(await edgeTypeOf(fresh, keep, peer), 'relates-to')
  // … and the archived node carries its own copy, so restore loses nothing.
  await restoreNode(fresh, absorb)
  const restored = (await readNode(fresh, absorb)).edges.find((e) => e.id === peer)
  assert.equal(restored?.type, 'relates-to', 'the restored edge comes back typed, not stripped')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('readNode reports edge types from either sidecar side, and never inverts a directed type (F54, #90)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-edgetype-read-'))
  const hub = await createNode(fresh, { description: 'hub' })
  const typed = await createNode(fresh, { description: 'typed target' })
  const plain = await createNode(fresh, { description: 'plain target' })
  const back = await createNode(fresh, { description: 'upstream' })
  await addEdge(fresh, hub, typed, { type: 'relates-to' })
  await addEdge(fresh, hub, plain)
  await addEdge(fresh, back, hub, { type: 'supersedes' }) // a directed INCOMING edge
  const view = await readNode(fresh, hub)
  const byId = Object.fromEntries(view.edges.map((e) => [e.id, e]))
  // `relates-to` is symmetric: its sidecar line lives on the lexicographically
  // smaller side only, yet BOTH node views show the type.
  assert.deepEqual(byId[typed], { id: typed, description: 'typed target', type: 'relates-to' })
  const peerView = await readNode(fresh, typed)
  assert.deepEqual(peerView.edges, [{ id: hub, description: 'hub', type: 'relates-to' }], 'the peer sees the same symmetric type')
  const loSidecar = await edgeTypes(fresh, hub < typed ? hub : typed)
  const hiSidecar = await edgeTypes(fresh, hub < typed ? typed : hub)
  assert.equal(loSidecar.get(hub < typed ? typed : hub), 'relates-to', 'the line lives on the smaller id')
  assert.equal(hiSidecar.get(hub < typed ? hub : typed), undefined, 'and never on the larger — the sides cannot disagree')
  // An untyped edge carries no `type` key at all — byte-identical shape.
  assert.deepEqual(byId[plain], { id: plain, description: 'plain target' })
  assert.ok(!('type' in byId[plain]))
  // A directed edge pointing AT the hub stays one-way and invisible from the
  // hub's own view: inverting "supersedes" onto the node it points at would
  // state the opposite of what was stored.
  assert.equal(byId[back], undefined, 'a directed in-edge is not a peer row')
  assert.deepEqual((await readNode(fresh, back)).edges, [{ id: hub, description: 'hub', type: 'supersedes' }])
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('mergeNodes folds absorb into keep: body, out-edges, incoming repoint with type, files, and archives with a banner', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-merge-'))
  const now = Date.parse('2026-08-20T10:00:00Z')
  const when = '2026-08-20'
  const keep = await createNode(fresh, { description: 'keep node', body: 'keep body' })
  const absorb = await createNode(fresh, { description: 'absorb node', body: 'absorb body' })
  const outTarget = await createNode(fresh, { description: 'absorb out target' })
  const shared = await createNode(fresh, { description: 'shared out target' })
  const backTyped = await createNode(fresh, { description: 'incoming typed' })
  const backPlain = await createNode(fresh, { description: 'incoming plain' })

  // absorb's out-edges: one typed to outTarget, one to `shared` that keep ALSO has.
  await addEdge(fresh, absorb, outTarget, { type: 'relates-to' })
  await addEdge(fresh, absorb, shared)
  await addEdge(fresh, keep, shared) // keep already points here -> inherited edge is skipped
  // incoming edges to absorb: typed from backTyped, plain from backPlain, and keep itself.
  await addEdge(fresh, backTyped, absorb, { type: 'follows-from' })
  await addEdge(fresh, backPlain, absorb)
  await addEdge(fresh, keep, absorb) // self-pointer to drop; must NOT become a keep->keep edge
  // agent-space files: one unique, one colliding with a file keep already carries.
  await fsp.writeFile(path.join(fresh, absorb, 'unique.md'), 'u')
  await fsp.writeFile(path.join(fresh, absorb, 'notes.md'), 'absorb notes')
  await fsp.writeFile(path.join(fresh, keep, 'notes.md'), 'keep notes')

  // `keptBody`/`absorbedBody` are caller bookkeeping like `keepNode` (F72,
  // #152): the pre-append halves the merge advisory needs, not tool output.
  const { keepNode: writtenKeepNode, keptBody, absorbedBody, ...result } = await mergeNodes(fresh, keep, absorb, now)
  assert.deepEqual([keptBody, absorbedBody], ['keep body', 'absorb body'], 'the halves come back as they stood before the append')
  // Four repointed under F54 (#90): symmetric edges are pairs, so absorb's
  // plain neighbors (outTarget, shared, backPlain) all point at it and are
  // repointed alongside the directed backTyped edge; keep's own pointer is
  // dropped, never repointed.
  assert.deepEqual(result, { keep_id: keep, absorb_id: absorb, merged: true, edges_repointed: 4, files_moved: 2 })

  // (1) body concat under a provenance divider; keep's updated stamps.
  const keepNode = await loadNode(fresh, keep)
  assert.deepEqual(writtenKeepNode, keepNode, 'the result exposes the exact node written for race-free hashing')
  assert.equal(keepNode.body, `keep body\n\n---\nMerged from ${absorb} on ${when}:\n\nabsorb body`)
  assert.equal(keepNode.updated, when)

  // (2) keep inherited absorb's out-edges (type preserved), skipped the shared one,
  // and no longer points at absorb or itself.
  const keepOut = new Set(await outEdges(fresh, keep))
  assert.ok(keepOut.has(outTarget) && keepOut.has(shared))
  assert.ok(!keepOut.has(absorb) && !keepOut.has(keep))
  // Side-agnostic on purpose: the symmetric type's sidecar line lives on the
  // lexicographically smaller of (keep, outTarget), whichever that is.
  assert.equal(await edgeTypeOf(fresh, keep, outTarget), 'relates-to', 'inherited out-edge type preserved')

  // (3) incoming edges repointed to keep with their types; old edges to absorb detached.
  assert.deepEqual(await outEdges(fresh, backTyped), [keep])
  assert.equal((await edgeTypes(fresh, backTyped)).get(keep), 'follows-from', 'repointed edge keeps its type')
  assert.deepEqual(await outEdges(fresh, backPlain), [keep])
  assert.equal((await edgeTypes(fresh, backPlain)).get(keep), undefined, 'a plain incoming edge stays untyped')

  // (4) files moved; the collision is renamed with the absorb short-id prefix.
  assert.equal(await fsp.readFile(path.join(fresh, keep, 'unique.md'), 'utf8'), 'u')
  assert.equal(await fsp.readFile(path.join(fresh, keep, 'notes.md'), 'utf8'), 'keep notes', 'keep own file untouched')
  assert.equal(await fsp.readFile(path.join(fresh, keep, `${absorb.slice(0, 8)}_notes.md`), 'utf8'), 'absorb notes')

  // (5) absorb archived with a banner; gone from the live graph; no live keep->absorb edge.
  assert.equal(await loadNode(fresh, absorb), undefined, 'absorb is no longer live')
  const archived = parseNode(await fsp.readFile(path.join(fresh, ARCHIVE_DIR, absorb, 'node.md'), 'utf8'))
  assert.match(archived.body, new RegExp(`^Merged into ${keep} on ${when}\\.`))
  assert.match(archived.body, /absorb body/)
  await assert.rejects(fsp.readlink(path.join(fresh, keep, '__edges__', absorb)), 'no live keep->absorb edge is left to dangle')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('mergeNodes tolerates a dangling absorb out-edge: it succeeds, appends the body once, and inherits only valid out-edges', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-merge-dangling-'))
  const now = Date.parse('2026-08-20T10:00:00Z')
  const keep = await createNode(fresh, { description: 'keep', body: 'keep body' })
  const absorb = await createNode(fresh, { description: 'absorb', body: 'absorb body' })
  const valid = await createNode(fresh, { description: 'a real out target' })
  await addEdge(fresh, absorb, valid)
  // A well-formed but dangling out-edge from absorb to a node that never existed.
  const ghost = 'Z'.repeat(26)
  await fsp.symlink(`../../${ghost}`, path.join(fresh, absorb, '__edges__', ghost))

  // Before the fix this threw inside step (2) — after step (1) had already
  // appended provenance — leaving a half-merged keep a retry would double-append.
  const result = await mergeNodes(fresh, keep, absorb, now)
  assert.equal(result.merged, true)
  const body = (await loadNode(fresh, keep)).body
  assert.equal(body, `keep body\n\n---\nMerged from ${absorb} on 2026-08-20:\n\nabsorb body`)
  assert.equal((body.match(/Merged from/g) ?? []).length, 1, 'provenance appended exactly once')
  const keepOut = await outEdges(fresh, keep)
  assert.ok(keepOut.includes(valid), 'the valid out-edge is inherited')
  assert.ok(!keepOut.includes(ghost), 'the dangling out-edge is not inherited')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('mergeNodes never overwrites on an attachment collision: prior collisions land under distinct unused names', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-merge-collide-'))
  const keep = await createNode(fresh, { description: 'keep' })
  const absorb = await createNode(fresh, { description: 'absorb' })
  const prefix = absorb.slice(0, 8)
  // keep already carries both `notes.md` and the first fallback name, forcing a
  // second fallback (`<prefix>_1_notes.md`). Near-in-time ULIDs really do share
  // their first 8 chars, so this is the exact overwrite the fix prevents.
  await fsp.writeFile(path.join(fresh, keep, 'notes.md'), 'keep original')
  await fsp.writeFile(path.join(fresh, keep, `${prefix}_notes.md`), 'prior collision survivor')
  await fsp.writeFile(path.join(fresh, absorb, 'notes.md'), 'absorb notes')

  const result = await mergeNodes(fresh, keep, absorb)
  assert.equal(result.files_moved, 1)
  assert.equal(await fsp.readFile(path.join(fresh, keep, 'notes.md'), 'utf8'), 'keep original', 'keep own file untouched')
  assert.equal(await fsp.readFile(path.join(fresh, keep, `${prefix}_notes.md`), 'utf8'), 'prior collision survivor', 'the prior collision file is untouched')
  assert.equal(await fsp.readFile(path.join(fresh, keep, `${prefix}_1_notes.md`), 'utf8'), 'absorb notes', 'absorb file lands under a fresh unused name — nothing lost')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('recencyDecay is clamped to [0,1]: a future date cannot outweigh a genuine traversal signal', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-rank-future-'))
  const now = Date.parse('2026-08-20T12:00:00Z')
  const src = await createNode(fresh, { description: 'src', now })
  const anchor = await createNode(fresh, { description: 'anchor: one real traversal, old', now: Date.parse('2020-01-01') })
  const future = await createNode(fresh, { description: 'future-dated node', now: Date.parse('2020-01-01') })
  await fsp.mkdir(path.join(fresh, ACCESS_DIR), { recursive: true })
  await fsp.appendFile(path.join(fresh, ACCESS_DIR, `${src}.log`), `${anchor} 2020-02-02T00:00:00Z\n`) // one traversal onto anchor
  await updateNode(fresh, future, { body: 'x' }, Date.parse('2027-06-01T00:00:00Z')) // updated ~285 days AFTER now

  // WITHOUT the clamp, future's recency (~2.6) × 10 = ~26 would dwarf anchor's
  // single traversal × 15 = 15. WITH the clamp (recency ≤ 1 → ×10 = 10) anchor wins.
  const weights = { traversal: 15, read: 0, recency: 10, recencyWindowDays: 180 }
  const order = (await indexLines(fresh, 10, weights, now)).map((line) => line.slice(0, 26))
  assert.equal(order[0], anchor, 'the future date is clamped to recency 1, so it never exceeds the traversal signal')
  assert.ok(order.indexOf(future) > order.indexOf(anchor), 'the future-dated node ranks below the traversed one')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('mergeNodes rejects a self-merge, a malformed id, and a missing or archived node', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-merge-bad-'))
  const a = await createNode(fresh, { description: 'a live node' })
  const b = await createNode(fresh, { description: 'another live node' })
  await assert.rejects(() => mergeNodes(fresh, a, a), /cannot merge a node into itself/)
  await assert.rejects(() => mergeNodes(fresh, '../evil', b), /invalid keep node id/)
  await assert.rejects(() => mergeNodes(fresh, a, '01J00000000000000000000001'), /absorb node does not exist/)
  await assert.rejects(() => mergeNodes(fresh, '01J00000000000000000000001', a), /keep node does not exist/)
  // An archived node is not a valid merge target (loadNode only sees live nodes).
  await fsp.mkdir(path.join(fresh, ARCHIVE_DIR), { recursive: true })
  await fsp.rename(path.join(fresh, b), path.join(fresh, ARCHIVE_DIR, b))
  await assert.rejects(() => mergeNodes(fresh, a, b), /absorb node does not exist \(or is archived\)/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('full-token matches rank above higher-scoring partial matches', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-full-'))
  // partial: one token in description AND body -> score 4 under the old comparator
  await createNode(fresh, { description: 'alpha subsystem overview', body: 'subsystem details here' })
  // full: both tokens, body only -> score 2; must still rank first
  const exact = await createNode(fresh, { description: 'unrelated note', body: 'subsystem seven combo' })
  const result = await search(fresh, 'subsystem seven', 10)
  assert.equal(result.total, 2, 'partial matches still count into total')
  assert.equal(result.full, 1, 'only the node with every token is full')
  assert.equal(result.tokens, 2)
  assert.equal(result.matches[0].id, exact, 'full match outranks the higher-scoring partial')
  const empty = await search(fresh, '', 10)
  assert.equal(empty.tokens, 0)
  assert.equal(empty.full, 0, 'empty query reports no full matches, not all')
  await fsp.rm(fresh, { recursive: true, force: true })
})

// F40 (#60): the orphan census — live nodes with no edges in or out, the
// islands write-time link suggestions failed to prevent.
test('orphanCensus finds islands, ignores dangling edges, sorts newest first and caps', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-orphans-'))
  // Missing and empty roots are quiet.
  assert.deepEqual(orphanCensus(path.join(fresh, 'nowhere'), 3), { total: 0, shown: [] })
  assert.deepEqual(orphanCensus(fresh, 3), { total: 0, shown: [] })
  const a = await createNode(fresh, { description: 'linked source', now: Date.parse('2026-01-01T12:00:00Z') })
  const b = await createNode(fresh, { description: 'linked target', now: Date.parse('2026-01-02T12:00:00Z') })
  await addEdge(fresh, a, b)
  const o1 = await createNode(fresh, { description: 'older island', now: Date.parse('2026-02-01T12:00:00Z') })
  const o2 = await createNode(fresh, { description: 'newer island', now: Date.parse('2026-03-01T12:00:00Z') })
  // Neither side of a live edge is an orphan; both unlinked nodes are.
  const census = orphanCensus(fresh, 3)
  assert.equal(census.total, 2)
  assert.deepEqual(census.shown.map((n) => n.id), [o2, o1])
  assert.equal(census.shown[0].description, 'newer island')
  // A dangling edge is not evidence of connection: pointing at a gone target
  // leaves the source an island, and the target is not here to be marked.
  await fsp.symlink('../../ZZZZZZZZZZZZZZZZZZZZZZZZZZ', path.join(fresh, o2, '__edges__', 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ'))
  assert.equal(orphanCensus(fresh, 3).total, 2)
  // Nor is an entry merely WEARING a live id: a symlink named o1 that points
  // elsewhere, or a regular file named a live id, is not an edge — the
  // contract is a symlink targeting exactly `../../<name>` (codex review).
  await fsp.symlink('../../ZZZZZZZZZZZZZZZZZZZZZZZZZZ', path.join(fresh, o2, '__edges__', o1))
  await fsp.writeFile(path.join(fresh, o1, '__edges__', o2), 'not a symlink')
  assert.equal(orphanCensus(fresh, 3).total, 2)
  await fsp.rm(path.join(fresh, o2, '__edges__', o1))
  await fsp.rm(path.join(fresh, o1, '__edges__', o2))
  // The cap bounds `shown`, never `total`.
  const capped = orphanCensus(fresh, 1)
  assert.equal(capped.total, 2)
  assert.deepEqual(capped.shown.map((n) => n.id), [o2])
  // A revision lifts an old island to the front: recency is updated-else-created.
  await updateNode(fresh, o1, { body: 'revised today' })
  assert.deepEqual(orphanCensus(fresh, 3).shown.map((n) => n.id), [o1, o2])
  // A LEGACY single-direction edge (pre-F54, not yet symmetrized) still
  // connects both of its endpoints: the census marks the source out and the
  // target in from the one half, so neither is misreported as an island while
  // the graph migrates lazily (F54, #90).
  await fsp.symlink(`../../${o2}`, path.join(fresh, o1, '__edges__', o2))
  assert.equal(orphanCensus(fresh, 3).total, 0, 'a half-edge is connection evidence for both ends')
  await fsp.rm(fresh, { recursive: true, force: true })
})

// A directory or a regular file wearing a node id under __edges__/ (an agent's
// own script did `os.makedirs(<graph>/<id>/__edges__/<dst>)`) is not an edge:
// every engine reader skips it, exactly as the graph panel and graph-maintain do.
test('a directory or file under __edges__ is not an edge for any reader', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-nonsymlink-'))
  // Distinct clocks, so the ids sort in creation order (the rank tie-break below).
  const a = await createNode(fresh, { description: 'alpha hub', now: Date.parse('2026-01-01T12:00:00Z') })
  const b = await createNode(fresh, { description: 'beta peer', now: Date.parse('2026-01-02T12:00:00Z') })
  const c = await createNode(fresh, { description: 'gamma dir edge', now: Date.parse('2026-01-03T12:00:00Z') })
  const d = await createNode(fresh, { description: 'delta file edge', now: Date.parse('2026-01-04T12:00:00Z') })
  await addEdge(fresh, a, b)
  await fsp.mkdir(path.join(fresh, a, '__edges__', c))
  await fsp.mkdir(path.join(fresh, c, '__edges__', a))
  await fsp.writeFile(path.join(fresh, a, '__edges__', d), '')
  assert.deepEqual(await outEdges(fresh, a), [b])
  assert.deepEqual(await outEdges(fresh, c), [])
  assert.deepEqual((await readNode(fresh, a)).edges.map((e) => e.id), [b])
  assert.deepEqual((await readNode(fresh, c)).edges, [])
  assert.deepEqual(orphanCensus(fresh, 10).shown.map((n) => n.id).sort(), [c, d].sort())
  // Degree-only ranking: a and b hold one real edge each; c and d hold none.
  // Counting the directory would lift c above b (and a to 3).
  const degreeOnly = { traversal: 0, read: 0, recency: 0, degree: 1 }
  const expected = [b, a, d, c] // ties break newest first
  assert.deepEqual(indexLinesSync(fresh, 10, degreeOnly).map((line) => line.slice(0, 26)), expected)
  assert.deepEqual((await indexLines(fresh, 10, degreeOnly)).map((line) => line.slice(0, 26)), expected)
  // A traversal from c to a cannot wire over the occupied slot; the read still works.
  await assert.rejects(addEdge(fresh, c, a), /non-symlink already occupies edge slot.*graph-maintain/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

// F30 (#50): capture bulk by reference — copy an existing file into agent
// space instead of paying for a retype.
test('attachFromPath copies a file in: content lands, original stays, name defaults to the basename', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-frompath-'))
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-loose-'))
  const id = await createNode(fresh, { description: 'meeting thread' })
  const loose = path.join(outside, 'full-discussion.md')
  await fsp.writeFile(loose, 'Priya argued for 10000-row pages; counter was cursor expiry.\n')
  const copied = await attachFromPath(fresh, id, loose, undefined, { allowedRoots: [outside] })
  assert.deepEqual(copied, { file: 'full-discussion.md', bytes: 61, status: 'created' })
  assert.equal(await fsp.readFile(path.join(fresh, id, 'full-discussion.md'), 'utf8'), 'Priya argued for 10000-row pages; counter was cursor expiry.\n')
  // Copy, never move: the source is left exactly where it was.
  assert.equal(await fsp.readFile(loose, 'utf8'), 'Priya argued for 10000-row pages; counter was cursor expiry.\n')
  // An explicit filename overrides the basename; same name again overwrites.
  await fsp.writeFile(loose, 'v2 of the discussion\n')
  const renamed = await attachFromPath(fresh, id, loose, 'full-discussion.md', { allowedRoots: [outside] })
  assert.equal(renamed.status, 'overwritten')
  assert.equal(await fsp.readFile(path.join(fresh, id, 'full-discussion.md'), 'utf8'), 'v2 of the discussion\n')
  await fsp.rm(fresh, { recursive: true, force: true })
  await fsp.rm(outside, { recursive: true, force: true })
})

test('attachFromPath keeps every attach guard: source shape, caps, empty overwrite, names', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-frompath2-'))
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-loose2-'))
  const id = await createNode(fresh, { description: 'guarded node' })
  // Missing, non-file, and oversized sources are named plainly.
  await assert.rejects(() => attachFromPath(fresh, id, path.join(outside, 'nope.md'), undefined, { allowedRoots: [outside] }), /from_path does not exist/)
  await assert.rejects(() => attachFromPath(fresh, id, outside, undefined, { allowedRoots: [outside] }), /not a regular file/)
  const big = path.join(outside, 'big.md')
  await fsp.writeFile(big, 'x'.repeat(ATTACH_MAX_BYTES + 1))
  await assert.rejects(() => attachFromPath(fresh, id, big, undefined, { allowedRoots: [outside] }), /content too large/)
  await fsp.access(big) // a rejected source is never consumed
  // The empty-overwrite refusal survives the new path, and the target stays.
  await attach(fresh, id, 'notes.md', 'keep me')
  const empty = path.join(outside, 'notes.md')
  await fsp.writeFile(empty, '')
  await assert.rejects(() => attachFromPath(fresh, id, empty, undefined, { allowedRoots: [outside] }), /refusing to replace notes.md/)
  assert.equal(await fsp.readFile(path.join(fresh, id, 'notes.md'), 'utf8'), 'keep me')
  await fsp.access(empty)
  // Name rules are the same gate attach uses, applied to the DEFAULT name too.
  await assert.rejects(() => attachFromPath(fresh, id, empty, 'node.md', { allowedRoots: [outside] }), /reserved/)
  const dotted = path.join(outside, '.hidden')
  await fsp.writeFile(dotted, 'x')
  await assert.rejects(() => attachFromPath(fresh, id, dotted, undefined, { allowedRoots: [outside] }), /start with a dot/)
  // A symlink source copies its CONTENT: the link and its target both stay.
  const target = path.join(outside, 'target.md')
  await fsp.writeFile(target, 'real bytes')
  const link = path.join(outside, 'linked.md')
  await fsp.symlink(target, link)
  const viaLink = await attachFromPath(fresh, id, link, undefined, { allowedRoots: [outside] })
  assert.deepEqual(viaLink, { file: 'linked.md', bytes: 10, status: 'created' })
  assert.equal(await fsp.readFile(path.join(fresh, id, 'linked.md'), 'utf8'), 'real bytes')
  assert.ok((await fsp.lstat(link)).isSymbolicLink(), 'the link itself is left in place')
  assert.equal(await fsp.readFile(target, 'utf8'), 'real bytes')
  // A missing node still refuses before touching the source.
  await assert.rejects(() => attachFromPath(fresh, '01J00000000000000000000001', target, undefined, { allowedRoots: [outside] }), /node does not exist/)
  await fsp.access(target)
  // A source already under the graph root is refused — it already travels
  // with a node, and node.md is framework metadata (codex review). Both
  // survive untouched.
  await assert.rejects(() => attachFromPath(fresh, id, path.join(fresh, id, 'notes.md'), undefined, { allowedRoots: [outside] }), /inside the memory graph/)
  assert.equal(await fsp.readFile(path.join(fresh, id, 'notes.md'), 'utf8'), 'keep me')
  await assert.rejects(() => attachFromPath(fresh, id, path.join(fresh, id, 'node.md'), 'stolen.md', { allowedRoots: [outside] }), /inside the memory graph/)
  await fsp.access(path.join(fresh, id, 'node.md'))
  // …even when the graph root is reached through a symlink.
  const alias = path.join(outside, 'root-alias')
  await fsp.symlink(fresh, alias)
  await assert.rejects(() => attachFromPath(fresh, id, path.join(alias, id, 'notes.md'), undefined, { allowedRoots: [outside] }), /inside the memory graph/)
  // …and when an OUTSIDE symlink points at a graph file: the source is
  // judged on its real path, so the link is refused and left in place.
  const peek = path.join(outside, 'peek.md')
  await fsp.symlink(path.join(fresh, id, 'notes.md'), peek)
  await assert.rejects(() => attachFromPath(fresh, id, peek, 'copied-notes.md', { allowedRoots: [outside] }), /inside the memory graph/)
  assert.equal(await fsp.readFile(path.join(fresh, id, 'notes.md'), 'utf8'), 'keep me')
  assert.ok((await fsp.lstat(peek)).isSymbolicLink(), 'the outside link is left in place')
  await fsp.rm(fresh, { recursive: true, force: true })
  await fsp.rm(outside, { recursive: true, force: true })
})

// Security regression (2026-10-19): `from_path` is chosen by the model, and a
// writer running as root must never consume the file it names. F30 used to
// unlink the source after the copy; now the source is only read — same bytes,
// size, mode, inode and mtime afterwards, on create, on overwrite, and on
// every refusal path.
test('attachFromPath never deletes, moves or modifies the source file', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-frompath-keep-'))
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-loose-keep-'))
  const id = await createNode(fresh, { description: 'keeps the source' })
  const source = path.join(outside, 'authorized_keys')
  const original = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample operator@host\n'
  await fsp.writeFile(source, original, { mode: 0o600 })
  const past = new Date('2024-01-02T03:04:05Z')
  await fsp.utimes(source, past, past)
  const baseline = await fsp.stat(source)
  const unchanged = async (label) => {
    const after = await fsp.stat(source)
    assert.equal(await fsp.readFile(source, 'utf8'), original, `${label}: content identical`)
    assert.equal(after.size, baseline.size, `${label}: size unchanged`)
    assert.equal(after.mtimeMs, baseline.mtimeMs, `${label}: mtime unchanged`)
    assert.equal(after.ino, baseline.ino, `${label}: same inode — not replaced or renamed`)
    assert.equal(after.mode, baseline.mode, `${label}: mode unchanged`)
  }
  const created = await attachFromPath(fresh, id, source, 'keys-snapshot.md', { allowedRoots: [outside] })
  assert.equal(created.status, 'created')
  assert.equal(await fsp.readFile(path.join(fresh, id, 'keys-snapshot.md'), 'utf8'), original)
  await unchanged('after create')
  const overwritten = await attachFromPath(fresh, id, source, 'keys-snapshot.md', { allowedRoots: [outside] })
  assert.equal(overwritten.status, 'overwritten')
  await unchanged('after overwrite')
  // The attachment is an independent copy: editing it never reaches the source.
  await attach(fresh, id, 'keys-snapshot.md', 'edited in the graph')
  await unchanged('after editing the attachment')
  // Refusal paths leave it alone too.
  await assert.rejects(() => attachFromPath(fresh, id, source, 'node.md', { allowedRoots: [outside] }), /reserved/)
  await assert.rejects(() => attachFromPath(fresh, id, source, 'x.md', { maxBytes: 4, allowedRoots: [outside] }), /content too large/)
  await assert.rejects(() => attachFromPath(fresh, '01J00000000000000000000001', source, undefined, { allowedRoots: [outside] }), /node does not exist/)
  await unchanged('after refusals')
  // A failure after the copy (injected at the staging rename) still never
  // touches the source, and leaves no staging file behind.
  const realRename = fsp.rename
  fsp.rename = async () => { throw new Error('injected rename failure') }
  try {
    await assert.rejects(() => attachFromPath(fresh, id, source, 'late-failure.md', { allowedRoots: [outside] }), /injected rename failure/)
  } finally {
    fsp.rename = realRename
  }
  await unchanged('after a failed staging rename')
  assert.deepEqual((await fsp.readdir(path.join(fresh, id))).filter((name) => name.startsWith('.attach-')), [])
  await fsp.rm(fresh, { recursive: true, force: true })
  await fsp.rm(outside, { recursive: true, force: true })
})

// Security review (2026-10-19): the model chooses the path, so the source is
// confined — real path under an allowed root, no hidden component below it,
// never a system location, always a regular file — and every refusal leaves
// the source exactly as it was.
test('attachFromPath confines the source: allowed roots, hidden paths, system paths, regular files only', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-frompath-roots-'))
  const allowed = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-allowed-'))
  const elsewhere = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-elsewhere-'))
  const id = await createNode(fresh, { description: 'confined sources' })
  const opts = { allowedRoots: [allowed] }
  const files = new Map()
  const plant = async (file, text) => {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, text)
    files.set(file, { text, stat: await fsp.stat(file) })
  }
  const allUntouched = async () => {
    for (const [file, { text, stat }] of files) {
      const now = await fsp.stat(file)
      assert.equal(await fsp.readFile(file, 'utf8'), text, `${file} content`)
      assert.equal(now.mtimeMs, stat.mtimeMs, `${file} mtime`)
      assert.equal(now.ino, stat.ino, `${file} inode`)
    }
  }
  // An allowed file passes, through a nested ordinary directory too.
  const ok = path.join(allowed, 'project', 'meeting-notes.md')
  await plant(ok, 'decided: ship on 2026-10-20\n')
  const landed = await attachFromPath(fresh, id, ok, undefined, opts)
  assert.deepEqual(landed, { file: 'meeting-notes.md', bytes: 28, status: 'created' })
  assert.equal(await fsp.readFile(path.join(fresh, id, 'meeting-notes.md'), 'utf8'), 'decided: ship on 2026-10-20\n')
  // Outside every root.
  const stray = path.join(elsewhere, 'prod.db')
  await plant(stray, 'rows')
  await assert.rejects(() => attachFromPath(fresh, id, stray, undefined, opts), /not under an allowed source directory/)
  // A symlink INSIDE the root pointing outside it is judged on its target.
  const escape = path.join(allowed, 'escape.md')
  await fsp.symlink(stray, escape)
  await assert.rejects(() => attachFromPath(fresh, id, escape, undefined, opts), /not under an allowed source directory/)
  assert.ok((await fsp.lstat(escape)).isSymbolicLink(), 'the refused link stays')
  // `..` in the given path resolves before the check, never past it.
  await assert.rejects(() => attachFromPath(fresh, id, path.join(allowed, '..', path.basename(elsewhere), 'prod.db'), undefined, opts), /not under an allowed source directory/)
  // A sibling whose name merely starts with the root's name is not under it.
  const sibling = `${allowed}-sibling`
  await plant(path.join(sibling, 'x.md'), 'x')
  await assert.rejects(() => attachFromPath(fresh, id, path.join(sibling, 'x.md'), undefined, opts), /not under an allowed source directory/)
  // Hidden files and anything inside a dot-directory under the root.
  const dotfile = path.join(allowed, '.env')
  await plant(dotfile, 'SECRET=1')
  await assert.rejects(() => attachFromPath(fresh, id, dotfile, 'env-copy.md', opts), /hidden file or inside a hidden directory/)
  for (const dirName of ['.ssh', '.aws', '.git', '.config']) {
    const inside = path.join(allowed, dirName, 'payload.txt')
    await plant(inside, 'k')
    await assert.rejects(() => attachFromPath(fresh, id, inside, undefined, opts), /hidden file or inside a hidden directory/, dirName)
  }
  // A visible symlink pointing INTO a dot-directory is judged on the target.
  const disguised = path.join(allowed, 'innocent.md')
  await fsp.symlink(path.join(allowed, '.ssh', 'payload.txt'), disguised)
  await assert.rejects(() => attachFromPath(fresh, id, disguised, undefined, opts), /hidden file or inside a hidden directory/)
  // A credential directory is refused even when a root sits inside it.
  await assert.rejects(() => attachFromPath(fresh, id, path.join(allowed, '.ssh', 'payload.txt'), 'k.md', { allowedRoots: [path.join(allowed, '.ssh')] }), /hidden file or inside a hidden directory/)
  // System locations stay refused even under a root that includes them.
  for (const system of ['/etc/hosts', '/dev/null']) {
    await assert.rejects(() => attachFromPath(fresh, id, system, 'system.md', { allowedRoots: ['/'] }), /protected system location/, system)
  }
  // A directory and a FIFO are not regular files — the FIFO is refused
  // without being opened, so the call does not hang.
  const folder = path.join(allowed, 'folder')
  await fsp.mkdir(folder)
  await assert.rejects(() => attachFromPath(fresh, id, folder, 'folder.md', opts), /not a regular file/)
  const fifo = path.join(allowed, 'pipe')
  execFileSync('mkfifo', [fifo])
  await assert.rejects(() => attachFromPath(fresh, id, fifo, 'pipe.md', opts), /not a regular file/)
  assert.ok((await fsp.lstat(fifo)).isFIFO(), 'the FIFO stays')
  // An empty root list refuses everything; a missing list is a caller bug.
  await assert.rejects(() => attachFromPath(fresh, id, ok, undefined, { allowedRoots: [] }), /not under an allowed source directory/)
  await assert.rejects(() => attachFromPath(fresh, id, ok, undefined), /allowedRoots/)
  // Nothing refused was stored, and every source is exactly as planted.
  const stored = (await fsp.readdir(path.join(fresh, id))).filter((name) => name !== 'node.md' && name !== '__edges__')
  assert.deepEqual(stored, ['meeting-notes.md'])
  await allUntouched()
  for (const dir of [fresh, allowed, elsewhere, sibling]) await fsp.rm(dir, { recursive: true, force: true })
})

// F38 (#58): open handoffs — the note a session leaves its successor, live
// until something closes it.
test('openHandoffs lists live handoff nodes newest first and drops closed ones', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-handoff-'))
  assert.deepEqual(openHandoffs(path.join(fresh, 'nowhere')), [])
  assert.deepEqual(openHandoffs(fresh), [])
  await createNode(fresh, { description: 'ordinary fact', type: 'journal' })
  const h1 = await createNode(fresh, { description: 'cursor codec half done, blocked on Sample benchmark', type: 'handoff', now: Date.parse('2026-02-01T12:00:00Z') })
  const h2 = await createNode(fresh, { description: 'K11 pricing draft awaiting user confirmation', type: 'handoff', now: Date.parse('2026-03-01T12:00:00Z') })
  assert.deepEqual(openHandoffs(fresh).map((h) => h.id), [h2, h1])
  assert.equal(openHandoffs(fresh)[0].description, 'K11 pricing draft awaiting user confirmation')
  // Superseding closes: the banner must not outlive the work.
  const done = await createNode(fresh, { description: 'cursor codec shipped', type: 'journal' })
  await supersede(fresh, h1, done)
  assert.deepEqual(openHandoffs(fresh).map((h) => h.id), [h2])
  // Retyping closes too — the history stays, the pin goes.
  await updateNode(fresh, h2, { type: 'thread' })
  assert.deepEqual(openHandoffs(fresh), [])
  // And clearing the type back to untyped also closes.
  const h3 = await createNode(fresh, { description: 'left open then untyped', type: 'handoff' })
  assert.equal(openHandoffs(fresh).length, 1)
  await updateNode(fresh, h3, { type: '' })
  assert.deepEqual(openHandoffs(fresh), [])
  await fsp.rm(fresh, { recursive: true, force: true })
})

// F61 (#106): the same scan, widened. The close-out sweep needs `thread` state
// too (in-flight work inside a session, F45) and needs the BODIES — a pending
// item lives in the list, not in the description.
test('openWorkState carries handoff and thread bodies, and closes the same way', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-work-state-'))
  assert.deepEqual(openWorkState(path.join(fresh, 'nowhere')), [])
  await createNode(fresh, { description: 'ordinary fact', body: 'nothing pending here', type: 'journal' })
  const thread = await createNode(fresh, { description: '演练许可调研清单', body: '7. KORVAL演练许可分类:检索中', type: 'thread', now: Date.parse('2026-02-01T12:00:00Z') })
  const handoff = await createNode(fresh, { description: '交接:三项查询未返回', body: '- Fern会 结果未返回', type: 'handoff', now: Date.parse('2026-03-01T12:00:00Z') })
  assert.deepEqual(openWorkState(fresh), [
    { id: handoff, type: 'handoff', description: '交接:三项查询未返回', body: '- Fern会 结果未返回' },
    { id: thread, type: 'thread', description: '演练许可调研清单', body: '7. KORVAL演练许可分类:检索中' },
  ], 'newest first, bodies included, other kinds left out')
  // Closed is closed, whichever way: superseded, or retyped out of the kinds.
  const done = await createNode(fresh, { description: 'Fern会纪要已存储', type: 'journal' })
  await supersede(fresh, handoff, done)
  await updateNode(fresh, thread, { type: 'decision' })
  assert.deepEqual(openWorkState(fresh), [])
  // The banner's view is this scan narrowed to handoffs.
  const still = await createNode(fresh, { description: 'still open', body: 'pending: the benchmark', type: 'thread' })
  assert.deepEqual(openWorkState(fresh).map((n) => n.id), [still])
  assert.deepEqual(openHandoffs(fresh), [])
  await fsp.rm(fresh, { recursive: true, force: true })
})

// F59 (#103): the one-deep pre-rewrite snapshot. QA pass 6 / ledger #33
// counted three live losses in one pass through the in-place body-rewrite
// path — and an in-place write keeps no history, so nothing could be put
// back. The snapshot is the operator's recovery file; these tests pin its
// whole lifecycle: written only on a body change, byte-faithful, one deep,
// invisible to every listing surface, and it travels (and dies) with its node.
describe('the pre-rewrite snapshot (F59, #103)', () => {
  const prevOf = (base, id) => fsp.readFile(path.join(base, id, PREV_NODE_FILE), 'utf8')

  test('a body change snapshots the prior node.md byte-for-byte; a second change overwrites, one deep', async () => {
    // The on-disk name is contract — bash-side writers and operators reach
    // for the literal, not the export.
    assert.equal(PREV_NODE_FILE, '.node.md.prev')
    const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-prev-'))
    const id = await createNode(fresh, { description: 'guest wifi access', body: 'the password is cedarloop-88' })
    // Creating writes no snapshot — there is no prior to protect.
    await assert.rejects(() => fsp.lstat(path.join(fresh, id, '.node.md.prev')))
    // Byte-fidelity is against the RAW file, not a re-render: hand the node a
    // shape parseNode normalizes away (unknown frontmatter, a blank-padded
    // body) and the snapshot must still be exactly those bytes.
    const raw = `---\ndescription: guest wifi access\ncreated: 2026-08-18\ncustom: an external writer put this here\n---\n\n\n\nthe password is cedarloop-88\n`
    await fsp.writeFile(path.join(fresh, id, 'node.md'), raw, 'utf8')
    await updateNode(fresh, id, { body: 'cleared during a routine sweep' }, Date.parse('2026-08-24'))
    assert.equal(await prevOf(fresh, id), raw, 'the snapshot is the prior on-disk file, byte for byte')
    // A second body change replaces the snapshot with the newer prior — one
    // deep, never a rotation.
    const between = await fsp.readFile(path.join(fresh, id, 'node.md'), 'utf8')
    await updateNode(fresh, id, { body: 'third body' }, Date.parse('2026-08-25'))
    assert.equal(await prevOf(fresh, id), between)
    assert.doesNotMatch(await prevOf(fresh, id), /cedarloop-88/, 'the older prior is gone — one deep means one')
    assert.deepEqual((await fsp.readdir(path.join(fresh, id))).filter((name) => name.includes('prev')), [PREV_NODE_FILE])
    await fsp.rm(fresh, { recursive: true, force: true })
  })

  test('bytes parseNode cannot represent still snapshot exactly: invalid UTF-8 and an unclosed frontmatter fence', async () => {
    const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-prev-bytes-'))
    // 0xC3 0x28 is not valid UTF-8: a decode round-trip would mint U+FFFD and
    // the damaged original would survive in NEITHER file. The snapshot must be
    // the raw buffer, exactly.
    const id = await createNode(fresh, { description: 'damaged file host', body: 'placeholder' })
    const evil = Buffer.concat([
      Buffer.from('---\ndescription: damaged file host\ncreated: 2026-08-18\n---\n\nbytes an editor mangled: '),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('\n'),
    ])
    await fsp.writeFile(path.join(fresh, id, 'node.md'), evil)
    await updateNode(fresh, id, { body: 'replaced the damaged body' }, Date.parse('2026-08-24'))
    assert.ok((await fsp.readFile(path.join(fresh, id, PREV_NODE_FILE))).equals(evil), 'the invalid bytes survive in the snapshot, un-decoded')
    // An unclosed fence is a file parseNode reads as all-body (description '').
    // The update must proceed exactly as the old loadNode path did, and the
    // snapshot must be the malformed original verbatim.
    const half = await createNode(fresh, { description: 'malformed host', body: 'x' })
    const unclosed = '---\ndescription: never closed\nall of this is body\n'
    await fsp.writeFile(path.join(fresh, half, 'node.md'), unclosed, 'utf8')
    await updateNode(fresh, half, { body: 'a whole new body' }, Date.parse('2026-08-24'))
    assert.equal(await prevOf(fresh, half), unclosed)
    const rewritten = await loadNode(fresh, half)
    assert.equal(rewritten.body, 'a whole new body')
    assert.equal(rewritten.description, '', 'the malformed file parsed as description-less, before and after')
    await fsp.rm(fresh, { recursive: true, force: true })
  })

  test('a snapshot failure fails the update before the body is overwritten', async () => {
    const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-prev-strict-'))
    const id = await createNode(fresh, { description: 'protected fact', body: 'the body that must survive' })
    const before = await fsp.readFile(path.join(fresh, id, 'node.md'))
    // A directory squatting on the snapshot path makes writeAtomic's rename
    // throw — the injectable stand-in for any snapshot-write failure. The
    // ordering contract: the update rejects and node.md is untouched, because
    // the snapshot lands strictly BEFORE the body write.
    await fsp.mkdir(path.join(fresh, id, PREV_NODE_FILE))
    await assert.rejects(() => updateNode(fresh, id, { body: 'the overwrite that must not land' }))
    assert.ok((await fsp.readFile(path.join(fresh, id, 'node.md'))).equals(before), 'the prior node.md is byte-identical — the body was never overwritten')
    await fsp.rm(fresh, { recursive: true, force: true })
  })

  test('description-only, type-only, and no-op updates write no snapshot', async () => {
    const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-prev-noop-'))
    const id = await createNode(fresh, { description: 'stable body', body: 'the fact', type: 'trivia' })
    await updateNode(fresh, id, { description: 'stable body, retitled' })
    await updateNode(fresh, id, { type: 'decision' })
    // An idempotent echo of the same body destroys nothing, so it snapshots
    // nothing — the same resolved-value comparison that keeps `updated` honest.
    await updateNode(fresh, id, { body: 'the fact' })
    await assert.rejects(() => fsp.lstat(path.join(fresh, id, PREV_NODE_FILE)))
    // Once a snapshot exists, the same non-body shapes must leave its BYTES
    // alone — a snapshot only a body change may replace.
    await updateNode(fresh, id, { body: 'the revised fact' })
    const settled = await fsp.readFile(path.join(fresh, id, PREV_NODE_FILE))
    await updateNode(fresh, id, { description: 'retitled again' })
    assert.ok((await fsp.readFile(path.join(fresh, id, PREV_NODE_FILE))).equals(settled))
    await updateNode(fresh, id, { type: 'gotcha' })
    assert.ok((await fsp.readFile(path.join(fresh, id, PREV_NODE_FILE))).equals(settled))
    await updateNode(fresh, id, { body: 'the revised fact' })
    assert.ok((await fsp.readFile(path.join(fresh, id, PREV_NODE_FILE))).equals(settled), 'a no-op echo replaces nothing')
    // Blanking IS a body change — exactly the ledger-#33 delete-by-rewrite
    // shape — so it snapshots. Pins the !== guard against any truthiness slip.
    const preBlank = await fsp.readFile(path.join(fresh, id, 'node.md'))
    await updateNode(fresh, id, { body: '' })
    assert.ok((await fsp.readFile(path.join(fresh, id, PREV_NODE_FILE))).equals(preBlank), 'the blanked body is recoverable')
    await fsp.rm(fresh, { recursive: true, force: true })
  })

  test('supersede snapshots the pre-banner file; merge snapshots both nodes and the absorbed one is archived with its node', async () => {
    const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-prev-lifecycle-'))
    const oldId = await createNode(fresh, { description: 'first cut', body: 'original rationale' })
    const newId = await createNode(fresh, { description: 'revised cut' })
    const preBanner = await fsp.readFile(path.join(fresh, oldId, 'node.md'), 'utf8')
    await supersede(fresh, oldId, newId, Date.parse('2026-08-24'))
    assert.equal(await prevOf(fresh, oldId), preBanner, 'the banner prepend is a body change like any other')
    // Merge touches both bodies: keep gains provenance, absorb gains a banner
    // and moves under .archive/ — the whole dir, snapshot included.
    const keep = await createNode(fresh, { description: 'kept twin', body: 'kept body' })
    const absorb = await createNode(fresh, { description: 'absorbed twin', body: 'absorbed body' })
    const keepPrior = await fsp.readFile(path.join(fresh, keep, 'node.md'), 'utf8')
    const absorbPrior = await fsp.readFile(path.join(fresh, absorb, 'node.md'), 'utf8')
    await mergeNodes(fresh, keep, absorb, Date.parse('2026-08-25'))
    assert.equal(await prevOf(fresh, keep), keepPrior)
    assert.equal(await prevOf(path.join(fresh, ARCHIVE_DIR), absorb), absorbPrior, 'the absorbed snapshot travelled into .archive/ with its node')
    await assert.rejects(() => fsp.lstat(path.join(fresh, absorb, PREV_NODE_FILE)), 'nothing lingers at the old live path')
    await fsp.rm(fresh, { recursive: true, force: true })
  })

  test('no listing surface shows the snapshot and no move chases it to a successor', async () => {
    const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-prev-hidden-'))
    const oldId = await createNode(fresh, { description: 'zvqhidden decision', body: 'zvqhidden v1 qqprevonly' })
    await attach(fresh, oldId, 'notes.md', 'zvqhidden attachment detail')
    await updateNode(fresh, oldId, { body: 'zvqhidden v2' })
    await fsp.lstat(path.join(fresh, oldId, PREV_NODE_FILE)) // it does exist …
    // … but the attachment surfaces never say so.
    assert.deepEqual(await extraFiles(fresh, oldId), ['notes.md'])
    assert.deepEqual((await attachments(fresh, oldId)).map((f) => f.name), ['notes.md'])
    assert.deepEqual((await readNode(fresh, oldId)).files.map((f) => f.name), ['notes.md'])
    // Search: the row's `files` never names it, and the content scan never
    // reads it — the destroyed v1 body must not rank its own node.
    const hit = await search(fresh, 'zvqhidden', 5)
    assert.deepEqual(hit.matches[0].files, ['notes.md'])
    assert.deepEqual(hit.matches[0].matched_in, ['notes.md'])
    // The sharpest form of invisibility: a term that now lives ONLY in the
    // snapshot finds nothing and is reported unmatched — destroyed content
    // never haunts the index.
    const gone = await search(fresh, 'qqprevonly', 5)
    assert.equal(gone.total, 0)
    assert.deepEqual(gone.unmatched, ['qqprevonly'])
    // A supersede moves the attachments and leaves the snapshot where its
    // history happened.
    const successor = await createNode(fresh, { description: 'zvqhidden successor' })
    const { files_moved } = await supersede(fresh, oldId, successor, Date.parse('2026-08-26'))
    assert.equal(files_moved, 1, 'only the attachment moved')
    await fsp.lstat(path.join(fresh, oldId, PREV_NODE_FILE))
    await assert.rejects(() => fsp.lstat(path.join(fresh, successor, PREV_NODE_FILE)))
    await fsp.rm(fresh, { recursive: true, force: true })
  })
})


// F67 (#121): weekday annotation for the date anchors — date-only, UTC, fail-fast.
test('weekdayName resolves calendar days and rejects garbage (F67, #121)', () => {
  assert.equal(weekdayName('2026-08-20'), 'Thursday')
  assert.equal(weekdayName('2026-08-26'), 'Wednesday')
  assert.equal(weekdayName('2028-02-29'), 'Tuesday') // leap day resolves
  assert.equal(weekdayName('2026-01-01'), 'Thursday')
  assert.throws(() => weekdayName('not-a-date'), /invalid calendar date/)
  // V8 would normalize these into March / day+1 — the round-trip must reject them.
  assert.throws(() => weekdayName('2026-02-30'), /invalid calendar date/)
  assert.throws(() => weekdayName('2026-02-29'), /invalid calendar date/)
  assert.throws(() => weekdayName('2026-04-31'), /invalid calendar date/)
})

test('F83: zero-signal index ties break newest first (#193)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-f83-'))
  const now = Date.parse('2026-09-03T00:00:00Z')
  // Same `created` day for all, no access anywhere: exactly the DEMO shape where
  // 405 of 465 nodes tied at score 0 and the ascending-id tie-break kept the
  // OLDEST unread nodes in the index while the newest fell off it.
  // Distinct `now`s so the ULIDs order by creation (same ms would leave the
  // random suffix to decide); all fall on one day, so recency stays equal.
  const mk = (d, offsetMs) => createNode(fresh, { description: d, now: now + offsetMs })
  const oldest = await mk('oldest unread node', 0)
  const middle = await mk('middle unread node', 1000)
  const newest = await mk('newest unread node', 2000)
  const ids = (lines) => lines.map((line) => line.slice(0, 26))

  assert.deepEqual(ids(await indexLines(fresh, 10, undefined, now)), [newest, middle, oldest], 'a zero-signal tie ranks newest first')
  assert.deepEqual(ids(indexLinesSync(fresh, 10, undefined, now)), [newest, middle, oldest], 'the sync index agrees')
  // And the cap keeps the newest, not the oldest: the DEMO failure in miniature.
  const capped = await indexLines(fresh, 1, undefined, now)
  assert.deepEqual(ids(capped.slice(0, 1)), [newest], 'a truncated index keeps the newest tied node')
  assert.equal(capped.length, 2)
  assert.match(capped[1], /^… 2 more nodes;/, 'the two dropped nodes are still reachable by search')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('F83: the id tie-break compares code units, which locale collation would not (#193)', () => {
  // A ULID pair that Crockford base32 and Czech collation disagree about:
  // '…CH…' is the OLDER prefix by code unit, but cs- sorts "CH" as one letter
  // filed after "H", i.e. after '…D0…'. Feeding that to a descending sort keeps
  // the OLDER node — the very failure F83 fixes — and puts the injected index
  // out of step with MAP.md, which compares code points in graph-maintain.
  const older = '01M0CH000000000000000000AA'
  const newer = '01M0D0000000000000000000AA'
  assert.ok(older < newer, 'by code unit the CH prefix is the older id')

  assert.equal(compareIdsNewestFirst(older, newer), 1, 'the newer id sorts first')
  assert.equal(compareIdsNewestFirst(newer, older), -1, 'and the older one sorts second')
  assert.equal(compareIdsNewestFirst(older, older), 0, 'equal ids tie')
  // Antisymmetry, or Array#sort is free to produce either order.
  assert.equal(compareIdsNewestFirst(older, newer), -compareIdsNewestFirst(newer, older))
  assert.deepEqual([older, newer].sort(compareIdsNewestFirst), [newer, older])

  // The hazard itself, so the reason for not using localeCompare is visible
  // here rather than only in a comment. Skipped on a Node built without the
  // Czech collation data (small-icu), where every locale falls back to root.
  const hasCzech = typeof Intl === 'object' && Intl.Collator !== undefined
    && Intl.Collator.supportedLocalesOf(['cs']).length > 0
    && 'CH'.localeCompare('D0', 'cs') > 0
  if (hasCzech) {
    assert.ok(older.localeCompare(newer, 'cs') > 0, 'cs- collation calls the older id the greater one')
    // So the descending-localeCompare form this test guards against would put
    // the OLDER id on top, exactly opposite to the shipped comparator.
    const byCollation = [older, newer].sort((a, b) => b.localeCompare(a, 'cs'))
    assert.deepEqual(byCollation, [older, newer], 'a descending localeCompare ranks the older id first')
  }
})

test('F84: edge degree ranks a hub before anyone reads it (#194)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-degree-'))
  const now = Date.parse('2026-09-03T00:00:00Z')
  // One created day, one read in the whole graph: the DEMO shape where 405 of
  // 465 nodes carried no access at all and the access terms left them tied.
  // Distinct `now`s so the ULIDs are monotonic — same-ms ids would leave the
  // random suffix to decide, and the tie-break assertions below with it. All
  // land on one day, so the recency term stays equal.
  let minted = 0
  const mk = (d) => createNode(fresh, { description: d, now: now + minted++ })
  const hub = await mk('hub: the node the others hang off')
  const a = await mk('spoke a')
  const b = await mk('spoke b')
  const c = await mk('spoke c')
  const readOnce = await mk('read once, linked to nothing')
  // Plain edges are symmetric (ADR 0012): each addEdge writes an entry on both
  // sides, so the hub reaches degree 3 and every spoke degree 1.
  for (const spoke of [a, b, c]) await addEdge(fresh, hub, spoke)
  await touchRead(fresh, readOnce, now)
  const ids = (lines) => lines.map((line) => line.slice(0, 26))

  // Default weights: hub 3·degree, readOnce 2·read, spokes 1·degree, and the
  // shared created day gives everyone the same recency term.
  const order = ids(await indexLines(fresh, 10, undefined, now))
  assert.equal(order[0], hub, 'the unread hub leads on degree alone')
  assert.ok(order.indexOf(hub) < order.indexOf(readOnce), 'degree lifts the hub past the one node anybody read')
  assert.deepEqual(ids(indexLinesSync(fresh, 10, undefined, now)), order, 'the sync index agrees')

  // The term is a knob, not a rewrite: at weight 0 the ranking is the pure
  // access one again, and the read node is back in front of the hub.
  const noDegree = { ...DEFAULT_RANK_WEIGHTS, degree: 0 }
  const without = ids(await indexLines(fresh, 10, noDegree, now))
  assert.ok(without.indexOf(readOnce) < without.indexOf(hub), 'at degree 0 a single read beats an unread hub')
  assert.deepEqual(ids(indexLinesSync(fresh, 10, noDegree, now)), without, 'the sync index agrees at degree 0')

  // Dotfiles in __edges__ are bookkeeping, not edges: the typed-edge sidecar
  // must not inflate a spoke's degree.
  await fsp.writeFile(path.join(fresh, a, '__edges__', '.edge-types'), `${hub} relates-to\n`)
  assert.deepEqual(ids(await indexLines(fresh, 10, undefined, now)), order, 'the .edge-types sidecar adds no degree')
  assert.deepEqual(ids(indexLinesSync(fresh, 10, undefined, now)), order, 'the sync index agrees')
  await fsp.rm(fresh, { recursive: true, force: true })
})

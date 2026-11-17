// Unit tests for the pure parsers (§6 "Unit tests").

import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

import { SafeRoot } from '../src/server/fs-safe.ts'
import { parseAccessLog, readAccessLines } from '../src/server/graph/access.ts'
import { buildGraphSnapshot, parseMapOrder } from '../src/server/graph/build.ts'
import { findSupersededBy, isOpenHandoff, parseNodeFile, splitFrontmatter } from '../src/server/graph/frontmatter.ts'
import { parseEdgeTypes, resolveEdgeType, type Sidecar } from '../src/server/graph/sidecar.ts'
import { isValidAttachmentName, isValidNodeId, realFileInside } from '../src/server/guard.ts'
import {
  aggregateObservation,
  minimiseEvent,
  parseObservationText,
  USAGE_KEYS,
  withTaskState,
} from '../src/server/usage/observation.ts'
import { dayKeys, localDayKey, nearestRank, percentileOf, computeStats } from '../src/server/usage/stats.ts'
import type { RunSummary } from '../src/shared/types.ts'
import {
  appendAccess,
  cleanupTemps,
  completeObservation,
  edgeAdd,
  jsonl,
  newNode,
  tempDir,
  treeSignature,
  writeAttachment,
} from './helpers.ts'

/** Aggregate a capture and apply a task state, as the run index does. */
function reduce(parse: ReturnType<typeof parseObservationText>, terminal = true) {
  return withTaskState(aggregateObservation(parse), terminal)
}

afterAll(() => cleanupTemps())

// ---- frontmatter ---------------------------------------------------------

describe('frontmatter parser', () => {
  test('reads line-oriented key: value fields, not YAML', () => {
    const parsed = parseNodeFile(
      ['---', 'description: a node: with colons', 'created: 2026-10-01', 'type: decision', '---', '', 'body line'].join('\n'),
    )
    expect(parsed.description).toBe('a node: with colons')
    expect(parsed.created).toBe('2026-10-01')
    expect(parsed.type).toBe('decision')
    expect(parsed.updated).toBeNull()
    expect(parsed.body).toBe('body line')
    expect(parsed.warning).toBeNull()
  })

  test('drops one blank separator line after the delimiter', () => {
    const { body } = splitFrontmatter('---\ndescription: x\n---\n\ntext\n')
    expect(body).toBe('text\n')
  })

  test('flags malformed frontmatter without throwing', () => {
    const parsed = parseNodeFile('no frontmatter here\n')
    expect(parsed.warning).toBe('malformed frontmatter')
    expect(parsed.description).toBe('')
    expect(parsed.type).toBeNull()
  })

  test('treats an unclosed frontmatter block as malformed', () => {
    expect(parseNodeFile('---\ndescription: x\n').warning).toBe('malformed frontmatter')
  })

  test('banner: supersededBy comes from the first 10 body lines only', () => {
    expect(findSupersededBy('Superseded by 01J00000000000000000000001 on 2026-11-01.')).toBe('01J00000000000000000000001')
    const late = `${Array.from({ length: 10 }, () => 'filler').join('\n')}\nSuperseded by 01J00000000000000000000001 on 2026-11-01.`
    expect(findSupersededBy(late)).toBeNull()
  })

  test('banner must start the line and name a 26-char ULID', () => {
    expect(findSupersededBy('  Superseded by 01J00000000000000000000001 on 2026-11-01.')).toBe('01J00000000000000000000001')
    expect(findSupersededBy('Superseded by 01J0000000000000000000000 on 2026-11-01.')).toBeNull()
    expect(findSupersededBy('Note: Superseded by 01J00000000000000000000001 on 2026-11-01.')).toBeNull()
  })

  test('open handoff = type handoff and not superseded', () => {
    expect(isOpenHandoff('handoff', null)).toBe(true)
    expect(isOpenHandoff('handoff', '01J00000000000000000000001')).toBe(false)
    expect(isOpenHandoff('thread', null)).toBe(false)
  })
})

// ---- edge types ----------------------------------------------------------

describe('edgeTypeOf classification', () => {
  const sidecars = new Map<string, Sidecar>([
    ['A', new Map([['B', 'supersedes']] as const) as Sidecar],
    ['B', new Map([['C', 'relates-to']] as const) as Sidecar],
    ['C', new Map([['D', 'follows-from']] as const) as Sidecar],
  ])

  test("the source's own sidecar line wins", () => {
    expect(resolveEdgeType(sidecars, 'A', 'B')).toBe('supersedes')
  })

  test('a symmetric peer line counts from either side', () => {
    expect(resolveEdgeType(sidecars, 'C', 'B')).toBe('relates-to')
    expect(resolveEdgeType(sidecars, 'B', 'C')).toBe('relates-to')
  })

  test("a directed peer line is never inverted onto the source", () => {
    expect(resolveEdgeType(sidecars, 'D', 'C')).toBeUndefined()
  })

  test('no line at all means plain (undefined)', () => {
    expect(resolveEdgeType(sidecars, 'A', 'Z')).toBeUndefined()
  })

  test('sidecar parsing ignores malformed and unknown types', () => {
    const { types, malformed } = parseEdgeTypes(
      ['01J00000000000000000000001 supersedes', 'garbage', '01J00000000000000000000017 sideways', ''].join('\n'),
    )
    expect(types.get('01J00000000000000000000001')).toBe('supersedes')
    expect(types.size).toBe(1)
    expect(malformed).toBe(2)
  })
})

// ---- edges over a real fixture graph -------------------------------------

describe('edge dedupe over a real fixture graph', () => {
  test('a plain pair is one edge with two halves; retyping keeps one directed edge', () => {
    const root = tempDir()
    const a = newNode(root, 'node a')
    const b = newNode(root, 'node b')
    const c = newNode(root, 'node c')
    const d = newNode(root, 'node d')

    edgeAdd(root, a, b) // plain pair
    edgeAdd(root, c, d, 'supersedes') // directed, one symlink
    edgeAdd(root, a, c) // plain pair, then retyped (reverse symlink survives)
    edgeAdd(root, a, c, 'supersedes')
    edgeAdd(root, d, c, 'follows-from') // opposite directed edge

    const snapshot = buildGraphSnapshot(root, 1)
    const pair = snapshot.edges.filter((e) => (e.source === a && e.target === b) || (e.source === b && e.target === a))
    expect(pair).toHaveLength(1)
    expect(pair[0]).toMatchObject({ directed: false, type: 'plain', halves: 2 })
    const pairEdge = pair[0] as { source: string; target: string }
    expect(pairEdge.source < pairEdge.target).toBe(true)

    const ac = snapshot.edges.filter(
      (e) => (e.source === a && e.target === c) || (e.source === c && e.target === a),
    )
    expect(ac).toHaveLength(1)
    expect(ac[0]).toMatchObject({ source: a, target: c, type: 'supersedes', directed: true, halves: 2 })

    const cd = snapshot.edges.filter(
      (e) =>
        (e.source === c && e.target === d) ||
        (e.source === d && e.target === c),
    )
    expect(cd).toHaveLength(2)
    expect(cd.map((e) => `${e.source}->${e.target}:${e.type}`).sort()).toEqual(
      [`${c}->${d}:supersedes`, `${d}->${c}:follows-from`].sort(),
    )
  })

  test('a single untyped symlink is a half edge and a warning', () => {
    const root = tempDir()
    const a = newNode(root, 'half a')
    const b = newNode(root, 'half b')
    fs.mkdirSync(path.join(root, a, '__edges__'), { recursive: true })
    fs.symlinkSync(`../../${b}`, path.join(root, a, '__edges__', b))

    const snapshot = buildGraphSnapshot(root, 1)
    expect(snapshot.edges).toHaveLength(1)
    // Symmetric edges always report the lexicographically smaller id first.
    const [lo, hi] = a < b ? [a, b] : [b, a]
    expect(snapshot.edges[0]).toMatchObject({ source: lo, target: hi, halves: 1, type: 'plain' })
    expect(snapshot.warnings.some((warning) => warning.includes('half edge'))).toBe(true)
  })

  test('a dangling symlink is a warning, not an edge', () => {
    const root = tempDir()
    const a = newNode(root, 'dangling owner')
    const missing = '01J00000000000000000000001'
    fs.mkdirSync(path.join(root, a, '__edges__'), { recursive: true })
    fs.symlinkSync(`../../${missing}`, path.join(root, a, '__edges__', missing))

    const snapshot = buildGraphSnapshot(root, 1)
    expect(snapshot.edges).toHaveLength(0)
    expect(snapshot.warnings.some((warning) => warning.startsWith('dangling edge'))).toBe(true)
  })

  test('a legacy non-canonical relates-to line still classifies the pair', () => {
    const root = tempDir()
    const a = newNode(root, 'legacy a')
    const b = newNode(root, 'legacy b')
    edgeAdd(root, a, b)
    const [lo, hi] = a < b ? [a, b] : [b, a]
    // Write the symmetric line on the LARGER id's side — the legacy layout.
    fs.writeFileSync(path.join(root, hi, '__edges__', '.edge-types'), `${lo} relates-to\n`, 'utf8')

    const snapshot = buildGraphSnapshot(root, 1)
    expect(snapshot.edges).toHaveLength(1)
    expect(snapshot.edges[0]?.type).toBe('relates-to')
    expect(snapshot.edges[0]?.directed).toBe(false)
  })

  test('AC-003: banner + sidecar agree; sidecar alone is a disagreement warning', () => {
    const root = tempDir()
    const a = newNode(root, 'successor')
    const b = newNode(root, 'superseded with banner', {
      type: 'handoff',
      body: `Superseded by ${a} on 2026-11-01.\n\nrest of body`,
    })
    const c = newNode(root, 'no banner')
    edgeAdd(root, a, b, 'supersedes')
    edgeAdd(root, a, c, 'supersedes')

    const snapshot = buildGraphSnapshot(root, 1)
    const nodeB = snapshot.nodeById.get(b)
    expect(nodeB?.superseded).toBe(true)
    expect(nodeB?.supersededBy).toBe(a)
    expect(nodeB?.openHandoff).toBe(false) // a superseded handoff is not open
    expect(snapshot.openHandoffs).not.toContain(b)
    expect(snapshot.warnings.some((warning) => warning.includes('supersedes without banner'))).toBe(true)
    const edge = snapshot.edges.find((e) => e.source === a && e.target === b)
    expect(edge).toMatchObject({ directed: true, type: 'supersedes' })
  })

  test('a banner without a supersedes sidecar is also a warning', () => {
    const root = tempDir()
    const a = newNode(root, 'named successor')
    const b = newNode(root, 'banner only', { body: `Superseded by ${a} on 2026-11-01.` })
    const snapshot = buildGraphSnapshot(root, 1)
    expect(snapshot.nodeById.get(b)?.supersededBy).toBe(a)
    expect(snapshot.warnings.some((warning) => warning.includes('banner without supersedes sidecar'))).toBe(true)
  })
})

// ---- access logs ---------------------------------------------------------

describe('access aggregation', () => {
  test('AC-016: symmetric edge strength sums both sides and legacy logs; self-lines are visits', () => {
    const root = tempDir()
    const a = newNode(root, 'accessed a')
    const b = newNode(root, 'accessed b')
    edgeAdd(root, a, b)
    appendAccess(root, a, b, '2026-11-01T00:00:00Z')
    appendAccess(root, a, b, '2026-11-02T00:00:00Z')
    appendAccess(root, b, a, '2026-11-03T00:00:00Z')
    appendAccess(root, a, b, '2026-10-30T00:00:00Z', true) // legacy in-node log
    appendAccess(root, a, a, '2026-11-04T00:00:00Z')
    appendAccess(root, a, a, '2026-11-04T01:00:00Z')
    appendAccess(root, a, a, '2026-11-04T02:00:00Z')

    const snapshot = buildGraphSnapshot(root, 1)
    expect(snapshot.edges).toHaveLength(1)
    expect(snapshot.edges[0]?.accessCount).toBe(4)
    expect(snapshot.edges[0]?.lastAccess).toBe('2026-11-03T00:00:00Z')
    expect(snapshot.nodeById.get(a)?.visitCount).toBe(3)
    expect(snapshot.nodeById.get(b)?.visitCount).toBe(0)
  })

  test('readAccessLines merges .access and legacy accessed.log', () => {
    const root = tempDir()
    const id = newNode(root, 'merge logs')
    appendAccess(root, id, id, '2026-11-01T00:00:00Z')
    appendAccess(root, id, id, '2026-11-02T00:00:00Z', true)
    const safe = SafeRoot.open(root)
    expect(safe).not.toBeNull()
    const { lines } = readAccessLines(safe as SafeRoot, id)
    expect(lines).toHaveLength(2)
  })

  test('malformed access lines are dropped and reported', () => {
    const sink: { dst: string; src: string; at: string; ms: number }[] = []
    const malformed = parseAccessLog('not-a-ulid 2026-11-01T00:00:00Z\n01J00000000000000000000001 not-a-date\n', 'X', sink)
    expect(malformed).toBe(2)
    expect(sink).toHaveLength(0)
  })

  test('recentAccess is newest first and includes incoming lines', () => {
    const root = tempDir()
    const a = newNode(root, 'recent a')
    const b = newNode(root, 'recent b')
    edgeAdd(root, a, b)
    appendAccess(root, a, b, '2026-11-01T00:00:00Z')
    appendAccess(root, b, a, '2026-11-05T00:00:00Z')
    const snapshot = buildGraphSnapshot(root, 1)
    const recentB = snapshot.nodeById.get(b)?.recentAccess ?? []
    // b's own line (b -> a) is newest, then the incoming line (a -> b).
    expect(recentB[0]).toMatchObject({ dst: a, src: b, at: '2026-11-05T00:00:00Z' })
    expect(recentB[1]).toMatchObject({ dst: b, src: a, at: '2026-11-01T00:00:00Z' })
  })
})

// ---- attachments ---------------------------------------------------------

describe('attachment filter', () => {
  test('AC-018: only plain files; dotfiles, accessed.log and directories are excluded', () => {
    const root = tempDir()
    const id = newNode(root, 'attachments')
    writeAttachment(root, id, 'notes.md', '# notes\n')
    writeAttachment(root, id, 'observation.txt', 'obs\n')
    writeAttachment(root, id, '.node.md.prev', 'prev\n')
    writeAttachment(root, id, '.notes.md.prev', 'prev\n')
    writeAttachment(root, id, '..attach-x', 'tmp\n')
    writeAttachment(root, id, 'accessed.log', 'legacy\n')
    writeAttachment(root, id, 'subdir/inner.txt', 'inner\n')
    writeAttachment(root, id, '.DS_Store', 'junk')

    const snapshot = buildGraphSnapshot(root, 1)
    const node = snapshot.nodeById.get(id)
    expect(node?.attachments.map((attachment) => attachment.name)).toEqual(['notes.md', 'observation.txt'])
    expect(node?.attachmentCount).toBe(2)
  })
})

// ---- MAP.md order --------------------------------------------------------

describe('MAP.md order', () => {
  test('ranks column-0 rows only; the indented handoff header is not a row', () => {
    const text = [
      'Open handoff — unfinished work:',
      '  01J00000000000000000000001 — pinned handoff',
      '',
      '01J00000000000000000000017 — first row',
      '01J00000000000000000000018 — second row [superseded by 01J00000000000000000000017]',
    ].join('\n')
    const index = parseMapOrder(text)
    expect(index.order).toEqual(['01J00000000000000000000017', '01J00000000000000000000018'])
    expect(index.rank.get('01J00000000000000000000018')).toBe(1)
    expect(index.rank.has('01J00000000000000000000001')).toBe(false)
  })

  test('a Node missing from MAP.md has mapRank null', () => {
    const root = tempDir()
    const listed = newNode(root, 'listed')
    const unlisted = newNode(root, 'unlisted')
    fs.writeFileSync(path.join(root, 'MAP.md'), `${listed} — listed\n`, 'utf8')
    const snapshot = buildGraphSnapshot(root, 1)
    expect(snapshot.nodeById.get(listed)?.mapRank).toBe(0)
    expect(snapshot.nodeById.get(unlisted)?.mapRank).toBeNull()
  })
})

// ---- path guard ----------------------------------------------------------

describe('path guard', () => {
  test('node ids must be 26-char Crockford ULIDs', () => {
    expect(isValidNodeId('01J00000000000000000000001')).toBe(true)
    expect(isValidNodeId('01J0000000000000000000000')).toBe(false)
    expect(isValidNodeId('01J0000000000000000000000I')).toBe(false) // I is not Crockford
    expect(isValidNodeId('../../etc/passwd')).toBe(false)
  })

  test('attachment names are single non-dot segments', () => {
    expect(isValidAttachmentName('notes.md')).toBe(true)
    expect(isValidAttachmentName('.node.md.prev')).toBe(false)
    expect(isValidAttachmentName('../x')).toBe(false)
    expect(isValidAttachmentName('a/b')).toBe(false)
    expect(isValidAttachmentName('')).toBe(false)
    expect(isValidAttachmentName('..')).toBe(false)
  })

  test('realFileInside rejects a symlink escaping the graph root', () => {
    const root = tempDir()
    const outside = tempDir()
    const secret = path.join(outside, 'secret.txt')
    fs.writeFileSync(secret, 'outside content')
    fs.symlinkSync(secret, path.join(root, 'escape.txt'))
    expect(realFileInside(root, path.join(root, 'escape.txt'))).toBeNull()
    const inside = path.join(root, 'inside.txt')
    fs.writeFileSync(inside, 'ok')
    // The result is the CANONICAL path (macOS /var -> /private/var).
    expect(realFileInside(root, inside)).toBe(fs.realpathSync(inside))
  })
})

// ---- usage summation -----------------------------------------------------

describe('observation usage summation', () => {
  test('keeps only type, seq, requestId and usage (SEC-006)', () => {
    const event = minimiseEvent({
      v: 1,
      seq: 7,
      tMs: 999,
      type: 'request_end',
      requestId: 'r1',
      outcome: 'finish',
      message: 'SECRET TASK TEXT',
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 1, junk: 5 },
    })
    expect(event).toEqual({
      type: 'request_end',
      seq: 7,
      requestId: 'r1',
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 1 },
    })
    expect(JSON.stringify(event)).not.toContain('SECRET')
  })

  test('a complete capture sums the first request_end per requestId', () => {
    const aggregate = reduce(parseObservationText(completeObservation()), true)
    expect(aggregate.usageStatus).toBe('complete')
    expect(aggregate.usage).toMatchObject({ inputTokens: 1000, outputTokens: 100, totalTokens: 1100 })
  })

  test('AC-007(c): a duplicated request_end counts once', () => {
    const text = jsonl([
      { seq: 1, type: 'request_start', requestId: 'r1' },
      { seq: 2, type: 'request_end', requestId: 'r1', usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } },
      { seq: 3, type: 'request_end', requestId: 'r1', usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } },
    ])
    const aggregate = reduce(parseObservationText(text), true)
    expect(aggregate.usageStatus).toBe('complete')
    expect(aggregate.usage?.totalTokens).toBe(11)
  })

  test('AC-007(a): no observation and no usage both mean unknown', () => {
    expect(reduce(parseObservationText(''), true).usageStatus).toBe('unknown')
    const noUsage = jsonl([{ seq: 1, type: 'request_start', requestId: 'r1' }])
    expect(reduce(parseObservationText(noUsage), true).usageStatus).toBe('unknown')
  })

  test('AC-007(b): a capped event makes the run partial and keeps its tokens', () => {
    const text = jsonl([
      { seq: 1, type: 'request_start', requestId: 'r1' },
      { seq: 2, type: 'request_end', requestId: 'r1', usage: { inputTokens: 500, outputTokens: 50, totalTokens: 550 } },
      { seq: 3, type: 'capped', reason: 'events' },
    ])
    const aggregate = reduce(parseObservationText(text), true)
    expect(aggregate.usageStatus).toBe('partial')
    expect(aggregate.usage?.totalTokens).toBe(550)
    expect(aggregate.reasons).toContain('capped')
  })

  test('sink_error, seq gap, open request and non-terminal task are all partial', () => {
    const sink = jsonl([
      { seq: 1, type: 'request_start', requestId: 'r1' },
      { seq: 2, type: 'request_end', requestId: 'r1', usage: { totalTokens: 5 } },
      { seq: 3, type: 'sink_error', reason: 'write_failed' },
    ])
    expect(reduce(parseObservationText(sink), true).usageStatus).toBe('partial')

    const gap = jsonl([
      { seq: 1, type: 'request_start', requestId: 'r1' },
      { seq: 5, type: 'request_end', requestId: 'r1', usage: { totalTokens: 5 } },
    ])
    expect(reduce(parseObservationText(gap), true).usageStatus).toBe('partial')

    const open = jsonl([
      { seq: 1, type: 'request_start', requestId: 'r1' },
      { seq: 2, type: 'request_end', requestId: 'r1', usage: { totalTokens: 5 } },
      { seq: 3, type: 'request_start', requestId: 'r2' },
    ])
    expect(reduce(parseObservationText(open), true).usageStatus).toBe('partial')

    expect(reduce(parseObservationText(completeObservation()), false).usageStatus).toBe('partial')
  })

  test('a torn final line is skipped, not counted as malformed', () => {
    const good = completeObservation()
    const parsed = parseObservationText(`${good}{"v":1,"seq":3,"type":"request_st`)
    expect(parsed.tornLastLine).toBe(true)
    expect(parsed.malformedLines).toBe(0)
    expect(parsed.events).toHaveLength(2)
  })

  test('an absent usage key is never treated as 0', () => {
    const text = jsonl([{ seq: 1, type: 'request_end', requestId: 'r1', usage: { inputTokens: 10, totalTokens: 10 } }])
    const aggregate = reduce(parseObservationText(text), true)
    expect(aggregate.usage).toEqual({ inputTokens: 10, totalTokens: 10 })
    expect('outputTokens' in (aggregate.usage ?? {})).toBe(false)
  })

  // ---- #5: component coverage across requests ---------------------------

  test('#5: a component reported by only some requests is omitted, not under-summed', () => {
    const text = jsonl([
      { seq: 1, type: 'request_start', requestId: 'r1' },
      { seq: 2, type: 'request_end', requestId: 'r1', usage: { totalTokens: 100 } },
      { seq: 3, type: 'request_start', requestId: 'r2' },
      { seq: 4, type: 'request_end', requestId: 'r2', usage: { inputTokens: 200 } },
    ])
    const aggregate = reduce(parseObservationText(text), true)
    // `totalTokens` was reported by ONE of two requests: 100 is not the run's
    // total, so it must never be presented as one.
    expect('totalTokens' in (aggregate.usage ?? {})).toBe(false)
    // `inputTokens` is likewise only in the second request.
    expect('inputTokens' in (aggregate.usage ?? {})).toBe(false)
    // An incomplete TOTAL means the run is not exactly known, so it cannot feed
    // exact token statistics.
    expect(aggregate.usageStatus).toBe('partial')
    expect(aggregate.reasons.join(',')).toContain('incomplete_components')
    expect(aggregate.reasons.join(',')).toContain('totalTokens')
  })

  test('#5: a secondary component missing from some requests does not degrade the run', () => {
    // The production case: totalTokens on every request, cacheReadTokens only on
    // the requests that hit the cache.
    const text = jsonl([
      { seq: 1, type: 'request_start', requestId: 'r1' },
      { seq: 2, type: 'request_end', requestId: 'r1', usage: { inputTokens: 10, totalTokens: 11, cacheReadTokens: 4 } },
      { seq: 3, type: 'request_start', requestId: 'r2' },
      { seq: 4, type: 'request_end', requestId: 'r2', usage: { inputTokens: 20, totalTokens: 22 } },
    ])
    const aggregate = reduce(parseObservationText(text), true)
    expect(aggregate.usageStatus).toBe('complete')
    // The miss-only component is dropped rather than reported as a partial sum...
    expect('cacheReadTokens' in (aggregate.usage ?? {})).toBe(false)
    // ...while the total, which every request reported, stays exact.
    expect(aggregate.usage).toEqual({ inputTokens: 30, totalTokens: 33 })
    expect(aggregate.reasons).toEqual([])
  })

  test('#5: a component every request reports is still summed exactly', () => {
    const text = jsonl([
      { seq: 1, type: 'request_start', requestId: 'r1' },
      { seq: 2, type: 'request_end', requestId: 'r1', usage: { inputTokens: 10, totalTokens: 11 } },
      { seq: 3, type: 'request_start', requestId: 'r2' },
      { seq: 4, type: 'request_end', requestId: 'r2', usage: { inputTokens: 20, totalTokens: 22 } },
    ])
    const aggregate = reduce(parseObservationText(text), true)
    expect(aggregate.usageStatus).toBe('complete')
    expect(aggregate.usage).toEqual({ inputTokens: 30, totalTokens: 33 })

    // A component NEITHER request reports is simply absent — not zero, and not
    // a reason to degrade the run.
    expect('cacheReadTokens' in (aggregate.usage ?? {})).toBe(false)
  })

  test('#5: incomplete totals keep the run out of tokensPerRun', () => {
    const runs: RunSummary[] = [
      {
        taskId: 'exact',
        authority: 'read',
        createdAt: '2026-11-01T00:00:00Z',
        latencyMs: 10,
        usage: { totalTokens: 100 },
        usageStatus: 'complete',
      },
      {
        taskId: 'lower-bound',
        authority: 'read',
        createdAt: '2026-11-01T00:00:00Z',
        latencyMs: 10,
        usage: { inputTokens: 900 },
        usageStatus: 'partial',
      },
    ]
    const stats = computeStats(runs)
    // The partial run's tokens are a lower bound: in totals, out of the mean.
    expect(stats.usageRuns).toEqual({ complete: 1, partial: 1, unknown: 0 })
    expect(stats.tokensPerRun.p50).toBe(100)
    // Population coverage (#5): only ONE of the two contributing runs reported
    // inputTokens, so the population total omits it instead of presenting 900 as
    // the exact sum. totalTokens is reported by one run only as well, so it is
    // omitted too — nothing here is an exact population figure.
    expect('inputTokens' in stats.totals).toBe(false)
    expect('totalTokens' in stats.totals).toBe(false)
  })

  test('#5: population totals keep only components every contributing run reported', () => {
    // The reviewer's case: both runs are complete, but with different sets.
    const runs: RunSummary[] = [
      {
        taskId: 'with-input',
        authority: 'read',
        createdAt: '2026-11-01T00:00:00Z',
        latencyMs: 10,
        usage: { totalTokens: 100, inputTokens: 80 },
        usageStatus: 'complete',
      },
      {
        taskId: 'total-only',
        authority: 'read',
        createdAt: '2026-11-01T00:00:00Z',
        latencyMs: 10,
        usage: { totalTokens: 200 },
        usageStatus: 'complete',
      },
    ]
    const stats = computeStats(runs)
    expect(stats.usageRuns).toEqual({ complete: 2, partial: 0, unknown: 0 })
    // totalTokens: both runs -> exact 300.
    expect(stats.totals.totalTokens).toBe(300)
    // inputTokens: one run only -> omitted, never "80".
    expect('inputTokens' in stats.totals).toBe(false)
    // tokensPerRun is a per-run distribution over [100, 200]; nearest-rank p50 is
    // the first of the two, not the mean.
    expect(stats.tokensPerRun).toEqual({ mean: 150, p50: 100, p95: 200 })
  })

  test('#5: unknown runs do not shrink population coverage', () => {
    const runs: RunSummary[] = [
      {
        taskId: 'a',
        authority: 'read',
        createdAt: '2026-11-01T00:00:00Z',
        latencyMs: 10,
        usage: { totalTokens: 10, inputTokens: 5 },
        usageStatus: 'complete',
      },
      {
        taskId: 'b',
        authority: 'read',
        createdAt: '2026-11-01T00:00:00Z',
        latencyMs: 10,
        usage: { totalTokens: 20, inputTokens: 15 },
        usageStatus: 'partial',
      },
      {
        // Unknown runs contribute nothing and are not part of the denominator.
        taskId: 'c',
        authority: 'read',
        createdAt: '2026-11-01T00:00:00Z',
        latencyMs: 10,
        usage: null,
        usageStatus: 'unknown',
      },
    ]
    const stats = computeStats(runs)
    expect(stats.totals).toEqual({ totalTokens: 30, inputTokens: 20 })
  })

  test('#4: a request end with no usage breaks total coverage', () => {
    // Two complete request/response pairs; the second carries no usage at all.
    const text = jsonl([
      { seq: 1, type: 'request_start', requestId: 'r1' },
      { seq: 2, type: 'request_end', requestId: 'r1', usage: { totalTokens: 100 } },
      { seq: 3, type: 'request_start', requestId: 'r2' },
      { seq: 4, type: 'request_end', requestId: 'r2' },
    ])
    const aggregate = reduce(parseObservationText(text))
    // r2's contribution is unknown, not zero, so 100 is not the run's total.
    expect('totalTokens' in (aggregate.usage ?? {})).toBe(false)
    expect(aggregate.usageStatus).toBe('partial')
    expect(aggregate.reasons.join(',')).toContain('incomplete_components:totalTokens')
    // The denominator counted BOTH first ends.
    expect(aggregate.requestEnds).toBe(2)
  })

  test('#4: duplicate ends do not change the coverage denominator', () => {
    const text = jsonl([
      { seq: 1, type: 'request_start', requestId: 'r1' },
      { seq: 2, type: 'request_end', requestId: 'r1', usage: { totalTokens: 50, inputTokens: 40 } },
      { seq: 3, type: 'request_end', requestId: 'r1', usage: { totalTokens: 50 } },
    ])
    const aggregate = reduce(parseObservationText(text))
    // The duplicate is ignored entirely, so coverage is judged over ONE end.
    expect(aggregate.requestEnds).toBe(1)
    expect(aggregate.usageStatus).toBe('complete')
    expect(aggregate.usage).toEqual({ totalTokens: 50, inputTokens: 40 })
  })

  test('#4: only usage-free ends means unknown, not a zero total', () => {
    const text = jsonl([
      { seq: 1, type: 'request_start', requestId: 'r1' },
      { seq: 2, type: 'request_end', requestId: 'r1' },
    ])
    const aggregate = reduce(parseObservationText(text))
    expect(aggregate.usageStatus).toBe('unknown')
    expect(aggregate.usage).toBeNull()
  })

  test('#5: a duplicate request_end does not distort coverage', () => {
    const text = jsonl([
      { seq: 1, type: 'request_start', requestId: 'r1' },
      { seq: 2, type: 'request_end', requestId: 'r1', usage: { totalTokens: 5 } },
      { seq: 3, type: 'request_end', requestId: 'r1', usage: { inputTokens: 5 } },
    ])
    const aggregate = reduce(parseObservationText(text), true)
    // Only the FIRST end counts, so coverage is judged over one request.
    expect(aggregate.usageStatus).toBe('complete')
    expect(aggregate.usage).toEqual({ totalTokens: 5 })
  })

  test('bad JSON never throws', () => {
    expect(() => parseObservationText('{oops}\n')).not.toThrow()
    expect(parseObservationText('{oops}\n').malformedLines).toBe(1)
  })

  test('usage keys are exactly the contract set', () => {
    expect([...USAGE_KEYS]).toEqual([
      'inputTokens',
      'outputTokens',
      'totalTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'reasoningTokens',
    ])
  })
})

// ---- percentiles + buckets ----------------------------------------------

describe('nearest-rank percentiles', () => {
  test('sorted[ceil(p*n)-1]', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(nearestRank(values, 0.5)).toBe(5)
    expect(nearestRank(values, 0.95)).toBe(10)
    expect(nearestRank([7], 0.5)).toBe(7)
    expect(nearestRank([], 0.5)).toBeNull()
  })

  test('percentileOf sorts a copy', () => {
    expect(percentileOf([10, 1, 5], 0.5)).toBe(5)
    expect(percentileOf([10, 1, 5], 0.95)).toBe(10)
  })

  test('AC-012: read/manage/combined stats match a reference computation', () => {
    const run = (taskId: string, authority: 'read' | 'manage', latencyMs: number | null, tokens: number): RunSummary => ({
      taskId,
      authority,
      createdAt: '2026-11-01T00:00:00Z',
      latencyMs,
      usage: { totalTokens: tokens },
      usageStatus: 'complete',
    })
    const runs = [
      run('t1', 'read', 100, 10),
      run('t2', 'read', 200, 20),
      run('t3', 'read', 300, 30),
      run('t4', 'manage', 400, 40),
      run('t5', 'manage', null, 50),
    ]
    const read = computeStats(runs.filter((r) => r.authority === 'read'))
    expect(read.runs).toBe(3)
    expect(read.runsWithLatency).toBe(3)
    expect(read.latencyMs).toEqual({ p50: 200, p95: 300, max: 300 })
    expect(read.tokensPerRun).toEqual({ mean: 20, p50: 20, p95: 30 })
    expect(read.totals.totalTokens).toBe(60)

    const manage = computeStats(runs.filter((r) => r.authority === 'manage'))
    expect(manage.runs).toBe(2)
    expect(manage.runsWithLatency).toBe(1)
    expect(manage.latencyMs).toEqual({ p50: 400, p95: 400, max: 400 })

    const combined = computeStats(runs)
    expect(combined.runs).toBe(5)
    expect(combined.totals.totalTokens).toBe(150)
    // ceil(0.5 * 4) - 1 = 1 -> the second of [100, 200, 300, 400].
    expect(combined.latencyMs.p50).toBe(200)
    expect(combined.latencyMs.p95).toBe(400)
  })

  test('partial runs are in totals but excluded from tokensPerRun', () => {
    const runs: RunSummary[] = [
      { taskId: 'a', authority: 'read', createdAt: '2026-11-01T00:00:00Z', latencyMs: 10, usage: { totalTokens: 100 }, usageStatus: 'complete' },
      { taskId: 'b', authority: 'read', createdAt: '2026-11-01T00:00:00Z', latencyMs: 10, usage: { totalTokens: 900 }, usageStatus: 'partial' },
      { taskId: 'c', authority: 'read', createdAt: '2026-11-01T00:00:00Z', latencyMs: 10, usage: null, usageStatus: 'unknown' },
    ]
    const stats = computeStats(runs)
    expect(stats.runs).toBe(3)
    expect(stats.usageRuns).toEqual({ complete: 1, partial: 1, unknown: 1 })
    expect(stats.totals.totalTokens).toBe(1000)
    expect(stats.tokensPerRun.p50).toBe(100)
  })
})

describe('time-zone bucketing', () => {
  test('AC-020: 17:30Z falls in the next day in Asia/Shanghai', () => {
    expect(localDayKey(Date.parse('2026-11-03T17:30:00Z'), 'Asia/Shanghai')).toBe('2026-11-04')
    expect(localDayKey(Date.parse('2026-11-03T15:59:00Z'), 'Asia/Shanghai')).toBe('2026-11-03')
    expect(localDayKey(Date.parse('2026-11-03T17:30:00Z'), 'UTC')).toBe('2026-11-03')
  })

  test('dayKeys covers every day in [from, to) including empty ones', () => {
    const from = Date.parse('2026-11-01T00:00:00Z')
    const to = Date.parse('2026-11-04T00:00:00Z')
    expect(dayKeys(from, to, 'UTC')).toEqual(['2026-11-01', '2026-11-02', '2026-11-03'])
  })

  test('an empty or inverted range yields no buckets', () => {
    expect(dayKeys(Date.parse('2026-11-04T00:00:00Z'), Date.parse('2026-11-04T00:00:00Z'), 'UTC')).toEqual([])
    expect(dayKeys(Date.parse('2026-11-05T00:00:00Z'), Date.parse('2026-11-04T00:00:00Z'), 'UTC')).toEqual([])
  })

  test('a 3-day Shanghai range keeps local days aligned across the UTC boundary', () => {
    const from = Date.parse('2026-11-01T16:00:00Z') // 2026-11-02 00:00 +08:00
    const to = Date.parse('2026-11-04T16:00:00Z')
    expect(dayKeys(from, to, 'Asia/Shanghai')).toEqual(['2026-11-02', '2026-11-03', '2026-11-04'])
  })
})

// ---- read-only proof -----------------------------------------------------

describe('snapshot building is read-only', () => {
  test('building a snapshot twice leaves the fixture byte-identical', () => {
    const root = tempDir()
    const a = newNode(root, 'ro a')
    const b = newNode(root, 'ro b')
    edgeAdd(root, a, b)
    appendAccess(root, a, b, '2026-11-01T00:00:00Z')
    writeAttachment(root, a, 'notes.md', 'hi')

    const before = treeSignature(root)
    buildGraphSnapshot(root, 1)
    buildGraphSnapshot(root, 2)
    expect(treeSignature(root)).toBe(before)
  })
})

// The plugin run source: `<usageDir>/usage-YYYY-MM.jsonl`.
//
// Covers the parsing and aggregation rules of the shared contract (Lane A, item
// 2): monthly files, torn trailing line, dedupe by callId, the graphRoot filter,
// nulls rather than zeroes, month rollover and incremental append.

import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

import { Store } from '../src/server/store.ts'
import { JsonlRunSource, monthKeyOf, summaryOf, usageOf } from '../src/server/usage/jsonl-source.ts'
import { computeStats } from '../src/server/usage/stats.ts'
import { cleanupTemps, newNode, tempDir } from './helpers.ts'

afterEach(cleanupTemps)

/** A complete usage record, as the plugin writes it. */
function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    callId: 'call-1',
    ts: '2026-10-15T10:00:00.000Z',
    finishedAt: '2026-10-15T10:00:12.000Z',
    authority: 'read',
    outcome: 'ok',
    latencyMs: 12_000,
    usageStatus: 'complete',
    tokens: { input: 1000, output: 100, reasoning: 20, cacheRead: 500, cacheWrite: 10 },
    costUsd: 0.0012,
    provider: 'mexplore',
    model: 'deepseek-v4.1-flash-1017',
    modelSource: 'default',
    steps: 3,
    graphRoot: '/graphs/one',
    pluginVersion: '0.1.0',
    ...overrides,
  }
}

function writeLines(file: string, records: readonly unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, records.map((entry) => `${JSON.stringify(entry)}\n`).join(''), 'utf8')
}

function appendLines(file: string, records: readonly unknown[]): void {
  fs.appendFileSync(file, records.map((entry) => `${JSON.stringify(entry)}\n`).join(''), 'utf8')
}

const usageFile = (dir: string, month = '2026-10') => path.join(dir, `usage-${month}.jsonl`)

describe('usageOf: token mapping is 1:1 and nulls stay null', () => {
  test('maps the contract fields onto the UI Usage shape', () => {
    expect(usageOf({ input: 10, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 })).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 3,
      cacheReadTokens: 4,
      cacheWriteTokens: 5,
      // Derived, never stored by the writer (contract: total is input+output+
      // reasoning+cacheRead+cacheWrite).
      totalTokens: 24,
    })
  })

  test('a partial token object keeps only what it has and reports no total', () => {
    const usage = usageOf({ input: 10, output: 2 })
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 2 })
    expect(usage?.totalTokens).toBeUndefined()
  })

  test('null tokens are null, never zeroes', () => {
    expect(usageOf(null)).toBeNull()
    expect(usageOf({ input: 'x' })).toBeNull()
    expect(usageOf(undefined)).toBeNull()
  })

  test('negative and non-finite values are not token counts', () => {
    expect(usageOf({ input: -1, output: Number.NaN, reasoning: 1, cacheRead: 1, cacheWrite: 1 })).toEqual({
      reasoningTokens: 1,
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
    })
  })
})

describe('summaryOf: one line becomes one RunSummary', () => {
  test('taskId is the callId and createdAt is ts', () => {
    const mapped = summaryOf(record())
    expect(mapped?.run.taskId).toBe('call-1')
    expect(mapped?.run.createdAt).toBe('2026-10-15T10:00:00.000Z')
    expect(mapped?.run.authority).toBe('read')
    expect(mapped?.run.latencyMs).toBe(12_000)
    expect(mapped?.run.usageStatus).toBe('complete')
    expect(mapped?.graphRoot).toBe('/graphs/one')
  })

  test('a missing latency is null, and an unusable record is dropped', () => {
    expect(summaryOf(record({ latencyMs: null }))?.run.latencyMs).toBeNull()
    expect(summaryOf(record({ callId: '' }))).toBeNull()
    expect(summaryOf(record({ ts: 'not a date' }))).toBeNull()
    expect(summaryOf(record({ authority: 'root' }))).toBeNull()
    expect(summaryOf('a string')).toBeNull()
  })

  test('null tokens give a null usage and unknown status', () => {
    const mapped = summaryOf(record({ tokens: null, usageStatus: 'unknown' }))
    expect(mapped?.run.usage).toBeNull()
    expect(mapped?.run.usageStatus).toBe('unknown')
  })

  test('complete without a complete total is downgraded to partial (a lower bound)', () => {
    const mapped = summaryOf(record({ tokens: { input: 10, output: 1 } }))
    expect(mapped?.run.usageStatus).toBe('partial')
  })
})

describe('JsonlRunSource: files, torn lines, dedupe, filter', () => {
  test('reads a single month and sorts by createdAt', () => {
    const dir = tempDir()
    writeLines(usageFile(dir), [
      record({ callId: 'b', ts: '2026-10-16T00:00:00.000Z' }),
      record({ callId: 'a', ts: '2026-10-15T00:00:00.000Z' }),
    ])
    const result = new JsonlRunSource({ usageDir: dir, graphRoot: '/graphs/one' }).refresh()
    expect(result.unavailable).toBe(false)
    expect(result.runs.map((run) => run.taskId)).toEqual(['a', 'b'])
  })

  test('spans months and ignores files that are not usage-YYYY-MM.jsonl', () => {
    const dir = tempDir()
    writeLines(usageFile(dir, '2026-09'), [record({ callId: 'sep', ts: '2026-09-30T23:00:00.000Z' })])
    writeLines(usageFile(dir, '2026-10'), [record({ callId: 'oct', ts: '2026-10-01T00:00:00.000Z' })])
    fs.writeFileSync(path.join(dir, 'usage-2026-10.jsonl.tmp'), '{"callId":"x"}\n', 'utf8')
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello\n', 'utf8')
    const result = new JsonlRunSource({ usageDir: dir, graphRoot: '/graphs/one' }).refresh()
    expect(result.runs.map((run) => run.taskId)).toEqual(['sep', 'oct'])
  })

  test('a torn trailing line is skipped, not cached as a record, and picked up once complete', () => {
    const dir = tempDir()
    const file = usageFile(dir)
    fs.mkdirSync(dir, { recursive: true })
    const complete = `${JSON.stringify(record({ callId: 'done' }))}\n`
    const torn = JSON.stringify(record({ callId: 'torn' })).slice(0, 40)
    fs.writeFileSync(file, complete + torn, 'utf8')

    const source = new JsonlRunSource({ usageDir: dir, graphRoot: '/graphs/one' })
    const first = source.refresh()
    expect(first.runs.map((run) => run.taskId)).toEqual(['done'])
    // The offset stops BEFORE the torn bytes, so completing them costs nothing extra.
    expect(source.offsetOf(path.basename(file))).toBe(Buffer.byteLength(complete, 'utf8'))

    fs.appendFileSync(file, `${JSON.stringify(record({ callId: 'torn' })).slice(40)}\n`, 'utf8')
    const second = source.refresh()
    expect(second.runs.map((run) => run.taskId)).toEqual(['done', 'torn'])
  })

  test('a malformed complete line is skipped with a warning; the rest of the file still reads', () => {
    const dir = tempDir()
    const file = usageFile(dir)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, `{"not":"a record"}\n${JSON.stringify(record({ callId: 'ok' }))}\n`, 'utf8')
    const result = new JsonlRunSource({ usageDir: dir, graphRoot: '/graphs/one' }).refresh()
    expect(result.runs.map((run) => run.taskId)).toEqual(['ok'])
    expect(result.warnings.join('\n')).toContain('usage line(s) skipped')
  })

  test('a record is deduped by callId: the last line wins, and the call is counted once', () => {
    const dir = tempDir()
    writeLines(usageFile(dir), [
      record({ callId: 'same', usageStatus: 'partial', tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }),
      record({ callId: 'same', usageStatus: 'complete' }),
    ])
    const result = new JsonlRunSource({ usageDir: dir, graphRoot: '/graphs/one' }).refresh()
    expect(result.runs).toHaveLength(1)
    expect(result.runs[0]?.usageStatus).toBe('complete')
    expect(result.runs[0]?.usage?.inputTokens).toBe(1000)
  })

  test('only the served graph root is shown; a trailing slash is the same graph', () => {
    const dir = tempDir()
    writeLines(usageFile(dir), [
      record({ callId: 'mine', graphRoot: '/graphs/one' }),
      record({ callId: 'slashed', graphRoot: '/graphs/one/' }),
      record({ callId: 'other', graphRoot: '/graphs/two' }),
      record({ callId: 'nowhere', graphRoot: undefined }),
    ])
    const result = new JsonlRunSource({ usageDir: dir, graphRoot: '/graphs/one' }).refresh()
    expect(result.runs.map((run) => run.taskId).sort()).toEqual(['mine', 'slashed'])
  })

  test('a usage dir that does not exist yet is empty, not unavailable', () => {
    const dir = path.join(tempDir(), 'never-created')
    const result = new JsonlRunSource({ usageDir: dir, graphRoot: '/graphs/one' }).refresh()
    expect(result.unavailable).toBe(false)
    expect(result.runs).toEqual([])
    expect(result.warnings).toEqual([])
  })

  test('a symlinked usage directory is refused', () => {
    const base = tempDir()
    const real = path.join(base, 'real')
    writeLines(path.join(real, 'usage-2026-10.jsonl'), [record()])
    const link = path.join(base, 'usage')
    fs.symlinkSync(real, link)
    const result = new JsonlRunSource({ usageDir: link, graphRoot: '/graphs/one' }).refresh()
    expect(result.unavailable).toBe(true)
    expect(result.warnings.join('\n')).toContain('symlink')
  })

  test('a symlinked usage file is refused, other files still read', () => {
    const base = tempDir()
    const dir = path.join(base, 'usage')
    const outside = path.join(base, 'outside.jsonl')
    writeLines(outside, [record({ callId: 'evil' })])
    fs.mkdirSync(dir, { recursive: true })
    writeLines(usageFile(dir), [record({ callId: 'good' })])
    fs.symlinkSync(outside, usageFile(dir, '2026-09'))
    const result = new JsonlRunSource({ usageDir: dir, graphRoot: '/graphs/one' }).refresh()
    expect(result.runs.map((run) => run.taskId)).toEqual(['good'])
    expect(result.warnings.join('\n')).toContain('usage file refused')
  })
})

describe('JsonlRunSource: incremental append and month rollover', () => {
  test('an appended line is picked up and only the new bytes are read', () => {
    const dir = tempDir()
    const file = usageFile(dir)
    writeLines(file, [record({ callId: 'first' })])

    let clock = Date.parse('2026-10-20T00:00:00.000Z')
    const source = new JsonlRunSource({ usageDir: dir, graphRoot: '/graphs/one', now: () => clock })
    expect(source.refresh().runs.map((run) => run.taskId)).toEqual(['first'])
    const firstOffset = source.offsetOf(path.basename(file)) ?? -1
    const sizeAfterFirst = fs.statSync(file).size
    expect(firstOffset).toBe(sizeAfterFirst)

    expect(source.moved()).toBe(false)

    appendLines(file, [record({ callId: 'second', ts: '2026-10-20T01:00:00.000Z' })])
    expect(source.moved()).toBe(true)
    const second = source.refresh()
    expect(second.runs.map((run) => run.taskId)).toEqual(['first', 'second'])
    // Incremental: the offset advanced by exactly the appended bytes.
    expect((source.offsetOf(path.basename(file)) ?? -1) - firstOffset).toBe(fs.statSync(file).size - sizeAfterFirst)
    expect(source.moved()).toBe(false)
  })

  test('an in-place rewrite (same size, new mtime) is re-read from the start', () => {
    const dir = tempDir()
    const file = usageFile(dir)
    // Two lines of IDENTICAL byte length, differing only in the number: an
    // offset-based reader would skip the second write entirely.
    writeLines(file, [record({ callId: 'first', latencyMs: 1000 })])
    const source = new JsonlRunSource({ usageDir: dir, graphRoot: '/graphs/one' })
    expect(source.refresh().runs[0]?.latencyMs).toBe(1000)

    const rewritten = `${JSON.stringify(record({ callId: 'first', latencyMs: 2000 }))}\n`
    expect(rewritten.length).toBe(fs.statSync(file).size)
    fs.writeFileSync(file, rewritten, 'utf8')
    const later = new Date(Date.now() + 5_000)
    fs.utimesSync(file, later, later)

    expect(source.refresh().runs[0]?.latencyMs).toBe(2000)
  })

  test('a truncated file restarts from zero', () => {
    const dir = tempDir()
    const file = usageFile(dir)
    writeLines(file, [record({ callId: 'one' }), record({ callId: 'two', ts: '2026-10-16T00:00:00.000Z' })])
    const source = new JsonlRunSource({ usageDir: dir, graphRoot: '/graphs/one' })
    expect(source.refresh().runs).toHaveLength(2)

    writeLines(file, [record({ callId: 'three' })])
    expect(source.refresh().runs.map((run) => run.taskId)).toEqual(['three'])
  })

  test('rolling into a new UTC month reads the new file and closes the old one', () => {
    const dir = tempDir()
    let clock = Date.parse('2026-10-31T23:59:00.000Z')
    const source = new JsonlRunSource({ usageDir: dir, graphRoot: '/graphs/one', now: () => clock })

    writeLines(usageFile(dir, '2026-10'), [record({ callId: 'oct', ts: '2026-10-31T23:00:00.000Z' })])
    expect(source.refresh().runs.map((run) => run.taskId)).toEqual(['oct'])

    clock = Date.parse('2026-11-01T00:01:00.000Z')
    expect(monthKeyOf(clock)).toBe('2026-11')
    writeLines(usageFile(dir, '2026-11'), [record({ callId: 'nov', ts: '2026-11-01T00:00:30.000Z' })])
    const rolled = source.refresh()
    expect(rolled.runs.map((run) => run.taskId)).toEqual(['oct', 'nov'])

    // November is now the OPEN month: an append is still incremental.
    appendLines(usageFile(dir, '2026-11'), [record({ callId: 'nov2', ts: '2026-11-01T00:02:00.000Z' })])
    expect(source.refresh().runs.map((run) => run.taskId)).toEqual(['oct', 'nov', 'nov2'])
  })
})

describe('Store: the JSONL source feeds the dashboard unchanged', () => {
  test('rows, latency, usage and status reach /api/usage through the Store', () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'jsonl source node')
    const usageDir = path.join(base, 'usage')
    writeLines(usageFile(usageDir, '2026-11'), [
      record({ callId: 'r1', authority: 'read', ts: '2026-11-01T01:00:00.000Z', graphRoot }),
      record({
        callId: 'm1',
        authority: 'manage',
        ts: '2026-11-01T02:00:00.000Z',
        graphRoot,
        tokens: null,
        usageStatus: 'unknown',
        latencyMs: null,
      }),
      record({ callId: 'other-graph', graphRoot: '/somewhere/else' }),
    ])

    const store = new Store({
      graphRoot,
      runs: new JsonlRunSource({ usageDir, graphRoot, now: () => Date.parse('2026-11-02T00:00:00.000Z') }),
      debounceMs: 20,
      reconcileMs: 600_000,
      taskPollMs: 600_000,
    })
    try {
      expect(store.source).toBe('plugin')
      expect(store.runsUnavailable()).toBe(false)
      const runs = store.runs().runs
      expect(runs.map((run) => run.taskId)).toEqual(['r1', 'm1'])
      // Summary stats treat the null-usage run as unknown, not as zero spend.
      const stats = computeStats(runs)
      expect(stats.usageRuns).toEqual({ complete: 1, partial: 0, unknown: 1 })
      expect(stats.totals.totalTokens).toBe(1630)
      expect(stats.latencyMs.max).toBe(12_000)
    } finally {
      store.close()
    }
  })

  test('a new line in the usage log reaches the Store through its poll', () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'poll node')
    const usageDir = path.join(base, 'usage')
    writeLines(usageFile(usageDir, '2026-11'), [record({ callId: 'r1', graphRoot })])
    const store = new Store({
      graphRoot,
      runs: new JsonlRunSource({ usageDir, graphRoot, now: () => Date.parse('2026-11-02T00:00:00.000Z') }),
      debounceMs: 20,
      reconcileMs: 600_000,
      taskPollMs: 600_000,
    })
    try {
      expect(store.runs().runs).toHaveLength(1)
      appendLines(usageFile(usageDir, '2026-11'), [record({ callId: 'r2', ts: '2026-11-01T03:00:00.000Z', graphRoot })])
      expect(store.pollRunsSide()).toBe(true)
      expect(store.runs().runs.map((run) => run.taskId)).toEqual(['r1', 'r2'])
      // Nothing new: the poll reports nothing, so no `run` hint is emitted.
      expect(store.pollRunsSide()).toBe(false)
    } finally {
      store.close()
    }
  })
})

describe('edge cases a hostile or buggy writer can produce', () => {
  test('a record claiming complete with null tokens is unknown, not complete-with-no-numbers', () => {
    const mapped = summaryOf(record({ tokens: null, usageStatus: 'complete' }))
    expect(mapped?.run.usageStatus).toBe('unknown')
    expect(mapped?.run.usage).toBeNull()
  })

  test('a very large but space-free callId is rejected (bounded identifier)', () => {
    expect(summaryOf(record({ callId: 'x'.repeat(201) }))).toBeNull()
    expect(summaryOf(record({ callId: 'x'.repeat(200) }))).not.toBeNull()
  })

  test('a negative latency is null, not a negative duration in the table', () => {
    expect(summaryOf(record({ latencyMs: -5 }))?.run.latencyMs).toBeNull()
    expect(summaryOf(record({ latencyMs: 'fast' }))?.run.latencyMs).toBeNull()
  })

  test('a usage directory that is a FILE is unavailable, not empty', () => {
    const base = tempDir()
    const file = path.join(base, 'usage')
    fs.writeFileSync(file, '', 'utf8')
    const result = new JsonlRunSource({ usageDir: file, graphRoot: '/graphs/one' }).refresh()
    expect(result.unavailable).toBe(true)
    expect(result.warnings.join('\n')).toContain('not-dir')
  })

  test('a nested path in the usage directory is not read as a monthly file', () => {
    const dir = tempDir()
    fs.mkdirSync(path.join(dir, 'usage-2026-10.jsonl'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'usage-2026-10.jsonl', 'inner.jsonl'), `${JSON.stringify(record())}\n`)
    const result = new JsonlRunSource({ usageDir: dir, graphRoot: '/graphs/one' }).refresh()
    expect(result.runs).toEqual([])
    // A DIRECTORY named like a monthly file can never be a monthly file, so it is
    // ignored rather than descended into or reported as a broken log.
    expect(result.warnings).toEqual([])
  })
})

// The `RunSource` seam in the Store (Lane A, item 2).
//
// The Store used to know one history format; it now delegates to a source. These
// tests pin the seam itself: the default is the service source (unchanged
// behaviour, including its observation cache), the plugin source is whatever the
// caller passes, and a Store with neither is a programming error rather than a
// silently empty dashboard.

import { afterAll, describe, expect, test } from 'bun:test'
import path from 'node:path'

import { Store } from '../src/server/store.ts'
import { ServiceRunSource } from '../src/server/usage/service-source.ts'
import { JsonlRunSource } from '../src/server/usage/jsonl-source.ts'
import type { RunSource, RunSourceKind, RunSourceResult } from '../src/server/usage/source.ts'
import { cleanupTemps, completeObservation, newNode, taskUuid, tempDir, writeRunDir, writeTasksDb } from './helpers.ts'

const stores: Store[] = []

afterAll(() => {
  for (const store of stores) store.close()
  cleanupTemps()
})

function graphFixture(): { graphRoot: string; stateDir: string } {
  const base = tempDir()
  const graphRoot = path.join(base, 'graph')
  newNode(graphRoot, 'run source node')
  return { graphRoot, stateDir: path.join(base, 'state') }
}

/** A source that reports whatever it is told, for the seam itself. */
class FakeSource implements RunSource {
  readonly kind: RunSourceKind
  refreshCount = 0
  moveCount = 0
  constructor(
    kind: RunSourceKind,
    private readonly result: RunSourceResult,
    private readonly moves = false,
  ) {
    this.kind = kind
  }
  refresh(): RunSourceResult {
    this.refreshCount += 1
    return this.result
  }
  moved(): boolean {
    this.moveCount += 1
    return this.moves
  }
  watchPath(): string | null {
    return null
  }
}

describe('the default source is the service one', () => {
  test('a Store built from (graphRoot, stateDir) reports source "service"', () => {
    const { graphRoot, stateDir } = graphFixture()
    writeTasksDb(stateDir, [
      { taskId: taskUuid('rs-1'), createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:03Z' },
    ])
    const taskId = taskUuid('rs-1')
    writeRunDir(stateDir, { taskId, observation: completeObservation() }, 0)

    const store = new Store({ graphRoot, stateDir, debounceMs: 20, reconcileMs: 600_000, taskPollMs: 600_000 })
    stores.push(store)
    expect(store.source).toBe('service')
    expect(store.runSource).toBeInstanceOf(ServiceRunSource)
    expect(store.runs().runs).toHaveLength(1)
    expect(store.runs().runs[0]?.usageStatus).toBe('complete')
  })

  test('the service source keeps its observation cache across refreshes', () => {
    const { graphRoot, stateDir } = graphFixture()
    const taskId = taskUuid('rs-cache')
    writeTasksDb(stateDir, [{ taskId, createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:03Z' }])
    writeRunDir(stateDir, { taskId, observation: completeObservation() }, 0)

    const store = new Store({ graphRoot, stateDir, debounceMs: 20, reconcileMs: 600_000, taskPollMs: 600_000 })
    stores.push(store)
    const source = store.runSource as ServiceRunSource
    expect(source.observationCounters.parses).toBe(1)

    // Five rebuilds of an unchanged capture: still one parse, four cache hits.
    for (let i = 0; i < 5; i++) store.rebuildNow()
    expect(source.observationCounters.parses).toBe(1)
    expect(source.observationCounters.hits).toBe(5)
  })

  test('a Store with neither stateDir nor an explicit source fails loudly', () => {
    const { graphRoot } = graphFixture()
    expect(() => new Store({ graphRoot, debounceMs: 20, reconcileMs: 600_000, taskPollMs: 600_000 })).toThrow(
      /stateDir is required/,
    )
  })

  test('a contradicting source label is refused rather than shown', () => {
    const { graphRoot } = graphFixture()
    const fake = new FakeSource('plugin', {
      runs: [],
      orphanRunDirs: [],
      warnings: [],
      unavailable: false,
      signature: 's',
    })
    // Labelling plugin rows as "service" would make the dashboard claim the
    // wrong deployment (and pick the wrong unavailable wording).
    expect(
      () => new Store({ graphRoot, runs: fake, source: 'service', debounceMs: 20, reconcileMs: 600_000, taskPollMs: 600_000 }),
    ).toThrow(/does not match the run source/)
  })
})

describe('an explicit source is used verbatim', () => {
  test('source and kind come from the source, and its rows reach the API', () => {
    const { graphRoot } = graphFixture()
    const fake = new FakeSource('plugin', {
      runs: [
        {
          taskId: 'from-fake',
          authority: 'manage',
          createdAt: '2026-11-01T00:00:00.000Z',
          latencyMs: 5,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          usageStatus: 'complete',
        },
      ],
      orphanRunDirs: [],
      warnings: ['a fake warning'],
      unavailable: false,
      signature: 'sig-1',
    })
    const store = new Store({ graphRoot, runs: fake, debounceMs: 20, reconcileMs: 600_000, taskPollMs: 600_000 })
    stores.push(store)
    expect(store.source).toBe('plugin')
    expect(store.runs().runs.map((run) => run.taskId)).toEqual(['from-fake'])
    expect(store.runs().warnings).toEqual(['a fake warning'])
  })

  test('an unavailable source makes the usage side unavailable, not empty-and-fine', () => {
    const { graphRoot } = graphFixture()
    const fake = new FakeSource('plugin', {
      runs: [],
      orphanRunDirs: [],
      warnings: ['usage log unreadable'],
      unavailable: true,
      signature: 'unavailable',
    })
    const store = new Store({ graphRoot, runs: fake, debounceMs: 20, reconcileMs: 600_000, taskPollMs: 600_000 })
    stores.push(store)
    expect(store.runsUnavailable()).toBe(true)
    expect(store.runs().warnings).toEqual(['usage log unreadable'])
  })

  test('the poll consults the source before rebuilding', () => {
    const { graphRoot } = graphFixture()
    const idle = new FakeSource('plugin', { runs: [], orphanRunDirs: [], warnings: [], unavailable: false, signature: 's' }, false)
    const store = new Store({ graphRoot, runs: idle, debounceMs: 20, reconcileMs: 600_000, taskPollMs: 600_000 })
    stores.push(store)
    const before = idle.refreshCount
    expect(store.pollRunsSide()).toBe(false)
    expect(idle.moveCount).toBe(1)
    // No move -> no rebuild: checking is cheap, refreshing is not.
    expect(idle.refreshCount).toBe(before)

    const busy = new FakeSource('plugin', { runs: [], orphanRunDirs: [], warnings: [], unavailable: false, signature: 's2' }, true)
    const moving = new Store({ graphRoot, runs: busy, debounceMs: 20, reconcileMs: 600_000, taskPollMs: 600_000 })
    stores.push(moving)
    const refreshed = busy.refreshCount
    expect(moving.pollRunsSide()).toBe(true)
    expect(busy.refreshCount).toBe(refreshed + 1)
  })

  test('the JSONL source is what the plugin passes, and its kind is "plugin"', () => {
    const { graphRoot } = graphFixture()
    const source = new JsonlRunSource({ usageDir: path.join(tempDir(), 'usage'), graphRoot })
    const store = new Store({ graphRoot, runs: source, debounceMs: 20, reconcileMs: 600_000, taskPollMs: 600_000 })
    stores.push(store)
    expect(store.source).toBe('plugin')
    expect(store.runsUnavailable()).toBe(false)
    expect(store.runs().runs).toEqual([])
  })
})

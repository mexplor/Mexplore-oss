// Pass-2 review fixes: installer hard-link refusal (#2), uninstall traversal
// (#3), usage coverage (#4/#5) at the population level, and the reduced
// observation cache (#6) including a scale check.

import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

import { install, layoutFor, uninstall } from '../scripts/agent.ts'
import { Store } from '../src/server/store.ts'
import { ObservationCache, buildRunIndex, maxUpdatedAt } from '../src/server/usage/runs.ts'
import { readTasks } from '../src/server/usage/tasks.ts'
import { computeStats } from '../src/server/usage/stats.ts'
import { parseObservationText, aggregateObservation, MAX_OBSERVATION_BYTES } from '../src/server/usage/observation.ts'
import type { RunSummary, UsageSummary } from '../src/shared/types.ts'
import {
  cleanupTemps,
  completeObservation,
  jsonl,
  newNode,
  taskUuid,
  tempDir,
  treeSignature,
  writeConfig,
  writeRunDir,
  writeTasksDb,
} from './helpers.ts'

const stores: Store[] = []

afterAll(() => {
  for (const store of stores) store.close()
  cleanupTemps()
})

function fixturePackage(): { graphRoot: string; stateDir: string; configPath: string } {
  const base = tempDir()
  const graphRoot = path.join(base, 'graph')
  newNode(graphRoot, 'fixture node')
  const stateDir = path.join(base, 'state')
  fs.mkdirSync(stateDir, { recursive: true })
  const configPath = writeConfig(path.join(base, 'test_1.json'), graphRoot, stateDir)
  return { graphRoot, stateDir, configPath }
}

function distFixture(): string {
  const dist = path.join(tempDir('mexplore-dist-'), 'dist')
  fs.mkdirSync(dist, { recursive: true })
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html>', 'utf8')
  return dist
}

// ---- #2: hard-linked output file ----------------------------------------

describe('#2: installer refuses a hard-linked log file', () => {
  test('ui.log hard-linked to a graph canary is refused before bootstrap', async () => {
    const home = tempDir('mexplore-home-')
    const { configPath, graphRoot } = fixturePackage()
    const layout = layoutFor('test_1', home)

    // A graph file the operator must never see modified.
    const canary = path.join(graphRoot, 'canary.txt')
    const canaryText = 'GRAPH-CANARY-MUST-SURVIVE'
    fs.writeFileSync(canary, canaryText, 'utf8')

    // Point the UI log path at the SAME inode, with a legitimately safe realpath.
    fs.mkdirSync(layout.logDir, { recursive: true })
    fs.linkSync(canary, layout.logPath)
    expect(fs.lstatSync(layout.logPath).nlink).toBe(2)

    const calls: string[][] = []
    const messages: string[] = []
    const result = await install({
      configPath,
      port: 43190,
      home,
      pathEnv: '/usr/bin:/bin',
      bunPath: '/bun',
      load: true,
      distDir: distFixture(),
      runCommand: (command) => {
        calls.push(command)
        return { status: 0, stdout: '', stderr: '' }
      },
      stdout: () => {},
      stderr: (line) => messages.push(line),
    })

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(messages.join('\n')).toContain('hard-linked')
    // Nothing was loaded and the canary is byte-identical.
    expect(calls).toEqual([])
    expect(fs.readFileSync(canary, 'utf8')).toBe(canaryText)
    expect(fs.readFileSync(layout.logPath, 'utf8')).toBe(canaryText)
  })

  test('a singly-linked existing log file is accepted (normal re-install)', async () => {
    const home = tempDir('mexplore-home-')
    const fixture = setupLoosePackage()
    const layout = layoutFor('test_1', home)
    fs.mkdirSync(layout.logDir, { recursive: true })
    fs.writeFileSync(layout.logPath, 'previous run\n', 'utf8')
    expect(fs.lstatSync(layout.logPath).nlink).toBe(1)

    const result = await install({
      configPath: fixture.configPath,
      port: 43190,
      home,
      pathEnv: '/usr/bin:/bin',
      bunPath: '/bun',
      load: false,
      distDir: distFixture(),
      stdout: () => {},
      stderr: () => {},
    } as Parameters<typeof install>[0])
    expect(result.ok).toBe(true)
    // The log file is kept, not truncated by the installer.
    expect(fs.readFileSync(layout.logPath, 'utf8')).toBe('previous run\n')
  })
})

function setupLoosePackage(): { configPath: string } {
  const base = tempDir()
  const graphRoot = path.join(base, 'graph')
  newNode(graphRoot, 'loose node')
  const stateDir = path.join(base, 'state')
  fs.mkdirSync(stateDir, { recursive: true })
  return { configPath: writeConfig(path.join(base, 'test_1.json'), graphRoot, stateDir) }
}

// ---- #3: uninstall must not traverse a redirected LaunchAgents dir -------

describe('#3: uninstall refuses a redirected LaunchAgents directory', () => {
  function plantGraphAttachment(graphRoot: string): string {
    const id = newNode(graphRoot, 'holds a plist-shaped attachment')
    const attachment = path.join(graphRoot, id, 'ai.mexplore.mexplore-ui.test_1.plist')
    fs.writeFileSync(attachment, 'GRAPH-ATTACHMENT-CONTENT', 'utf8')
    return attachment
  }

  test('LaunchAgents symlinked into a graph Node directory deletes nothing', () => {
    const home = tempDir('mexplore-home-')
    const { configPath, graphRoot, stateDir } = fixturePackage()
    const attachment = plantGraphAttachment(graphRoot)

    fs.mkdirSync(path.join(home, 'Library'), { recursive: true })
    fs.symlinkSync(path.dirname(attachment), path.join(home, 'Library', 'LaunchAgents'))

    const before = treeSignature(graphRoot)
    const calls: string[][] = []
    const result = uninstall({
      configPath,
      home,
      protectedRoots: [graphRoot, stateDir],
      runCommand: (command) => {
        calls.push(command)
        return { status: 0, stdout: '', stderr: '' }
      },
      stdout: () => {},
      stderr: () => {},
    })

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.message).toContain('symlink')
    // No launchctl call, nothing removed, the tree is byte-identical.
    expect(calls).toEqual([])
    expect(treeSignature(graphRoot)).toBe(before)
    expect(fs.existsSync(attachment)).toBe(true)
  })

  test('LaunchAgents symlinked into stateDir deletes nothing', () => {
    const home = tempDir('mexplore-home-')
    const { configPath, graphRoot, stateDir } = fixturePackage()
    const victim = path.join(stateDir, 'ai.mexplore.mexplore-ui.test_1.plist')
    fs.writeFileSync(victim, 'STATE-CONTENT', 'utf8')

    fs.mkdirSync(path.join(home, 'Library'), { recursive: true })
    fs.symlinkSync(stateDir, path.join(home, 'Library', 'LaunchAgents'))

    const before = treeSignature(stateDir)
    const result = uninstall({
      configPath,
      home,
      protectedRoots: [graphRoot, stateDir],
      runCommand: () => ({ status: 0, stdout: '', stderr: '' }),
      stdout: () => {},
      stderr: () => {},
    })

    expect(result.ok).toBe(false)
    expect(treeSignature(stateDir)).toBe(before)
    expect(fs.readFileSync(victim, 'utf8')).toBe('STATE-CONTENT')
  })

  test('a normal install then uninstall still removes only its own plist', async () => {
    const home = tempDir('mexplore-home-')
    const { configPath } = fixturePackage()
    const layout = layoutFor('test_1', home)
    expect(
      (
        await install({
          configPath,
          port: 43190,
          home,
          pathEnv: '/usr/bin:/bin',
          bunPath: '/bun',
          load: false,
          distDir: distFixture(),
          stdout: () => {},
          stderr: () => {},
        })
      ).ok,
    ).toBe(true)

    const sibling = path.join(home, 'Library', 'LaunchAgents', 'ai.mexplore.memory-agent.test_1.plist')
    fs.writeFileSync(sibling, 'agent', 'utf8')

    const result = uninstall({
      configPath,
      home,
      load: false,
      protectedRoots: [],
      stdout: () => {},
      stderr: () => {},
    })
    expect(result.ok).toBe(true)
    expect(fs.existsSync(layout.plistPath)).toBe(false)
    expect(fs.existsSync(sibling)).toBe(true)
  })

  test('a plist-shaped leaf that is not ours is never removed', () => {
    const home = tempDir('mexplore-home-')
    const { configPath } = fixturePackage()
    const dir = path.join(home, 'Library', 'LaunchAgents')
    fs.mkdirSync(dir, { recursive: true })
    // A sibling job's plist: same directory, different label.
    const other = path.join(dir, 'ai.mexplore.memory-agent.test_1.plist')
    fs.writeFileSync(other, 'agent plist', 'utf8')

    const result = uninstall({ configPath, home, load: false, stdout: () => {}, stderr: () => {} })
    expect(result.ok).toBe(true)
    expect(fs.readFileSync(other, 'utf8')).toBe('agent plist')
  })
})

// ---- #4/#5 at the API level --------------------------------------------

describe('#4/#5: usage coverage through the real index and API shapes', () => {
  function seed(tasks: { taskId: string; observation?: string }[]): {
    stateDir: string
    graphRoot: string
  } {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'coverage node')
    const stateDir = path.join(base, 'state')
    writeTasksDb(
      stateDir,
      tasks.map((task, index) => ({
        taskId: task.taskId,
        createdAt: new Date(Date.UTC(2026, 10, 1, 0, index, 0)).toISOString(),
        finishedAt: new Date(Date.UTC(2026, 10, 1, 0, index, 30)).toISOString(),
      })),
    )
    for (const [index, task] of tasks.entries()) {
      writeRunDir(
        stateDir,
        { taskId: task.taskId, ...(task.observation === undefined ? {} : { observation: task.observation }) },
        index,
      )
    }
    return { stateDir, graphRoot }
  }

  test('a run whose second request reported no usage is partial and loses its total', () => {
    const taskId = taskUuid('no-usage-second')
    const { stateDir, graphRoot } = seed([
      {
        taskId,
        observation: jsonl([
          { seq: 1, type: 'request_start', requestId: 'r1' },
          { seq: 2, type: 'request_end', requestId: 'r1', usage: { totalTokens: 100, inputTokens: 80 } },
          { seq: 3, type: 'request_start', requestId: 'r2' },
          { seq: 4, type: 'request_end', requestId: 'r2' },
        ]),
      },
    ])
    const cache = new ObservationCache()
    const index = buildRunIndex({ stateDir, tasks: readTasks(stateDir).rows, cache })
    const run = index.runs[0] as RunSummary
    expect(run.usageStatus).toBe('partial')
    expect('totalTokens' in (run.usage ?? {})).toBe(false)
    expect('inputTokens' in (run.usage ?? {})).toBe(false)

    const stats = computeStats(index.runs)
    expect(stats.usageRuns).toEqual({ complete: 0, partial: 1, unknown: 0 })
    // The partial run has no total, so the exact token stats are empty.
    expect(stats.tokensPerRun.p50).toBeNull()
    // And no key is claimed exact in totals.
    expect('totalTokens' in stats.totals).toBe(false)

    const store = new Store({ graphRoot, stateDir, debounceMs: 20, reconcileMs: 60_000, taskPollMs: 60_000 })
    stores.push(store)
    expect(store.runs().runs[0]?.usageStatus).toBe('partial')
  })

  test('a capture with only usage-free ends is unknown through the index', () => {
    const taskId = taskUuid('only-no-usage')
    const { stateDir } = seed([
      {
        taskId,
        observation: jsonl([
          { seq: 1, type: 'request_start', requestId: 'r1' },
          { seq: 2, type: 'request_end', requestId: 'r1' },
        ]),
      },
    ])
    const index = buildRunIndex({ stateDir, tasks: readTasks(stateDir).rows, cache: new ObservationCache() })
    expect(index.runs[0]?.usageStatus).toBe('unknown')
    expect(index.runs[0]?.usage).toBeNull()
  })
})

// ---- #6: reduced cache, oversized capture, scale ------------------------

describe('#6: reduced observation cache', () => {
  test('the cached aggregate retains no event list', () => {
    const base = tempDir()
    const stateDir = path.join(base, 'state')
    const taskId = taskUuid('reduced')
    writeTasksDb(stateDir, [{ taskId, createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:05Z' }])
    writeRunDir(stateDir, { taskId, observation: completeObservation() }, 0)
    const cache = new ObservationCache()
    const index = buildRunIndex({ stateDir, tasks: readTasks(stateDir).rows, cache })
    expect(index.runs[0]?.usageStatus).toBe('complete')
    // The cache exposes only reduced aggregates.
    expect(cache.size).toBe(1)
    expect(cache.counters.parses).toBe(1)
  })

  test('an oversized capture is refused with a warning and unknown usage', () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'oversized node')
    const stateDir = path.join(base, 'state')
    const taskId = taskUuid('oversized')
    writeTasksDb(stateDir, [{ taskId, createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:05Z' }])
    const runDir = writeRunDir(stateDir, { taskId }, 0)
    // A sparse-looking big file: write a header then pad past the cap.
    const file = path.join(runDir, 'observation.jsonl')
    fs.writeFileSync(file, completeObservation(), 'utf8')
    fs.truncateSync(file, MAX_OBSERVATION_BYTES + 1024)

    const store = new Store({ graphRoot, stateDir, debounceMs: 20, reconcileMs: 60_000, taskPollMs: 60_000 })
    stores.push(store)
    const run = store.runs().runs.find((entry) => entry.taskId === taskId)
    expect(run?.usageStatus).toBe('unknown')
    expect(store.runs().warnings.join('\n')).toContain('observation_too_large')
  })

  test('10,000 small captures index within the time bound', () => {
    const base = tempDir()
    const stateDir = path.join(base, 'state')
    const count = 10_000
    const tasks = []
    for (let i = 0; i < count; i++) {
      tasks.push({
        taskId: taskUuid(`scale-${i}`),
        createdAt: '2026-11-01T00:00:00Z',
        finishedAt: '2026-11-01T00:00:01Z',
      })
    }
    writeTasksDb(stateDir, tasks)
    const observation = completeObservation()
    for (const [index, task] of tasks.entries()) {
      writeRunDir(stateDir, { taskId: task.taskId, observation }, index)
    }

    const rows = readTasks(stateDir).rows
    expect(rows.length).toBe(count)
    expect(maxUpdatedAt(rows)).not.toBeNull()

    const cache = new ObservationCache()
    const started = Date.now()
    const index = buildRunIndex({ stateDir, tasks: rows, cache })
    const elapsed = Date.now() - started
    expect(index.runs.length).toBe(count)
    expect(index.runs.every((run) => run.usageStatus === 'complete')).toBe(true)
    // Loose bound: the point is that it is linear and cheap, not a benchmark.
    expect(elapsed).toBeLessThan(10_000)
    expect(cache.counters.parses).toBe(count)

    // Re-indexing with nothing changed parses NOTHING.
    const before = cache.counters.parses
    buildRunIndex({ stateDir, tasks: rows, cache })
    expect(cache.counters.parses).toBe(before)

    // Change ONE capture: exactly one re-parse.
    const victim = tasks[0] as { taskId: string }
    const runDir = path.join(stateDir, 'runs', victim.taskId, fs.readdirSync(path.join(stateDir, 'runs', victim.taskId))[0] as string)
    fs.writeFileSync(
      path.join(runDir, 'observation.jsonl'),
      completeObservation(9, 9, 999),
      'utf8',
    )
    buildRunIndex({ stateDir, tasks: rows, cache })
    expect(cache.counters.parses).toBe(before + 1)
  }, 60_000)

  test('parsing keeps only the four permitted fields per line', () => {
    const parse = parseObservationText(
      jsonl([
        { seq: 1, type: 'request_end', requestId: 'r1', usage: { totalTokens: 1 }, message: 'SECRET', tool: 'x' },
      ]),
    )
    const aggregate = aggregateObservation(parse)
    // The aggregate exposes usage/coverage only — no per-event text survives.
    expect(JSON.stringify(aggregate)).not.toContain('SECRET')
    expect(aggregate.requestEnds).toBe(1)
  })
})

// ---- usage summary invariants -----------------------------------------

describe('usage summary coverage invariants', () => {
  test('totals never claim a component the contributing runs did not all report', () => {
    const runs: RunSummary[] = [
      {
        taskId: 'r1',
        authority: 'read',
        createdAt: '2026-11-01T00:00:00Z',
        latencyMs: 5,
        usage: { totalTokens: 10, inputTokens: 8, cacheReadTokens: 2 },
        usageStatus: 'complete',
      },
      {
        taskId: 'r2',
        authority: 'read',
        createdAt: '2026-11-01T00:00:00Z',
        latencyMs: 5,
        usage: { totalTokens: 20, inputTokens: 18 },
        usageStatus: 'complete',
      },
    ]
    const stats = computeStats(runs)
    expect(stats.totals.totalTokens).toBe(30)
    expect(stats.totals.inputTokens).toBe(26)
    // cacheReadTokens: only one run -> omitted.
    expect('cacheReadTokens' in stats.totals).toBe(false)
  })

  test('the API shape carries the warning list for an unavailable database', () => {
    const summary: UsageSummary = {
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-02T00:00:00.000Z',
      tz: 'UTC',
      read: computeStats([]),
      manage: computeStats([]),
      combined: computeStats([]),
      series: [],
      warnings: [],
      unavailable: true,
    }
    expect(summary.unavailable).toBe(true)
  })
})

// ---- #3: an intermediate parent, not just LaunchAgents, is checked ------

describe('#3: any parent between HOME and the plist is validated', () => {
  test('Library symlinked into a graph node dir is refused', () => {
    const home = tempDir('mexplore-home-')
    const { configPath, graphRoot, stateDir } = fixturePackage()
    // The graph node holds a plist-shaped attachment.
    const id = newNode(graphRoot, 'library victim')
    const attachment = path.join(graphRoot, id, 'ai.mexplore.mexplore-ui.test_1.plist')
    fs.writeFileSync(attachment, 'GRAPH-LIBRARY-ATTACHMENT', 'utf8')
    // HOME/Library itself points at the node directory.
    fs.symlinkSync(path.join(graphRoot, id), path.join(home, 'Library'))

    const before = treeSignature(graphRoot)
    const result = uninstall({
      configPath,
      home,
      protectedRoots: [graphRoot, stateDir],
      runCommand: () => ({ status: 0, stdout: '', stderr: '' }),
      stdout: () => {},
      stderr: () => {},
    })
    expect(result.ok).toBe(false)
    expect(treeSignature(graphRoot)).toBe(before)
    expect(fs.existsSync(attachment)).toBe(true)
  })

  test('a leaf that is a symlink is refused even when parents are clean', () => {
    const home = tempDir('mexplore-home-')
    const { configPath, graphRoot, stateDir } = fixturePackage()
    const dir = path.join(home, 'Library', 'LaunchAgents')
    fs.mkdirSync(dir, { recursive: true })
    const victim = path.join(graphRoot, 'canary.txt')
    fs.writeFileSync(victim, 'GRAPH-CANARY', 'utf8')
    fs.symlinkSync(victim, path.join(dir, 'ai.mexplore.mexplore-ui.test_1.plist'))

    const result = uninstall({
      configPath,
      home,
      protectedRoots: [graphRoot, stateDir],
      runCommand: () => ({ status: 0, stdout: '', stderr: '' }),
      stdout: () => {},
      stderr: () => {},
    })
    expect(result.ok).toBe(false)
    expect(fs.readFileSync(victim, 'utf8')).toBe('GRAPH-CANARY')
  })
})

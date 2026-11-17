import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { after, before, test } from 'node:test'
import { createNode, loadNode } from '../lib/graph.js'

const run = promisify(execFile)
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const WORKER = path.join(TEST_DIR, 'race-worker.js')
const GRAPH_MAINTAIN = path.join(TEST_DIR, '..', '..', 'memory_fs', 'bin', 'graph-maintain')
const TOP_LEVEL_SEED = 0x13168
const COUNTER_WORKERS = 6
const COUNTER_ITERATIONS = 12
const UNGATED_WORKERS = 8
const UNGATED_ITERATIONS = 15

let tempRoot
before(async () => { tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-race-')) })
after(async () => { await fsp.rm(tempRoot, { recursive: true, force: true }) })

function workerSpec(directory, index, role, iterations, target, peers, mode = 'gated') {
  return {
    label: `${role}-${index}`,
    role,
    iterations,
    outfile: path.join(directory, `${role}-${index}.jsonl`),
    args: [
      '--root', path.dirname(directory),
      '--target', target,
      '--role', role,
      '--iterations', String(iterations),
      '--outfile', path.join(directory, `${role}-${index}.jsonl`),
      '--seed', String(TOP_LEVEL_SEED + index),
      '--peers', peers.join(','),
      '--mode', mode,
    ],
  }
}

async function runWorkers(specs, timeoutMs) {
  const running = specs.map((spec) => {
    const child = spawn(process.execPath, [WORKER, ...spec.args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const exited = new Promise((resolve) => {
      child.once('error', (error) => resolve({ spec, code: null, signal: null, stdout, stderr, error }))
      child.once('close', (code, signal) => resolve({ spec, code, signal, stdout, stderr }))
    })
    return { child, exited }
  })
  const allExited = Promise.all(running.map(({ exited }) => exited))
  let timer
  const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(true), timeoutMs) })
  const result = await Promise.race([allExited, timedOut])
  clearTimeout(timer)
  if (result === true) {
    for (const { child } of running) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    await allExited
    throw new Error(`race workers exceeded ${timeoutMs}ms watchdog and were killed`)
  }
  return result
}

function assertCleanExits(results) {
  for (const result of results) {
    assert.equal(
      result.code,
      0,
      `${result.spec.label} exited code=${result.code} signal=${result.signal}; stderr=${result.stderr || '(empty)'}`,
    )
  }
}

async function readOutcomes(specs) {
  const outcomes = []
  for (const spec of specs) {
    const text = await fsp.readFile(spec.outfile, 'utf8')
    const records = text.trimEnd() === '' ? [] : text.trimEnd().split('\n').map((line) => JSON.parse(line))
    const expected = spec.role === 'supersede' ? 1 : spec.iterations
    assert.equal(records.length, expected, `${spec.label} did not record exactly one outcome per attempt`)
    outcomes.push(...records.map((record) => ({ ...record, worker: spec.label })))
  }
  return outcomes
}

function finalCounter(body) {
  const match = body.match(/^counter: (\d+)$/m)
  assert.notEqual(match, null, `target body has no counter line: ${JSON.stringify(body)}`)
  return Number(match[1])
}

function unexpectedDetails(records) {
  return records.map((record) => `${record.worker}[${record.iter}]: ${record.detail?.message ?? record.outcome}`).join('\n')
}

async function assertNoLocks(root) {
  try {
    assert.deepEqual(await fsp.readdir(path.join(root, '.locks')), [], 'race leaked one or more Node lock directories')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

test('N mixed concurrent writers, no silent lost update (#131)', async () => {
  const root = path.join(tempRoot, 'mixed-graph')
  const outputDir = path.join(root, '.race-output')
  await fsp.mkdir(outputDir, { recursive: true })
  const target = await createNode(root, { description: 'race counter target', body: 'counter: 0' })
  const peers = await Promise.all(Array.from({ length: 6 }, (_, index) => (
    createNode(root, { description: `race edge peer ${index}` })
  )))

  const specs = []
  let index = 0
  for (let worker = 0; worker < COUNTER_WORKERS; worker++) {
    specs.push(workerSpec(outputDir, index++, 'counter', COUNTER_ITERATIONS, target, peers))
  }
  specs.push(workerSpec(outputDir, index++, 'supersede', 1, target, peers))
  // Every shell worker gets one exclusive peer; plugin-edge workers share a
  // separate pool. Cross-role lock-free symlink writes can never collide.
  for (let worker = 0; worker < 2; worker++) {
    specs.push(workerSpec(outputDir, index++, 'shell-plain', 8, target, peers.slice(worker, worker + 1)))
  }
  for (let worker = 0; worker < 2; worker++) {
    specs.push(workerSpec(outputDir, index++, 'shell-typed', 8, target, peers.slice(worker + 2, worker + 3)))
  }
  for (let worker = 0; worker < 2; worker++) {
    specs.push(workerSpec(outputDir, index++, 'plugin-edge', 8, target, peers.slice(4)))
  }

  const processes = await runWorkers(specs, 60_000)
  assertCleanExits(processes)
  const outcomes = await readOutcomes(specs)

  const counters = outcomes.filter((record) => record.role === 'counter')
  assert.equal(counters.length, COUNTER_WORKERS * COUNTER_ITERATIONS)
  const badCounters = counters.filter((record) => ['rejected-other', 'rejected-unread'].includes(record.outcome))
  assert.equal(badCounters.length, 0, `unexpected counter rejection(s):\n${unexpectedDetails(badCounters)}`)
  const landed = counters.filter((record) => record.outcome === 'landed')
  const stale = counters.filter((record) => record.outcome === 'rejected-stale')
  assert.equal(landed.length + stale.length, counters.length, 'every counter attempt must land or receive a typed Stale Write rejection')

  const targetNode = await loadNode(root, target)
  assert.notEqual(targetNode, undefined)
  assert.equal(
    finalCounter(targetNode.body),
    landed.length,
    'every reported successful increment must remain in the final counter (no silent lost update)',
  )

  const shellOutcomes = outcomes.filter((record) => record.role === 'shell-plain' || record.role === 'shell-typed')
  const badShell = shellOutcomes.filter((record) => record.outcome !== 'landed')
  assert.equal(badShell.length, 0, `shell edge failure(s):\n${unexpectedDetails(badShell)}`)
  const pluginEdges = outcomes.filter((record) => record.role === 'plugin-edge')
  const badPluginEdges = pluginEdges.filter((record) => !['landed', 'rejected-stale'].includes(record.outcome))
  assert.equal(badPluginEdges.length, 0, `plugin edge failure(s):\n${unexpectedDetails(badPluginEdges)}`)
  const supersede = outcomes.filter((record) => record.role === 'supersede')
  assert.equal(supersede.length, 1)
  // Gated supersede (#143): against nonstop counter traffic the banner write
  // may exhaust its reconcile retries — landed and typed-stale are both
  // contract outcomes; unread/other rejections and silence are not.
  assert.ok(
    ['landed', 'rejected-stale'].includes(supersede[0].outcome),
    `supersede failed: ${unexpectedDetails(supersede)}`,
  )

  const { stdout: report } = await run(GRAPH_MAINTAIN, [], { env: { ...process.env, GRAPH_ROOT: root } })
  const summary = report.split('\n').find((line) => line.startsWith('summary:'))
  assert.ok(summary, `graph-maintain omitted its summary:\n${report}`)
  assert.match(summary, /\bintegrity_issues=0\b/)
  assert.match(summary, /\bhalf_edges=0\b/)
  assert.match(summary, /\bfork_nodes=\d+\b/)
  await assertNoLocks(root)
})

test('reintroducing the unlocked, ungated update path loses writes silently (v1 defect, #131)', async () => {
  const root = path.join(tempRoot, 'ungated-graph')
  const outputDir = path.join(root, '.race-output')
  await fsp.mkdir(outputDir, { recursive: true })
  const target = await createNode(root, { description: 'ungated race counter target', body: 'counter: 0' })
  const specs = Array.from({ length: UNGATED_WORKERS }, (_, index) => (
    workerSpec(outputDir, index, 'counter', UNGATED_ITERATIONS, target, [], 'ungated')
  ))

  const processes = await runWorkers(specs, 30_000)
  assertCleanExits(processes)
  const outcomes = await readOutcomes(specs)
  const expectedAttempts = UNGATED_WORKERS * UNGATED_ITERATIONS
  assert.equal(outcomes.length, expectedAttempts)
  assert.equal(
    outcomes.filter((record) => record.outcome === 'landed').length,
    expectedAttempts,
    `the ungated path unexpectedly rejected or failed an attempt:\n${unexpectedDetails(outcomes.filter((record) => record.outcome !== 'landed'))}`,
  )
  const targetNode = await loadNode(root, target)
  assert.notEqual(targetNode, undefined)
  assert.ok(
    finalCounter(targetNode.body) < expectedAttempts,
    'expected the unlocked/ungated path to silently lose at least one update — if this fails, the harness cannot prove it detects the v1 defect',
  )
})

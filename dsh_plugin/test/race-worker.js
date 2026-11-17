#!/usr/bin/env node

import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { loadNode, updateNode } from '../lib/graph.js'
import { apply } from '../lib/index.js'

const run = promisify(execFile)
const EDGE_ADD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'memory_fs', 'bin', 'edge-add')
const ROLES = new Set(['counter', 'supersede', 'shell-plain', 'shell-typed', 'plugin-edge'])
const MODES = new Set(['gated', 'ungated'])
const COUNTER_LINE = /^counter: (\d+)$/m

function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag?.startsWith('--') || value === undefined) throw new Error(`invalid argument list near ${JSON.stringify(flag)}`)
    values[flag.slice(2)] = value
  }
  for (const key of ['root', 'target', 'role', 'iterations', 'outfile', 'seed', 'peers', 'mode']) {
    if (values[key] === undefined) throw new Error(`missing --${key}`)
  }
  const iterations = Number(values.iterations)
  const seed = Number(values.seed)
  if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error(`invalid --iterations: ${values.iterations}`)
  if (!Number.isSafeInteger(seed)) throw new Error(`invalid --seed: ${values.seed}`)
  if (!ROLES.has(values.role)) throw new Error(`invalid --role: ${values.role}`)
  if (!MODES.has(values.mode)) throw new Error(`invalid --mode: ${values.mode}`)
  const peers = values.peers === '' ? [] : values.peers.split(',')
  if (['shell-plain', 'shell-typed', 'plugin-edge'].includes(values.role) && peers.length === 0) {
    throw new Error(`--role ${values.role} requires --peers`)
  }
  return { ...values, iterations, seed, peers }
}

/** A tiny deterministic generator: the command line seed fully reproduces every choice. */
function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state |= 0
    state = state + 0x6D2B79F5 | 0
    let value = Math.imul(state ^ state >>> 15, 1 | state)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}

function fakeCtx() {
  const tools = new Map()
  const ctx = {
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    inject(names, callback) {
      if (names.includes('systemPrompt')) return
      callback({ systemPrompt: { section: () => () => {}, variable: () => () => {} } })
    },
  }
  return { ctx, tools }
}

function counterValue(body) {
  const match = body.match(COUNTER_LINE)
  return match === null ? 0 : Number(match[1])
}

function withCounter(body, value) {
  if (COUNTER_LINE.test(body)) return body.replace(COUNTER_LINE, `counter: ${value}`)
  if (body.length === 0) return `counter: ${value}`
  return `${body}${body.endsWith('\n') ? '' : '\n'}counter: ${value}`
}

function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error)
  const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
  return stderr === '' || message.includes(stderr) ? message : `${message}: ${stderr}`
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const random = mulberry32(options.seed)
  const append = (record) => fsp.appendFile(options.outfile, `${JSON.stringify(record)}\n`, 'utf8')
  const record = (iter, outcome, detail) => append({ role: options.role, iter, outcome, detail })
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: options.root })
  const memoryRead = tools.get('memory_read')
  const memoryWrite = tools.get('memory_write')

  if (options.role === 'counter') {
    for (let iter = 0; iter < options.iterations; iter++) {
      try {
        let body
        if (options.mode === 'gated') {
          body = (await memoryRead.execute({ id: options.target }, {})).body
        } else {
          const node = await loadNode(options.root, options.target)
          if (node === undefined) throw new Error(`counter target does not exist: ${options.target}`)
          body = node.body
        }
        const next = counterValue(body) + 1
        const nextBody = withCounter(body, next)
        if (options.mode === 'gated') {
          await memoryWrite.execute({ id: options.target, body: nextBody }, {})
        } else {
          // Deliberately widen only the test's ungated read-modify-write window.
          // The production defect needs no delay, but relying on incidental OS
          // scheduling would make the proof-of-detection test flaky in CI.
          const delayMs = 5 + Math.floor(random() * 16)
          await new Promise((resolve) => setTimeout(resolve, delayMs))
          await updateNode(options.root, options.target, { body: nextBody })
        }
        await record(iter, 'landed', { counter: next })
      } catch (error) {
        const message = errorMessage(error)
        if (/Stale Write/.test(message)) await record(iter, 'rejected-stale', { message })
        else if (/has not been read/.test(message)) await record(iter, 'rejected-unread', { message })
        else await record(iter, 'rejected-other', { message })
      }
    }
    return
  }

  if (options.role === 'supersede') {
    // The banner prepend is gated (#143): against live counter traffic a
    // supersede may draw a Stale Write, and the contract answer is story 8's
    // reconcile — re-read and retry. Bounded, because the counter workers
    // never stop; a final typed rejection is a valid outcome, silence is not.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await memoryRead.execute({ id: options.target }, {})
        const result = await memoryWrite.execute({
          description: `race supersede contender ${process.pid}`,
          supersedes: options.target,
        }, {})
        await record(0, 'landed', { id: result.id, attempt })
        return
      } catch (error) {
        const message = errorMessage(error)
        if (/Stale Write/.test(message)) {
          if (attempt === 2) await record(0, 'rejected-stale', { message, attempt })
          continue
        }
        if (/has not been read/.test(message)) await record(0, 'rejected-unread', { message, attempt })
        else await record(0, 'rejected-other', { message, attempt })
        return
      }
    }
    return
  }

  if (options.role === 'plugin-edge') {
    const types = ['relates-to', 'follows-from']
    for (let iter = 0; iter < options.iterations; iter++) {
      const peer = options.peers[Math.floor(random() * options.peers.length)]
      const type = random() < 0.5 ? undefined : types[Math.floor(random() * types.length)]
      try {
        await memoryRead.execute({ id: peer }, {})
        const args = type === undefined
          ? { id: peer, links: [options.target] }
          : { id: peer, typed_links: [{ id: options.target, type }] }
        const result = await memoryWrite.execute(args, {})
        const failed = result.links.find((link) => link.to === options.target && link.status === 'failed')
        if (failed !== undefined) {
          await record(iter, 'rejected-other', { peer, type, message: 'memory_write reported a failed edge' })
        } else {
          await record(iter, 'landed', { peer, type })
        }
      } catch (error) {
        const message = errorMessage(error)
        if (/Stale Write/.test(message)) await record(iter, 'rejected-stale', { peer, type, message })
        else if (/has not been read/.test(message)) await record(iter, 'rejected-unread', { peer, type, message })
        else await record(iter, 'rejected-other', { peer, type, message })
      }
    }
    return
  }

  const types = ['relates-to', 'follows-from']
  for (let iter = 0; iter < options.iterations; iter++) {
    const peer = options.peers[Math.floor(random() * options.peers.length)]
    const type = options.role === 'shell-typed' ? types[Math.floor(random() * types.length)] : undefined
    const args = type === undefined ? [options.target, peer] : [options.target, peer, type]
    try {
      await run(EDGE_ADD, args, { env: { ...process.env, GRAPH_ROOT: options.root } })
      await record(iter, 'landed', { peer, type })
    } catch (error) {
      await record(iter, 'rejected-other', { peer, type, message: errorMessage(error) })
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`)
  process.exitCode = 1
})

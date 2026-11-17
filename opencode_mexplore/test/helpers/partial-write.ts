import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { GraphRuntime } from '../../src/graph/index'

/** A real, existing peer; fixture writes stay outside the call under test. */
export async function seedLinkTarget(runtime: GraphRuntime): Promise<string> {
  const seed = runtime.createCall({ callId: randomUUID(), authority: 'manage', message: 'create a link target', evidence: [] })
  await seed.execute('memory_write', { description: 'existing link target', body: 'the peer exists before the tested write' })
  const id = seed.report().writes[0]?.nodeId
  if (id === undefined) throw new Error('fixture did not create the link target')
  return id
}

/** Fail the actual symlink syscall after the node write, not a pre-write guard. */
export async function withFailedEdge<T>(peer: string, run: () => Promise<T>): Promise<T> {
  const original = fsp.symlink
  let reached = false
  fsp.symlink = async (target, link, ...rest) => {
    if (path.basename(String(link)) === peer && path.basename(path.dirname(String(link))) === '__edges__') {
      reached = true
      throw Object.assign(new Error('injected edge storage failure'), { code: 'ENOSPC' })
    }
    return original(target, link, ...rest)
  }
  try {
    const result = await run()
    if (!reached) throw new Error('fixture never reached the post-write edge syscall')
    return result
  } finally {
    fsp.symlink = original
  }
}

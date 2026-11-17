import fsp from 'node:fs/promises'
/**
 * Usage logging, wired into the plugin (Lane B, items 1 and 3).
 *
 * `createUsage` builds the one `UsageSink` a plugin instance uses: a recorder,
 * a writer and the constants `runCall` needs. It also starts the SINGLE event
 * subscription the plugin makes — `ctx.event.subscribe` is called once, at
 * setup, because every subscription is a server round trip and the stream is one
 * process-wide bus.
 *
 * Two properties keep this out of the way of a memory call:
 *
 *   - **it can be disabled** (`usageLog: false`), in which case no subscription
 *     is made and `runCall` does no usage work at all;
 *   - **a writer failure is logged once and never thrown**: usage accounting is
 *     telemetry, and losing a line must not lose the user's answer.
 *
 * @module mexplore/plugin/usage-sink
 */
import type { HostContext } from './host'
import type { UsageSink } from './call'
import { DRAIN_MS, UsageRecorder, type UsageEvent } from './usage-capture'
import { appendUsage, resolveUsageDir, type UsageRecord } from './usage-log'

/** The event types the recorder consumes. Narrowing server-side is cheaper. */
export const USAGE_EVENT_TYPES = [
  'session.usage.updated',
  'session.step.ended',
  'session.step.failed',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
] as const

export interface UsageSinkOptions {
  graphRoot: string
  pluginVersion: string
  /** Directory the monthly files live in. Overridable for tests. */
  usageDir?: string
  /** How long a call waits for the terminal event. */
  drainMs?: number
  /**
   * Debug aid (off by default): log one line per written record naming which
   * event kinds actually arrived. This is how the integration suite answers
   * "does `session.usage.updated` fire for a child?", rather than assuming it —
   * the counts come from the shipped capture path.
   */
  probe?: boolean
}

/** `realpath`, falling back to the input when the path does not exist yet. */
async function realpath(target: string): Promise<string> {
  return fsp.realpath(target).catch(() => target)
}

export interface CreatedUsage {
  /** The sink `runCall` receives, or `undefined` when the log is off. */
  sink: UsageSink
  /** The resolved directory, for `status`. */
  dir: string
  /** Stop the subscription and drop every buffer. */
  dispose: () => void
}

/**
 * Build the sink and start the ONE event subscription.
 *
 * The subscription runs detached (`void pump()`): a server that never emits an
 * event must not hold up plugin setup, and the stream's own end (plugin unload)
 * is what closes it.
 */
export function createUsage(ctx: HostContext, options: UsageSinkOptions): CreatedUsage {
  const dir = options.usageDir ?? resolveUsageDir()
  /**
   * The contract records the graph root's REAL path (`/abs/realpath/of/graph`),
   * not the lexical one: on macOS `/tmp` is a symlink to `/private/tmp`, and two
   * spellings of one graph must not look like two graphs to the reader.
   * Resolved on first write and then kept; a graph created after setup still
   * resolves on the record's own call.
   */
  let graphRoot: string | undefined
  const recorder = new UsageRecorder()
  let warned = false
  let closed = false
  // Counters for the debug probe, per event kind.
  const seen = new Map<string, number>()
  let lastTokens: unknown = null

  const sink: UsageSink = {
    track: (sessionID) => recorder.track(sessionID),
    drain: (sessionID, ms) => recorder.drain(sessionID, ms),
    read: (sessionID) => recorder.read(sessionID),
    write: async (record: UsageRecord) => {
      graphRoot ??= await realpath(options.graphRoot)
      record.graphRoot = graphRoot
      if (options.probe === true) {
        process.stderr.write(
          `mexplore usage probe: call=${record.callId} usage.updated=${seen.get('session.usage.updated') ?? 0}` +
            ` step=${(seen.get('session.step.ended') ?? 0) + (seen.get('session.step.failed') ?? 0)}` +
            ` lastTokens=${JSON.stringify(lastTokens)}` +
            ` terminal=${[...seen.entries()].filter(([type]) => type.startsWith('session.execution.')).reduce((left, [, count]) => left + count, 0)}` +
            ` status=${record.usageStatus} outcome=${record.outcome}\n`,
        )
      }
      const result = await appendUsage(dir, record)
      // One warning per process: a broken state directory would otherwise print
      // on every call.
      if ('error' in result && !warned) {
        warned = true
        process.stderr.write(
          `mexplore: usage logging is unavailable (${result.error}); memory calls are unaffected\n`,
        )
      }
    },
    drainMs: options.drainMs ?? DRAIN_MS,
    // The record is rewritten with the realpath on write; this is the value a
    // caller sees before one exists (status, `/mexplore usage`).
    graphRoot: options.graphRoot,
    pluginVersion: options.pluginVersion,
  }

  const pump = async (): Promise<void> => {
    try {
      for await (const event of ctx.event.subscribe({ types: USAGE_EVENT_TYPES })) {
        if (closed) return
        seen.set(event.type, (seen.get(event.type) ?? 0) + 1)
        if (event.type === 'session.usage.updated') lastTokens = event.data?.tokens ?? null
        recorder.observe(event as UsageEvent)
      }
    } catch {
      // A closed bus is normal on unload; anything else only means no usage for
      // the rest of this process, which the writer already reports.
    }
  }
  void pump()

  return {
    sink,
    dir,
    dispose: () => {
      closed = true
      recorder.clear()
    },
  }
}

/**
 * A promise chain that runs tasks one at a time (REQ-011's "writes run one at
 * a time").
 *
 * OpenCode runs the tool calls of one step concurrently, so without this two
 * `memory_write`s of one child would interleave their read-before-write state,
 * their `similar` scans and their node locks. Reads are deliberately NOT routed
 * through this: serializing them would only add latency, and they never mutate.
 *
 * @module mexplore/graph/queue
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()

  /** Queue `task` behind everything already queued. Its failure is the caller's. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task)
    // The chain must survive a failed task, or one refused write would strand
    // every later write in the same call.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /** Settle once everything queued so far has finished (success or failure). */
  async idle(): Promise<void> {
    await this.tail
  }
}

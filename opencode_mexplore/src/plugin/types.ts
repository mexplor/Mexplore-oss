/**
 * The shapes shared by the OpenCode wiring (lane A2).
 *
 * @module mexplore/plugin/types
 */
import type { Authority, GraphCall } from '../graph/index'

/** Where the child's model came from (REQ-005). Reported in `metadata.modelSource`. */
export type ModelSource = 'selected' | 'default' | 'parent-fallback'

/** A model reference in OpenCode's `provider/model` terms. */
export interface ModelRef {
  providerID: string
  id: string
}

/**
 * The child lifecycle (REQ-004): `creating → running → settling → removed`.
 *
 * `settling` means the answer is being finished: every graph-tool promise still
 * in flight for the child is awaited before the footer is built, so a late
 * write can never be reported as `no writes`.
 */
export type ChildState = 'creating' | 'running' | 'settling' | 'removed'

/** One child session this process owns, with the call it serves. */
export interface OwnedChild {
  /** The owned child's session ID. Never leaves the plugin (REQ-003). */
  readonly sessionID: string
  /** The dsh call id: keys read-before-write state, never the session ID. */
  readonly callId: string
  readonly authority: Authority
  readonly call: GraphCall
  readonly model: ModelRef
  readonly modelSource: ModelSource
  state: ChildState
}

/** What a tool executor hands the host. */
export interface ToolResultPayload {
  content: string
  metadata?: Record<string, unknown>
}


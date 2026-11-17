/**
 * The public shapes of the graph adapter, split out so every module can use
 * them without importing the loader (which has side effects at load).
 *
 * @module mexplore/graph/types
 */

/** Which half of the memory surface a call may reach. */
export type Authority = 'read' | 'manage'

/** One caller-supplied piece of conversation material (REQ-001 normalization). */
export interface Evidence {
  sourceId: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  complete: boolean
  date?: string
}

/** Where memory lives plus dsh's two result-size knobs. */
export interface GraphConfig {
  graphRoot: string
  searchLimit?: number
  maxIndexEntries?: number
  /**
   * Arm dsh_plugin's 2a placeholder guards on the MANAGE profile (default on).
   *
   * The A2A service arms them per deployment at manage authority, and the plugin
   * does the same: a live task filled every optional field with a stand-in (no
   * body, a one-byte attachment called `x`) and every one of them landed. The
   * guards are decidable from the arguments alone, so the refusal happens in
   * dsh's trusted preparation: provable non-execution, no fence latch, and the
   * model gets a remedy.
   *
   * Read authority is never affected: it cannot write at all.
   */
  placeholderGuards?: boolean
}

/** One model-facing tool: name, per-profile description, JSON Schema verbatim. */
export interface ToolDef {
  name: string
  description: string
  input: Record<string, unknown>
}

/** What the plugin footer reports for one write (REQ-012). Built from results. */
export interface WriteRecord {
  tool: 'memory_write' | 'memory_attach'
  nodeId?: string
  description?: string
  status: 'ok' | 'incomplete' | 'failed'
}

/** An edge `memory_read({from})` created, so the footer can announce it. */
export interface EdgeRecord {
  from: string
  to: string
}

/** The footer's own report — exactly what `footerLines()` renders. */
export interface GraphReport {
  toolCalls: number
  writes: WriteRecord[]
  edges: EdgeRecord[]
}

/** What one tool executor returns to the host. */
export interface ToolResult {
  content: string
  metadata?: Record<string, unknown>
}

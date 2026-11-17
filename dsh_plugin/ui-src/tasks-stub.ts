// Build-time replacement for mexplore_ui/src/server/usage/tasks.ts.
//
// The original reads the memory_service A2A task database through
// `require('bun:sqlite')`. The panel never reads it: server-entry.ts gives the
// Store its own run source, so mexplore_ui's ServiceRunSource is never built.
// But store.ts imports ServiceRunSource, which imports tasks.ts, and esbuild has
// to resolve `bun:sqlite` inside it whether or not that code can run. So
// scripts/build-ui.mjs swaps this file in for the one file whose RESOLVED path
// is mexplore_ui/src/server/usage/tasks.ts (not for an import text, which moves
// whenever mexplore_ui rearranges its imports).
//
// If it is ever reached anyway, it reports usage as unavailable, which is what
// the panel shows.

import type { Authority } from '../../mexplore_ui/src/shared/types.ts'

export interface TaskRow {
  taskId: string
  authority: Authority
  lifecycle: string
  createdAt: string
  finishedAt: string | null
  updatedAt: string | null
  latencyMs: number | null
  terminal: boolean
}

export interface TasksRead {
  available: boolean
  rows: TaskRow[]
  error: string | null
  rejectedTaskIds: number
}

export const TASKS_DB_FILE = 'memory-agent.sqlite'

export function readTasks(_stateDir: string): TasksRead {
  return { available: false, rows: [], error: null, rejectedTaskIds: 0 }
}

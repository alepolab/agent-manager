import { readFileSync } from 'node:fs'
import { resolveClaudePath } from './claudeDir.ts'

/** Agent Manager's own switches, kept under one key of Claude Code's settings.json so Claude Code ignores them. */
export interface AgentManagerSettings {
  labs?: boolean
  /** Per-run caps for new runs; an instance env var overrides them (see defaultBudget). */
  runBudget?: { maxTokens?: number, maxMinutes?: number, /** Dollars per run; the cap an operator actually budgets in. */ maxUsd?: number }
  /** A model alias every pipeline agent runs on, whatever its own file declares. Absent: each agent's own choice. */
  agentModel?: string
  /**
   * How many runs may be live on this instance at once. Absent or 0: no cap.
   *
   * The workspace lock already stops two runs corrupting one checkout, but it
   * says nothing about the total: forty runs against forty different
   * directories are forty concurrent agent pipelines, each spending its own
   * budget, and nothing between "start one" and "start every ticket on the
   * board" refuses. An instance-wide ceiling is the only thing that does.
   */
  maxConcurrentRuns?: number
}

/**
 * Read synchronously, per call, straight from the file: the values are small,
 * a run or an agent call starts seldom enough that caching would only add a
 * stale copy to reason about, and the Settings page writes the same file.
 */
export function agentManagerSettings(): AgentManagerSettings {
  try {
    const s = JSON.parse(readFileSync(resolveClaudePath('settings.json'), 'utf-8'))?.agentManager
    return s && typeof s === 'object' ? s : {}
  } catch {
    return {}
  }
}

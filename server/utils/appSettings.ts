import { readFileSync } from 'node:fs'
import { resolveClaudePath } from './claudeDir.ts'

/** Agent Manager's own switches, kept under one key of Claude Code's settings.json so Claude Code ignores them. */
export interface AgentManagerSettings {
  labs?: boolean
  /** Per-run caps for new runs; an instance env var overrides them (see defaultBudget). */
  runBudget?: { maxTokens?: number, maxMinutes?: number }
  /** A model alias every pipeline agent runs on, whatever its own file declares. Absent: each agent's own choice. */
  agentModel?: string
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

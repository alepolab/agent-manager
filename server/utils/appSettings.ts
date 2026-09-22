import { readFileSync } from 'node:fs'
import { resolveClaudePath } from './claudeDir.ts'

/** Agent Manager's own switches, kept under one key of Claude Code's settings.json so Claude Code ignores them. */
export interface AgentManagerSettings {
  labs?: boolean
  /** Per-run caps for new runs; an instance env var overrides them (see defaultBudget). */
  runBudget?: { maxTokens?: number, maxMinutes?: number }
  /** A model alias every pipeline agent runs on, whatever its own file declares. Absent: each agent's own choice. */
  agentModel?: string
  /**
   * Jira, for the fields that are not secrets. The API token is NOT here: it is
   * per-developer and encrypted (server/utils/users.ts), because settings.json
   * is exported, diffed and baked into images.
   */
  jira?: {
    /** Writing to Jira at all. Default false; JIRA_POST_ENABLED overrides either way. */
    postEnabled?: boolean
    baseUrl?: string
    defaultProject?: string
    /** Appended as "For vis: <name>" on a posted or rendered comment. */
    forVisName?: string
  }
}

/**
 * The precedence rule, in one place: an environment variable set to a
 * NON-EMPTY value wins, then the saved setting, then the built-in default.
 *
 * Non-empty is the whole point. `.env.sample` ships `JIRA_POST_ENABLED=`,
 * `AGENT_RUN_MAX_TOKENS=` and the rest as bare `NAME=` lines, and dotenv turns
 * those into `''`. If "set" meant "present", everyone who copied the sample
 * would be permanently pinned to the default with no way to change it from the
 * UI and nothing saying why. `defaultBudget` gets this right by accident
 * (`Number('') || …`); everything else gets it right through these two.
 */
export function envString(name: string): string | undefined {
  const raw = process.env[name]?.trim()
  return raw ? raw : undefined
}

/** A tri-state env flag: true for '1', false for '0', undefined when unset,
 *  empty or anything else - so a typo pins nothing rather than pinning off. */
export function envFlag(name: string): boolean | undefined {
  const raw = envString(name)
  return raw === '1' ? true : raw === '0' ? false : undefined
}

/**
 * A saved setting read as a string, or undefined for anything that is not a
 * non-empty one.
 *
 * Nothing validates what the raw settings.json editor writes - the PUT route
 * checks only that `agentManager` is an object - so a number, null or an array
 * reaches every reader here. `42.trim()` is a TypeError thrown out of whatever
 * was asking, which for the Jira host means a run that cannot start because
 * somebody mistyped a field on the Settings page.
 */
export function settingString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
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

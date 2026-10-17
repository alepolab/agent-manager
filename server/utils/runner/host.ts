/**
 * The host runner: what every step did before the runner abstraction existed.
 * The SDK spawns its bundled Claude Code binary on this machine, in the run's
 * worktree, with the environment agentCaller.ts builds. There is nothing to
 * configure, so this module exists to give the choice a name and a place for
 * the one thing a host step needs in common with a sandboxed one: the SDK
 * options it contributes (none).
 */
import type { Options } from '@anthropic-ai/claude-agent-sdk'

/** Extra SDK options for a step on the host: none. The SDK's own spawn is the host runner. */
export function hostRunnerOptions(): Partial<Options> {
  return {}
}

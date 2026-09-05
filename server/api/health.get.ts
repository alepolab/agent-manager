import { getClaudeDir } from '../utils/claudeDir'
import { agentRunsRoot } from '../utils/runArtifacts'

/**
 * Deliberately reports the two directories this instance actually reads,
 * not just "ok". A container's named volume or a dev server's host
 * `~/.claude` look identical from the UI otherwise — an empty run list and
 * a wrong-directory run list both render as "no runs" with no signal to
 * tell them apart. `curl` this before concluding a run "isn't there": it
 * usually means it's in the other store, not that it never happened.
 */
export default defineEventHandler(() => {
  return {
    status: 'ok',
    claudeDir: getClaudeDir(),
    agentRunsDir: agentRunsRoot(),
  }
})

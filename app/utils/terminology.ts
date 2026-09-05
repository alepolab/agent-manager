import { getModelTagline } from '~/utils/models'
import type { AgentModel } from '~/types'

export const friendlyToolName = {
  Read: 'Reading your files...',
  Write: 'Saving changes...',
  Edit: 'Editing files...',
  Glob: 'Searching your workspace...',
  Grep: 'Searching file contents...',
  Bash: 'Running a command...',
  Agent: 'Working on a subtask...',
} as Record<string, string>

/**
 * @deprecated Import `getModelTagline` from `~/utils/models` instead.
 * Kept for backwards compat during migration.
 */
export function getFriendlyModelName(model: AgentModel | undefined): string {
  return getModelTagline(model)
}

export function getFriendlyToolName(tool: string): string {
  return friendlyToolName[tool] ?? `Working...`
}

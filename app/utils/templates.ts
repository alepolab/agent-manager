import type { AgentFrontmatter } from '~/types'

export interface AgentTemplate {
  id: string
  icon: string
  frontmatter: AgentFrontmatter
  body: string
}

/**
 * Empty, on purpose.
 *
 * This instance carries the oh-my-agent estate only: agents come from
 * `.agents/agents/`, skills from `.agents/skills/`, and workflows from
 * `.agents/workflows/` (projected as skills, which is how oh-my-agent's own
 * `link` puts a workflow into a Claude runtime). `server/utils/teamSync.ts`
 * seeds all three straight from that tree.
 *
 * The 28 templates that used to live here — 19 `sdlc-*` driving Runbook A and
 * C, plus nine general-purpose gallery entries — were removed with them. The
 * type stays because `workflowInstantiation.ts` and the template gallery are
 * still typed against it; the catalogue is simply empty.
 */
export const agentTemplates: AgentTemplate[] = []

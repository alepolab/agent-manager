import { resolveSkillInvocation } from './resolveSkill.ts'

export interface BuildPromptOpts {
  agentSlug: string
  agentName?: string
  agentBody: string
  /** Bare skill slugs from the agent's frontmatter. */
  skills?: string[]
  cwd: string
}

/**
 * The system prompt for one agent: its instructions, the bodies of the skills it
 * declares, and its working directory.
 *
 * Before this existed, `frontmatter.skills` was written by the UI, displayed by
 * the UI, and read by nothing — an agent's page could show it "using" a skill
 * the model never saw. Every path that runs an agent must build its prompt here,
 * or that divergence comes straight back.
 */
export async function buildAgentSystemPrompt(opts: BuildPromptOpts): Promise<string> {
  const name = opts.agentName || opts.agentSlug
  const parts = [
    `You are "${name}", a specialized agent. Follow these instructions precisely:`,
    '',
    opts.agentBody,
  ]

  const bodies: string[] = []
  for (const slug of opts.skills ?? []) {
    try {
      const skill = await resolveSkillInvocation(slug)
      // An unresolvable slug is skipped, not fatal: one typo in a skills list
      // must not stop the agent from running at all.
      if (skill?.body?.trim()) bodies.push(`### ${skill.name}\n\n${skill.body.trim()}`)
    } catch {
      // Same reasoning — a broken skill file degrades that skill, nothing more.
    }
  }

  if (bodies.length) {
    parts.push(
      '',
      '## Skills available to you',
      '',
      'These are loaded because this agent declares them. Follow them as you would',
      'your own instructions above.',
      '',
      bodies.join('\n\n'),
    )
  }

  parts.push('', `The current working directory is: ${opts.cwd}`)
  return parts.join('\n')
}

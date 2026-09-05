import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { agentTemplates } from '~/utils/templates'
import { resolveClaudePath } from '../utils/claudeDir'
/**
 * Brings the instance's config directory in line with the team plugin and
 * the shipped templates at boot, so a fresh instance carries the team's
 * agents, skills and workflow before anyone signs in. TEAM_SEED_ON_BOOT=0
 * keeps a developer's own directory untouched.
 */
import { teamSync } from '../utils/teamSync.ts'

export default defineNitroPlugin(() => {
  if (process.env.TEAM_SEED_ON_BOOT === '0') return
  teamSync().then((s) => {
    console.log(`[teamSeed] plugin ${s.pluginVersion ?? 'not installed'}; ${s.agents.length} agents, ${s.skills.length} skills, workflow ${s.workflow.state}`)

    // That count is FILES SEEDED, not skills that resolve, and the two are not
    // the same thing: a boot reporting "9 agents, 8 skills" still had nine of
    // the thirteen skills its agents declare missing entirely. Nothing said so,
    // because buildAgentSystemPrompt swallows a per-skill resolution failure by
    // design - so each agent ran without the instructions it was supposed to
    // have and looked completely healthy doing it.
    //
    // So check what the agents actually ASK FOR against what is present, and
    // name anything missing. A warning, not a failure: one absent optional
    // skill must not take the instance down, but it must not be silent either.
    try {
      const declared = new Set<string>()
      for (const t of agentTemplates.filter(t => t.id.startsWith('sdlc-'))) {
        for (const skill of t.frontmatter.skills ?? []) declared.add(skill)
      }
      const missing = [...declared].filter(name => !existsSync(join(resolveClaudePath('skills'), name))).sort()
      if (missing.length) {
        console.warn(
          `[teamSeed] WARNING: ${missing.length} of ${declared.size} declared skills do not resolve — `
          + `agents declaring them run WITHOUT those instructions, silently: ${missing.join(', ')}`)
      } else {
        console.log(`[teamSeed] all ${declared.size} declared skills resolve`)
      }
    } catch (err) {
      console.warn('[teamSeed] could not verify declared skills', err)
    }
  }).catch((err) => console.error('[teamSeed] failed:', err instanceof Error ? err.message : err))
})

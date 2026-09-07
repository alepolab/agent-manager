/**
 * Brings the instance's config directory in line with the team plugin and
 * the shipped templates at boot, so a fresh instance carries the team's
 * agents, skills and workflow before anyone signs in. TEAM_SEED_ON_BOOT=0
 * keeps a developer's own directory untouched.
 */
import { teamSync } from '../utils/teamSync.ts'

export default defineNitroPlugin(() => {
  if (process.env.TEAM_SEED_ON_BOOT === '0') return
  teamSync('boot').then((s) => {
    console.log(`[teamSeed] plugin ${s.pluginVersion ?? 'not installed'}; ${s.agents.length} agents, ${s.skills.length} skills, ${s.commands.length} commands, ${s.watches.length} watches, workflow ${s.workflow.state}`)

    // That count is FILES SEEDED, not skills that resolve, and the two differ:
    // a boot reporting "9 agents, 8 skills" still had eight of the twelve skills
    // its agents declare missing entirely. Nothing said so, because
    // buildAgentSystemPrompt swallows a per-skill resolution failure by design -
    // so each agent ran without the instructions it was supposed to have and
    // looked healthy doing it.
    //
    // A warning, not a failure: one absent optional skill must not take the
    // instance down, but it must not be silent either. The same list is on the
    // Team page as `unresolvedSkills`.
    if (s.unresolvedSkills.length) {
      console.warn(
        `[teamSeed] WARNING: ${s.unresolvedSkills.length} declared skills do not resolve — `
        + `agents declaring them run WITHOUT those instructions, silently: ${s.unresolvedSkills.join(', ')}`)
    } else {
      console.log('[teamSeed] all declared skills resolve')
    }
  }).catch((err) => console.error('[teamSeed] failed:', err instanceof Error ? err.message : err))
})

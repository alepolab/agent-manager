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
    console.log(`[teamSeed] plugin ${s.pluginVersion ?? 'not installed'}; ${s.agents.length} agents, ${s.skills.length} skills, ${s.commands.length} commands, workflow ${s.workflow.state}`)
  }).catch((err) => console.error('[teamSeed] failed:', err instanceof Error ? err.message : err))
})

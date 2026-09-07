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

    // A seeded item that was edited locally is REWRITTEN here, every boot. That
    // is deliberate - it is how a team standard stays a standard - but until
    // now it happened in silence: an operator's edit to a shipped agent worked
    // on the very next run, and then disappeared at the next restart with
    // nothing anywhere saying so. Not in the UI, not in this log, and not on
    // the filesystem, which afterwards looks exactly as though the edit was
    // never made. Naming what was replaced is the whole fix; the replacing
    // itself is correct.
    if (s.reverted.length) {
      console.warn(
        `[teamSeed] WARNING: reverted ${s.reverted.length} locally-edited item(s) to the team version — `
        + `any UI edit to these is now gone: ${s.reverted.map(r => `${r.kind}/${r.name}`).join(', ')}. `
        + `To keep a change, promote it to the plugin (Team page) or edit the shipped template and redeploy.`)
    }

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

/**
 * With agents running as their developers' own users (osUsers.ts), the server
 * shares checkouts with them: it clones, their agents commit, and git refuses
 * a repository another user owns. So the server trusts them too, for every git
 * it runs, and says once at boot whether the host is set up for it.
 */
import { existsSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { resolveClaudePath } from '../utils/claudeDir.ts'
import { launcherPath, runAsUsers, SAFE_DIRECTORY_CONFIG, developersRoot, osUserProblem, reopenTranscripts } from '../utils/osUsers.ts'

export default defineNitroPlugin(() => {
  if (!runAsUsers()) return
  const n = Number(process.env.GIT_CONFIG_COUNT ?? 0) || 0
  process.env[`GIT_CONFIG_KEY_${n}`] = SAFE_DIRECTORY_CONFIG.key
  process.env[`GIT_CONFIG_VALUE_${n}`] = SAFE_DIRECTORY_CONFIG.value
  process.env.GIT_CONFIG_COUNT = String(n + 1)
  const missing = [launcherPath(), developersRoot()].filter(p => !existsSync(p))
  if (missing.length) console.error(`[runAs] AGENT_RUN_AS=user, but ${missing.join(' and ')} not found: no agent can start until an operator runs sudo scripts/install-run-as.sh`)
  else {
    console.log(`[runAs] agents run as their developers' own users (${developersRoot()})`)
    // Run records name every run's ticket, parameters and output, and their ids
    // lead to each run's artifacts. Open to other users, they undo the walls
    // between developers; install-run-as.sh closes them, and this says so if
    // something has opened them since.
    try {
      const runs = resolveClaudePath('workflow-runs')
      if (statSync(runs).mode & 0o007) console.error(`[runAs] ${runs} is readable by other users, so developers can read each other's runs. Run: chmod o-rwx ${runs}`)
    } catch { /* not created yet */ }
    // A session whose server restarted under it never had its transcript
    // reopened (spawnAs does that as the process ends), and would stay out of
    // the sidebar and unresumable. Each developer's directory is named by
    // their login's safe form, which osUserFor maps to the same user.
    for (const login of readdirSync(developersRoot())) {
      if (!osUserProblem(login)) reopenTranscripts(login)
    }
  }
})

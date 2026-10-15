/**
 * With agents running as their developers' own users (osUsers.ts), the server
 * shares checkouts with them: it clones, their agents commit, and git refuses
 * a repository another user owns. So the server trusts them too, for every git
 * it runs, and says once at boot whether the host is set up for it.
 */
import { existsSync } from 'node:fs'
import { readdirSync, watch } from 'node:fs'
import { getClaudeDir } from '../utils/claudeDir.ts'
import { closePrivateClaudeEntries, launcherPath, runAsUsers, SAFE_DIRECTORY_CONFIG, developersRoot, osUserProblem, reopenTranscripts } from '../utils/osUsers.ts'

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
    // Keep the server's Claude directory closed to developers' users beyond
    // the team config they need. The installer closed what existed; the server
    // creates roles.json, hierarchy.json, watches and the rest later, world-
    // readable by its umask. So: now, the moment a new entry appears, and on a
    // sweep in case a watch event is missed.
    const claudeDir = getClaudeDir()
    const close = () => {
      const closed = closePrivateClaudeEntries(claudeDir)
      if (closed.length) console.log(`[runAs] closed to other users in ${claudeDir}: ${closed.join(', ')}`)
    }
    close()
    try {
      watch(claudeDir, { persistent: false }, (type) => { if (type === 'rename') setTimeout(close, 50) })
    } catch (err) {
      console.error(`[runAs] cannot watch ${claudeDir} (${err instanceof Error ? err.message : String(err)}); new entries are closed by the sweep only`)
    }
    setInterval(close, 30_000).unref()
    // A session whose server restarted under it never had its transcript
    // reopened (spawnAs does that as the process ends), and would stay out of
    // the sidebar and unresumable. Each developer's directory is named by
    // their login's safe form, which osUserFor maps to the same user.
    for (const login of readdirSync(developersRoot())) {
      if (!osUserProblem(login)) reopenTranscripts(login)
    }
  }
})

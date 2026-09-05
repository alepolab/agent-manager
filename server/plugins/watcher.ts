/**
 * Starts the watch scheduler with the server.
 *
 * T3 built `watchScheduler.ts` against two seams — `setWatchSource` (which
 * watches to poll) and `setRunStarter` (how to turn a ticket into a run) —
 * because neither `watchConfig.ts` (T4) nor a real dispatch path existed
 * yet. This plugin is where both get wired to the real thing and the
 * scheduler is actually started. The dispatch path itself
 * (`realRunStarter`, ticket validation) lives in
 * `server/utils/watchRunStarter.ts`, not here — see that file's docstring
 * for why: `server/plugins/*.ts` depends on Nitro's `defineNitroPlugin`
 * global and can only be loaded by Nitro itself, so anything that needs to
 * be importable by a plain `scripts/test-*.mjs` script has to live in
 * `server/utils/` instead.
 *
 * Guard: skipped entirely when `WATCHER_DISABLED=1`. Every `scripts/test-*.mjs`
 * script imports `server/utils/*.ts` modules directly and never loads
 * `server/plugins/*.ts` — Nitro is the only thing that does that, on real
 * server boot — so in isolation this guard is unreachable-in-tests by
 * construction. It exists for the case that matters in practice: running
 * the real server (dev, CI smoke boot, or a future test that boots Nitro
 * itself) without wanting a live setInterval poll loop and its outbound
 * dispatch calls. See task-4-report.md for how this was verified against a
 * live timer, not just read from source.
 *
 * Ticket source (B5, half one): `ticketSource.ts`'s own default is the
 * file-backed stub, which is exactly right for a deployment with no Jira
 * configured — nothing here changes for that case. Only when all three
 * `JIRA_*` credentials (`jiraCredentials.ts`) are actually present does this
 * plugin swap in `createJiraTicketSource()`, so a real ticket reaches the
 * pipeline without anyone copying it by hand. Posting the result back stays
 * gated separately, inside `ticketNotifier.ts`, by `JIRA_POST_ENABLED` — a
 * deployment can read from Jira here while still never writing to it.
 */
import { listWatches } from '../utils/watchConfig.ts'
import { setWatchSource, setRunStarter, startScheduler } from '../utils/watchScheduler.ts'
import { realRunStarter } from '../utils/watchRunStarter.ts'
import { setTicketSource } from '../utils/ticketSource.ts'
import { createJiraTicketSource } from '../utils/jiraTicketSource.ts'
import { hasJiraCredentialsConfigured } from '../utils/jiraCredentials.ts'

export default defineNitroPlugin(() => {
  if (process.env.WATCHER_DISABLED === '1') return

  if (hasJiraCredentialsConfigured()) {
    setTicketSource(createJiraTicketSource())
  }

  setWatchSource(listWatches)
  setRunStarter(realRunStarter)
  startScheduler()
})

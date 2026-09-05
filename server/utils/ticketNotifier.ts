/**
 * B5, half two: "posts the PR link back" — when a ticket's run settles,
 * render what should go back to the ticket and, only if explicitly
 * configured, actually post it.
 *
 * Posting is OFF BY DEFAULT and stays off unless `JIRA_POST_ENABLED=1` is
 * set. This is not a convenience default — it is the user's own standing
 * rule that creating/transitioning a Jira issue or posting a comment is a
 * confirm-before-acting operation, never something a background poller does
 * unattended. With posting off (the default for every dev machine, every
 * test run, and any deployment that hasn't explicitly opted in), this
 * module still does its job: it renders the exact comment it WOULD post and
 * writes it to the run's own artifacts directory
 * (`runArtifactsDir(run.id)/jira-comment.json`, alongside `meta.json` and
 * the per-step artifacts `runArtifacts.ts` already writes) so an operator
 * can read, and if they choose, paste it in by hand. Nothing here ever
 * transitions an issue — there is no code path in this file that calls a
 * transition endpoint at all.
 *
 * `notifyTicketOutcome` never throws: `watchScheduler.ts` calls it after a
 * ticket's disposition is already settled (`recordSuccess`/`recordFailure`),
 * and a notification failure must never re-litigate that outcome or cost
 * the rest of the reconcile pass.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { plainTextToAdf } from './adf.ts'
import { isJiraPostingEnabled, jiraAuthHeader, resolveJiraCredentials } from './jiraCredentials.ts'
import { runArtifactsDir } from './runArtifacts.ts'
import type { FetchLike } from './jiraTicketSource.ts'
import type { Watch } from '../../shared/types/watch.ts'
import type { WorkflowRun } from '~~/shared/types/run'

export interface TicketOutcome {
  runId: string
  runStatus: string
  /** From the run's own `meta.json` (`fix.repos[].pr`) — the agent's
   *  self-reported PR link, the same field `runArtifacts.ts`'s
   *  `reconcileFix` already treats as unverifiable-by-git and preserves
   *  as-is. Empty when the run never reached (or never recorded) a PR. */
  prUrls: string[]
  /** The run's own halt/failure reason (`run.error`) — set only when there
   *  is no PR to report, never fabricated when one exists. */
  haltReason?: string
}

export interface RenderInput {
  ticketKey: string
  watchName: string
  outcome: TicketOutcome
  /** Display name to `@mention` — omitted (not fabricated) when the ticket
   *  source didn't supply an assignee or reporter. */
  owner?: string
  /** From `JIRA_COMMENT_FOR_VIS_NAME` — the "For vis: <name>" line is
   *  omitted entirely, not filled with a placeholder, when unset. */
  forVisName?: string
}

/**
 * Renders the comment body in the user's own house style: `@mention` at the
 * top, substance in the middle, `For vis: <name>` at the bottom (only when
 * a name is actually configured). Pure function — no I/O, no network — so
 * every shape (PR present, halted, no owner known) is directly testable.
 */
export function renderTicketComment(input: RenderInput): string {
  const lines: string[] = []
  lines.push(input.owner ? `@${input.owner}` : '(no assignee or reporter on this ticket to mention)')
  lines.push('')

  if (input.outcome.prUrls.length > 0) {
    lines.push(`Pipeline run for ${input.ticketKey} finished — a pull request is ready for review:`)
    for (const pr of input.outcome.prUrls) lines.push(pr)
  } else {
    lines.push(`Pipeline run for ${input.ticketKey} stopped before opening a pull request.`)
    lines.push(`Reason: ${input.outcome.haltReason ?? `run ended with status '${input.outcome.runStatus}'`}`)
  }

  lines.push('')
  lines.push(`Dispatched by watch "${input.watchName}" — run ${input.outcome.runId}.`)

  if (input.forVisName) {
    lines.push('')
    lines.push(`For vis: ${input.forVisName}`)
  }

  return lines.join('\n')
}

export interface NotifyResult {
  comment: string
  posted: boolean
  artifactPath: string
  /** Why `posted` is false: the default-off gate, or a real failure message
   *  from attempting the post. Always absent when `posted` is true. */
  reason?: string
}

/** Best-effort read of a run's `meta.json` for the `fix.repos[].pr` links a
 *  completed run's evidence-and-PR step recorded. Absent, unreadable, or
 *  malformed meta degrades to "no PR known" — never a thrown error, since a
 *  run that halted before that step legitimately never wrote one. */
async function readReportedPrUrls(runId: string): Promise<string[]> {
  const metaPath = join(runArtifactsDir(runId), 'meta.json')
  if (!existsSync(metaPath)) return []
  try {
    const meta = JSON.parse(await readFile(metaPath, 'utf-8')) as {
      fix?: { repos?: Array<{ pr?: unknown }> }
    }
    const repos = Array.isArray(meta.fix?.repos) ? meta.fix!.repos! : []
    const urls = repos
      .map(r => r?.pr)
      .filter((pr): pr is string => typeof pr === 'string' && pr.trim().length > 0)
    return [...new Set(urls)]
  } catch {
    return []
  }
}

/**
 * Builds this ticket's outcome from the run record plus its artifacts, then
 * renders, records, and — only when `JIRA_POST_ENABLED=1` — posts the
 * resulting comment. Called from `watchScheduler.ts`'s `reconcile()` once a
 * ticket's disposition is already settled; the caller wraps this in its own
 * guard so a bug here can never re-open that decision.
 *
 * `fetchImpl` is the same override seam `jiraTicketSource.ts` uses — tests
 * drive the "posting enabled" path against a fake, so the gating and
 * request-shaping logic is provably exercised without ever making a real
 * network call, which matters because this function must never post for
 * real during a test run.
 */
/** The minimum the notifier needs to name what triggered the run. `Watch`
 *  satisfies this structurally, so every existing caller is unchanged - but a
 *  run started from the command line or the UI, which has no watch at all, can
 *  now be reported on too. Jira does not care which of them started it; it
 *  cares that the ticket gets its comment. */
export interface NotifySource {
  id: string
  name: string
}

export async function notifyTicketOutcome(
  watch: NotifySource,
  ticketKey: string,
  run: WorkflowRun,
  owner: { assignee?: string, reporter?: string } = {},
  fetchImpl: FetchLike = fetch,
): Promise<NotifyResult> {
  const prUrls = await readReportedPrUrls(run.id)

  const outcome: TicketOutcome = {
    runId: run.id,
    runStatus: run.status,
    prUrls,
    haltReason: prUrls.length > 0 ? undefined : (run.error ?? undefined),
  }

  const comment = renderTicketComment({
    ticketKey,
    watchName: watch.name,
    outcome,
    owner: owner.assignee || owner.reporter,
    forVisName: process.env.JIRA_COMMENT_FOR_VIS_NAME?.trim() || undefined,
  })

  const dir = runArtifactsDir(run.id)
  const artifactPath = join(dir, 'jira-comment.json')
  const result: NotifyResult = { comment, posted: false, artifactPath }

  if (isJiraPostingEnabled()) {
    try {
      const creds = resolveJiraCredentials()
      const res = await fetchImpl(
        `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(ticketKey)}/comment`,
        {
          method: 'POST',
          headers: {
            Authorization: jiraAuthHeader(creds),
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ body: plainTextToAdf(comment) }),
        },
      )
      if (res.ok) {
        result.posted = true
      } else {
        const detail = await res.text().catch(() => res.statusText)
        result.reason = `Jira comment post failed (HTTP ${res.status}): ${detail.slice(0, 500)}`
      }
    } catch (err) {
      result.reason = err instanceof Error ? err.message : String(err)
    }
  } else {
    result.reason = 'posting disabled by default — set JIRA_POST_ENABLED=1 to post real comments'
  }

  try {
    await mkdir(dir, { recursive: true })
    await writeFile(artifactPath, JSON.stringify({
      ticketKey,
      watchId: watch.id,
      watchName: watch.name,
      runId: run.id,
      runStatus: run.status,
      posted: result.posted,
      reason: result.reason ?? null,
      comment,
      generatedAt: new Date().toISOString(),
    }, null, 2))
  } catch {
    // Recording the artifact is best-effort — a filesystem error here must
    // not undo the notification attempt already made (or deliberately not
    // made) above, nor propagate into the scheduler's reconcile loop.
  }

  return result
}

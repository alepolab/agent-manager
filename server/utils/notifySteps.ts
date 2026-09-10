import { readArtifactEntries } from './runArtifacts.ts'
import { runLink, sendToChannelNamed } from './notify.ts'
import { entryKey } from '../../shared/utils/workflowGraph.ts'
import { createLogger } from './log.ts'
import type { WorkflowRun } from '../../shared/types/run'

const log = createLogger('notify')

/**
 * A workflow step the runner executes itself: posts one message to a channel
 * configured on this instance. No model, no prompt, one HTTP POST.
 *
 * Two fields, and the restraint is the design. Everything else a useful message
 * needs, the runner already holds:
 *
 * - The artifact is not a field. A notify step on an escalation branch already
 *   names it in `runWhen.artifact`, which is also what stops the step running
 *   when there is nothing to report. A `source` of its own would be a second
 *   place to name one file and a way for the two to disagree.
 * - The link is not a field. `runLink` knows the shape.
 * - There is no template language. `{count}` is substituted and that is all;
 *   the entry names and the link are appended. Projecting arbitrary entry
 *   fields into the message would make this step's config know the artifact's
 *   schema, and a producer renaming a field would silently empty the message.
 */
export interface NotifyStepConfig {
  /** The channel's name in Settings → Notifications. Never a URL: workflow definitions ship inside the distributable image. */
  channel: string
  /** The step author's own sentence. `{count}` becomes the number of entries in this step's `runWhen` artifact. */
  message?: string
}

const MAX_NAMED = 5

/**
 * The message body. Pure — no fs, no fetch — the same discipline planDispatch
 * and gateSatisfied keep, and what makes the table-driven test possible.
 *
 * Entries are named with `entryKey`, the same function the dispatcher and the
 * review panel use, so a draft called DRAFT-002 in the message is called
 * DRAFT-002 everywhere else. A reviewer can tell that the thing they were told
 * about is the thing they are approving.
 */
export function composeNotification(opts: {
  message?: string
  artifact?: string
  entries: Record<string, unknown>[]
  link: string
}): string {
  const count = opts.entries.length
  const sentence = (opts.message?.trim() || `{count} ${opts.artifact ? `entries of ${opts.artifact}` : 'entries'} need a decision.`)
    .replace(/\{count\}/g, String(count))
  const named = opts.entries.slice(0, MAX_NAMED).map((e, i) => entryKey(e, i))
  const more = count > MAX_NAMED ? `, +${count - MAX_NAMED} more` : ''
  const names = named.length ? `\n${named.join(', ')}${more}` : ''
  return `${sentence}${names}\n${opts.link}`
}

/**
 * Runs one notify step and says what happened, in one sentence.
 *
 * Never throws for a delivery problem, and never fails the step. The reasoning
 * is the same one notify.ts states for transition messages — "a notification
 * that fails must never fail a run" — plus the discriminator the dispatch step
 * spells out for itself: a dispatch that started nothing "has produced
 * NOTHING", whereas a notify step that could not reach Teams has changed
 * nothing about the run. The run still reaches `awaiting_review`,
 * `run.question.artifact` still names the file, and the decision endpoint still
 * works. The webhook is a convenience on top of durable state, and failing the
 * step would fail the whole run — discarding a complete scan because of a
 * Microsoft outage.
 *
 * The cost of that choice: a permanently misconfigured channel reads as a green
 * step. It is mitigated at configuration time, by the "Send a test message"
 * button in Settings, rather than by inventing a `required` flag here — a
 * failure sentence in the step output plus a warn line is what the run page has
 * to show for it.
 */
export async function runNotifyStep(
  run: WorkflowRun, cfg: NotifyStepConfig, artifact?: string,
): Promise<string> {
  const channel = cfg.channel?.trim()
  if (!channel) return 'Nothing posted: this step names no channel. Choose one in the workflow builder.'

  let entries: Record<string, unknown>[] = []
  if (artifact) {
    const read = await readArtifactEntries(run.id, artifact)
    // An unreadable artifact is reported and the message still goes out. The
    // step's job is to fetch a person; telling them with a count of 0 beats
    // telling them nothing because a file was malformed.
    if (read && 'error' in read) log.warn('notify step could not read its artifact', { runId: run.id, artifact, error: read.error })
    else if (read) entries = read.entries
  }

  const link = runLink(run)
  const text = composeNotification({ message: cfg.message, artifact, entries, link })
  try {
    await sendToChannelNamed(channel, text)
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    log.warn('notify step could not post', { runId: run.id, channel, error: why })
    // The link is repeated in the failure sentence on purpose: whoever reads
    // this step's output is the person who now has to go and tell somebody.
    return `Could not post to "${channel}": ${why}. The run still needs attention at ${link}`
  }
  log.info('notify step posted', () => ({ runId: run.id, channel, entries: entries.length }))
  return `Posted to "${channel}": ${text.split('\n')[0]}`
}

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runArtifactsDir } from './runArtifacts.ts'
import { summarizeRunCost } from './costReport.ts'
import { fixReposAndCommits } from './runIndex.ts'
import { runElapsedMinutes } from '../../shared/utils/runClock.ts'
import { createLogger } from './log.ts'
import type { WorkflowRun, RunStep } from '~~/shared/types/run'

// Under 'artifacts': this writes one, and a namespace per file is how a log
// filter stops being usable.
const log = createLogger('artifacts')

/**
 * One page a person who was not here can read.
 *
 * A finished run leaves 40-plus files behind — step JSON, probes, oracles,
 * bundles — and none of them answers the question everybody actually asks:
 * what happened, did it work, and what do I do now. Reading the evidence is a
 * job for whoever disputes the outcome; everyone else needs the outcome.
 *
 * Written from the run RECORD and meta.json only, both runner-owned. Nothing
 * here is generated prose or an agent's self-report: every line is a fact the
 * runner already holds, phrased in plain words. That is deliberate — a summary
 * that paraphrases an agent inherits the agent's confidence, and this file is
 * the one a manager will quote.
 */
export const SUMMARY_FILE = 'RUN-SUMMARY.md'

/** Plain-language names for the states. "skipped" and "failed" mean nothing to a reader who has not seen the pipeline. */
const STEP_WORDS: Record<string, string> = {
  completed: 'done',
  failed: 'failed',
  skipped: 'not needed',
  running: 'still running',
  waiting: 'waiting for a person',
  pending: 'never started',
}

function duration(ms: number | undefined): string {
  if (!ms || ms < 0) return '—'
  const mins = Math.round(ms / 60000)
  if (mins < 1) return 'under a minute'
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  return `${h}h ${mins % 60}m`
}

/** Readable and unambiguous across time zones, which a locale string is not. */
function when(ts: number | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}

/**
 * The one line of a step's output worth quoting.
 *
 * Agents open with a heading or a first sentence that says what they concluded
 * ("## CSUP-7519 reproduced — root cause found, RED test committed"), which is
 * the summary a person wants. Anything longer is the evidence, and the evidence
 * is what this file exists to spare them.
 */
function gist(step: RunStep): string {
  const raw = (step.output ?? '').trim()
  if (!raw) return step.error ? firstSentence(step.error) : ''
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('```') || t.startsWith('|') || /^[-=*_]{3,}$/.test(t)) continue
    return firstSentence(t.replace(/^#+\s*/, '').replace(/\*\*/g, '').replace(/`/g, ''))
  }
  return ''
}

function firstSentence(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim()
  const cut = one.length > 220 ? `${one.slice(0, 217)}…` : one
  return cut
}

/**
 * The same core facts as runIndex.ts's `RunIndexRow`, as YAML front matter
 * ahead of the prose body below. Hand-rolled rather than a YAML library — this
 * is a flat map, and `JSON.stringify` already produces a valid YAML
 * double-quoted scalar, so every string value is quoted through it instead of
 * through YAML's own escaping rules. A key the run never produced a value for
 * (no ticket, no PR, unmeasured cost) is omitted entirely, never emitted as
 * `null` — the same "absent rather than guessed" rule runIndex.ts's row keeps.
 *
 * Exported so a caller that only wants the machine-readable half (or a test)
 * doesn't have to parse it back out of the rendered page. `renderRunSummary`
 * prepends this ahead of the prose body, unchanged below it.
 */
export function runSummaryFrontMatter(run: WorkflowRun, meta: Record<string, unknown>): string {
  const prs = pullRequests(meta)
  const { repos, commits } = fixReposAndCommits(meta)
  const lastStepEnd = run.steps.reduce((max, s) => Math.max(max, s.completedAt ?? 0), 0)
  const ended = run.endedAt ?? (lastStepEnd || undefined)
  const blastRadius = run.blastRadius ?? (typeof meta.blast_radius === 'string' ? meta.blast_radius : undefined)
  const cost = summarizeRunCost(run)

  const lines: string[] = ['---']
  lines.push(`runId: ${JSON.stringify(run.id)}`)
  if (run.ticketKey) lines.push(`ticket: ${JSON.stringify(run.ticketKey)}`)
  lines.push(`workflow: ${JSON.stringify(run.workflowSlug)}`)
  if (run.product?.name) lines.push(`product: ${JSON.stringify(run.product.name)}`)
  lines.push(`status: ${JSON.stringify(run.status)}`)
  lines.push(`started: ${JSON.stringify(new Date(run.startedAt).toISOString())}`)
  if (ended) lines.push(`ended: ${JSON.stringify(new Date(ended).toISOString())}`)
  lines.push(`active_minutes: ${Math.round(runElapsedMinutes(run))}`)
  if (cost.totals.measured_step_count > 0) lines.push(`cost_usd: ${cost.totals.cost_usd}`)
  if (prs.length) {
    lines.push('prs:')
    for (const p of prs) lines.push(`  - repo: ${JSON.stringify(p.repo)}\n    url: ${JSON.stringify(p.pr)}`)
  }
  if (repos.length) {
    lines.push('repos:')
    for (const r of repos) lines.push(`  - ${JSON.stringify(r)}`)
  }
  if (commits.length) {
    lines.push('commits:')
    for (const c of commits) lines.push(`  - ${JSON.stringify(c)}`)
  }
  if (blastRadius) lines.push(`blast_radius: ${JSON.stringify(blastRadius)}`)
  lines.push(`recovered: ${Boolean(run.recovered)}`)
  lines.push('---')
  return lines.join('\n')
}

/** Pull requests the runner recorded, from meta.fix.repos[].pr. */
function pullRequests(meta: Record<string, unknown>): { repo: string, pr: string }[] {
  const fix = meta.fix
  if (!fix || typeof fix !== 'object' || Array.isArray(fix)) return []
  const repos = (fix as Record<string, unknown>).repos
  if (!Array.isArray(repos)) return []
  return repos
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .filter(r => typeof r.pr === 'string' && (r.pr as string).startsWith('http'))
    .map(r => ({ repo: String(r.repo ?? 'repository'), pr: String(r.pr) }))
}

/**
 * The headline: what a reader should take away before reading anything else.
 *
 * A pull request is the only unambiguous evidence that work left the machine,
 * so it outranks the run's own status word: a run can be `completed` and have
 * shipped nothing, and reporting that as success is the misreading this line
 * exists to prevent.
 */
function verdict(run: WorkflowRun, prs: { repo: string, pr: string }[]): string {
  const failed = run.steps.filter(s => s.status === 'failed')
  if (prs.length) {
    const where = prs.map(p => `[${p.repo}](${p.pr})`).join(', ')
    return `**A fix was proposed and is waiting for review.** ${prs.length === 1 ? 'Pull request' : 'Pull requests'}: ${where}.`
  }
  if (run.status === 'running' || run.status === 'paused') {
    return `**Still going.** ${run.status === 'paused' ? 'It is paused and can be resumed.' : 'No result yet.'}`
  }
  if (failed.length) {
    return `**No fix was shipped.** The run stopped at "${failed[0]!.label}"${run.error ? `: ${firstSentence(run.error)}` : '.'}`
  }
  if (run.status === 'stopped') return '**Stopped by a person before it finished.** Nothing was shipped.'
  return '**It ran to the end without opening a pull request.** Nothing was shipped — read the last step below for why.'
}

export function renderRunSummary(run: WorkflowRun, meta: Record<string, unknown> = {}): string {
  const prs = pullRequests(meta)
  const cost = summarizeRunCost(run)
  const lastStepEnd = run.steps.reduce((max, s) => Math.max(max, s.completedAt ?? 0), 0)
  const ended = run.endedAt ?? (lastStepEnd || undefined)
  const title = run.ticketKey ? `${run.ticketKey} — what this run did` : `${run.workflowName} — what this run did`
  // The ticket's own first line, which is a human summary someone already wrote.
  const ask = firstSentence((run.initialPrompt ?? '').split('\n')[0] ?? '')

  const lines: string[] = [runSummaryFrontMatter(run, meta), '']
  lines.push(`# ${title}`, '')
  lines.push(verdict(run, prs), '')
  if (ask) lines.push(`**What it was asked to do:** ${ask}`, '')
  // An open pull request is not the same as an approved one: a run can ship a
  // branch and still end on "two blockers remain". The last step that actually
  // ran says how it ended, and that belongs next to the headline rather than
  // eleven steps down the page.
  const last = [...run.steps].reverse().find(s => s.status === 'completed' || s.status === 'failed')
  const lastGist = last ? gist(last) : ''
  if (lastGist) lines.push(`**How it ended** (${last!.label}): ${lastGist}`, '')

  lines.push('| | |', '|---|---|')
  lines.push(`| Pipeline | ${run.workflowName} |`)
  if (run.product?.name) lines.push(`| Product | ${run.product.name} |`)
  lines.push(`| Started | ${when(run.startedAt)} |`)
  lines.push(`| Finished | ${when(ended)} |`)
  lines.push(`| Time taken | ${duration(ended ? ended - run.startedAt : undefined)} |`)
  lines.push(`| Steps | ${run.steps.filter(s => s.status === 'completed').length} done of ${run.steps.length} |`)
  // From the RUN RECORD, which the runner writes at every publish — not
  // recomputed here. The same run reported $35.85 on this page, $66.77 across
  // its step files and nothing at all in its record, because three readers each
  // did their own arithmetic. One writer, quoted everywhere.
  if (typeof run.usage?.usd === 'number') {
    const unmeasured = run.steps.filter(s => s.status === 'completed' && !(s as { usage?: unknown }).usage).length
    lines.push(`| Machine cost | $${run.usage.usd.toFixed(2)}${unmeasured ? ` (${unmeasured} step(s) reported no usage)` : ''} |`)
  } else if (cost.totals.cost_usd !== null) {
    lines.push(`| Machine cost | $${cost.totals.cost_usd.toFixed(2)} |`)
  }
  if (run.branch) lines.push(`| Branch | \`${run.branch}\` |`)
  lines.push(`| Pull request | ${prs.length ? prs.map(p => `[${p.repo}](${p.pr})`).join(', ') : 'none'} |`)
  if (run.startedBy) lines.push(`| Started by | ${run.startedBy} |`)
  lines.push('')

  lines.push('## What happened, step by step', '')
  run.steps.forEach((s, i) => {
    const word = STEP_WORDS[s.status] ?? s.status
    const took = s.startedAt && s.completedAt ? ` · ${duration(s.completedAt - s.startedAt)}` : ''
    const retried = s.visits > 1 ? ` · retried ${s.visits - 1}×` : ''
    lines.push(`**${i + 1}. ${s.label}** — ${word}${took}${retried}`)
    const g = gist(s)
    if (g) lines.push(`> ${g}`)
    if (s.status === 'skipped' && s.skipReason) lines.push(`> Skipped because: ${firstSentence(s.skipReason)}`)
    // Work that is on nobody's branch. It reads as an ordinary completed step
    // everywhere else, which is how a3cb9d37's client fix went missing.
    if (s.laneKept) lines.push(`> **Uncommitted work left behind:** ${firstSentence(s.laneKept)}`)
    lines.push('')
  })

  if (run.decisions?.length) {
    lines.push('## What a person decided', '')
    for (const d of run.decisions) {
      const verb = d.verdict === 'approved' ? 'approved' : d.verdict === 'rejected' ? 'rejected' : 'sent back'
      lines.push(`- **${d.by}** ${verb} "${d.label}" after ${duration(d.waitedMs)} of waiting${d.note ? ` — ${firstSentence(d.note)}` : ''}`)
    }
    lines.push('')
  }

  if (run.ci) {
    lines.push('## Automated checks on the pull request', '')
    lines.push(`- ${run.ci.status}${run.ci.final ? '' : ' (still running when last checked)'} — ${run.ci.pr}`)
    lines.push('')
  }

  // The scope boundary, first among the sections a reviewer reads after the
  // steps: the runner promises every agent that "the summary prints them".
  if (run.notDone?.length) {
    lines.push('## What this run did not do', '')
    for (const e of run.notDone) lines.push(`- **${e.what}** — ${e.why} _(${e.label})_`)
    lines.push('')
  }
  if (run.shipIntegrity?.length) {
    lines.push('## What could not be reached', '')
    for (const f of run.shipIntegrity) lines.push(`- **${f.repo}** — ${f.detail}`)
    lines.push('')
  }
  lines.push('## Where the detail is', '')
  lines.push(`Everything this run produced is in \`${runArtifactsDir(run.id)}\`.`)
  lines.push('`steps/` holds one file per step above, with the full transcript; `meta.json` holds the machine-readable facts this page was written from.')
  lines.push('')
  lines.push(`_Written automatically when the run finished. Run id \`${run.id}\`._`)

  return lines.join('\n')
}

/** Write (or rewrite) the summary beside the run's other artifacts. */
export async function writeRunSummary(run: WorkflowRun): Promise<string> {
  const dir = runArtifactsDir(run.id)
  let meta: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed
  } catch {
    /* no meta.json: the summary still renders from the run record alone */
  }
  const path = join(dir, SUMMARY_FILE)
  await writeFile(path, `${renderRunSummary(run, meta)}\n`)
  log.debug('run summary written', { runId: run.id, path })
  return path
}

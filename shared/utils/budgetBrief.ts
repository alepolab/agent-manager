/**
 * What a person needs to decide whether to grant a run more budget: what it
 * spent and on which steps, what is left to run, what that has taken on runs
 * of the same workflow that finished, and what stopping keeps.
 *
 * The budget pause said "Budget exceeded: 182 min over the 180 min cap.
 * Continue to grant another 8,000,000 tokens and 180 minutes, or stop the run
 * here" - ASECRM-318, with three short steps left and a finished fix on its
 * branch - and nothing on the page told the reviewer any of that.
 *
 * Pure, so it is computed the same wherever it is read. Never guessed: a
 * remaining step no finished run has timed has no estimate, and says so.
 */
import type { WorkflowRun } from '../types/run'
import { runElapsedMinutes } from './runClock.ts'

export interface BudgetBrief {
  minutesUsed: number
  maxMinutes: number
  /** Uncached input plus output: what the cap counts. */
  tokensUsed: number
  maxTokens: number
  costUsd: number | null
  /** Which cap the run crossed. */
  over: ('minutes' | 'tokens')[]
  /** Steps that did work, most expensive first. */
  spent: { label: string, minutes: number, visits: number, tokens: number | null }[]
  /** Steps not yet run, in order, with what they took on finished runs of this workflow. */
  remaining: { label: string, typicalMinutes: number | null, samples: number }[]
  /** Sum of the remaining steps' typical minutes, when every one of them has one. */
  estimateMinutes: number | null
  /** How many finished runs of this workflow the typical figures come from. */
  comparedRuns: number
  /** What Continue grants: a fresh allowance of this size. */
  grant: { minutes: number, tokens: number }
  /** What stopping leaves behind. */
  keeps: { branch?: string, pr?: string }
}

const stepMinutes = (s: { startedAt?: number, completedAt?: number }): number | null =>
  s.startedAt && s.completedAt && s.completedAt >= s.startedAt ? (s.completedAt - s.startedAt) / 60000 : null

const stepTokens = (s: WorkflowRun['steps'][number]): number | null =>
  s.usage ? Math.max(0, s.usage.input_tokens - (s.usage.cache_read_input_tokens ?? 0)) + s.usage.output_tokens : null

const median = (xs: number[]): number | null => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

export function budgetBrief(run: WorkflowRun, others: WorkflowRun[], grant: { minutes: number, tokens: number }, now = Date.now()): BudgetBrief {
  const minutesUsed = runElapsedMinutes(run, now)
  const u = run.usage
  const tokensUsed = u ? Math.max(0, u.input_tokens - (u.cached_tokens ?? 0)) + u.output_tokens : 0
  const over: BudgetBrief['over'] = []
  if (minutesUsed > run.budget.maxMinutes) over.push('minutes')
  if (tokensUsed > run.budget.maxTokens) over.push('tokens')

  const spent = run.steps
    .filter(s => s.visits > 0 && (s.status === 'completed' || s.status === 'failed'))
    .map(s => ({ label: s.label, minutes: stepMinutes(s) ?? 0, visits: s.visits, tokens: stepTokens(s) }))
    .filter(s => s.minutes > 0 || (s.tokens ?? 0) > 0)
    .sort((a, b) => b.minutes - a.minutes)

  const finished = others.filter(o => o.id !== run.id && o.workflowSlug === run.workflowSlug && o.status === 'completed')
  const remaining = run.steps
    .filter(s => s.status === 'pending' || s.status === 'running')
    .map((s) => {
      const times = finished
        .map(o => o.steps.find(x => x.stepId === s.stepId))
        .map(x => (x && x.status === 'completed' ? stepMinutes(x) : null))
        .filter((m): m is number => m !== null)
      return { label: s.label, typicalMinutes: median(times), samples: times.length }
    })
  const estimateMinutes = remaining.length && remaining.every(r => r.typicalMinutes !== null)
    ? remaining.reduce((n, r) => n + (r.typicalMinutes ?? 0), 0)
    : null

  return {
    minutesUsed, maxMinutes: run.budget.maxMinutes, tokensUsed, maxTokens: run.budget.maxTokens,
    costUsd: u?.usd ?? null, over, spent, remaining, estimateMinutes, comparedRuns: finished.length, grant,
    keeps: { ...(run.branch ? { branch: run.branch } : {}), ...(run.ci?.pr ? { pr: run.ci.pr } : {}) },
  }
}

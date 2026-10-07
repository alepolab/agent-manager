import type { RunStep, WorkflowRun } from '../types/run'

/**
 * How far along a working step is, read against what the same kind of step
 * usually takes. "Implement Fix, 2 h, 421 replies" says nothing on its own;
 * against a typical 86 replies and 20 minutes it says this one is five times
 * the usual size, which is what the person looking at Home wants to know.
 */

/** What one kind of step (an agent) usually takes, from the steps of that kind that completed. */
export interface StepNorm {
  /** How many completed steps this is drawn from. */
  n: number
  /** Median agent replies. */
  replies: number
  /** Median minutes from start to completion. */
  minutes: number
  /** The 75th percentile of minutes: "most finish within". */
  minutesP75: number
}

/** Fewer completed steps than this and there is no "usual" to compare with. */
export const MIN_SAMPLES = 5

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}
const percentile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!

/**
 * Norms per agent, from every completed step that had a model working in it.
 * Steps the runner did itself (no replies) are left out: a Jira transition
 * says nothing about how long an implementer takes.
 */
export function stepNorms(runs: Pick<WorkflowRun, 'steps'>[]): Record<string, StepNorm> {
  const by = new Map<string, { replies: number[], minutes: number[] }>()
  for (const run of runs) {
    for (const s of run.steps) {
      if (s.status !== 'completed' || !s.assistantMessages || !s.startedAt || !s.completedAt || s.completedAt < s.startedAt) continue
      const b = by.get(s.agentSlug) ?? { replies: [], minutes: [] }
      b.replies.push(s.assistantMessages)
      b.minutes.push((s.completedAt - s.startedAt) / 60_000)
      by.set(s.agentSlug, b)
    }
  }
  const out: Record<string, StepNorm> = {}
  for (const [agent, b] of by) {
    if (b.replies.length < MIN_SAMPLES) continue
    out[agent] = { n: b.replies.length, replies: Math.round(median(b.replies)), minutes: Math.round(median(b.minutes)), minutesP75: Math.round(percentile(b.minutes, 0.75)) }
  }
  return out
}

export type ProgressStage = 'starting' | 'early' | 'halfway' | 'most' | 'over' | 'far-over'

export interface StepProgress {
  stepId: string
  label: string
  minutes: number
  replies: number
  /** The norm it is read against, when there is one. */
  norm?: StepNorm
  /** Replies against the usual number: 0.5 is halfway, 2 is twice the usual size. */
  ratio?: number
  stage?: ProgressStage
  /** The stage in words: "about halfway", "5× the usual size". */
  words?: string
  /** Seconds since the step last did anything, when that is long enough to mention. */
  quietSec?: number
}

/** A step quiet for longer than this is mentioned: a long build or test inside one command looks exactly like this. */
export const QUIET_SEC = 90

/**
 * Replies, not minutes, carry the estimate: a step's time includes builds and
 * test runs that a reply count does not, and a quota pause stretches the clock
 * without the step doing anything. Minutes are shown beside it as they are.
 */
export function stepProgress(step: Pick<RunStep, 'stepId' | 'label' | 'agentSlug' | 'startedAt' | 'assistantMessages' | 'lastActivityAt'>, norms: Record<string, StepNorm>, now = Date.now()): StepProgress {
  const replies = step.assistantMessages ?? 0
  const minutes = step.startedAt ? Math.max(0, Math.floor((now - step.startedAt) / 60_000)) : 0
  const quiet = step.lastActivityAt ? Math.floor((now - step.lastActivityAt) / 1000) : undefined
  const out: StepProgress = { stepId: step.stepId, label: step.label, minutes, replies, ...(quiet !== undefined && quiet >= QUIET_SEC ? { quietSec: quiet } : {}) }
  const norm = norms[step.agentSlug]
  if (!norm || norm.replies <= 0) return out
  const ratio = replies / norm.replies
  const [stage, words]: [ProgressStage, string] = ratio < 0.15 ? ['starting', 'just started']
    : ratio < 0.4 ? ['early', 'early on']
    : ratio < 0.7 ? ['halfway', 'about halfway']
    : ratio <= 1.1 ? ['most', 'most of the way']
    : ratio < 2 ? ['over', 'past the usual size']
    : ['far-over', `${Math.round(ratio)}× the usual size`]
  return { ...out, norm, ratio, stage, words }
}

/** The steps of a run that are working right now, with their progress. */
export function runningStepsProgress(run: Pick<WorkflowRun, 'steps'>, norms: Record<string, StepNorm>, now = Date.now()): StepProgress[] {
  return run.steps.filter(s => s.status === 'running').map(s => stepProgress(s, norms, now))
}

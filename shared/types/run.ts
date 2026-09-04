export type WorkflowRunStatus =
  | 'running' | 'paused' | 'completed' | 'failed' | 'stopped' | 'interrupted'

export type RunStepStatus =
  | 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export interface RunStep {
  stepId: string
  label: string
  /** The agent behind this step. The operator's real question is "which agent, and how is it doing". */
  agentSlug: string
  status: RunStepStatus
  input: string
  output: string
  error?: string
  startedAt?: number
  completedAt?: number
  visits: number
  monitorVerdict?: 'CONTINUE' | 'RETRY' | 'ABORT'
  monitorNote?: string
  /** The model the agent call actually ran, as the SDK's own system/init
   *  message reported it (an observed id, e.g. 'claude-sonnet-4-6') - never
   *  the alias requested. Absent when a stub caller (tests) never returned
   *  one; `null` when the real caller ran but no init message reported a
   *  model. Never guessed either way, since a wrong value here is the kind
   *  of defect that produces no error. */
  model?: string | null
}

export interface WorkflowRun {
  id: string
  workflowSlug: string
  workflowName: string
  status: WorkflowRunStatus
  autoRun: boolean
  initialPrompt: string
  /** What triggered this run: the id of the watch (registry/watches.yaml)
   *  that dispatched it, or the reserved literal 'direct-invocation' for a
   *  run started manually (the API route, run-ticket.mjs). Set once at
   *  creation by the runner itself — never inferred from, or left to, an
   *  agent's self-report. Non-nullable on purpose: "what triggered this?"
   *  always has an honest answer, and 'direct-invocation' is it when
   *  nothing did. */
  watch: string
  projectDir?: string
  /** `projectDir`'s HEAD sha, captured by the runner (startRun, via
   *  gitFacts.ts's captureBaseline) the instant this run started, before any
   *  step ran. gitFacts.ts's computeFixFacts diffs the CURRENT HEAD against
   *  THIS sha — never against a branch's default base (`main`) — to compute
   *  what this run actually committed. Runner-owned provenance, exactly
   *  like `watch` and `identity`: set once at creation, never inferred from
   *  or trusted from an agent's self-report. Absent when `projectDir` was
   *  missing, not a git repo, or had no commits yet (an unborn HEAD) at
   *  start — computeFixFacts then computes nothing rather than falling back
   *  to a guessed base, since that fallback is exactly the fabrication this
   *  field exists to prevent. */
  baseCommit?: string
  steps: RunStep[]
  currentStepIds: string[]
  nextStepIds: string[]
  startedAt: number
  endedAt?: number
  error?: string
  /** The process that owns this run. A live status from a dead pid is a lie. */
  pid: number
}

export interface NewRunInput {
  workflowSlug: string
  workflowName: string
  autoRun: boolean
  initialPrompt: string
  /** See WorkflowRun.watch — the caller states it, createRun carries it
   *  straight onto the persisted run, unmodified. */
  watch: string
  projectDir?: string
  /** See WorkflowRun.baseCommit — startRun captures it via
   *  gitFacts.ts's captureBaseline and passes it straight through; createRun
   *  carries it onto the persisted run, unmodified. */
  baseCommit?: string
  steps: { stepId: string, label: string, agentSlug: string }[]
}

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
  /** Tokens the agent call actually consumed, as the SDK reported them. */
  usage?: { input_tokens: number, output_tokens: number } | null
}

export interface RunUsage { input_tokens: number, output_tokens: number, usd: number }
export interface RunBudget { maxMinutes: number, maxTokens: number }

/** The registry entry a run resolved to at start, or absent when nothing matched. */
export interface ProductMatch {
  name: string
  suite?: string
  repos: string[]
  branches: Record<string, string>
  stack: { compose: string, topology_default: string, liquibase?: boolean }
  tests: Record<string, string>
  recipe?: string
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
  product?: ProductMatch
  steps: RunStep[]
  /** Runner-owned totals over every step, recomputed on each publish. */
  usage?: RunUsage
  /** Caps checked between waves. Defaults come from AGENT_RUN_MAX_MINUTES and AGENT_RUN_MAX_TOKENS. */
  budget: RunBudget
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
  product?: ProductMatch
  steps: { stepId: string, label: string, agentSlug: string }[]
}

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
  projectDir?: string
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
  projectDir?: string
  steps: { stepId: string, label: string, agentSlug: string }[]
}

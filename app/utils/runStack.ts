import type { InjectionKey, Ref } from 'vue'
import type { RunStep, WorkflowRun } from '~~/shared/types/run'
import type { WorkflowStep } from '~/types'
import type { SendBackArrow, StepKind } from '~~/shared/utils/workflowStack'

/** What every card in one run stack needs, provided once by RunStack. */
export interface RunStackContext {
  run: Ref<WorkflowRun>
  stepOf: (id: string) => RunStep | undefined
  workflowStepOf: (id: string) => WorkflowStep | undefined
  kindOf: (id: string) => StepKind
  /** Labels of the steps whose output this step reads, per its contextMode. */
  readsOf: (id: string) => string[]
  logsOf: (id: string) => string[]
  isOpen: (id: string) => boolean
  toggle: (id: string) => void
  /** Send-backs that landed on this step, for the marker above its card. */
  arrivalsOf: (id: string) => (SendBackArrow & { n: number })[]
  /** Child runs by status, for a loop step. */
  childSummary: (id: string) => string
  gate: {
    respond: (reply: string) => void
    continue: (note?: string) => void
    reject: (note: string) => void
    rework: (stepId: string, note: string) => void
  }
  restart: (stepId: string, note?: string) => void
  openEvidence: () => void
}

export const RUN_STACK_KEY: InjectionKey<RunStackContext> = Symbol('run-stack')

export const STEP_KIND_LABEL: Record<StepKind, string> = {
  'agent': 'Agent',
  'jira': 'Update Jira ticket',
  'jira-create': 'Create Jira tickets',
  'notify': 'Post to a channel',
  'loop': 'Loop over items',
}

export const STEP_KIND_ICON: Record<StepKind, string> = {
  'agent': 'i-lucide-bot',
  'jira': 'i-lucide-ticket',
  'jira-create': 'i-lucide-ticket-plus',
  'notify': 'i-lucide-send',
  'loop': 'i-lucide-repeat',
}

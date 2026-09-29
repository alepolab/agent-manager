import type { InjectionKey, Ref } from 'vue'
import type { RunStep, StepCheck, WorkflowRun } from '~~/shared/types/run'
import type { WorkflowStep } from '~/types'
import type { SendBackArrow, StepKind } from '~~/shared/utils/workflowStack'
import { RUN_STATUS_COLOR } from '~/utils/runStatus'

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
  /**
   * Where the run's open decision (if any) is hosted, for this step id: the
   * approval card above it, the card itself, or nowhere (it is hosted at the
   * top level, or the decision belongs to a different step). RunStack decides
   * this once so a decision never renders twice and never renders nowhere.
   */
  gateAt: (id: string) => 'approval' | 'card' | null
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

/** A step's usage as a run card shows it, "12,345 tok · $0.42"; '' when it reported none. */
export function stepUsageLabel(u: RunStep['usage']): string {
  if (!u) return ''
  return `${(u.input_tokens + u.output_tokens).toLocaleString()} tok${u.usd != null ? ` · $${u.usd.toFixed(2)}` : ''}`
}

/** A monitor verdict's colour: go on, stop, or retry. */
export const verdictColor = (v: StepCheck['verdict']) =>
  v === 'CONTINUE' ? RUN_STATUS_COLOR.completed : v === 'ABORT' ? RUN_STATUS_COLOR.failed : 'var(--warning)'

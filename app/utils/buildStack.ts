import type { InjectionKey, Ref } from 'vue'
import type { WorkflowStep } from '~/types'
import type { ActionKind, SeqPath, Slot } from '~~/shared/utils/stackEdit'

export type Selection = { kind: 'trigger' } | { kind: 'step', stepId: string } | null

/** What a "+" can add. Approval is a flag on the step below; split adds paths. */
export type PickerChoice =
  | { kind: 'action', action: ActionKind, agentSlug?: string }
  | { kind: 'approval' }
  | { kind: 'split' }

export interface BuildStackContext {
  readOnly: Ref<boolean>
  stepOf: (id: string) => WorkflowStep | undefined
  agentName: (slug: string) => string
  agents: Ref<{ slug: string, name: string }[]>
  isSelected: (id: string) => boolean
  select: (stepId: string) => void
  apply: (choice: PickerChoice, slot: Slot) => void
  remove: (stepId: string) => void
  move: (seq: SeqPath, from: number, to: number) => void
  addBranch: (at: Slot) => void
  removeBranch: (at: Slot, branch: number) => void
  setRejoin: (at: Slot, rejoin: boolean) => void
  /** Writes the branch's first step's runWhen; empty clears it. */
  setCondition: (firstStepId: string, artifact: string) => void
  clearApproval: (stepId: string) => void
}

export const BUILD_STACK_KEY: InjectionKey<BuildStackContext> = Symbol('build-stack')

export function triggerSummary(schedules: { name: string }[], watches: { name: string }[]): string {
  const parts = [
    ...watches.map(w => `Jira watch ${w.name}`),
    ...(schedules.length ? [`${schedules.length} ${schedules.length === 1 ? 'schedule' : 'schedules'}`] : []),
  ]
  return parts.length ? parts.join(' · ') : 'Run manually'
}

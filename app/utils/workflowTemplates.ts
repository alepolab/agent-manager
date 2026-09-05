import type { WorkflowStep } from '~/types'

export interface WorkflowTemplateStep {
  agentTemplateId: string
  label: string
  /**
   * `agentTemplateId` values of steps in this same template that follow this one.
   * Absent means "the next step in array order", which is how every template
   * behaved before graphs were expressible here.
   */
  next?: string[]
  /** `agentTemplateId` of the agent that reviews this step's output. */
  monitorSlug?: string
  /** How many times this step may run in one execution. */
  maxVisits?: number
  /** See WorkflowStep.contextMode. */
  contextMode?: 'predecessors' | 'ancestors'
}

export interface WorkflowTemplate {
  id: string
  name: string
  description: string
  icon: string
  steps: WorkflowTemplateStep[]
}

/**
 * Turn a template into real workflow steps. Template steps refer to each other by
 * `agentTemplateId`; the workflow they become refers to generated step ids, so every
 * `next` has to be translated through the same map.
 *
 * `agentSlugByTemplateId` must have an entry for every step passed in - the caller
 * filters out steps whose agent template could not be resolved before calling. A
 * `next` naming a template step that got filtered out this way (or that never
 * existed) has its target dropped rather than surviving as `undefined`/`null`.
 */
export function materializeTemplateSteps(
  template: WorkflowTemplate,
  agentSlugByTemplateId: Record<string, string>,
  existingIds?: string[],
): WorkflowStep[] {
  // The global crypto, not node:crypto - this module is bundled for the browser too.
  //
  // One id per STEP (by index), not per `agentTemplateId`: a template that uses the
  // same agent template in two steps must not collapse them onto the same generated
  // id, or the repeated step becomes unreachable (stepById()/indexOf() only ever
  // resolve the first match).
  // Keep ids by position when a saved workflow of the same shape exists: a
  // re-sync that renamed every step would orphan every run recorded against it.
  const reuse = existingIds && existingIds.length === template.steps.length
  const stepIds = template.steps.map((_, i) => (reuse ? existingIds![i] : crypto.randomUUID()))

  // Still keyed by `agentTemplateId`, because that's what a `next` entry names.
  // If an `agentTemplateId` repeats, the last step wins as the translation target -
  // an inherent ambiguity of naming a step by its agent rather than by index, not
  // something this function can resolve on the template author's behalf.
  const stepIdByTemplateId: Record<string, string> = {}
  template.steps.forEach((step, i) => { stepIdByTemplateId[step.agentTemplateId] = stepIds[i] })

  return template.steps.map((step, i) => {
    const materialized: WorkflowStep = {
      id: stepIds[i],
      agentSlug: agentSlugByTemplateId[step.agentTemplateId]!,
      label: step.label,
    }
    if (step.next) {
      const resolved = step.next
        .map(target => stepIdByTemplateId[target])
        .filter((id): id is string => id !== undefined)

      // If every declared target was filtered out, this step's `next` becoming `[]`
      // would silently truncate the workflow here (buildGraph treats an explicit
      // empty `next` as terminal - it does NOT fall back to array order the way an
      // absent `next` does). That's not what "all my targets disappeared" means, so
      // leave `next` unset instead and let it fall back to array order. An
      // originally-empty `next` (an explicit terminal step) is left as `[]` as-is.
      if (resolved.length > 0 || step.next.length === 0) {
        materialized.next = resolved
      }
    }
    // monitorSlug names an AGENT, not a step, so it resolves through the same
    // agentSlug map the step's own agentSlug does — not through
    // stepIdByTemplateId. Dropped when unresolvable, for the same reason a
    // dangling `next` target is dropped: a monitorSlug naming an agent that
    // does not exist makes every review silently CONTINUE.
    if (step.monitorSlug) {
      const resolved = agentSlugByTemplateId[step.monitorSlug]
      if (resolved) materialized.monitorSlug = resolved
    }
    if (step.maxVisits !== undefined) materialized.maxVisits = step.maxVisits
    if (step.contextMode !== undefined) materialized.contextMode = step.contextMode
    return materialized
  })
}

export const workflowTemplates: WorkflowTemplate[] = [
  {
    id: 'code-review-pipeline',
    name: 'Code Review Pipeline',
    description: 'Review code changes then update documentation.',
    icon: 'i-lucide-scan-eye',
    steps: [
      { agentTemplateId: 'code-reviewer', label: 'Review Code' },
      { agentTemplateId: 'documentation-writer', label: 'Update Docs' },
    ],
  },
  {
    id: 'content-creation',
    name: 'Content Creation',
    description: 'Research a topic then write about it.',
    icon: 'i-lucide-pen-line',
    steps: [
      { agentTemplateId: 'research-assistant', label: 'Research' },
      { agentTemplateId: 'writing-assistant', label: 'Write' },
    ],
  },
  {
    id: 'email-workflow',
    name: 'Email Workflow',
    description: 'Draft content then format as a professional email.',
    icon: 'i-lucide-mail',
    steps: [
      { agentTemplateId: 'writing-assistant', label: 'Draft Content' },
      { agentTemplateId: 'email-drafter', label: 'Format Email' },
    ],
  },
  {
    id: 'runbook-a-jira-to-diff',
    name: 'Runbook A — Ticket to Evidence-Backed PR',
    description: 'Paste a support ticket: stands up the stack, writes a failing parameterised test, fixes the cause, verifies, and opens a PR carrying the evidence bundle.',
    icon: 'i-lucide-git-pull-request-arrow',
    steps: [
      { agentTemplateId: 'sdlc-ticket-intake', label: 'Ticket Intake', next: ['sdlc-stack-provisioner'], monitorSlug: 'sdlc-step-monitor' },
      { agentTemplateId: 'sdlc-stack-provisioner', label: 'Stand Up Stack',
        next: ['sdlc-test-author'], monitorSlug: 'sdlc-step-monitor' },
      { agentTemplateId: 'sdlc-test-author', label: 'Failing Test', next: ['sdlc-fix-implementer'], monitorSlug: 'sdlc-step-monitor' },
      // Verification and browser evidence are independent of each other - one wave.
      { agentTemplateId: 'sdlc-fix-implementer', label: 'Implement Fix', next: ['sdlc-verifier', 'sdlc-trace-capture', 'sdlc-security-review'], monitorSlug: 'sdlc-step-monitor' },
      { agentTemplateId: 'sdlc-verifier', label: 'Verify + Regression',
        next: ['sdlc-evidence-and-pr'], monitorSlug: 'sdlc-step-monitor' },
      { agentTemplateId: 'sdlc-trace-capture', label: 'Browser Trace', next: ['sdlc-evidence-and-pr'], monitorSlug: 'sdlc-step-monitor' },
      // Security review runs beside verification and tracing; the PR waits on all three.
      { agentTemplateId: 'sdlc-security-review', label: 'Security Review', next: ['sdlc-evidence-and-pr'], monitorSlug: 'sdlc-step-monitor' },
      { agentTemplateId: 'sdlc-evidence-and-pr', label: 'Evidence Bundle + PR',
        next: [], contextMode: 'ancestors', monitorSlug: 'sdlc-step-monitor' },
    ],
  },
]

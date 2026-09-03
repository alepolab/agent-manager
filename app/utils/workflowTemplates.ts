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
 * filters out steps whose agent template could not be resolved before calling.
 */
export function materializeTemplateSteps(
  template: WorkflowTemplate,
  agentSlugByTemplateId: Record<string, string>,
): WorkflowStep[] {
  // The global crypto, not node:crypto - this module is bundled for the browser too.
  const stepIdByTemplateId: Record<string, string> = {}
  for (const step of template.steps) stepIdByTemplateId[step.agentTemplateId] = crypto.randomUUID()

  return template.steps.map((step) => {
    const materialized: WorkflowStep = {
      id: stepIdByTemplateId[step.agentTemplateId]!,
      agentSlug: agentSlugByTemplateId[step.agentTemplateId]!,
      label: step.label,
    }
    if (step.next) {
      materialized.next = step.next.map(target => stepIdByTemplateId[target]!)
    }
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
      { agentTemplateId: 'sdlc-ticket-intake', label: 'Ticket Intake', next: ['sdlc-stack-provisioner'] },
      { agentTemplateId: 'sdlc-stack-provisioner', label: 'Stand Up Stack', next: ['sdlc-test-author'] },
      { agentTemplateId: 'sdlc-test-author', label: 'Failing Test', next: ['sdlc-fix-implementer'] },
      // Verification and browser evidence are independent of each other - one wave.
      { agentTemplateId: 'sdlc-fix-implementer', label: 'Implement Fix', next: ['sdlc-verifier', 'sdlc-trace-capture'] },
      { agentTemplateId: 'sdlc-verifier', label: 'Verify + Regression', next: ['sdlc-evidence-and-pr'] },
      { agentTemplateId: 'sdlc-trace-capture', label: 'Browser Trace', next: ['sdlc-evidence-and-pr'] },
      { agentTemplateId: 'sdlc-evidence-and-pr', label: 'Evidence Bundle + PR', next: [] },
    ],
  },
]

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
  /** See WorkflowStep.approval. */
  approval?: boolean
  /** See WorkflowStep.continuesSession. */
  continuesSession?: boolean
  /** See WorkflowStep.contextMode. */
  contextMode?: 'predecessors' | 'ancestors'
  /** See WorkflowStep.jira. */
  jira?: { transition?: string, comment?: boolean, attach?: boolean }
  /** See WorkflowStep.testsUnlocked. */
  testsUnlocked?: boolean
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
  // stepIds is generated with exactly one id per step just above, so indexing
  // always hits - but indexing is `T | undefined` to the checker, and a
  // silently-undefined step id would produce a workflow whose edges reference
  // nothing. Assert the invariant rather than paper over it.
  template.steps.forEach((step, i) => {
    const id = stepIds[i]
    if (!id) throw new Error(`materializeTemplateSteps: no id generated for step ${i}`)
    stepIdByTemplateId[step.agentTemplateId] = id
  })

  return template.steps.map((step, i) => {
    const materialized: WorkflowStep = {
      id: stepIds[i]!,
      agentSlug: agentSlugByTemplateId[step.agentTemplateId]!,
      label: step.label,
      ...(step.approval ? { approval: true } : {}),
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
    if (step.jira !== undefined) materialized.jira = step.jira
    if (step.testsUnlocked) materialized.testsUnlocked = true
    if (step.continuesSession) materialized.continuesSession = true
    return materialized
  })
}

/** The runbooks the team ships: template id -> the file name each is seeded as under the config dir's workflows/. Shared by the server's team sync and scripts/sync-agents.mjs. */
export const RUNBOOK_FILES: Record<string, string> = {
  'runbook-a-jira-to-diff': 'runbook-a-ticket-to-evidence-backed-pr',
  'runbook-c-ce-ticket-to-pr': 'runbook-c-ce-ticket-to-qa-proven-pr',
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
      // Runner-executed, no model: the ticket moves to In Progress the moment the
      // run starts, so nobody else picks it up while an agent is on it.
      { agentTemplateId: 'sdlc-jira-tracker', label: 'Jira: In Progress', next: ['sdlc-ticket-intake'], jira: { transition: 'In Progress' }, monitorSlug: 'sdlc-step-monitor' },
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
      // The one step with an outward effect: it pushes and opens the pull request. It waits for a person.
      { agentTemplateId: 'sdlc-evidence-and-pr', label: 'Evidence Bundle + PR',
        next: ['sdlc-pr-follow-up'], contextMode: 'ancestors', monitorSlug: 'sdlc-step-monitor' },
      // Closes the loop the PR opens: reviewer checklist answered, checks watched, blockers
      // from the automated review fixed and pushed. Loops on RETRY until mergeable.
      { agentTemplateId: 'sdlc-pr-follow-up', label: 'PR Checks + Review',
        next: ['sdlc-jira-tracker'], contextMode: 'ancestors', maxVisits: 3, monitorSlug: 'sdlc-step-monitor' },
      // `next` names a template id, and a repeated id resolves to its LAST step, which
      // is this one: the review step, not the In Progress step at the top.
      // The one step that writes to a customer's ticket, and it waits for a
      // person. Moving an issue to Dev Done, commenting on it and attaching the
      // evidence is the pipeline ASSERTING the work is finished, to an audience
      // of reporters, watchers and whoever is on support that week. A human
      // qualifies that claim before it is made. Starting the run is what
      // justifies the In Progress transition above; nothing justifies Dev Done
      // except someone having looked.
      { agentTemplateId: 'sdlc-jira-tracker', label: 'Jira: Dev Done', next: [], jira: { transition: 'Dev Done', comment: true, attach: true }, approval: true, monitorSlug: 'sdlc-step-monitor' },
    ],
  },
  {
    id: 'runbook-c-ce-ticket-to-pr',
    name: 'Runbook C — ce Ticket to QA-Proven PR',
    description: 'Paste a ticket: stands up the stack, plans the change and its QA cases, implements and reviews the way the compound-engineering skills do, rebuilds the stack from the fix, runs automated and manual QA against it, and opens the PR carrying all of it.',
    icon: 'i-lucide-workflow',
    steps: [
      { agentTemplateId: 'sdlc-jira-tracker', label: 'Jira: In Progress', next: ['sdlc-ticket-intake'], jira: { transition: 'In Progress' }, monitorSlug: 'sdlc-step-monitor' },
      { agentTemplateId: 'sdlc-ticket-intake', label: 'Ticket Intake', next: ['sdlc-stack-provisioner'], monitorSlug: 'sdlc-step-monitor' },
      // The runner makes the run's worktree beside the clone as soon as this step has cloned it; every step after works there.
      { agentTemplateId: 'sdlc-stack-provisioner', label: 'Stand Up Stack', next: ['sdlc-ce-plan'], monitorSlug: 'sdlc-step-monitor' },
      // ce-plan: the implementation plan and the QA plan (automated and manual cases) the run is judged by.
      { agentTemplateId: 'sdlc-ce-plan', label: 'Plan', next: ['sdlc-ce-work'], monitorSlug: 'sdlc-step-monitor' },
      // Labelled as in Runbook A on purpose: the security review and the QA steps send work back to "Implement Fix".
      // ce-work writes each test before the code that passes it, in one step, so the
      // test lock that guards Runbook A's separate fix step would stop it after the
      // first source edit; a real run asked the operator for the unlock and stalled.
      // Continues the planner's session. It is the same agent's work: the plan
      // it just wrote, the files it just read, the repository it just learned.
      // Across the recorded runs this pair and its Runbook A equivalent were
      // over half of every run's cost, each half rebuilding what the other had
      // just finished learning.
      { agentTemplateId: 'sdlc-ce-work', label: 'Implement Fix', next: ['sdlc-ce-review'], continuesSession: true, monitorSlug: 'sdlc-step-monitor', testsUnlocked: true },
      { agentTemplateId: 'sdlc-ce-review', label: 'Code Review', next: ['sdlc-stack-update'], monitorSlug: 'sdlc-step-monitor' },
      // Rebuilds the image from the worktree and redeploys in place, alone, before anything tests it.
      { agentTemplateId: 'sdlc-stack-update', label: 'Update Stack', next: ['sdlc-qa-automated', 'sdlc-qa-manual', 'sdlc-security-review'], monitorSlug: 'sdlc-step-monitor' },
      // QA is the gate: both halves and the security review run against the rebuilt stack in one wave, and a FAIL sends the run back to Implement Fix.
      { agentTemplateId: 'sdlc-qa-automated', label: 'Automated QA', next: ['sdlc-ce-ship'], monitorSlug: 'sdlc-step-monitor' },
      { agentTemplateId: 'sdlc-qa-manual', label: 'Manual QA', next: ['sdlc-ce-ship'], monitorSlug: 'sdlc-step-monitor' },
      { agentTemplateId: 'sdlc-security-review', label: 'Security Review', next: ['sdlc-ce-ship'], monitorSlug: 'sdlc-step-monitor' },
      // The one step with an outward effect: pushes the branch and opens the PR quoting the QA, review and security reports.
      { agentTemplateId: 'sdlc-ce-ship', label: 'Push + PR', next: ['sdlc-pr-follow-up'], contextMode: 'ancestors', monitorSlug: 'sdlc-step-monitor' },
      // Continues the ship step's session: same branch, same PR, same GitHub
      // context, minutes later. Answering a reviewer on a PR you just opened is
      // not a new problem.
      { agentTemplateId: 'sdlc-pr-follow-up', label: 'PR Checks + Review', next: ['sdlc-jira-tracker'], contextMode: 'ancestors', continuesSession: true, maxVisits: 3, monitorSlug: 'sdlc-step-monitor' },
      // The one step that writes to a customer's ticket, and it waits for a
      // person. Moving an issue to Dev Done, commenting on it and attaching the
      // evidence is the pipeline ASSERTING the work is finished, to an audience
      // of reporters, watchers and whoever is on support that week. A human
      // qualifies that claim before it is made. Starting the run is what
      // justifies the In Progress transition above; nothing justifies Dev Done
      // except someone having looked.
      { agentTemplateId: 'sdlc-jira-tracker', label: 'Jira: Dev Done', next: [], jira: { transition: 'Dev Done', comment: true, attach: true }, approval: true, monitorSlug: 'sdlc-step-monitor' },
    ],
  },
]

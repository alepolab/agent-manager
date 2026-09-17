import type { WorkflowStep } from '~/types'

export interface WorkflowTemplateStep {
  agentTemplateId: string
  label: string
  /**
   * Template-local identity for this step, for other steps' `next` to name.
   *
   * Optional, and omitted by every template written before it existed: those are
   * addressed by `agentTemplateId`, exactly as before. It stops being optional in
   * practice the moment a template uses one agent template in more than one step,
   * because `agentTemplateId` is then ambiguous and the LAST step declaring it
   * wins the name - so the earlier ones become unaddressable. Runbook A and C
   * both do that, with five `sdlc-jira-tracker` steps each.
   */
  id?: string
  /**
   * Steps in this same template that follow this one, named by their `id` or,
   * for a step that declares none, by its `agentTemplateId`.
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
  /** See WorkflowStep.contextMode. */
  contextMode?: 'predecessors' | 'ancestors'
  /** See WorkflowStep.jira. */
  jira?: { transition?: string, comment?: boolean, attach?: boolean }
  /** See WorkflowStep.testsUnlocked. */
  testsUnlocked?: boolean
  /** See WorkflowStep.produces. */
  produces?: string[]
  /** See WorkflowStep.runWhen. */
  runWhen?: { artifact: string }
  /** See WorkflowStep.triggerWorkflow. Slugs here name real workflows on the
   *  instance, not other templates: nothing in this file resolves them. */
  triggerWorkflow?: { source?: string, fromParameter?: string, itemParameter?: string, join?: boolean, routeBy?: string, routes?: Record<string, string>, slug?: string }
  /** See WorkflowStep.notify. The channel names a row in Settings on the
   *  instance, not anything in this file. */
  notify?: { channel: string, message?: string }
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
  existing?: Array<string | { id: string, label?: string }>,
): WorkflowStep[] {
  // The global crypto, not node:crypto - this module is bundled for the browser too.
  //
  // One id per STEP (by index), not per `agentTemplateId`: a template that uses the
  // same agent template in two steps must not collapse them onto the same generated
  // id, or the repeated step becomes unreachable (stepById()/indexOf() only ever
  // resolve the first match).
  const saved = (existing ?? []).map(e => (typeof e === 'string' ? { id: e } : e))

  // Keep ids by position when a saved workflow of the same shape exists: a
  // re-sync that renamed every step would orphan every run recorded against it.
  const byPosition = saved.length === template.steps.length

  // Different shape, because the team added or removed a step: keep the id of
  // every step whose label is unchanged and mint one only for the rest.
  //
  // What this protects is the operator's canvas layout. teamSync carries step
  // positions over keyed by step id, so regenerating the ids snaps every node
  // back to its default position. It does NOT make an older run restartable
  // across a step-count change - alignStepIds (workflowRunner.ts) refuses that
  // on the step count alone, whatever the ids say. Callers that pass bare id
  // strings have no labels to match on and still regenerate, as before.
  const keptByLabel = new Map<string, string>()
  if (!byPosition) for (const s of saved) if (s.label && !keptByLabel.has(s.label)) keptByLabel.set(s.label, s.id)

  const used = new Set<string>()
  const stepIds = template.steps.map((step, i) => {
    const kept = byPosition ? saved[i]!.id : keptByLabel.get(step.label)
    // Never hand one saved id to two steps: two steps sharing an id is the exact
    // breakage this whole mechanism exists to prevent, and a duplicated label in
    // a saved workflow must not reintroduce it.
    const id = kept && !used.has(kept) ? kept : crypto.randomUUID()
    used.add(id)
    return id
  })

  // Keyed by a step's own `id` when it declares one, and by `agentTemplateId`
  // either way - that is what a `next` entry in an older template names.
  // If an `agentTemplateId` repeats and the steps declare no ids, the last one
  // still wins as the translation target: an inherent ambiguity of naming a step
  // by its agent rather than by identity, which is what `id` exists to resolve.
  const stepIdByTemplateId: Record<string, string> = {}
  // stepIds is generated with exactly one id per step just above, so indexing
  // always hits - but indexing is `T | undefined` to the checker, and a
  // silently-undefined step id would produce a workflow whose edges reference
  // nothing. Assert the invariant rather than paper over it.
  template.steps.forEach((step, i) => {
    const id = stepIds[i]
    if (!id) throw new Error(`materializeTemplateSteps: no id generated for step ${i}`)
    if (step.id) stepIdByTemplateId[step.id] = id
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
    if (step.produces?.length) materialized.produces = step.produces
    if (step.runWhen !== undefined) materialized.runWhen = step.runWhen
    if (step.triggerWorkflow !== undefined) materialized.triggerWorkflow = step.triggerWorkflow
    if (step.notify !== undefined) materialized.notify = step.notify
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
      // Five steps here are the same runner-executed tracker agent, so every one of
      // them declares an `id`: `next` resolves ids before agent template ids, and
      // without them all five collapse onto whichever is declared last.
      //
      // Runner-executed, no model: the ticket moves to In Progress the moment the
      // run starts, so nobody else picks it up while an agent is on it.
      { agentTemplateId: 'sdlc-jira-tracker', id: 'jira-in-progress', label: 'Jira: In Progress', next: ['sdlc-ticket-intake'], jira: { transition: 'In Progress' }, monitorSlug: 'sdlc-step-monitor' },
      { agentTemplateId: 'sdlc-ticket-intake', label: 'Ticket Intake', produces: ['intent.md', 'context-packet.json'], next: ['sdlc-stack-provisioner'], monitorSlug: 'sdlc-step-monitor' },
      { agentTemplateId: 'sdlc-stack-provisioner', label: 'Stand Up Stack', produces: ['stack-report.md'],
        next: ['sdlc-test-author'], monitorSlug: 'sdlc-step-monitor' },
      { agentTemplateId: 'sdlc-test-author', label: 'Failing Test', produces: ['oracle-before.xml'], next: ['sdlc-fix-implementer'], monitorSlug: 'sdlc-step-monitor' },
      // The fix hands straight to Jira rather than to verification: the board reads
      // DEV DONE and then READY FOR QA as soon as the code is written, which is what
      // a developer does by hand before asking anyone to test it.
      { agentTemplateId: 'sdlc-fix-implementer', label: 'Implement Fix', next: ['jira-dev-done'], monitorSlug: 'sdlc-step-monitor' },
      // The outcome comment rides this step, not the last one: this is the moment the
      // code work is finished, which is what that comment describes.
      { agentTemplateId: 'sdlc-jira-tracker', id: 'jira-dev-done', label: 'Jira: Dev Done', next: ['jira-ready-for-qa'], jira: { transition: 'Dev Done', comment: true }, monitorSlug: 'sdlc-step-monitor' },
      { agentTemplateId: 'sdlc-jira-tracker', id: 'jira-ready-for-qa', label: 'Jira: Ready for QA', next: ['jira-qa-in-progress'], jira: { transition: 'Ready for QA' }, monitorSlug: 'sdlc-step-monitor' },
      // Immediately before the fan-out. A step cannot fire while its siblings start,
      // so this is the closest honest moment to "QA has begun" the graph can express.
      { agentTemplateId: 'sdlc-jira-tracker', id: 'jira-qa-in-progress', label: 'Jira: QA In Progress', next: ['sdlc-verifier', 'sdlc-trace-capture', 'sdlc-security-review'], jira: { transition: 'QA In Progress' }, monitorSlug: 'sdlc-step-monitor' },
      // Verification and browser evidence are independent of each other - one wave.
      { agentTemplateId: 'sdlc-verifier', label: 'Verify + Regression', produces: ['oracle-after.xml', 'regression.xml'],
        next: ['sdlc-evidence-and-pr'], monitorSlug: 'sdlc-step-monitor' },
      { agentTemplateId: 'sdlc-trace-capture', label: 'Browser Trace', next: ['sdlc-evidence-and-pr'], monitorSlug: 'sdlc-step-monitor' },
      // Security review runs beside verification and tracing; the PR waits on all three.
      { agentTemplateId: 'sdlc-security-review', label: 'Security Review', produces: ['security-review.md'], next: ['sdlc-evidence-and-pr'], monitorSlug: 'sdlc-step-monitor' },
      // The one step with an outward effect: it pushes and opens the pull request. It waits for a person.
      { agentTemplateId: 'sdlc-evidence-and-pr', label: 'Evidence Bundle + PR', produces: ['summary.md', 'bundle.json'],
        next: ['sdlc-pr-follow-up'], contextMode: 'ancestors', monitorSlug: 'sdlc-step-monitor' },
      // Closes the loop the PR opens: reviewer checklist answered, checks watched, blockers
      // from the automated review fixed and pushed. Loops on RETRY until mergeable.
      { agentTemplateId: 'sdlc-pr-follow-up', label: 'PR Checks + Review', produces: ['pr-follow-up.md'],
        next: ['jira-qa-done'], contextMode: 'ancestors', maxVisits: 3, monitorSlug: 'sdlc-step-monitor' },
      // The evidence bundle does not exist until Evidence Bundle + PR has run, so the
      // attachments ride the last tracker step rather than the first.
      { agentTemplateId: 'sdlc-jira-tracker', id: 'jira-qa-done', label: 'Jira: QA Done', next: [], jira: { transition: 'QA Done', attach: true }, monitorSlug: 'sdlc-step-monitor' },
    ],
  },
  {
    id: 'runbook-c-ce-ticket-to-pr',
    name: 'Runbook C — ce Ticket to QA-Proven PR',
    description: 'Paste a ticket: stands up the stack, plans the change and its QA cases, implements and reviews the way the compound-engineering skills do, rebuilds the stack from the fix, runs automated and manual QA against it, and opens the PR carrying all of it.',
    icon: 'i-lucide-workflow',
    steps: [
      // As in Runbook A, every tracker step declares an `id`: five steps share one
      // agent template here too, and `next` cannot tell them apart without one.
      { agentTemplateId: 'sdlc-jira-tracker', id: 'jira-in-progress', label: 'Jira: In Progress', next: ['sdlc-ticket-intake'], jira: { transition: 'In Progress' }, monitorSlug: 'sdlc-step-monitor' },
      { agentTemplateId: 'sdlc-ticket-intake', label: 'Ticket Intake', produces: ['intent.md', 'context-packet.json'], next: ['sdlc-stack-provisioner'], monitorSlug: 'sdlc-step-monitor' },
      // The runner makes the run's worktree beside the clone as soon as this step has cloned it; every step after works there.
      { agentTemplateId: 'sdlc-stack-provisioner', label: 'Stand Up Stack', produces: ['stack-report.md'], next: ['sdlc-ce-plan'], monitorSlug: 'sdlc-step-monitor' },
      // ce-plan: the implementation plan and the QA plan (automated and manual cases) the run is judged by.
      { agentTemplateId: 'sdlc-ce-plan', label: 'Plan', produces: ['plan.md', 'qa-plan.md'], next: ['sdlc-ce-work'], monitorSlug: 'sdlc-step-monitor' },
      // Labelled as in Runbook A on purpose: the security review and the QA steps send work back to "Implement Fix".
      // ce-work writes each test before the code that passes it, in one step, so the
      // test lock that guards Runbook A's separate fix step would stop it after the
      // first source edit; a real run asked the operator for the unlock and stalled.
      { agentTemplateId: 'sdlc-ce-work', label: 'Implement Fix', produces: ['implementation.md'], next: ['jira-dev-done'], monitorSlug: 'sdlc-step-monitor', testsUnlocked: true },
      // Placed exactly as in Runbook A - straight after the implementation step, ahead
      // of review and QA - so the two runbooks tell the board the same story.
      { agentTemplateId: 'sdlc-jira-tracker', id: 'jira-dev-done', label: 'Jira: Dev Done', next: ['jira-ready-for-qa'], jira: { transition: 'Dev Done', comment: true }, monitorSlug: 'sdlc-step-monitor' },
      { agentTemplateId: 'sdlc-jira-tracker', id: 'jira-ready-for-qa', label: 'Jira: Ready for QA', next: ['sdlc-ce-review'], jira: { transition: 'Ready for QA' }, monitorSlug: 'sdlc-step-monitor' },
      { agentTemplateId: 'sdlc-ce-review', label: 'Code Review', produces: ['review.md'], next: ['sdlc-stack-update'], monitorSlug: 'sdlc-step-monitor' },
      // Rebuilds the image from the worktree and redeploys in place, alone, before anything tests it.
      { agentTemplateId: 'sdlc-stack-update', label: 'Update Stack', produces: ['deploy-report.md'], next: ['jira-qa-in-progress'], monitorSlug: 'sdlc-step-monitor' },
      // Immediately before the QA wave, for the same reason as in Runbook A.
      { agentTemplateId: 'sdlc-jira-tracker', id: 'jira-qa-in-progress', label: 'Jira: QA In Progress', next: ['sdlc-qa-automated', 'sdlc-qa-manual', 'sdlc-security-review'], jira: { transition: 'QA In Progress' }, monitorSlug: 'sdlc-step-monitor' },
      // QA is the gate: both halves and the security review run against the rebuilt stack in one wave, and a FAIL sends the run back to Implement Fix.
      { agentTemplateId: 'sdlc-qa-automated', label: 'Automated QA', produces: ['qa-automated.md'], next: ['sdlc-ce-ship'], monitorSlug: 'sdlc-step-monitor' },
      { agentTemplateId: 'sdlc-qa-manual', label: 'Manual QA', produces: ['qa-manual.md'], next: ['sdlc-ce-ship'], monitorSlug: 'sdlc-step-monitor' },
      { agentTemplateId: 'sdlc-security-review', label: 'Security Review', produces: ['security-review.md'], next: ['sdlc-ce-ship'], monitorSlug: 'sdlc-step-monitor' },
      // The one step with an outward effect: pushes the branch and opens the PR quoting the QA, review and security reports.
      { agentTemplateId: 'sdlc-ce-ship', label: 'Push + PR', produces: ['pr.md', 'summary.md'], next: ['sdlc-pr-follow-up'], contextMode: 'ancestors', monitorSlug: 'sdlc-step-monitor' },
      { agentTemplateId: 'sdlc-pr-follow-up', label: 'PR Checks + Review', produces: ['pr-follow-up.md'], next: ['jira-qa-done'], contextMode: 'ancestors', maxVisits: 3, monitorSlug: 'sdlc-step-monitor' },
      { agentTemplateId: 'sdlc-jira-tracker', id: 'jira-qa-done', label: 'Jira: QA Done', next: [], jira: { transition: 'QA Done', attach: true }, monitorSlug: 'sdlc-step-monitor' },
    ],
  },
]

import type { WorkflowStep } from '~/types'
import type { Role } from '~~/shared/types/role'

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
  /** See WorkflowStep.gateRole. */
  gateRole?: Role
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
      // Only meaningful alongside `approval`, but carried whenever the template
      // sets it: a step that declares whose gate it is should not silently lose
      // that when someone later toggles `approval` back on.
      ...(step.gateRole ? { gateRole: step.gateRole } : {}),
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

export const workflowTemplates: WorkflowTemplate[] = [
  {
    id: 'oma-plan-build-review',
    name: 'Work: Parallel Plan, Build, Verify',
    description: 'Investigate and reproduce in parallel, plan from both, implement backend and frontend in parallel, then verify, refine and document.',
    icon: 'i-lucide-git-branch',
    // `agentTemplateId` IS the agent slug here: runbookSteps() builds an
    // identity map (teamSync.ts:207-211), so these resolve directly against the
    // oh-my-agent agents this instance seeds from .agents/agents — no entry in
    // `agentTemplates` is needed, which is why an empty catalogue does not stop
    // this materialising.
    //
    // The shape is oh-my-agent's /work phases with /orchestrate's fan-out:
    // COLLECT (2 lanes) -> PLAN -> IMPL (2 lanes) -> VERIFY -> REFINE -> SHIP.
    // Two waves run in parallel and two steps are joins; `markCompleted` arms a
    // forward target only once EVERY forward predecessor completed
    // (shared/utils/workflowGraph.ts), so each join really waits for its lanes.
    //
    // One agent per step, deliberately: `next` names a step by its
    // `agentTemplateId`, so the same agent twice makes every edge pointing at it
    // ambiguous (materializeTemplateSteps: "the last step wins").
    steps: [
      // COLLECT. Both are entry nodes - no forward predecessors - so the engine
      // starts them together rather than in array order.
      {
        agentTemplateId: 'research-explorer',
        label: 'Research & Prior Art',
        next: ['pm-planner'],
      },
      {
        agentTemplateId: 'debug-investigator',
        label: 'Reproduce & Failing Test',
        next: ['pm-planner'],
        // This step owns the tests, and only this step: it writes the failing
        // regression test that proves the defect, and the test-lock guardrail
        // then freezes tests for every step after it. Unlocking the implementer
        // lanes instead would let the agent that writes the fix also relax the
        // test that judges it.
        testsUnlocked: true,
      },
      // PLAN. A join over both collect lanes, and it needs their evidence, not
      // just the immediately preceding output.
      {
        agentTemplateId: 'pm-planner',
        label: 'Plan',
        next: ['architecture-reviewer'],
        contextMode: 'ancestors',
      },
      // Reviews the plan before any code is written, and fans out to the
      // implementation lanes. No approval: the run is meant to reach QA without
      // a babysitter, and a plan nobody implemented yet is cheap to redo.
      {
        agentTemplateId: 'architecture-reviewer',
        label: 'Plan Review',
        next: ['backend-engineer', 'frontend-engineer'],
        contextMode: 'ancestors',
      },
      // IMPL, in parallel. Disjoint by layer so two agents never edit one file.
      {
        agentTemplateId: 'backend-engineer',
        label: 'Implement Backend',
        next: ['qa-reviewer'],
      },
      {
        agentTemplateId: 'frontend-engineer',
        label: 'Implement Frontend',
        next: ['qa-reviewer'],
      },
      // VERIFY. The join over both lanes, and the one human gate: QA owns it, so
      // a developer cannot accept their own verification. `ancestors` because a
      // review that cannot see the plan and the failing test cannot tell whether
      // the change met either.
      {
        agentTemplateId: 'qa-reviewer',
        label: 'Verify',
        next: ['refactor-engineer'],
        contextMode: 'ancestors',
        approval: true,
        gateRole: 'qa',
      },
      // REFINE, then SHIP. Both run after verification passes, never before: a
      // refactor judged by nothing is how a green suite turns red.
      {
        agentTemplateId: 'refactor-engineer',
        label: 'Refine',
        next: ['docs-curator'],
      },
      {
        agentTemplateId: 'docs-curator',
        label: 'Docs & Handoff',
        // Explicitly terminal: an absent `next` would fall back to array order,
        // and this step being last today is an accident of ordering, not intent.
        next: [],
        contextMode: 'ancestors',
      },
    ],
  },
]

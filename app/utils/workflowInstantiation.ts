import type { Agent } from '~/types'
// Relative, not '~/utils/...': this module is imported by both the Nuxt app
// (aliases resolved at build time) and scripts/test-workflow-instantiation.mjs
// running under plain node (no alias resolution at all) - a bare '~' import
// only works for the former. See app/utils/templates.ts for the same
// precedent with its './models.ts' import.
import type { WorkflowTemplate, WorkflowTemplateStep } from './workflowTemplates.ts'
import type { AgentTemplate } from './templates.ts'

/**
 * The decision this makes: given a workflow template and the agents that already
 * exist, which `agentTemplateId`s need turning into a real agent slug, and which of
 * those already have an existing agent to reuse.
 *
 * Every step's own `agentTemplateId` needs resolving - but so does every step's
 * `monitorSlug`. `monitorSlug` names an AGENT, not a step, so it is never itself a
 * step in `template.steps` and is easy to miss: materializeTemplateSteps() (in
 * workflowTemplates.ts) resolves a step's `monitorSlug` through this same
 * agentTemplateId -> slug map, and silently drops a monitor whose id never made it
 * in - turning every review into a no-op CONTINUE with no error anywhere.
 *
 * Pure: does no I/O. Creating an agent is a side effect the caller performs for
 * every id in `toCreate`, folding the new slug into its own copy of `resolved`
 * before calling materializeTemplateSteps().
 */
export interface TemplateResolutionPlan {
  /**
   * The subset of `template.steps` whose `agentTemplateId` names a real agent
   * template - i.e. what should be passed to materializeTemplateSteps() as
   * `{ ...template, steps }`. A step naming an agent template that no longer
   * exists is dropped, same as before this was extracted.
   */
  steps: WorkflowTemplateStep[]
  /** agentTemplateId -> slug of an existing agent that can be reused as-is. */
  resolved: Record<string, string>
  /**
   * agentTemplateIds that name a real agent template but have no existing agent
   * yet. The caller must create one for each and add its slug to `resolved`
   * (or a copy of it) before calling materializeTemplateSteps().
   */
  toCreate: string[]
}

export function planTemplateResolution(
  template: Pick<WorkflowTemplate, 'steps'>,
  agentTemplates: AgentTemplate[],
  existingAgents: Pick<Agent, 'slug' | 'frontmatter'>[],
): TemplateResolutionPlan {
  const resolved: Record<string, string> = {}
  const toCreate: string[] = []
  const seen = new Set<string>()
  const steps: WorkflowTemplateStep[] = []

  // Records that `id` needs to end up in the map, either by reuse (already in
  // `resolved`) or by creation (queued in `toCreate`). Returns whether `id` names a
  // real agent template at all - a dangling id (agent template deleted out from
  // under a saved workflow template) resolves to nothing, same as materializeTemplateSteps()
  // already does for a dangling `next` or `monitorSlug`.
  function resolveId(id: string): boolean {
    if (seen.has(id)) return true
    const agentTemplate = agentTemplates.find(t => t.id === id)
    if (!agentTemplate) return false
    seen.add(id)
    const existing = existingAgents.find(a => a.slug === agentTemplate.frontmatter.name)
    if (existing) {
      resolved[id] = existing.slug
    } else {
      toCreate.push(id)
    }
    return true
  }

  for (const step of template.steps) {
    if (!resolveId(step.agentTemplateId)) continue
    steps.push(step)
  }

  // monitorSlug agents (e.g. sdlc-step-monitor) are referenced by steps but are
  // never themselves a step in template.steps, so the loop above never resolves
  // them on its own - do it explicitly here.
  for (const step of template.steps) {
    if (step.monitorSlug) resolveId(step.monitorSlug)
  }

  return { steps, resolved, toCreate }
}

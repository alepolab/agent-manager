/**
 * A concurrency group: a name, and how many of its runs may be in flight at
 * once.
 *
 * The unit is a GROUP rather than a workflow because the rule this replaces was
 * never per-workflow. "At most two active pipelines" meant two across the whole
 * SDLC family - runbook A, runbook B and whatever a scan dispatches into them
 * share one machine, one set of clones and one agent budget. A cap on each
 * workflow separately cannot express that, and three workflows each capped at
 * two is a cap of six.
 *
 * Membership is by `id`, never by `name`: renaming a group must not orphan
 * every workflow that named it.
 */
export interface WorkflowGroup {
  id: string
  name: string
  /**
   * Runs of this group's workflows allowed in flight at once.
   *
   * An integer of at least 1, validated where it is saved rather than clamped
   * where it is read. `0` would be an invisible "this group never runs again":
   * every automated start would queue, nothing would ever drain, and the only
   * symptom would be work silently not happening.
   */
  maxConcurrent: number
}

export const WORKFLOW_GROUPS_FILE_NAME = 'workflow-groups.json'

/**
 * The group a workflow that names none belongs to.
 *
 * Not "uncapped". Leaving ungrouped workflows unlimited would delete the
 * protection this whole mechanism exists for - a twenty-finding scan opening
 * twenty pipelines at once - for anybody who never opens the Groups editor.
 * Its cap comes from AGENT_MAX_CONCURRENT_PIPELINES (see capFor), which is the
 * same env var and the same default of 2 that governed child dispatch before
 * groups existed.
 */
export const DEFAULT_GROUP_ID = 'default'

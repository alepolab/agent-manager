import { isWaitingOnAPerson, type WorkflowRun } from '~~/shared/types/run'

/**
 * How many runs are waiting on this viewer, for the sidebar's one badge that
 * means "needs you" rather than "here is how many exist".
 *
 * The ownership rule is the same two lines as `mineToAnswer` in
 * pages/index.vue and WorkflowRunPanel.vue, and it is kept local here for the
 * same reason those two are: the server is what actually refuses, this is a
 * courtesy, and a shared helper would imply an authority it does not have.
 */
export function useRunsAwaiting() {
  const runs = useState<WorkflowRun[]>('runs-awaiting', () => [])
  const { role } = useUser()

  async function fetchAll() {
    // A failed poll keeps the last good count: a badge that drops to nothing
    // because one request timed out reads as "all clear", which is the one
    // thing it must never say wrongly.
    try { runs.value = await $fetch<WorkflowRun[]>('/api/runs') } catch { /* keep the last count */ }
  }

  const count = computed(() => runs.value.filter((r) => {
    if (r.dismissed || !isWaitingOnAPerson(r.status)) return false
    const want = r.question?.role
    return !want || !role.value || role.value === 'operator' || role.value === want
  }).length)

  return { count, fetchAll }
}

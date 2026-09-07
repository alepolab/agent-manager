/** "Promote to team" from an editor: opens a PR against the plugin and says where it is. */
export function usePromote() {
  const promoting = ref(false)
  const toast = useToast()
  async function promote(kind: 'agent' | 'skill' | 'command', slug: string) {
    promoting.value = true
    try {
      const r = await $fetch<{ pr: string, path: string }>('/api/team/promote', { method: 'POST', body: { kind, slug } })
      toast.add({ title: 'Pull request opened', description: `${r.path} is up for review.`, color: 'success', actions: [{ label: 'Open PR', onClick: () => { window.open(r.pr, '_blank', 'noopener') } }] })
    } catch (e: any) {
      toast.add({ title: 'Could not promote', description: e.data?.message || e.message, color: 'error' })
    } finally {
      promoting.value = false
    }
  }
  return { promoting, promote }
}

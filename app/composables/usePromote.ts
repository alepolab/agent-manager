/** "Promote to team" from an editor: opens a PR against the plugin and says where it is. */
export function usePromote() {
  const promoting = ref(false)
  const toast = useToast()
  async function promote(kind: 'agent' | 'skill' | 'command', slug: string) {
    promoting.value = true
    try {
      const r = await $fetch<{ pr: string, path: string, pluginInstalled: boolean, note?: string }>(
        '/api/team/promote', { method: 'POST', body: { kind, slug } })
      const openPr = { label: 'Open PR', onClick: () => { window.open(r.pr, '_blank', 'noopener') } }
      // The PR opened either way — that half succeeded. But on an instance with
      // no plugin installed, merging it changes the team repo and NOT this box:
      // the seeder keeps reverting the same edit on every boot. A plain success
      // toast here would be a green tick over a change that never arrives.
      if (r.pluginInstalled) {
        toast.add({ title: 'Pull request opened', description: `${r.path} is up for review.`, color: 'success', actions: [openPr] })
      } else {
        toast.add({
          title: 'PR opened — but it will not take effect here',
          description: r.note ?? `${r.path} is up for review, but no plugin is installed on this instance.`,
          color: 'warning',
          duration: 0,
          actions: [openPr],
        })
      }
    } catch (e: any) {
      toast.add({ title: 'Could not promote', description: e.data?.message || e.message, color: 'error' })
    } finally {
      promoting.value = false
    }
  }
  return { promoting, promote }
}

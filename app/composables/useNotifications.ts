import type { NotificationItem } from '~~/shared/types/notification'

/**
 * Every decision waiting on this viewer (run gates and /cli permission
 * prompts), for /notifications and the sidebar's one badge that means
 * "needs you" rather than "here is how many exist".
 *
 * Shared state, so the page and the badge never disagree about the count.
 */
export function useNotifications() {
  const items = useState<NotificationItem[]>('notifications', () => [])
  const loaded = useState('notifications-loaded', () => false)
  const error = useState<string | null>('notifications-error', () => null)

  async function fetchAll() {
    // A failed poll keeps the last good list: a badge that drops to nothing
    // because one request timed out reads as "all clear", which is the one
    // thing it must never say wrongly.
    try {
      items.value = (await $fetch<{ items: NotificationItem[] }>('/api/notifications')).items
      error.value = null
    } catch (e: any) {
      error.value = e?.data?.message || e?.message || 'Could not load notifications'
    } finally { loaded.value = true }
  }

  const count = computed(() => items.value.filter(n => n.mine).length)

  return { items, loaded, error, count, fetchAll }
}

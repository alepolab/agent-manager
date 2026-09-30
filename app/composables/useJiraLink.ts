/**
 * Where a ticket key opens in Jira: `<base>/browse/<KEY>`. The base is the
 * instance's own (JIRA_BASE_URL, the Settings page, or JIRA_SERVER), read once
 * from /api/config and shared by every link on the page.
 */
let pending: Promise<void> | null = null

export function useJiraLink() {
  const base = useState<string | null>('jiraBaseUrl', () => null)
  if (import.meta.client && !base.value && !pending) {
    pending = $fetch<{ jiraBaseUrl?: string }>('/api/config')
      .then((c) => { base.value = c.jiraBaseUrl?.replace(/\/+$/, '') || null })
      .catch(() => { pending = null })
  }
  /** Null until the base is known, or for a key that is not a Jira key. */
  const ticketUrl = (key: string | undefined | null) =>
    key && base.value && /^[A-Z][A-Z0-9_]+-\d+$/.test(key) ? `${base.value}/browse/${key}` : null
  return { ticketUrl }
}

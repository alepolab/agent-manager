import type { Capabilities, Role } from '~~/shared/types/role'

export interface Me {
  login: string
  name?: string
  avatar?: string
  /** The role this session acts with — the real one, or the one an operator is viewing as. */
  role: Role
  /** What they actually hold. Differs from `role` only while viewing as someone else. */
  realRole: Role
  can: Capabilities
  authDisabled: boolean
  profile: { login: string, jiraEmail?: string, hasJiraToken: boolean, hasGithubToken: boolean, updatedAt: number }
}

/** The signed-in developer, fetched once per app load and shared. */
export function useUser() {
  const me = useState<Me | null>('me', () => null)
  const checked = useState<boolean>('meChecked', () => false)
  // During server-side rendering a plain $fetch carries none of the browser's
  // cookies, so /api/me answered 401 and the freshly signed-in developer was
  // sent straight back to the login page. useRequestFetch forwards them.
  const requestFetch = useRequestFetch()

  async function load() {
    try {
      me.value = await requestFetch<Me>('/api/me')
    } catch {
      me.value = null
    } finally {
      checked.value = true
    }
  }

  async function signOut() {
    await $fetch('/api/auth/logout', { method: 'POST' })
    me.value = null
    await navigateTo('/login')
  }

  /**
   * What this session may do. Defaults to false while `me` is still loading,
   * so a control is never shown and then taken away — a button that appears
   * for half a second and vanishes reads as a bug, and one that appears and
   * then 403s reads as a worse one.
   */
  const can = (capability: keyof Capabilities) => me.value?.can?.[capability] === true
  const role = computed<Role | null>(() => me.value?.role ?? null)
  const viewingAs = computed(() => !!me.value && me.value.role !== me.value.realRole)

  /** Look at the app as a lesser role, or stop (`null`). Operators only; the server refuses the rest. */
  async function viewAs(next: Role | null) {
    await $fetch('/api/view-as', { method: 'POST', body: { role: next } })
    await load()
  }

  return { me, checked, load, signOut, can, role, viewingAs, viewAs }
}

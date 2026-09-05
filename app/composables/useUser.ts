export interface Me {
  login: string
  name?: string
  avatar?: string
  authDisabled: boolean
  profile: { login: string, jiraEmail?: string, hasJiraToken: boolean, hasGithubToken: boolean, updatedAt: number }
}

/** The signed-in developer, fetched once per app load and shared. */
export function useUser() {
  const me = useState<Me | null>('me', () => null)
  const checked = useState<boolean>('meChecked', () => false)

  async function load() {
    try {
      me.value = await $fetch<Me>('/api/me')
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

  return { me, checked, load, signOut }
}

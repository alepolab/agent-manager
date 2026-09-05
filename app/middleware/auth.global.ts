/**
 * Client-side guard: without a session, every page goes to /login. The API is
 * protected server-side; this only spares the developer a page full of 401s.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === '/login') return
  const { me, checked, load } = useUser()
  if (!checked.value) await load()
  if (!me.value) return navigateTo(`/login?next=${encodeURIComponent(to.fullPath)}`)
})

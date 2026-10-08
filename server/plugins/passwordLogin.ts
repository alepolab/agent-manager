/**
 * Says at boot when the password account's username is a GitHub user here:
 * sign-in with it is refused (see auth/password.post.ts), and the operator
 * should hear why before someone tries.
 */
import { passwordAccountTakenBy, passwordLoginConfigured } from '../utils/passwordLogin.ts'

export default defineNitroPlugin(async () => {
  if (!passwordLoginConfigured()) return
  const login = process.env.AGENT_MANAGER_LOGIN_USER!.trim()
  if (await passwordAccountTakenBy(login).catch(() => false)) {
    console.error(`[password login] AGENT_MANAGER_LOGIN_USER "${login}" is a GitHub user on this instance. Password sign-in with it is refused, because the session would carry that person's GitHub token and identity. Give the password account a name of its own.`)
  }
})

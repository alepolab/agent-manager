import { requireUser } from '../utils/session'
import { anthropicKindOf, normaliseAnthropicToken, removePastedGithubToken, saveProfile, savePastedGithubToken, toPublic, UNRECOGNISED_ANTHROPIC_TOKEN } from '../utils/users'

/** Jira email and token, and the Claude credential every agent they start runs
 *  on, for the signed-in developer, and their own preferences. An empty token
 *  clears it. `requireUser`, not a capability: every role edits
 *  their own profile, whatever else they may not touch. */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<{ jiraEmail?: string, jiraToken?: string, anthropicToken?: string, githubToken?: string, labs?: boolean }>(event)
  const patch: Parameters<typeof saveProfile>[1] = {}
  if (typeof body?.jiraEmail === 'string') patch.jiraEmail = body.jiraEmail.trim()
  if (typeof body?.jiraToken === 'string') patch.jiraTokenPlain = body.jiraToken.trim()
  if (typeof body?.anthropicToken === 'string') {
    // All whitespace, not just the ends: a token copied out of a terminal
    // carries the line wrap in its middle. See normaliseAnthropicToken.
    const token = normaliseAnthropicToken(body.anthropicToken)
    if (token && !anthropicKindOf(token)) throw createError({ statusCode: 400, message: UNRECOGNISED_ANTHROPIC_TOKEN })
    patch.anthropicTokenPlain = token
  }
  if (typeof body?.labs === 'boolean') patch.labs = body.labs
  // A GitHub token of their own: checked with GitHub before it is stored, and
  // kept across sign-ins. Empty removes it. Done apart from the patch above
  // because it asks GitHub first, and a refusal must store nothing.
  if (typeof body?.githubToken === 'string') {
    try {
      if (body.githubToken.trim()) await savePastedGithubToken(user.login, body.githubToken)
      else await removePastedGithubToken(user.login)
    } catch (err) {
      throw createError({ statusCode: 400, message: err instanceof Error ? err.message : String(err) })
    }
  }
  return toPublic(await saveProfile(user.login, patch))
})

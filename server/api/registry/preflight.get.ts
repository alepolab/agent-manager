import { resolveProduct } from '../../utils/registry'
import { artifactsWritable, checkoutDirFor, checkoutState } from '../../utils/workspace'
import { currentUser } from '../../utils/session'
import { getProfile } from '../../utils/users'

/** Everything a developer should know before pressing Start: routing, the checkout, evidence storage, identity. */
export default defineEventHandler(async (event) => {
  const q = getQuery(event).q
  const text = typeof q === 'string' ? q.trim() : ''
  const user = await currentUser(event)
  const profile = user ? await getProfile(user.login) : null
  const [artifacts, p] = await Promise.all([artifactsWritable(), text ? resolveProduct(text) : Promise.resolve(undefined)])
  const repo = p?.repos?.[0]
  const checkout = repo ? await checkoutState(checkoutDirFor(repo)) : null
  return {
    product: p ? { name: p.name, suite: p.suite ?? null, repos: p.repos, recipe: !!p.recipe } : null,
    checkout,
    artifacts,
    tokens: {
      github: !!profile?.githubToken || !!process.env.AGENT_GH_TOKEN,
      jira: !!(profile?.jiraToken && profile?.jiraEmail) || !!(process.env.JIRA_API_TOKEN && process.env.JIRA_EMAIL),
    },
  }
})

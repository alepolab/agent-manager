import { explainResolution, resolveProduct } from '../../utils/registry'
import { artifactsWritable, checkoutDirFor, checkoutState } from '../../utils/workspace'
import { currentUser } from '../../utils/session'
import { getProfile } from '../../utils/users'
import { githubSourceFor } from '../../utils/githubSource'

/** Everything a developer should know before pressing Start: routing, the checkout, evidence storage, identity. */
export default defineEventHandler(async (event) => {
  const q = getQuery(event).q
  const text = typeof q === 'string' ? q.trim() : ''
  const user = await currentUser(event)
  const profile = user ? await getProfile(user.login) : null
  // `why` is not decoration. The rule that decides most ambiguous tickets is
  // file order, which is invisible: a ticket routed to the wrong product looks
  // exactly like one routed to the right one, and the only way to find out
  // otherwise used to be starting a run and watching it clone the wrong repo.
  // GitHub is asked in the environment the agents get, not read off the
  // profile: without a profile token a run falls back to this host's own `gh`
  // login, and the warning used to say it would stop when it would not.
  const [artifacts, p, why, github] = await Promise.all([
    artifactsWritable(),
    text ? resolveProduct(text) : Promise.resolve(undefined),
    text ? explainResolution(text) : Promise.resolve(null),
    githubSourceFor(user?.login),
  ])
  const repo = p?.repos?.[0]
  const checkout = repo ? await checkoutState(checkoutDirFor(repo, user?.login)) : null
  return {
    product: p ? { name: p.name, suite: p.suite ?? null, repos: p.repos, recipe: !!p.recipe } : null,
    why,
    checkout,
    artifacts,
    tokens: {
      github: github.ok,
      githubVia: github.via,
      githubLogin: github.login,
      jira: !!(profile?.jiraToken && profile?.jiraEmail) || !!(process.env.JIRA_API_TOKEN && process.env.JIRA_EMAIL),
    },
  }
})

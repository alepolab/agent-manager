/**
 * Why a GitHub org membership check failed, in words the person reading the
 * login page can act on.
 *
 * `GET /user/memberships/orgs/{org}` fails for three unrelated reasons, and the
 * first version of the callback collapsed all of them into "you are not a
 * member of this organisation". That message sent an active org ADMIN looking
 * for an invitation they already had: the account was a member, the token could
 * not see it. An org with third-party application access restrictions withholds
 * org data from an OAuth app it has not approved, and the endpoint 404s exactly
 * as it does for a non-member.
 *
 * The requested scope is not the variable — login.get.ts asks for `read:org`.
 * Approval is.
 *
 * Kept separate from the handler so it can be tested without an HTTP event or
 * a live GitHub.
 */

export function oauthPolicyUrl(org: string): string {
  return `https://github.com/organizations/${org}/settings/oauth_application_policy`
}

/**
 * `status` is the HTTP status of the membership call; `state` is the `state`
 * field of a 2xx body, absent otherwise. Returns '' when the membership is
 * active — the caller should not be rendering a failure at all.
 */
export function membershipFailureDetail(
  opts: { status: number, state?: string, org: string, login: string },
): string {
  const { status, state, org, login } = opts
  const policy = oauthPolicyUrl(org)

  if (status >= 200 && status < 300) {
    if (state === 'active') return ''
    if (state === 'pending') return `The invitation to ${org} has not been accepted yet — accept it, then sign in again.`
    return `GitHub reports the membership state as "${state ?? 'unknown'}".`
  }

  if (status === 403) {
    return `GitHub returned 403, which is what an organisation with third-party application access restrictions returns for an OAuth app it has not approved. An owner grants it at ${policy}.`
  }
  if (status === 404) {
    return `GitHub returned 404. Either @${login} is genuinely not a member of ${org}, or the organisation restricts third-party OAuth apps and has not approved this one — an owner grants it at ${policy}.`
  }
  return `GitHub returned ${status} for the membership check.`
}

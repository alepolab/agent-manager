/**
 * Self-check for the org-membership failure message.
 *
 *   node scripts/test-org-membership.mjs
 *
 * The bug this pins: a 404 from /user/memberships/orgs/{org} was reported as
 * "@user is not an active member of the organisation". An active ADMIN of
 * alepolab saw that message. The account was a member; the OAuth app had not
 * been approved by the org, so the token could not see the membership, and the
 * endpoint 404s identically in both cases.
 *
 * A message that names one cause when three are possible is worse than one that
 * names the status, because it stops the reader investigating.
 */
import assert from 'node:assert/strict'

const { membershipFailureDetail, oauthPolicyUrl } = await import('../server/utils/orgMembership.ts')

const org = 'alepolab'
const login = 'ashwanisingh-alepo'
const policy = oauthPolicyUrl(org)
assert.equal(policy, 'https://github.com/organizations/alepolab/settings/oauth_application_policy')

// Active membership is not a failure at all.
assert.equal(membershipFailureDetail({ status: 200, state: 'active', org, login }), '')

// A pending invitation is the one case where "accept your invitation" is right.
const pending = membershipFailureDetail({ status: 200, state: 'pending', org, login })
assert.match(pending, /invitation/i)
assert.ok(!pending.includes(policy), 'a pending invitation is not an app-approval problem')

// 403 is the restricted-org signature. It must point at the policy page and
// must NOT tell the reader they are not a member.
const forbidden = membershipFailureDetail({ status: 403, org, login })
assert.match(forbidden, /403/)
assert.ok(forbidden.includes(policy), '403 must name where an owner approves the app')
assert.ok(!/is not a member/i.test(forbidden), '403 must not assert non-membership')

// 404 is genuinely ambiguous, so it must say so — both causes, not one.
const notFound = membershipFailureDetail({ status: 404, org, login })
assert.match(notFound, /404/)
assert.ok(notFound.includes(policy), '404 must name where an owner approves the app')
assert.match(notFound, /Either/, '404 must present both causes, not pick one')
assert.match(notFound, new RegExp(login), '404 should name the account it checked')

// Anything else still reports the status rather than inventing a cause.
const teapot = membershipFailureDetail({ status: 418, org, login })
assert.match(teapot, /418/)
assert.ok(!teapot.includes(policy), 'an unrelated status must not blame app approval')

// The org is not hardcoded: a different GITHUB_ORG must flow through.
assert.ok(membershipFailureDetail({ status: 403, org: 'other-org', login })
  .includes('https://github.com/organizations/other-org/settings/oauth_application_policy'))

console.log('orgMembership: all assertions passed')

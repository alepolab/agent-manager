/**
 * A ticket resolves to a product without a plugin installed, and infra work
 * lands on the deployment repo.
 *
 *   node scripts/test-registry-routing.mjs
 *
 * Two defects, one of which had been silent since team mode shipped.
 *
 * registryPath() read products.yaml ONLY from the installed alepo-engineering
 * plugin. A team container installs no plugin, so registryPath returned null,
 * loadRegistry returned null, and resolveProduct returned undefined for EVERY
 * ticket. No repos, no branch policy, no stack profile, no test commands — the
 * agents improvised all of it, and in one run two of them improvised different
 * checkout directories. It was invisible because "no product matched this
 * ticket" and "the registry could not be found" both surfaced as undefined.
 *
 * And nothing claimed the DEVOPS project or any infrastructure vocabulary, so
 * compose and deployment work resolved to nothing even with a registry loaded.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// No plugin: an empty config directory, exactly what a fresh container has.
process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'reg-'))
delete process.env.AGENT_REGISTRY_PATH

const { resolveProduct, loadRegistry } = await import('../server/utils/registry.ts')

const reg = await loadRegistry()
assert.ok(reg, 'the registry must load from the shipped copy when no plugin is installed')
assert.ok(reg.path.includes('engineering/registry'), `expected the shipped copy, got ${reg?.path}`)

const routes = async t => (await resolveProduct(t))?.name

// Infra work lands on the deployment repo.
assert.equal(await routes('DEVOPS-15: add the Eswatini post-migrate compose profile'), 'infra')
assert.equal(await routes('Add a healthcheck to the crm service in docker-compose.crm.yml'), 'infra')
assert.equal(await routes('Dockerfile base image needs pinning before the GHCR push'), 'infra')

// The shared services have no repo of their own: they exist only as compose
// services in the deployment repo, so a ticket against one is a change to it.
assert.equal(await routes('RabbitMQ queue not draining on the shared stack'), 'infra')
assert.equal(await routes('Keycloak realm role missing after re-seed'), 'infra')

const infra = await resolveProduct('DEVOPS-15: compose profile')
assert.deepEqual(infra.repos, ['alepolab/alepo-dev-team-infra'],
  'infra work must target the deployment repo and nothing else')
assert.equal(infra.branches.bug, 'develop', 'a fix enters at develop and is promoted from there')

// The fallback must not steal a ticket that belongs to a product. A PCRF ticket
// mentioning docker still resolves to pcrf: the project-key tier is decided
// before any component word is considered.
assert.equal(await routes('PCRFV-88: policy engine drops a session, seen in the docker logs'), 'pcrf')
assert.equal(await routes('SCN-402: selfcare page blank'), 'selfcarenow')
// Two products share the SCN project; only a LUM component word reaches the LUM one.
assert.equal(await routes('SCN-77: LUM selfcare invoice download'), 'lum-selfcare')

// Every product in the registry routes, and each Jira project reaches the repo
// the product owner named.
for (const [text, want] of [
  ['CRM-101 Liferay module fails to deploy', 'crm'],
  ['SEBL-77 rbsbill rounding is wrong', 'billing'],
  ['SA-1203 Fix bank instance update args', 'ocs'],
  ['CGW-12 charging gateway timeout', 'cgw'],
  ['URM-9 role seeding', 'urm'],
  ['WPM-31 partner onboarding', 'pms'],
  ['FFM-4 task plugin retry', 'ffm'],
  ['ANS-9 notification seeds', 'ans'],
  ['SCN-402 selfcare page blank', 'selfcarenow'],
  ['SCN-77 LUM selfcare invoice download', 'lum-selfcare'],
  ['VMS-3 voucher batch', 'vms'],
  ['MPOS-224 receipt printing', 'mpos'],
  ['WSO2-2 MI sequence', 'wso2'],
  ['OMS-1 order stuck', 'oms'],
  ['PC-5 catalogue offer', 'product-catalog'],
  ['CM-2 collection run', 'collection-manager'],
  ['RPM-8 promotion', 'rpm'],
]) {
  assert.equal(await routes(text), want, `"${text}" must route to ${want}`)
}

// Two Jira projects serve two products each, in different repos. The generic
// entry takes an unqualified ticket; naming the EMS reaches the EMS.
//
// Both halves of this were wrong before it was tested. `word('AAA')` matches
// INSIDE the key "AAA-56", so the generic product looked as specific as the EMS
// one — the key is stripped before disambiguating now, since it already chose
// the candidates and letting it choose between them counts it twice. And
// "PCRF" and "PCRF EMS" both appear in an EMS ticket, so the longest matching
// term wins: a longer term is a more specific claim.
assert.equal(await routes('AAA-55 RADIUS accounting drops'), 'aaa')
assert.equal(await routes('AAA-56 EMS Admin page fails to load'), 'aaa-ems')
assert.equal(await routes('PCRFV-88 policy engine drops a session'), 'pcrf')
assert.equal(await routes('PCRFV-90 PCRF EMS chart is blank'), 'pcrf-ems')

// DEVOPS likewise: compose work is the common case and takes an unqualified
// ticket; demo-environment infrastructure is named.
assert.equal(await routes('DEVOPS-40 Keycloak realm role missing'), 'infra')
assert.equal(await routes('DEVOPS-41 RabbitMQ queue not draining'), 'infra')
assert.equal(await routes('DEVOPS-42 Liquibase changelog fails'), 'infra')
assert.equal(await routes('DEVOPS-50 Terraform demo environment'), 'demo-infra')

// Branch policy is read from the repositories, not guessed. The three C++ repos
// use `development`; two repos have no develop branch at all.
const branchOf = async t => (await resolveProduct(t)).branches.bug
assert.equal(await branchOf('SA-1203 x'), 'development', 'ocs_cpp14 enters at development')
assert.equal(await branchOf('SEBL-77 x'), 'development', 'billing_cpp14 enters at development')
assert.equal(await branchOf('PCRFV-88 policy'), 'development', 'pcrf_cpp14 enters at development')
assert.equal(await branchOf('OMS-1 x'), 'main', 'order-management-system has no develop branch')
assert.equal(await branchOf('FFM-4 x'), 'develop')

// And it is a fallback, not a catch-all: a ticket about nothing still matches
// nothing, because guessing a product is how a run stands up the wrong stack.
assert.equal(await routes('Nothing in particular about anything'), undefined)

// ── the Environment block does not decide the product ────────────────────
// Run a3cb9d37 (CSUP-7526) spent $35.54 and 72 minutes working in the WRONG
// REPOSITORY because of one word in boilerplate. Every CSUP ticket carries an
// Environment section naming the deployment estate; that one read
// "Keycloak / CRM Nodes: DC-CRM1-KC1", and `Keycloak` is an infra label. The
// resolver matched the whole prompt, so a Selfcare billing bug resolved to
// `infra`: every lane's worktree was cut from the devops repo, and a lane
// committed 859 lines of the ticket's SQL onto a devops branch.
//
// The subject and the ticket's own Component field decide. Deployment
// vocabulary in the environment boilerplate does not.
{
  const csup7526 = [
    'CSUP-7526: Selfcare onboarding: going back a step silently replaces the $100 student promo with the $25 referral discount',
    'URL: https://alepo.atlassian.net/browse/CSUP-7526',
    '',
    'Component',
    '',
    'Web Selfcare Portal — member onboarding',
    '',
    'Environment',
    '',
    'Target Environment: Upgrade Production',
    'Load Balancers: DC-WSC1-LB1 / DC-WSC2-LB2',
    'Keycloak / CRM Nodes: DC-CRM1-KC1 / DC-CRM2-KC2',
    'Database Instance: crmdb',
    '',
    'Background',
    '',
    'Lüm Mobile offers targeted promotional incentives during the digital onboarding flow.',
  ].join('\n')

  // Asserted as the Selfcare FAMILY, not one member of it: the subject and
  // Component say "Web Selfcare Portal" and never "LUM", so which of
  // selfcarenow and lum-selfcare owns this ticket is a registry question for
  // the people who own those repos - not something routing should invent. What
  // is not in question is that it is not the deployment repo.
  const family = ['selfcarenow', 'lum-selfcare']
  const got = await routes(csup7526)
  assert.ok(family.includes(got),
    `the subject decides; the Keycloak in the Environment block must not route a Selfcare bug elsewhere - got ${got}`)
  assert.notEqual(got, 'infra', 'a Selfcare billing bug is never devops work')

  // The same ticket with the Environment BLOCK removed routes the same way,
  // which is what makes that block the cause rather than the subject. Only
  // those lines are dropped: the Background stays, because it is the ticket
  // talking about its own subject rather than about the estate.
  const withoutEstate = csup7526.split('\n').filter(l =>
    !/Load Balancers|Keycloak \/ CRM Nodes|Database Instance|Target Environment/.test(l)).join('\n')
  assert.equal(await routes(withoutEstate), got,
    'the Environment block changes nothing about where this ticket goes')
}

// ── but a real infrastructure ticket still reaches infra ─────────────────
// The fix must not be "stop matching deployment words". A DEVOPS ticket, and
// an infra ticket whose SUBJECT names the estate, both still route to infra.
{
  assert.equal(await routes('DEVOPS-20: Keycloak realm import fails on the sso stack'), 'infra')
  assert.equal(await routes([
    'SBN-9001: Keycloak container will not start after the compose bump',
    'URL: https://alepo.atlassian.net/browse/SBN-9001',
    '',
    'Component',
    '',
    'Deployment',
    '',
    'Environment',
    '',
    'Database Instance: crmdb',
  ].join('\n')), 'infra', 'the estate named in the SUBJECT and Component is a real infra ticket')

  // And a ticket whose Component says Selfcare while the body mentions
  // Liquibase is still a Selfcare ticket.
  assert.equal(await routes([
    'CSUP-7600: LUM Selfcare checkout totals wrong after a plan change',
    '',
    'Component',
    '',
    'LUM Selfcare',
    '',
    'Environment',
    '',
    'Liquibase ran at 03:00; SSO nodes DC-CRM1-KC1',
  ].join('\n')), 'lum-selfcare',
  'a Component naming LUM Selfcare still outranks the estate vocabulary in the Environment block')
}

// ── the customer decides: SaskTel and Lüm always mean lum-selfcare ──────
// Sandeep's rule, after two runs went to the wrong repo: "if i specifically
// say selfcare now then only go to new selfcare, and whenever sasktel, or lum
// comes in then always use lum selfcare repo".
//
// The customer's name is a stronger claim than any product vocabulary: a
// ticket that says SaskTel is about SaskTel's estate whatever else it mentions.
// CSUP-7524 proved the cost of the alternative - "Selfcare" appearing once in
// an analysis sentence outranked the customer named in the title.
{
  assert.equal(await routes('CSUP-7524: SaskTel | One-time SIM/eSIM fee transactions are never closed after the fee is charged'), 'lum-selfcare',
    'SaskTel in the subject means the LUM Selfcare repo')
  assert.equal(await routes('CSUP-7522: Sasktel || myLüm Android app uses deprecated APIs'), 'lum-selfcare',
    'the customer spelled Lüm, which the registry could not match before')
  assert.equal(await routes('CSUP-7527: Lum Mobile payment endpoint migration'), 'lum-selfcare')

  // The umlaut spelling ALONE, with no SaskTel and no bare "Lum" anywhere:
  // "myLüm" never matched the registry's LUM term, because the L is preceded
  // by a word character and the umlaut is not in it at all. Four open tickets
  // spell the app this way.
  assert.equal(await routes('CSUP-7530: myLüm checkout crashes on the review step'), 'lum-selfcare',
    'the app name as the tickets actually spell it')

  // Even when Selfcare vocabulary appears elsewhere in the ticket: the
  // customer wins, which is the whole point of the rule.
  assert.equal(await routes([
    'CSUP-7524: SaskTel | fee transactions are never closed',
    '',
    'Background',
    '',
    'billing only exposes the lifecycle events, CRM/Selfcare create the transactions',
  ].join('\n')), 'lum-selfcare',
  'a Selfcare mention in the body does not outrank the customer in the title')

  // And the explicit product name still reaches the other repo.
  assert.equal(await routes('SCN-500: SelfcareNow dashboard fails to load'), 'selfcarenow',
    'naming SelfcareNow explicitly is how a ticket reaches the new selfcare repo')
}

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
console.log('registry routing: resolves with no plugin, infra work lands on the deployment repo')

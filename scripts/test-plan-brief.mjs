/**
 * A ticket carries its implementation plan into the run, and only where one exists.
 *
 * A Jira ticket states the outcome. It does not say which tasks deliver it,
 * what they depend on, what closes each, or which pairs must ship together —
 * so a run started from a summary and a description rediscovers the sequencing
 * badly, or not at all. This covers the enrichment and, more importantly, the
 * cases where it must stay silent.
 *
 *   node scripts/test-plan-brief.mjs
 */
import assert from 'node:assert/strict'
import { planBriefFor, planBriefTickets } from '../server/utils/planBrief.ts'
import { ticketText } from '../server/utils/jiraTicketSource.ts'

// ---- Silence where the plan says nothing --------------------------------
// The failure worth guarding: a heading with nothing under it reads as "there
// is no work here", which is a different claim from "this ticket is not in the
// plan". Every non-Blossom ticket in the estate goes down this path.
for (const key of [undefined, '', 'CSUP-1', 'SBN-4091', 'DEVOPS-15', 'SASKNEPCR-999', 'SASKNEPCR-20']) {
  assert.equal(planBriefFor(key), null, `${key ?? '(none)'} has no plan and must get no brief`)
}

// ---- A mapped ticket gets its own tasks, not the whole plan -------------
{
  const brief = planBriefFor('SASKNEPCR-29')   // Change Phone Number — Port In
  assert.ok(brief, 'a mapped ticket gets a brief')
  for (const id of ['E1.1', 'E1.2', 'E2.1', 'A1.1']) {
    assert.ok(brief.includes(id), `${id} delivers this ticket and must be named`)
  }
  // The discipline that makes the brief worth attaching: it is this ticket's
  // work, not a copy of the sprint.
  for (const id of ['B2.2', 'T3.1', 'I2.3', 'C3.1']) {
    assert.ok(!brief.includes(id + ' ·'), `${id} belongs to another ticket and must not appear`)
  }
  assert.match(brief, /Done when:/, 'each task carries the evidence that closes it')
  assert.match(brief, /person-days/, 'and what it is priced at')
}

// ---- Case-insensitive, because a prompt is typed by a person ------------
assert.equal(planBriefFor('sasknepcr-29'), planBriefFor('SASKNEPCR-29'))

// ---- Dependencies outside the ticket are called out separately ----------
// These are the ones most likely to be missed: nothing on the ticket mentions
// them and nothing in its own task list implies them.
{
  const brief = planBriefFor('SASKNEPCR-27')   // Change Membership
  assert.match(brief, /Must already be finished elsewhere/,
    'C2.1 depends on C1.2 from another ticket, and that has to be visible')
  assert.ok(brief.includes('B1.0'), 'the audit that gates the catalogue work is named')
}

// ---- The rules that no single ticket can reveal -------------------------
{
  const brief = planBriefFor('SASKNEPCR-25')
  assert.match(brief, /D2\.1 and D2\.2 ship in the same release/, 'risk R2 travels with every brief')
  assert.match(brief, /tag AND the rule in one change/, 'risk R1 too')
  assert.match(brief, /Do not flip the apply-state flag/,
    'the revenue defect is stated as a prohibition, not left to be inferred')
  assert.match(brief, /Saskatchewan must be provably unchanged/)
}

// ---- Every mapping resolves to a real task ------------------------------
// A brief that names a task id nothing defines is worse than no brief: the
// agent goes looking for a plan entry that does not exist.
for (const key of planBriefTickets()) {
  const brief = planBriefFor(key)
  assert.ok(brief && brief.includes('Tasks that deliver it'), `${key} produces a usable brief`)
  assert.ok(!/ {2}undefined/.test(brief), `${key} has no unresolved task id`)
}

// ---- It reaches the prompt, which is the whole point --------------------
{
  const issue = {
    key: 'SASKNEPCR-34',
    summary: 'eSIM Activation — Port In (Existing Number, Province Restriction)',
    description: 'As a Manitoba customer I want to port my existing number.',
    labels: ['manitoba'],
    url: 'https://example.invalid/browse/SASKNEPCR-34',
  }
  const text = ticketText(issue)
  assert.ok(text.startsWith('SASKNEPCR-34: eSIM Activation'), 'the ticket still leads')
  assert.ok(text.includes(issue.description), 'and its own words are untouched')
  assert.match(text, /Implementation brief/, 'the plan is appended')
  assert.match(text, /E1\.2/, 'with the tasks that deliver it')
  assert.match(text, /Not from Jira/, 'and says plainly that it is not the customer speaking')

  // A ticket with no plan is passed through exactly as before.
  const plain = ticketText({ ...issue, key: 'CSUP-1' })
  assert.ok(!plain.includes('Implementation brief'), 'an unplanned ticket is unchanged')
}

// ---- Worklog buckets are not work ---------------------------------------
// SASKNEPCR-1..21 are the project's admin rows: meetings, lab setup, "CR
// related devlopement work", cutover, lessons learnt. They have no acceptance
// criteria because they exist to log hours against. Three of them once carried
// lane-wide briefs, so a Jira-to-PR run was dispatched against a timesheet
// ticket and commented on it. Only the journeys, -22..-35, describe work.
{
  for (let n = 1; n <= 21; n++) {
    const key = `SASKNEPCR-${n}`
    assert.equal(planBriefFor(key), null, `${key} is an admin bucket and carries no brief`)
  }
  assert.ok(planBriefFor('SASKNEPCR-22'), 'while the first journey ticket still does')
}

console.log('plan brief: a planned ticket carries its tasks, dependencies and the rules no single ticket reveals — and an unplanned one is untouched')

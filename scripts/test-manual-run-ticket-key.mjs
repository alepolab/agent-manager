/**
 * A run started by hand reports back to its ticket.
 *
 *   node scripts/test-manual-run-ticket-key.mjs
 *
 * startRun accepts a ticketKey and only watchRunStarter passed one, so
 * notifyTicketOutcome never fired for a manually started run — whatever
 * JIRA_POST_ENABLED said. The completed DEVOPS-15 run recorded
 * `ticketKey: null` with an initialPrompt beginning
 * "DEVOPS-15: Support running post-migrate script for Eswatini". The key was in
 * plain sight and nothing looked for it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { ticketKeyFrom } = await import('../server/utils/jiraTicketSource.ts')

// The exact prompt from the run that reported back to nothing.
assert.equal(ticketKeyFrom('DEVOPS-15: Support running post-migrate script for Eswatini'), 'DEVOPS-15')
assert.equal(ticketKeyFrom('DEVOPS-15'), 'DEVOPS-15')
assert.equal(ticketKeyFrom('  PCRFV-88 policy engine drops a session '), 'PCRFV-88')

// First match wins: a ticket body quotes other issues, and the one it is about
// is the one it opens with.
assert.equal(ticketKeyFrom('SA-1203 regressed what PCRFV-88 fixed'), 'SA-1203')

// No key is not a key. Guessing one would report a run against a stranger's
// ticket, which is worse than reporting against none.
assert.equal(ticketKeyFrom('add a healthcheck to the crm service'), undefined)
assert.equal(ticketKeyFrom(''), undefined)
assert.equal(ticketKeyFrom(undefined), undefined)

// Shapes that are not Jira keys must not match.
for (const s of ['ipv4-1 address', 'A-1', 'lowercase-12', 'DEVOPS-', 'ABC123']) {
  const got = ticketKeyFrom(s)
  assert.ok(got === undefined || /^[A-Z][A-Z0-9]+-\d+$/.test(got), `"${s}" produced "${got}"`)
}

// And the manual start path actually passes it, which is the half that was missing.
const src = readFileSync(join(import.meta.dirname, '..', 'server/api/workflows/[slug]/runs.post.ts'), 'utf8')
assert.match(src, /ticketKey:\s*ticketKeyFrom\(body\.initialPrompt\)/,
  'the manual run-start route must pass a ticketKey, or the notifier can never fire for it')

console.log('manual run ticket key: a hand-started run knows which ticket it is for')

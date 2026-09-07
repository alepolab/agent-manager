/**
 * A watch-dispatched run knows which ticket it came from.
 *
 *   node scripts/test-watch-dispatch-ticket-key.mjs
 *
 * watchRunStarter built the run's prompt out of the ticket — `${ticket.key}:
 * ${ticket.summary}` — and then did not pass ticketKey to startRun. So a
 * dispatched run recorded `ticketKey: null` and notifyTicketOutcome never
 * fired, leaving B5 broken for exactly the unattended case it exists for.
 *
 * Observed live: run 4ade0298, dispatched by a watch from PCRFV-1855, recorded
 * no ticket key at all.
 *
 * The manual path got this fixed first; the dispatch path is the one that
 * matters more, because nobody is watching it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dirname, '..', 'server/utils/watchRunStarter.ts'), 'utf8')

// The dispatch must hand startRun the key, not just bury it in the prompt.
assert.match(src, /ticketKey:\s*ticket\.key/,
  'a watch dispatch must pass ticketKey, or the run can never report back to its ticket')

// It must come from the ticket, never re-derived from the prompt text: the
// dispatch HAS the ticket, and parsing a string it just built would be a
// second source of truth that can disagree with the first.
assert.ok(!/ticketKey:\s*ticketKeyFrom/.test(src),
  'the dispatch has the ticket — it must not re-parse its own prompt for the key')

// Both start paths now carry it. The manual one reads the prompt because that
// is all it has; the dispatch one has the ticket itself.
const manual = readFileSync(join(import.meta.dirname, '..', 'server/api/workflows/[slug]/runs.post.ts'), 'utf8')
assert.match(manual, /ticketKey:\s*ticketKeyFrom\(body\.initialPrompt\)/,
  'the manual path reads the key from the prompt, which is all it has')

// And a keyless ticket never reaches the dispatch: validateTicket refuses it
// first, so `ticket.key` is always present by then.
assert.match(src, /if \(!ticket\.key\?\.trim\(\)\)/,
  'validateTicket must still reject a keyless ticket before dispatch')

console.log('watch dispatch: a dispatched run carries the key of the ticket that caused it')

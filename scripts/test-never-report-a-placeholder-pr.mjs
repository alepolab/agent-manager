#!/usr/bin/env node
/**
 * Run 1dd343a8 posted this onto the real PCRFV-1855 ticket:
 *
 *   Pipeline run for PCRFV-1855 finished — a pull request is ready for review:
 *   https://example.invalid/pending
 *
 * No pull request existed. The run consumed 8,265,304 tokens against an
 * 8,000,000 cap, the budget breaker tripped between waves — correctly — and
 * skipped `Evidence Bundle + PR`, which is the ONLY step that overwrites the
 * fix-implementer's `https://example.invalid/pending` placeholder with a real
 * URL. So a correctly-tripped circuit breaker produced a false success claim on
 * a customer-visible ticket.
 *
 * Two independent defects in one sentence:
 *
 *  1. `ciPoller.prUrlsOf` filtered the placeholder; `ticketNotifier`'s
 *     `readReportedPrUrls` read the same field of the same file and did not.
 *     Two readers of one field, and one silently stopped agreeing.
 *  2. The run's status was `failed`, and the comment said "finished".
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = p => readFileSync(join(root, p), 'utf8')
let failures = 0
const check = (name, ok, why) => {
  if (ok) return console.log(`  ok   ${name}`)
  failures++
  console.error(`  FAIL ${name}\n       ${why}`)
}

const artifacts = read('server/utils/runArtifacts.ts')
const poller = read('server/utils/ciPoller.ts')
const notifier = read('server/utils/ticketNotifier.ts')

check('the placeholder is defined exactly once',
  /export const PLACEHOLDER_PR = 'https:\/\/example\.invalid\/pending'/.test(artifacts)
  && !/PLACEHOLDER_PR = 'https/.test(poller)
  && !/= 'https:\/\/example\.invalid\/pending'/.test(notifier),
  'a constant copied into two files is how one copy stops agreeing with the other — which is precisely what happened')

check('both readers import it',
  /import \{ PLACEHOLDER_PR,[\s\S]*?from '\.\/runArtifacts/.test(poller)
  && /import \{ PLACEHOLDER_PR,[\s\S]*?from '\.\/runArtifacts/.test(notifier),
  'the notifier must answer "is this a real PR" the same way the poller does')

check('the notifier filters the placeholder out of reported PR URLs',
  /pr\.trim\(\) !== PLACEHOLDER_PR/.test(notifier),
  'without this the placeholder reaches Jira as a link a reviewer is told to open')

check('a run that did not complete is never called "finished"',
  /const finishedCleanly = input\.outcome\.runStatus === 'completed'/.test(notifier)
  && /prUrls\.length > 0 && finishedCleanly/.test(notifier),
  "the run was `failed` and the comment said `finished` — a real PR from a halted run still must not be reported as a clean pass")

check('a PR from an unfinished run is reported with that caveat',
  /did not finish cleanly/.test(notifier) && /Run outcome:/.test(notifier),
  'the breaker can trip AFTER the PR is opened; dropping the PR entirely would be as wrong as overstating it')

check('the halt reason survives when a PR exists but the run failed',
  /\(prUrls\.length > 0 && run\.status === 'completed'\) \? undefined : \(run\.error/.test(notifier),
  'the caveat branch has nothing to say without it')

// The exact shape that reached Jira must be impossible to render again.
const render = notifier.slice(notifier.indexOf('export function renderTicketComment'))
check('"ready for review" is unreachable without a completed run',
  !/a pull request is ready for review[\s\S]{0,200}\n  \} else if/.test(render.replace(/finishedCleanly/g, 'X'))
    || /prUrls\.length > 0 && finishedCleanly/.test(render),
  'the success sentence must be gated on run status, not only on a non-empty URL list')

console.log(failures === 0 ? '\nplaceholder never reaches Jira: all checks passed' : `\nplaceholder never reaches Jira: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)

/**
 * A PIPELINE-ASK line only pauses the run when it carries a real question.
 *
 * A decision gate ended with `PIPELINE-ASK: n/a — no ambiguity requiring a
 * person`, and its scan run paused on a question nobody could answer, holding
 * a group slot while the other nightly scans queued behind it.
 *
 *   node scripts/test-ask-needs-a-question.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'ask-'))
const { parseAsk } = await import('../server/utils/workflowRunner.ts')

const noQuestion = [
  'PIPELINE-ASK: n/a — no ambiguity requiring a person; this step\'s output is itself the set of questions',
  'PIPELINE-ASK: N/A',
  'PIPELINE-ASK: NA - nothing ambiguous',
  'PIPELINE-ASK: none',
  'PIPELINE-ASK: None.',
  'PIPELINE-ASK: nothing to ask',
  'PIPELINE-ASK: Not applicable (all drafts auto-approved)',
  'PIPELINE-ASK: no questions',
  'PIPELINE-ASK: No question: every draft is clear-cut',
]
for (const line of noQuestion) {
  assert.equal(parseAsk(`report…\n\n${line}\n\nVERDICT: done`), null, line)
}

const real = [
  'Is the SQL in api/search.py:89 reachable from user input, or only from admin calls?',
  'None of the three callers pass a currency — should the default be USD or the tenant currency?',
  'Nothing in the ticket says which tenant: CRM or portal?',
  'NAT traversal is off on the lab stack — enable it for this run?',
]
for (const q of real) {
  assert.equal(parseAsk(`report…\n\nPIPELINE-ASK: ${q}\n`), q, q)
}

assert.equal(parseAsk('no ask line at all'), null)
console.log('ok - PIPELINE-ASK needs a real question')

/**
 * Before a run spends money, it asks whether the work is already done.
 *
 * A fix can already exist four ways, and three of them are invisible from the
 * ticket alone: merged on another branch, pushed to a branch nobody PR'd, in a
 * PR opened and never merged, or named in a Jira comment. The pipeline reads
 * the ticket's summary, labels and description — never its comments — so a run
 * would happily produce a second PR against a bug that already has one, after
 * paying for every step to get there.
 *
 * ASK, never halt, and that distinction is the point of this file. A branch six
 * weeks stale and a PR merged yesterday look identical to a grep. Halting on a
 * false positive throws away a whole run; asking costs one answer from the
 * person who can tell them apart.
 *
 *   node scripts/test-prior-art-before-work.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const src = readFileSync(join(root, 'app', 'utils', 'templates.ts'), 'utf-8')
const { agentTemplates } = await import('../app/utils/templates.ts')

const block = src.slice(src.indexOf('const PRIOR_ART_CHECK = `'), src.indexOf('const SDLC_LANGUAGE_SKILLS = `'))
assert.ok(block.length > 500, 'PRIOR_ART_CHECK exists as one shared block, not copied into each agent')

// It asks. It must never be the thing that ends a run on its own: every
// finding is a question for a person, because the evidence is ambiguous by
// nature.
assert.ok(/PIPELINE-ASK/.test(block), 'a finding becomes a PIPELINE-ASK')
assert.ok(/do NOT halt the run/i.test(block), 'and explicitly not a halt')
assert.ok(!/PIPELINE-HALT/.test(block), 'the block must not offer halting as an option at all')

// All four hiding places, each with the command that actually looks there.
for (const [what, needle] of [
  ['commits on any branch', 'git log --all'],
  ['branches by name', 'git branch --all --list'],
  ['pull requests in any state', 'gh pr list --state all'],
  ['the ticket comments the packet never carries', '/comment?maxResults='],
]) assert.ok(block.includes(needle), `it searches ${what} (${needle})`)

// A missing credential answers exactly like an empty result. Reporting that as
// "no prior art" is the silent-empty failure this codebase keeps meeting.
assert.ok(/credential failure as "no prior art"/.test(block), 'an absent token is reported as a partial check, never as a clean result')
assert.ok(/prior-art\.md/.test(block), 'the finding is written down for later steps and the next run')

// The steps that carry it: the first step of each runbook that can run a shell
// and still precedes any code being written. Earlier is impossible — intake has
// no Bash; later is too late — the money is already spent.
const carriers = agentTemplates.filter(t => t.body.includes('Has this already been fixed?')).map(t => t.id)
assert.deepEqual(carriers.sort(), ['sdlc-ce-plan', 'sdlc-test-author'],
  `the check sits on the first shell-capable step of each runbook; found: ${carriers.join(', ') || '(none)'}`)

for (const id of carriers) {
  const t = agentTemplates.find(a => a.id === id)
  assert.ok(t.frontmatter.tools.includes('Bash'), `${id} can run the commands it is told to run`)
  assert.ok(t.frontmatter.tools.includes('Write'), `${id} can write prior-art.md`)
}

console.log(`prior art: ${carriers.length} steps check 4 sources before any work, and ask rather than halt`)

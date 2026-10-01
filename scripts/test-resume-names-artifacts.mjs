/**
 * A resumed agent session is told where the run's artifacts and checkout are
 * now. ASECRM-270 resumed a session started under another instance, wrote its
 * oracle to that instance's artifacts directory, and failed for a file it had
 * written - the header that names the directory is sent only to a fresh session.
 *
 *   node scripts/test-resume-names-artifacts.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../server/utils/workflowRunner.ts', import.meta.url), 'utf8')
const where = src.indexOf('const whereNow = `Artifacts directory for this run: ${runArtifactsDir(run.id)}')
assert.ok(where > 0, 'the reminder names the run artifacts directory')
assert.match(src.slice(where, where + 400), /Checkout: \$\{run\.projectDir\}/, 'and the checkout')
assert.match(src, /const input = resume \? whereNow \+/, 'every resumed visit gets it, first')
console.log('ok - a resumed session is told where the artifacts are now')

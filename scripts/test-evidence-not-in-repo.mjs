/**
 * Evidence stays in the app; it never lands in a repository.
 *
 *   node scripts/test-evidence-not-in-repo.mjs
 *
 * What this replaces: the runner copied the whole run directory to
 * `<projectDir>/.agent/evidence-run/` on completion, and the evidence agent was
 * told to `git add` it. That put a run's logs, step outputs and oracle XML into
 * someone else's product repo, as commits a reviewer has to read past to reach
 * the diff — permanently, in their history.
 *
 * Evidence is what a reviewer judges the change BY. It is not part of the
 * change. The app already serves it at /api/runs/:id/artifacts, so the pull
 * request body quotes the output and links the run.
 *
 * Two files are the exception and must still be committed, because they are the
 * fix's oracle rather than artifacts of the run: the test file, and
 * .agent/plan.md which the plan gate requires.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const read = f => readFileSync(join(root, f), 'utf8')

// Nothing may copy the run directory into a project tree any more.
const runner = read('server/utils/workflowRunner.ts')
assert.ok(
  !/^\s*(?!\/\/).*publishEvidenceToProject\s*\(/m.test(runner),
  'workflowRunner must not publish the run directory into the project tree',
)

const artifacts = read('server/utils/runArtifacts.ts')
assert.ok(
  !/export async function publishEvidenceToProject/.test(artifacts),
  'publishEvidenceToProject must not exist: nothing should be able to call it',
)

// The agent must be told not to commit artifacts, and must still be told to
// commit the two files that are the oracle.
const templates = read('app/utils/templates.ts')
assert.ok(
  !/git add .\.agent\/evidence-run/.test(templates),
  'no agent may be instructed to git add the evidence directory',
)
assert.match(templates, /The evidence does not go in the repository/,
  'the evidence agent must carry the instruction explicitly')
assert.match(templates, /\.agent\/plan\.md/,
  'the plan file is still required in the repo by the plan gate')

// The app is the destination, so an agent has to be told where that is.
assert.match(artifacts, /api\/runs\/\$\{runId\}\/artifacts/,
  'the artifact header must name the URL the app serves this run at')

console.log('evidence: stays in the app, never committed to a repository')

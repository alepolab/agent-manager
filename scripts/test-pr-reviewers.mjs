/**
 * Every pull request a run opens asks its product's reviewers for a review,
 * once, read from the registry at the time: a reviewer added today reaches
 * the runs already in flight.
 *
 *   node scripts/test-pr-reviewers.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'reviewers-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'reviewers-artifacts-'))
writeFileSync(join(process.env.CLAUDE_DIR, 'products.yaml'), `products:
  demo:
    match: { projects: [DEMO] }
    repos: [alepolab/demo]
    reviewers: [sandeep-patel-alepo-fifth]
    branches: { bug: develop, feature: develop }
    stack: { compose: x.yml, topology_default: single }
  quiet:
    match: { projects: [QUIET] }
    repos: [alepolab/quiet]
    branches: { bug: develop, feature: develop }
    stack: { compose: x.yml, topology_default: single }
`)

const C = await import('../server/utils/ciPoller.ts')
const store = await import('../server/utils/workflowRunStore.ts')
const { runArtifactsDir } = await import('../server/utils/runArtifacts.ts')

const asked = []
let fail = false
C.setReviewRequester(async (url, reviewers) => { if (fail) throw new Error('gh: 502'); asked.push([url, reviewers]) })

const withPr = async (product, pr, status) => {
  const r = await store.createRun({ workflowSlug: 'w', workflowName: 'W', autoRun: true, initialPrompt: 'x', watch: 'direct-invocation', steps: [{ stepId: 'a', label: 'A', agentSlug: 'x' }] })
  await store.saveRun({ ...r, status, product: { name: product, repos: [], branches: {}, tests: {} } })
  mkdirSync(runArtifactsDir(r.id), { recursive: true })
  writeFileSync(join(runArtifactsDir(r.id), 'meta.json'), JSON.stringify({ fix: { repos: [{ repo: 'alepolab/demo', pr }] } }))
  return r.id
}

const gate = await withPr('demo', 'https://github.com/alepolab/demo/pull/7', 'paused')
await withPr('quiet', 'https://github.com/alepolab/quiet/pull/8', 'completed')

fail = true
assert.equal(await C.requestReviewsOnce(), 0, 'a failed request is not recorded')
fail = false
assert.equal(await C.requestReviewsOnce(), 1)
assert.deepEqual(asked, [['https://github.com/alepolab/demo/pull/7', ['sandeep-patel-alepo-fifth']]], 'a run waiting at a gate after its PR is asked for too; a product with no reviewers is not')
assert.deepEqual((await store.getRun(gate)).reviewRequested, ['https://github.com/alepolab/demo/pull/7'])
assert.equal(await C.requestReviewsOnce(), 0, 'once per pull request')

console.log('ok - every run PR asks its product reviewers, once')
process.exit(0)

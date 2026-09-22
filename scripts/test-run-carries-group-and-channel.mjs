// Every start path snapshots the workflow's concurrency group and notify
// channel onto the run record. Both decide something the run cannot recover
// later: `group` is the cap it counts against, `notifyChannel` is who hears
// about it. A manual start ignores the cap on purpose but still OCCUPIES a
// slot, so a run filed under `default` because the route dropped `group` let
// the drain launch two more beside it.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// --- No start path builds the `workflow:` argument by hand any more. -------
// That literal is how the two fields went missing from four of five paths.
const sites = [
  'server/api/workflows/[slug]/runs.post.ts',
  'server/utils/watchRunStarter.ts',
  'server/utils/scheduleRunStarter.ts',
  'server/utils/workflowRunner.ts',
]
for (const rel of sites) {
  const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
  assert.doesNotMatch(src, /workflow: \{ slug:/,
    `${rel} builds the workflow argument as an object literal again; use toWorkflowLike so a field cannot be left out`)
}
// And the runner's own two call sites go through it.
const runnerSrc = readFileSync(new URL('../server/utils/workflowRunner.ts', import.meta.url), 'utf8')
assert.ok(runnerSrc.split('toWorkflowLike(').length - 1 >= 2,
  'the runner should use toWorkflowLike for both startChild and launchQueuedRun')

// --- The helper itself keeps both fields. ---------------------------------
const root = mkdtempSync(join(tmpdir(), 'run-fields-'))
process.env.CLAUDE_DIR = root
mkdirSync(join(root, 'workflows'), { recursive: true })

const store = await import('../server/utils/workflowRunStore.ts')

const full = { slug: 'scan', name: 'Scan', group: 'sdlc', notifyChannel: 'reviewers', steps: [{ id: 'a', label: 'A', agentSlug: 'x' }] }
assert.deepEqual(store.toWorkflowLike(full), full, 'nothing is dropped')
// Extra fields are not carried: the run snapshots what it needs, not the file.
assert.deepEqual(
  Object.keys(store.toWorkflowLike({ ...full, parameters: [], description: 'x' })).sort(),
  ['group', 'name', 'notifyChannel', 'slug', 'steps'])
// A workflow that states neither still produces the fields, as undefined.
const bare = store.toWorkflowLike({ slug: 's', name: 'S', steps: [] })
assert.equal(bare.group, undefined)
assert.equal(bare.notifyChannel, undefined)

// --- loadWorkflowSteps, the reader every automated starter uses. -----------
writeFileSync(join(root, 'workflows', 'scan.json'), JSON.stringify({
  name: 'Scan', group: 'sdlc', notifyChannel: 'reviewers', steps: [{ id: 'a', label: 'A', agentSlug: 'x' }],
}))
const read = await store.loadWorkflowSteps('scan')
assert.equal(read.group, 'sdlc')
assert.equal(read.notifyChannel, 'reviewers')
assert.deepEqual(store.toWorkflowLike(read), {
  slug: 'scan', name: 'Scan', group: 'sdlc', notifyChannel: 'reviewers', steps: read.steps,
})

// An empty string in the file is not a group: it must read back as absent, or
// groupOf would file the run under '' rather than 'default'.
writeFileSync(join(root, 'workflows', 'blank.json'), JSON.stringify({
  name: 'Blank', group: '', notifyChannel: '', steps: [{ id: 'a', label: 'A', agentSlug: 'x' }],
}))
const blank = await store.loadWorkflowSteps('blank')
assert.equal(blank.group, undefined)
assert.equal(blank.notifyChannel, undefined)

// --- The record: both fields survive createRun, started or queued. --------
const queue = await import('../server/utils/runQueue.ts')
for (const status of ['running', 'queued']) {
  const run = await store.createRun({
    workflowSlug: 'scan', workflowName: 'Scan', status,
    group: read.group, notifyChannel: read.notifyChannel,
    initialPrompt: 'go', steps: [], watch: 'direct-invocation',
  })
  const back = await store.getRun(run.id)
  assert.equal(back.group, 'sdlc', `a ${status} run lost its group`)
  assert.equal(back.notifyChannel, 'reviewers', `a ${status} run lost its notify channel`)
  assert.equal(queue.groupOf(back), 'sdlc',
    `a ${status} run counts against the wrong cap; this is what let three pipelines run at a cap of two`)
}

// A run with no group falls to the shared default, which is the behaviour the
// fix must NOT have changed for workflows that genuinely state none.
const ungrouped = await store.createRun({
  workflowSlug: 'blank', workflowName: 'Blank', status: 'running',
  initialPrompt: 'go', steps: [], watch: 'direct-invocation',
})
assert.equal(queue.groupOf(ungrouped), 'default')

console.log('run carries group and channel: all checks passed')

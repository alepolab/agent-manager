/**
 * Reading the review a GitHub Actions run leaves on a pull request.
 *
 * The pipeline opens a PR, a workflow reviews it, and until now nothing read
 * the result: comments on three real PRs sat unanswered until a person noticed
 * them. This is the read side of closing that loop - the runner collects the
 * review into the run's artifacts so a step can act on it.
 *
 * Every case below is written against what the real PRs actually contained,
 * because each one is a way this can lie:
 *
 *  - Human comments are interleaved with the bot's in the same REST array
 *    (measured: 2 of 4 comments on liferay-extension_lbss#74, 4 of 8 on
 *    administrator_lbss#117). Acting on a colleague's comment as if the review
 *    bot wrote it would put an agent in the middle of a human conversation.
 *  - An outdated comment carries `line: null` and only `original_line`
 *    (measured on ase_lbss#159), so a reader that trusts `line` gets null and
 *    one that overwrites it with `original_line` reports a stale line as
 *    current.
 *  - The review workflow sets `concurrency: cancel-in-progress: true`, so a
 *    push while the review is running CANCELS it. "Not SUCCESS yet" and "will
 *    never be SUCCESS" are different states and only one of them is worth
 *    waiting on.
 *
 *   node scripts/test-review-comments.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'review-comments-'))

const { reviewReady, shapeComments, collectReviewComments, REVIEW_BOT_LOGIN } = await import('../server/utils/reviewComments.ts')
const { runArtifactsDir } = await import('../server/utils/runArtifacts.ts')

// ---- reviewReady: only a completed review licenses acting on its comments ---
{
  const done = reviewReady([{ name: 'claude-review', bucket: 'pass', state: 'SUCCESS', completedAt: '2026-09-18T04:52:03Z' }])
  assert.equal(done.ready, true, 'a completed review is ready')
  assert.match(done.why, /claude-review/, 'and the reason names the check it read')

  const running = reviewReady([{ name: 'claude-review', bucket: 'pending', state: 'IN_PROGRESS' }])
  assert.equal(running.ready, false, 'a review still running is not ready')
  assert.match(running.why, /progress|pending|running/i)

  // The cancel-in-progress hazard: waiting on this forever is the bug.
  const cancelled = reviewReady([{ name: 'claude-review', bucket: 'fail', state: 'CANCELLED' }])
  assert.equal(cancelled.ready, false, 'a cancelled review is not ready')
  assert.equal(cancelled.terminal, true, 'and it is TERMINAL - waiting for it to finish is waiting forever')

  const absent = reviewReady([{ name: 'build', bucket: 'pass', state: 'SUCCESS' }])
  assert.equal(absent.ready, false, 'no review check means not ready')
  assert.match(absent.why, /no .*review/i, 'and it says the check was absent rather than implying failure')
}

// ---- shapeComments: the bot's comments only, and never a guessed line -------
{
  const raw = [
    {
      id: 4043827385, user: { login: 'github-actions[bot]' },
      path: 'datatable-taglib/src/main/java/com/alepo/se/taglib/datatable/DataTableTag.java',
      line: 92, start_line: 81, original_line: 89,
      body: '\u{1F7E1} Nit [Testing] \u2014 New pure-Java methods are untested\n\nDetail here.',
      html_url: 'https://github.com/alepolab/liferay-extension_lbss/pull/74#discussion_r4043827385',
    },
    {
      // Outdated: REST gives line null and only original_line.
      id: 4043824205, user: { login: 'github-actions[bot]' },
      path: 'configs/common/portal-ext.properties',
      line: null, original_line: 665,
      body: '\u{1F7E1} Nit [Documentation] \u2014 Comment contradicts the runbook',
      html_url: 'https://github.com/alepolab/ase_lbss/pull/159#discussion_r4043824205',
    },
    {
      // A human. Must be excluded and counted, never acted on.
      id: 999001, user: { login: 'sandeep-patel-alepo-fifth' },
      path: 'x.java', line: 3, body: 'Fixed, and further than suggested.',
    },
    {
      // A second human, replying in a thread.
      id: 999002, user: { login: 'jitendrajaware-alepo' },
      path: 'x.java', line: 4, body: 'Please also check the exempt list.', in_reply_to_id: 4043827385,
    },
    // The same bot comment delivered twice (re-review repeats its findings).
    {
      id: 4043827385, user: { login: 'github-actions[bot]' },
      path: 'datatable-taglib/src/main/java/com/alepo/se/taglib/datatable/DataTableTag.java',
      line: 92, body: '\u{1F7E1} Nit [Testing] \u2014 New pure-Java methods are untested',
    },
  ]

  const shaped = shapeComments(raw)

  assert.equal(shaped.comments.length, 2, `only the bot's distinct comments are actionable; got ${JSON.stringify(shaped.comments.map(c => c.id))}`)
  assert.ok(shaped.comments.every(c => c.authorIsReviewBot === true), 'every actionable comment is flagged as the bot\'s')
  assert.equal(shaped.excluded.length, 2, 'the two human comments are excluded, not dropped silently')
  assert.ok(shaped.excluded.every(e => e.reason === 'not-review-bot'), 'and the exclusion says why')
  assert.equal(shaped.counts.humanComments, 2, 'the human count is reported so a reader knows a conversation exists')
  assert.equal(shaped.counts.duplicates, 1, 'the repeated finding is deduplicated and counted')

  // The login is matched exactly: GraphQL reports the same account without the
  // [bot] suffix, so one shared constant used against both surfaces matches
  // nothing on one side.
  assert.equal(REVIEW_BOT_LOGIN, 'github-actions[bot]', 'the REST login is exact')

  const outdated = shaped.comments.find(c => c.id === 4043824205)
  assert.equal(outdated.line, 665, 'an outdated comment falls back to original_line')
  assert.equal(outdated.lineIsCurrent, false, 'and says the line is NOT current, so nobody reports a stale line as live')

  const current = shaped.comments.find(c => c.id === 4043827385)
  assert.equal(current.line, 92)
  assert.equal(current.lineIsCurrent, true)
  assert.equal(current.startLine, 81, 'a multi-line comment keeps its start')

  // Severity and category come from the bot's own prefix, parsed not guessed.
  assert.equal(current.severity, 'Nit')
  assert.equal(current.category, 'Testing')
  assert.match(current.title, /New pure-Java methods are untested/)
  assert.ok(current.body.includes('Detail here.'), 'the full body is kept for the agent to read')
}

// ---- an unparsable body is carried, never discarded or invented ------------
{
  const shaped = shapeComments([
    { id: 1, user: { login: 'github-actions[bot]' }, path: 'a.ts', line: 1, body: 'just a sentence with no severity marker' },
  ])
  assert.equal(shaped.comments.length, 1)
  assert.equal(shaped.comments[0].severity, null, 'no severity is null, not a default like "Nit"')
  assert.equal(shaped.comments[0].category, null)
  assert.equal(shaped.comments[0].title, 'just a sentence with no severity marker', 'the title falls back to the first line')
}

// ---- collectReviewComments: writes the artifact the acting step reads -------
{
  const run = {
    id: 'review-run-1', ticketKey: 'CSUP-7495', status: 'running',
    workflowSlug: 'oma-csup-to-pr', workflowName: 'CSUP', watch: 'direct-invocation',
    branch: 'fix/CSUP-7495-x', baseBranch: 'develop', steps: [], startedAt: Date.now(),
    budget: { maxMinutes: 60, maxTokens: 1 },
  }
  const prUrl = 'https://github.com/alepolab/liferay-extension_lbss/pull/74'
  const calls = []

  const artifact = await collectReviewComments(run, {
    prUrls: [prUrl],
    readChecks: async (url) => { calls.push(`checks:${url}`); return [{ name: 'claude-review', bucket: 'pass', state: 'SUCCESS', completedAt: '2026-09-18T04:52:03Z' }] },
    readComments: async (pr) => {
      calls.push(`comments:${pr.owner}/${pr.repo}#${pr.number}`)
      return [{ id: 7, user: { login: 'github-actions[bot]' }, path: 'a.java', line: 5, body: '\u{1F7E1} Nit [Design] \u2014 duplicated default' }]
    },
  })

  assert.deepEqual(calls, ['checks:' + prUrl, 'comments:alepolab/liferay-extension_lbss#74'],
    'the PR url is parsed into owner/repo/number and both readers are called for it')
  assert.equal(artifact.prs.length, 1)
  assert.equal(artifact.prs[0].number, 74)
  assert.equal(artifact.prs[0].repo, 'alepolab/liferay-extension_lbss')
  assert.equal(artifact.prs[0].review.ready, true)
  assert.equal(artifact.prs[0].comments.length, 1)
  assert.ok(artifact.fetchedAt > 0, 'the artifact records when it was read, since a review moves')

  // On disk, in the directory the app serves and every agent is pointed at.
  const path = join(runArtifactsDir(run.id), 'review-comments.json')
  assert.ok(existsSync(path), 'review-comments.json is written into the run artifacts')
  const onDisk = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(onDisk.prs[0].comments[0].id, 7, 'and the file holds the same data the caller got')
  assert.equal(onDisk.prs[0].review.check, 'claude-review')
}

// ---- a run with no pull request collects nothing and says so --------------
{
  const run = { id: 'review-run-2', status: 'running', workflowSlug: 'x', workflowName: 'x', watch: 'direct-invocation', steps: [], startedAt: Date.now(), budget: { maxMinutes: 1, maxTokens: 1 } }
  const artifact = await collectReviewComments(run, {
    prUrls: [],
    readChecks: async () => { throw new Error('must not be called') },
    readComments: async () => { throw new Error('must not be called') },
  })
  assert.deepEqual(artifact.prs, [], 'no PR means no review to read')
  assert.match(artifact.note ?? '', /no pull request/i, 'and the artifact says that rather than looking like an empty review')
}

// ---- a reader that fails is reported, never turned into "no comments" ------
{
  const run = { id: 'review-run-3', status: 'running', workflowSlug: 'x', workflowName: 'x', watch: 'direct-invocation', steps: [], startedAt: Date.now(), budget: { maxMinutes: 1, maxTokens: 1 } }
  const artifact = await collectReviewComments(run, {
    prUrls: ['https://github.com/alepolab/ase_lbss/pull/159'],
    readChecks: async () => [{ name: 'claude-review', bucket: 'pass', state: 'SUCCESS' }],
    readComments: async () => { throw new Error('gh: HTTP 403 rate limited') },
  })
  assert.equal(artifact.prs[0].comments.length, 0)
  assert.match(artifact.prs[0].error ?? '', /403|rate limited/, 'the failure is carried on the PR, so nobody reads silence as "no findings"')
}

rmSync(process.env.AGENT_RUNS_DIR, { recursive: true, force: true })
console.log('review comments: the bot\'s findings only, no invented line, and a failure never reads as no findings')

/**
 * The notifications inbox: which decisions it lists, whose they are, and in
 * what order.
 *
 * The inbox is where a person goes to find out what is waiting on them. A gate
 * it leaves out is a run nobody knows is stuck; a gate it marks as someone
 * else's is one the right person skips. Both fail silently, which is why the
 * rules are pinned here.
 *
 *   node scripts/test-notifications.mjs
 */
import assert from 'node:assert/strict'

const { buildNotifications, gateAsk, gateIsMine, permissionAsk } = await import('../shared/utils/notifications.ts')

const HOUR = 3_600_000
const now = Date.now()
const run = (id, status, extra = {}) => ({
  id, status, workflowSlug: 'wf', workflowName: 'Runbook A', initialPrompt: `Fix ${id}\nmore detail`,
  startedAt: now - 10 * HOUR, steps: [], currentStepIds: [], ...extra,
})

// ── 1. only runs stopped on a person, and not dismissed ──────────────────────
{
  const runs = [
    run('a', 'paused', { question: { stepId: 's', text: 'Approve the plan?', kind: 'approval', askedAt: now - HOUR } }),
    run('b', 'awaiting_review', { question: { stepId: 's', text: '', kind: 'approval', askedAt: now - HOUR, artifact: 'escalated-drafts.json' } }),
    run('c', 'failed'), run('d', 'completed'), run('e', 'running'), run('f', 'interrupted'),
    run('g', 'paused', { dismissed: true, question: { stepId: 's', text: 'x', kind: 'question', askedAt: now } }),
  ]
  const ids = buildNotifications(runs, [], 'developer').map(n => n.id).sort()
  assert.deepEqual(ids, ['run:a', 'run:b'], 'lists paused and awaiting_review runs, nothing settled, nothing dismissed')
  const b = buildNotifications(runs, [], 'developer').find(n => n.id === 'run:b')
  assert.equal(b.review, true, 'an artifact review is flagged as one')
}

// ── 2. whose gate it is ──────────────────────────────────────────────────────
{
  assert.equal(gateIsMine('qa', 'developer'), false, "QA's gate is not the developer's")
  assert.equal(gateIsMine('qa', 'qa'), true)
  assert.equal(gateIsMine('qa', 'operator'), true, 'an operator is the backstop for every gate')
  assert.equal(gateIsMine(undefined, 'developer'), true, 'a gate naming no role is everyone\'s')
  assert.equal(gateIsMine(undefined, 'manager'), false, 'a manager holds no answerGate, so no gate is theirs')
  assert.equal(gateIsMine('developer', undefined), true, 'no viewer role (auth disabled) sees every gate as theirs')
}

// ── 3. order: prompts, then mine, then longest wait ──────────────────────────
{
  const runs = [
    run('theirs-old', 'paused', { question: { stepId: 's', text: 'q', kind: 'approval', askedAt: now - 9 * HOUR, role: 'qa' } }),
    run('mine-new', 'paused', { question: { stepId: 's', text: 'q', kind: 'approval', askedAt: now - HOUR, role: 'developer' } }),
    run('mine-old', 'paused', { question: { stepId: 's', text: 'q', kind: 'approval', askedAt: now - 5 * HOUR } }),
  ]
  const perm = { id: 'p1', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'rm -rf dist' }, workingDir: '/w', askedAt: now, expiresAt: now + 300_000 }
  const order = buildNotifications(runs, [perm], 'developer').map(n => n.id)
  assert.deepEqual(order, ['permission:p1', 'run:mine-old', 'run:mine-new', 'run:theirs-old'],
    'a prompt that expires in minutes leads; then my gates, longest wait first; then other people\'s')
}

// ── 4. how the question is worded ────────────────────────────────────────────
{
  assert.match(gateAsk({ status: 'awaiting_review', question: { artifact: 'escalated-drafts.json' } }), /escalated-drafts\.json/)
  assert.match(gateAsk({ status: 'paused', question: { reason: 'budget', text: 'ignored' } }), /budget/)
  assert.match(gateAsk({ status: 'paused', question: { reason: 'rework', text: 'ignored' } }), /send-backs/)
  assert.equal(gateAsk({ status: 'paused', question: { text: 'Which schema?' } }), 'Which schema?', 'a step\'s own question is shown as asked')
  assert.match(gateAsk({ status: 'paused' }), /open it/, 'a pause with no question still says something')
}

// ── 5. permission prompts ────────────────────────────────────────────────────
{
  assert.equal(buildNotifications([], [], 'operator').length, 0, 'no prompts are invented when none are passed')
  assert.equal(permissionAsk({ toolName: 'Bash', toolInput: { command: 'git push\n--force' } }), 'git push', 'the first line of the command')
  assert.equal(permissionAsk({ toolName: 'Edit', toolInput: { file_path: '/a/b.ts', old_string: 'x' } }), '/a/b.ts')
  assert.equal(permissionAsk({ toolName: 'AskUserQuestion', toolInput: { questions: [{ question: 'Which DB?' }] } }), 'Which DB?')
  assert.equal(permissionAsk({ toolName: 'Mystery', toolInput: {} }), 'Allow Mystery?')
  const [p] = buildNotifications([], [{ id: 'p', sessionId: 's', toolName: 'Bash', toolInput: { command: 'ls' }, workingDir: '/', askedAt: now, expiresAt: now }], 'operator')
  assert.equal(p.kind, 'permission')
  assert.equal(p.mine, true)
}

console.log('notifications: ok')

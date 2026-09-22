/**
 * The Slack webhook an operator can store, and the rules around it.
 *
 * Slack notification was code-complete and wired into both the runner and the
 * CI poller, and reached nobody for six weeks: the only way to point it at a
 * channel was a SLACK_WEBHOOK_URL variable on the container, and nothing in
 * the app could set one or say that none was set. This covers the half that
 * was missing.
 *
 *   node scripts/test-integrations.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'integrations-'))
process.env.AGENT_USERS_DIR = join(root, 'users')
process.env.AGENT_MANAGER_SECRET = 'test-secret-not-a-real-one'
delete process.env.SLACK_WEBHOOK_URL

const I = await import('../server/utils/integrations.ts')
const file = join(root, 'integrations.json')

// ---- Nothing configured reads as nothing, not as an error ---------------
{
  const p = await I.publicIntegrations()
  assert.equal(p.slack.configured, false)
  assert.equal(p.slack.source, 'none')
  assert.equal(await I.slackWebhookUrl(), null)
}

// ---- A URL that is not a Slack webhook is refused at the door -----------
// The failure this module exists to end is a silent non-delivery, and a typo
// discovered weeks later is the same failure wearing a different hat.
for (const [bad, why] of [
  ['not a url', /not a URL/],
  ['http://hooks.slack.com/services/x', /https/],
  ['https://example.com/services/x', /hooks\.slack\.com/],
  ['https://hooks.slack.com/oops/x', /services/],
]) {
  await assert.rejects(() => I.setSlackWebhook(bad), why, `refused: ${bad}`)
}
assert.equal(await I.slackWebhookUrl(), null, 'and nothing was stored by a rejected attempt')

// ---- A good one round-trips, and never lands in plaintext ---------------
const real = 'https://hooks.slack.com/services/T000/B000/abcdefghijklmnop'
{
  await I.setSlackWebhook(real)
  assert.equal(await I.slackWebhookUrl(), real, 'what was stored is what comes back')

  const onDisk = readFileSync(file, 'utf8')
  assert.ok(!onDisk.includes(real), 'the webhook is never written in plaintext')
  assert.ok(!onDisk.includes('abcdefghijklmnop'), 'not even its secret path segment')

  const p = await I.publicIntegrations()
  assert.equal(p.slack.configured, true)
  assert.equal(p.slack.source, 'stored')
  assert.ok(!JSON.stringify(p).includes('abcdefghijklmnop'), 'and the browser is told that it is set, never what it is')
}

// ---- The environment wins ------------------------------------------------
// A deployment that already configures one keeps working, and an operator
// cannot silently redirect an instance's notifications by storing another.
{
  process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/ENV/ENV/env'
  assert.equal(await I.slackWebhookUrl(), 'https://hooks.slack.com/services/ENV/ENV/env')
  const p = await I.publicIntegrations()
  assert.equal(p.slack.source, 'env')
  delete process.env.SLACK_WEBHOOK_URL
  assert.equal(await I.slackWebhookUrl(), real, 'and the stored one is still there underneath')
}

// ---- A rotated secret reads as unconfigured, never as a bad webhook -----
{
  const saved = process.env.AGENT_MANAGER_SECRET
  process.env.AGENT_MANAGER_SECRET = 'a-different-secret'
  assert.equal(await I.slackWebhookUrl(), null,
    'a secret that no longer decrypts is not a webhook, and must not be posted to')
  process.env.AGENT_MANAGER_SECRET = saved
  assert.equal(await I.slackWebhookUrl(), real, 'restoring the secret restores the webhook')
}

// ---- Clearing it ---------------------------------------------------------
{
  await I.setSlackWebhook('')
  assert.equal(await I.slackWebhookUrl(), null)
  assert.equal((await I.publicIntegrations()).slack.configured, false)
}

// ---- No secret configured: say so rather than throwing at the caller ----
{
  const saved = process.env.AGENT_MANAGER_SECRET
  delete process.env.AGENT_MANAGER_SECRET
  assert.match(I.canStoreSecrets() ?? '', /AGENT_MANAGER_SECRET/,
    'an instance that cannot store a credential says which variable it needs')
  process.env.AGENT_MANAGER_SECRET = saved
  assert.equal(I.canStoreSecrets(), null)
}

// ---- A corrupt file does not take the instance down ---------------------
{
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '{ not json')
  assert.equal(await I.slackWebhookUrl(), null, 'unreadable is treated as unconfigured, not as a crash')
  assert.equal((await I.publicIntegrations()).slack.configured, false)
}

// ---- notify.ts actually posts to the STORED webhook ---------------------
// The point of the whole change: a run transition reaches Slack without
// anyone setting an environment variable on the container.
{
  writeFileSync(file, '{}')
  await I.setSlackWebhook(real)

  process.env.AGENT_RUNS_ROOT = join(root, 'runs')
  const N = await import('../server/utils/notify.ts')
  const posted = []
  N.setPoster(async (url, body) => { posted.push({ url, body }) })
  N._resetNotified()

  N.notifyRunTransition({
    id: 'r1', workflowName: 'SDLC', workflowSlug: 'sdlc', status: 'paused',
    initialPrompt: 'CSUP-1 something broke', steps: [], currentStepIds: [], nextStepIds: [],
    question: { stepId: 's', text: '', kind: 'approval', reason: 'budget', askedAt: Date.now() },
  })
  // The delivery path is deliberately fire-and-forget, so let it settle.
  await new Promise(r => setTimeout(r, 50))

  assert.equal(posted.length, 1, 'a paused run posts to the stored webhook with no env var set')
  assert.equal(posted[0].url, real)
  assert.match(posted[0].body.text, /PAUSED/)
  assert.equal(posted[0].body.reason, 'paused-on-budget')
  assert.match(posted[0].body.text, /budget is spent/, 'and says what the reader is expected to do')
}

rmSync(root, { recursive: true, force: true })
console.log('integrations: a Slack webhook stores encrypted, the environment still wins, a rotated secret reads as unconfigured, and a paused run reaches the stored webhook')

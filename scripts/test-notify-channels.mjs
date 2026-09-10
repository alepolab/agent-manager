/**
 * Self-checks for named notification channels: the sealed store, the per-product
 * body shapes, the composed message, and the notify step's outcomes.
 *
 *   node scripts/test-notify-channels.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'channels-'))
process.env.AGENT_MANAGER_SECRET = 'test-secret-for-channels'
process.env.AGENT_CHANNELS_FILE = join(tmp, 'channels.json')
process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'channels-claude-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'channels-artifacts-'))
process.env.AGENT_MANAGER_URL = 'https://agents.example.test'

const C = await import('../server/utils/channels.ts')
const N = await import('../server/utils/notify.ts')
const S = await import('../server/utils/notifySteps.ts')

// ── the store: sealed at rest, never handed to the browser ────────────────
const SLACK_URL = 'https://hooks.slack.com/services/T000/B111/zzsecretpathzz'
await C.saveChannel('reviewers', { kind: 'slack', url: SLACK_URL }, 'arisht')

const raw = readFileSync(process.env.AGENT_CHANNELS_FILE, 'utf8')
assert.ok(!raw.includes('zzsecretpathzz'), 'the webhook path must not appear in the file on disk')
assert.ok(!raw.includes(SLACK_URL), 'the webhook URL must not appear in the file on disk')
assert.match(raw, /"url": "v1:/, 'the URL is stored in the sealed v1 envelope')

const stored = await C.getChannel('reviewers')
assert.equal(C.channelUrl(stored), SLACK_URL, 'it round-trips back to the URL that went in')
assert.equal(stored.updatedBy, 'arisht', 'the store records who saved it')

const [pub] = await C.listPublicChannels()
assert.equal(pub.url, undefined, 'the public view carries no URL')
assert.equal(pub.hasUrl, true)
assert.equal(pub.host, 'hooks.slack.com', 'the host is shown so two channels can be told apart')
assert.ok(!JSON.stringify(pub).includes('zzsecretpathzz'), 'no part of the path leaks through the public view')

// Mode is only meaningful where the OS honours it.
if (process.platform !== 'win32') {
  assert.equal(statSync(process.env.AGENT_CHANNELS_FILE).mode & 0o777, 0o600, 'the store is owner-only')
}

// An empty url on a save KEEPS the stored one - the form cannot echo a secret
// back, so blank must mean unchanged rather than "wipe it".
await C.saveChannel('reviewers', { kind: 'teams', url: '' })
assert.equal(C.channelUrl(await C.getChannel('reviewers')), SLACK_URL, 'an empty url keeps the stored webhook')
assert.equal((await C.getChannel('reviewers')).kind, 'teams', 'but the rest of the row still updates')
await C.saveChannel('reviewers', { kind: 'slack', url: SLACK_URL })

// Validation, table-driven over the ways a row can be wrong.
for (const [patch, name, why] of [
  [{ kind: 'slack', url: 'https://x.test/a' }, '', 'an empty name'],
  [{ kind: 'slack', url: 'https://x.test/a' }, ' leading', 'a leading space'],
  [{ kind: 'slack', url: 'https://x.test/a' }, 'a'.repeat(41), 'a name over 40 characters'],
  [{ kind: 'carrier-pigeon', url: 'https://x.test/a' }, 'ok-name', 'an unknown kind'],
  [{ kind: 'slack', url: 'http://x.test/a' }, 'ok-name', 'a plaintext URL to another host'],
  [{ kind: 'slack', url: 'not a url' }, 'ok-name', 'a non-URL'],
  [{ kind: 'slack' }, 'brand-new', 'no URL on a channel that does not exist yet'],
]) {
  await assert.rejects(() => C.saveChannel(name, patch), `${why} is refused`)
}

// Loopback over http is allowed, so the feature can be exercised against a
// local sink without weakening the rule for anything that leaves the machine.
await C.saveChannel('local-sink', { kind: 'slack', url: 'http://localhost:9099/hook' })
assert.equal(C.channelUrl(await C.getChannel('local-sink')), 'http://localhost:9099/hook', 'http to loopback is allowed')
await C.deleteChannel('local-sink')

assert.equal(await C.deleteChannel('nope'), false, 'deleting what is not there says so')

// ── body shapes: the host decides, not the operator ───────────────────────
for (const [kind, url, expect, why] of [
  ['slack', 'https://hooks.slack.com/services/x', 'text', 'Slack takes a plain text body'],
  ['teams', 'https://alepo.webhook.office.com/webhookb2/x', 'text', 'a surviving O365 connector takes a MessageCard'],
  ['teams', 'https://prod-12.westeurope.logic.azure.com/workflows/x', 'card', 'a Power Automate URL needs an Adaptive Card'],
  ['teams', 'https://contoso.powerplatform.com/x', 'card', 'so does a Power Platform URL'],
  ['teams', 'not-a-url', 'text', 'an unparseable URL falls back to the plain body rather than throwing'],
]) {
  const body = N.bodyFor(kind, url, 'hello')
  if (expect === 'text') {
    assert.deepEqual(body, { text: 'hello' }, why)
  } else {
    assert.equal(body.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive', why)
    assert.equal(body.attachments[0].content.body[0].text, 'hello', 'the card carries the text')
    assert.equal(body.attachments[0].content.body[0].wrap, true, 'and wraps it')
  }
}

// ── composeNotification: pure, and varied over what actually differs ──────
const LINK = 'https://agents.example.test/workflows/scan?run=r1'
const named = n => Array.from({ length: n }, (_, i) => ({ jira_key: `DRAFT-${i + 1}` }))

for (const [entries, message, expects, why] of [
  [named(3), '{count} drafts need a decision', [/^3 drafts need a decision$/m, /DRAFT-1, DRAFT-2, DRAFT-3/], 'count substitutes and entries are named'],
  [[{}, {}, {}], undefined, [/^3 entries of escalated-drafts\.json need a decision\.$/m, /entry 1, entry 2, entry 3/], 'entries with no identity fall back to their position'],
  [named(12), undefined, [/DRAFT-1, DRAFT-2, DRAFT-3, DRAFT-4, DRAFT-5, \+7 more/], 'a long list is capped and counted'],
  [[], undefined, [/^0 entries of escalated-drafts\.json need a decision\.$/m], 'zero renders rather than throwing'],
  [named(1), '{count} draft, {count} decision', [/^1 draft, 1 decision$/m], 'every occurrence is substituted'],
]) {
  const text = S.composeNotification({ message, artifact: 'escalated-drafts.json', entries, link: LINK })
  for (const re of expects) assert.match(text, re, why)
  assert.ok(text.endsWith(LINK), 'the link is always last')
}
assert.ok(
  !S.composeNotification({ entries: [], link: LINK }).includes('undefined'),
  'no artifact named is still a sentence, not "undefined"',
)

// ── runNotifyStep: every outcome completes, and says which ────────────────
const RUN = { id: 'r1', workflowSlug: 'scan', workflowName: 'Scan', status: 'running', steps: [], currentStepIds: [], nextStepIds: [], initialPrompt: 'scan alepo-api' }
mkdirSync(join(process.env.AGENT_RUNS_DIR, 'r1', 'artifacts'), { recursive: true })
writeFileSync(join(process.env.AGENT_RUNS_DIR, 'r1', 'artifacts', 'escalated-drafts.json'), JSON.stringify(named(3)))

const sent = []
N.setPoster(async (url, body) => { sent.push({ url, body }) })

let out = await S.runNotifyStep(RUN, { channel: 'reviewers', message: '{count} drafts need review' }, 'escalated-drafts.json')
assert.equal(sent.length, 1, 'it posted')
assert.match(out, /^Posted to "reviewers": 3 drafts need review/, 'the output names the channel and what was said')
assert.match(sent[0].body.text, /DRAFT-1, DRAFT-2, DRAFT-3/, 'the message carries the entry names')
assert.match(sent[0].body.text, /workflows\/scan\?run=r1/, 'and the run link')
assert.equal(sent[0].url, SLACK_URL, 'posted to the stored webhook')

out = await S.runNotifyStep(RUN, { channel: '' }, 'escalated-drafts.json')
assert.match(out, /names no channel/, 'a step with no channel says so')
assert.equal(sent.length, 1, 'and posts nothing')

out = await S.runNotifyStep(RUN, { channel: 'ghosts' }, 'escalated-drafts.json')
assert.match(out, /no channel named "ghosts" is configured/, 'an unconfigured channel is a sentence, not a throw')
assert.match(out, /run still needs attention at https:/, 'and still tells the reader where to go')

N.setPoster(async () => { throw new Error('the webhook answered 500') })
out = await S.runNotifyStep(RUN, { channel: 'reviewers' }, 'escalated-drafts.json')
assert.match(out, /^Could not post to "reviewers": the webhook answered 500/, 'a delivery failure is reported')
assert.match(out, /run still needs attention at https:/, 'with the link the reader now has to act on')

// A malformed artifact must not stop the message: telling somebody with a
// count of zero beats telling nobody because a producer crashed mid-write.
writeFileSync(join(process.env.AGENT_RUNS_DIR, 'r1', 'artifacts', 'broken.json'), '{ not json')
N.setPoster(async (url, body) => { sent.push({ url, body }) })
out = await S.runNotifyStep(RUN, { channel: 'reviewers' }, 'broken.json')
assert.match(out, /^Posted to "reviewers"/, 'an unreadable artifact still sends')

// ── which channel a run's transitions go to ───────────────────────────────
await C.saveChannel('default', { kind: 'slack', url: 'https://hooks.slack.com/services/default' })
await C.saveChannel('per-workflow', { kind: 'slack', url: 'https://hooks.slack.com/services/perwf' })
process.env.SLACK_WEBHOOK_URL = 'https://hooks.example/legacy'

const transition = { ...RUN, status: 'failed', error: 'boom' }
for (const [notifyChannel, expected, why] of [
  ['per-workflow', 'https://hooks.slack.com/services/perwf', "the workflow's own channel wins"],
  [undefined, 'https://hooks.slack.com/services/default', 'then a channel called default'],
]) {
  sent.length = 0
  N._resetNotified()
  await N.notifyRunTransition({ ...transition, notifyChannel })
  assert.equal(sent.length, 1, why)
  assert.equal(sent[0].url, expected, why)
}

// The legacy env webhook keeps working when no channel is configured, so an
// existing deployment needs no migration.
await C.deleteChannel('default')
sent.length = 0
N._resetNotified()
await N.notifyRunTransition({ ...transition })
assert.equal(sent[0].url, 'https://hooks.example/legacy', 'SLACK_WEBHOOK_URL is the last fallback')

// ── email: recipients, the shared relay, and the subject line ─────────────
const mailed = []
N.setMailer(async (smtp, mail) => { mailed.push({ smtp, mail }) })

// A recipient list is not a secret, so it round-trips in the clear.
await C.saveChannel('leads', { kind: 'email', to: 'a@x.com, b@y.com' })
assert.deepEqual((await C.getChannel('leads')).to, ['a@x.com', 'b@y.com'], 'a comma list is split and trimmed')
const pubEmail = (await C.listPublicChannels()).find(c => c.name === 'leads')
assert.equal(pubEmail.hasUrl, false, 'an email channel has no webhook')
assert.equal(pubEmail.host, undefined, 'and no host to show')
assert.deepEqual(pubEmail.to, ['a@x.com', 'b@y.com'], 'the recipients are shown back, unlike a URL')

for (const [to, why] of [
  ['', 'no recipients at all'],
  ['not-an-address', 'a bare word'],
  ['ok@x.com, broken@', 'one bad address among good ones'],
]) {
  await assert.rejects(() => C.saveChannel('leads2', { kind: 'email', to }), `${why} is refused`)
}

// Sending with no relay configured is a sentence, not a crash.
const leads = await C.getChannel('leads')
await assert.rejects(
  () => N.sendToChannel(leads, 'hello'),
  /no SMTP relay is configured/,
  'an email channel with no relay says so',
)

await C.saveSmtp({ host: 'smtp.example.test', port: 587, from: 'bot@example.test', user: 'bot', password: 'hunter2' })
const rawSmtp = readFileSync(process.env.AGENT_CHANNELS_FILE, 'utf8')
assert.ok(!rawSmtp.includes('hunter2'), 'the SMTP password is not stored in the clear')
const pubSmtp = await C.getPublicSmtp()
assert.equal(pubSmtp.password, undefined, 'the public view carries no password')
assert.equal(pubSmtp.hasPassword, true)

await N.sendToChannel(await C.getChannel('leads'), 'Two drafts need a decision.\nDRAFT-1, DRAFT-2\nhttps://run')
assert.equal(mailed.length, 1, 'it sent')
assert.deepEqual(mailed[0].mail.to, ['a@x.com', 'b@y.com'], 'to every recipient')
assert.equal(mailed[0].smtp.password, 'hunter2', 'the relay password is decrypted for the transport')
assert.equal(mailed[0].mail.subject, 'Two drafts need a decision.',
  'the subject is the first line, so two escalations do not look identical in an inbox')
assert.match(mailed[0].mail.text, /DRAFT-1, DRAFT-2/, 'the body carries the detail')

// An empty password on a re-save keeps the stored one, like a webhook URL.
await C.saveSmtp({ host: 'smtp.example.test', port: 2525, from: 'bot@example.test', user: 'bot', password: '' })
mailed.length = 0
await N.sendToChannel(await C.getChannel('leads'), 'x')
assert.equal(mailed[0].smtp.password, 'hunter2', 'a blank password kept the stored one')
assert.equal(mailed[0].smtp.port, 2525, 'while the rest of the relay updated')

for (const [patch, why] of [
  [{ port: 587, from: 'a@b.com' }, 'no host'],
  [{ host: 'h', from: 'a@b.com', port: 0 }, 'a port out of range'],
  [{ host: 'h', port: 587 }, 'no From address'],
]) {
  await assert.rejects(() => C.saveSmtp(patch), `${why} is refused`)
}

// A notify step can address an email channel like any other.
mailed.length = 0
const emailOut = await S.runNotifyStep(RUN, { channel: 'leads', message: '{count} drafts need review' }, 'escalated-drafts.json')
assert.match(emailOut, /^Posted to "leads": 3 drafts need review/, 'the step reports an email send the same way')
assert.equal(mailed.length, 1, 'and the mail went out')

console.log('notify channels: all assertions passed')

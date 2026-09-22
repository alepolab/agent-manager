/**
 * Whatever is attached to a ticket reaches the run that works it.
 *
 * A screenshot on a ticket is often the whole specification — the defect, the
 * layout, the error dialog — and it was unreachable. The issue fetch asked for
 * summary, description and labels, so an agent working a ticket whose
 * description said "see attached" was working from nothing, and nothing said a
 * file had been skipped. Agents have no shell and no Jira access, and Jira's
 * attachment URLs need the same credentials the fetch needed, so the run is the
 * only thing that can bring them down.
 *
 *   node scripts/test-ticket-attachments.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const J = await import('../server/utils/jiraTicketSource.ts')
const env = { JIRA_BASE_URL: 'https://x.invalid', JIRA_EMAIL: 'a@b.c', JIRA_API_TOKEN: 't' }
const dir = mkdtempSync(join(tmpdir(), 'att-'))

const issue = (attachments) => ({
  key: 'SASKNEPCR-22', summary: 'Signup — Manitoba Address Support',
  description: 'See attached.', labels: [], url: 'https://x.invalid/browse/SASKNEPCR-22',
  attachments,
})
const png = { id: '1', filename: 'image-20260921-045555.png', mimeType: 'image/png', size: 214836, content: 'https://x.invalid/att/1' }

// ---- A ticket with no attachments costs nothing -------------------------
{
  const r = await J.downloadAttachments(issue([]), dir, env, async () => { throw new Error('must not fetch') })
  assert.deepEqual(r, { saved: [], failed: [] })
  assert.ok(!J.ticketText(issue([])).includes('Attachments'), 'and the prompt does not mention any')
}

// ---- A screenshot lands where the agent can open it ---------------------
{
  const body = Buffer.from('PNGDATA')
  const r = await J.downloadAttachments(issue([png]), dir, env, async (url, opts) => {
    assert.equal(url, png.content, 'fetched from the URL Jira gave')
    assert.match(opts.headers.Authorization, /^Basic /, 'with the same credentials the issue fetch used')
    return { ok: true, arrayBuffer: async () => body }
  })
  assert.equal(r.saved.length, 1)
  assert.equal(r.failed.length, 0)
  const path = join(dir, J.TICKET_FILES_DIR, png.filename)
  assert.ok(existsSync(path), 'the file is on disk in the run working directory')
  assert.equal(readFileSync(path, 'utf8'), 'PNGDATA', 'byte for byte')
  // Under .agent/, which ensureRunBranch excludes from git — a screenshot must
  // never be committed into the customer's repository by a `git add -A`.
  assert.ok(J.TICKET_FILES_DIR.startsWith('.agent/'), 'kept in the git-excluded scratch area')
}

// ---- The prompt tells the agent the file exists and where ---------------
{
  const text = J.ticketText(issue([png]))
  assert.match(text, /Attachments \(1\)/)
  assert.ok(text.includes(`${J.TICKET_FILES_DIR}/${png.filename}`), 'by path, so it can be opened')
  assert.match(text, /read them before you start/)
  assert.match(text, /image\/png, 210 KB/, 'with enough to know what it is')
}

// ---- One bad file does not lose the others, or the run ------------------
{
  const two = [png, { ...png, id: '2', filename: 'broken.png', content: 'https://x.invalid/att/2' }]
  const r = await J.downloadAttachments(issue(two), dir, env, async (url) =>
    url.endsWith('/2') ? { ok: false, status: 403 } : { ok: true, arrayBuffer: async () => Buffer.from('OK') })
  assert.equal(r.saved.length, 1, 'the readable one is kept')
  assert.equal(r.failed.length, 1, 'and the other is reported, not silently dropped')
  assert.match(r.failed[0].reason, /403/)
}

// ---- A filename from a ticket is untrusted input ------------------------
// It reaches a path join, so a traversal in it would write outside the run.
{
  const nasty = { ...png, filename: '../../../etc/passwd' }
  const r = await J.downloadAttachments(issue([nasty]), dir, env,
    async () => ({ ok: true, arrayBuffer: async () => Buffer.from('x') }))
  assert.equal(r.saved.length, 1)
  // The property that matters is containment, not the absence of dots: a
  // filename with no separators cannot traverse wherever the dots sit.
  assert.ok(!/[/\\]/.test(r.saved[0].filename), 'no separator survives in the name')
  assert.ok(r.saved[0].path.startsWith(join(dir, J.TICKET_FILES_DIR) + '/'),
    'and the file lands inside the run directory')
  assert.ok(!r.saved[0].path.includes('/etc/passwd'), 'nowhere near where it asked to go')
}

// ---- A fetch that throws is a failed file, never a failed run -----------
{
  const r = await J.downloadAttachments(issue([png]), dir, env, async () => { throw new Error('network gone') })
  assert.equal(r.saved.length, 0)
  assert.match(r.failed[0].reason, /network gone/)
}

rmSync(dir, { recursive: true, force: true })
console.log('ticket attachments: every ticket\'s files reach the run, in the git-excluded scratch area, named in the prompt — and one bad file loses neither the others nor the run')

/**
 * Browser smoke test for the "awaiting review" gate: the decision panel on
 * app/pages/runs/[id].vue, and how a run waiting on decisions paints on
 * /runs and on the dashboard.
 *
 * Why this exists: scripts/test-run-decisions.mjs proves the decision mix binds
 * on every step that reads the artifact, and scripts/test-jira-create.mjs
 * proves the drafts become issues. Neither proves a person can see the
 * question. A panel that renders no prompts, a Continue that stays disabled
 * forever, a run that offers a bare "Approve and run" beside the decisions, or
 * a status the history cannot filter for, all pass a fully green data-path
 * suite — and each of them puts the operator back on /review-drafts, which is
 * the thing this replaces.
 *
 * Seeds its CLAUDE_DIR entirely from literals here, like the sibling smokes, so
 * it runs on a fresh checkout.
 *
 *   node e2e/awaiting-review.smoke.mjs
 *
 * Requires Chromium for Playwright:  npx playwright install chromium
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import http from 'node:http'
import { chromium } from 'playwright'

// See workflow-run-panel.smoke.mjs: a no-op when the libraries are installed
// system-wide (and on Windows), so this works either way.
const LOCAL_BROWSER_LIBS = join(homedir(), '.cache', 'agent-manager-browser-libs')
if (existsSync(LOCAL_BROWSER_LIBS)) {
  process.env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH
    ? `${LOCAL_BROWSER_LIBS}:${process.env.LD_LIBRARY_PATH}`
    : LOCAL_BROWSER_LIBS
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const SERVER_READY_TIMEOUT_MS = 120_000
const VISIBLE_TIMEOUT_MS = 30_000

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      srv.close(() => resolve(address.port))
    })
  })
}

/** node:http, not fetch() - see workflow-run-panel.smoke.mjs on the undici
 *  assertion a dev server mid-startup can trip. */
function pingOnce(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { Connection: 'close' } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('ping timed out')))
  })
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastErr
  while (Date.now() < deadline) {
    try {
      if (await pingOnce(url) < 500) return
    } catch (err) { lastErr = err }
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error(`Dev server at ${url} did not respond within ${timeoutMs}ms (last error: ${lastErr?.message ?? 'none'})`)
}

/** nuxt dev forks nitro/vite children; signalling only the top pid orphans them
 *  and leaks the port. POSIX gets the process group, Windows gets taskkill /T. */
async function killServer(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
  await new Promise((resolve) => {
    proc.once('exit', resolve)
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        process.kill(-proc.pid, 'SIGTERM')
      }
    } catch { resolve() }
    setTimeout(resolve, 5000)
  })
}

const SLUG = 'smoke-scan-to-dispatch'
const RUN_ID = '77777777-1111-2222-3333-444444444444'
const ARTIFACT = 'escalated-drafts.json'

const draft = (n, over) => ({
  draft_id: `DRAFT-00${n}`,
  summary: over.summary,
  description: over.description,
  severity: over.severity,
  scan_type: over.scan_type,
  fields: { project: 'SEC', issue_type: over.issue_type, priority: over.priority, component: over.component, labels: ['scan'] },
  acceptance_criteria: over.criteria,
  gate: { verdict: 'escalated', reason: over.reason, decision_prompt: over.prompt, escalation_criteria: [over.criterion] },
})

const DRAFTS = [
  draft(1, {
    summary: 'Validate the payment amount before charging',
    description: 'Bare except blocks in the billing module swallow payment errors, so a negative amount reaches the gateway.',
    severity: 'high', scan_type: 'security', issue_type: 'Bug', priority: 'High', component: 'billing/charge.py',
    criteria: ['A negative amount is rejected before the gateway call'],
    reason: 'blast radius is money - human sign-off required',
    prompt: 'Create a ticket for missing input validation on payment amount in billing/charge.py:67?',
    criterion: 'blast_money',
  }),
  draft(2, {
    summary: 'Rotate session tokens on privilege change',
    description: 'auth/session.py keeps the same token after a role change.',
    severity: 'medium', scan_type: 'security', issue_type: 'Bug', priority: 'Medium', component: 'auth/session.py',
    criteria: ['A role change issues a new token'],
    reason: 'protocol change - needs a decision on the rollout',
    prompt: 'Create a ticket to rotate session tokens on privilege change in auth/session.py:212?',
    criterion: 'blast_protocol',
  }),
  draft(3, {
    summary: 'Drop the unused legacy migration path',
    description: 'db/legacy_migrate.py is dead code scheduled for removal.',
    severity: 'low', scan_type: 'tech-debt', issue_type: 'Task', priority: 'Low', component: 'db/legacy_migrate.py',
    criteria: ['The module is removed and nothing imports it'],
    reason: 'first of its kind for this repo',
    prompt: 'Create a ticket to delete the unused legacy migration path in db/legacy_migrate.py?',
    criterion: 'first_of_kind',
  }),
]

let claudeDir, runsDir, serverProc, browser, serverLog = ''

async function main() {
  // ── 1. Seed a disposable CLAUDE_DIR ─────────────────────────────────────
  claudeDir = mkdtempSync(join(tmpdir(), 'smoke-review-'))
  runsDir = mkdtempSync(join(tmpdir(), 'smoke-review-artifacts-'))
  mkdirSync(join(claudeDir, 'workflows'), { recursive: true })
  mkdirSync(join(claudeDir, 'workflow-runs'), { recursive: true })
  mkdirSync(join(runsDir, RUN_ID, 'artifacts'), { recursive: true })

  // The real scan shape: a gate fanning out to an approval-gated creator and a
  // dispatcher, both consuming the same escalated file. Continuing the run has
  // to find this on disk — rehydrate rebuilds the graph from the definition.
  writeFileSync(join(claudeDir, 'workflows', `${SLUG}.json`), JSON.stringify({
    name: 'Smoke Scan to Dispatch',
    description: 'Seeded by e2e/awaiting-review.smoke.mjs',
    steps: [
      { id: 'g', agentSlug: 'sdlc-decision-gate', label: 'Decision Gate', next: ['esc'] },
      { id: 'esc', agentSlug: 'sdlc-jira-creator', label: 'Create Jira (Escalated)', next: ['disp'], approval: true, runWhen: { artifact: ARTIFACT } },
      { id: 'disp', agentSlug: 'sdlc-auto-dispatcher', label: 'Dispatch Escalated', next: [], runWhen: { artifact: ARTIFACT } },
    ],
    createdAt: new Date().toISOString(),
  }, null, 2))

  writeFileSync(join(runsDir, RUN_ID, 'artifacts', ARTIFACT), JSON.stringify(DRAFTS, null, 2))

  // Written as a literal rather than run for real: reaching this gate honestly
  // costs an agent call per step, and what is under test is the painting and
  // the decision, not the scan. See concurrency-groups.smoke.mjs on why the pid
  // is this process's and bootId is absent — otherwise applyInterrupted reads
  // the seeded run back as `interrupted` and there is no gate to paint.
  const now = Date.now()
  writeFileSync(join(claudeDir, 'workflow-runs', `${RUN_ID}.json`), JSON.stringify({
    id: RUN_ID,
    workflowSlug: SLUG,
    workflowName: 'Smoke Scan to Dispatch',
    status: 'awaiting_review',
    autoRun: true,
    watch: 'direct-invocation',
    initialPrompt: 'SMOKE-REVIEW security scan of the billing service',
    startedAt: now - 600_000,
    startedBy: 'smoke-reviewer',
    pid: process.pid,
    projectDir: join(tmpdir(), 'smoke-review-checkout'),
    currentStepIds: [],
    nextStepIds: ['esc'],
    budget: { maxMinutes: 180, maxTokens: 8_000_000 },
    question: {
      stepId: 'esc',
      kind: 'approval',
      askedAt: now - 60_000,
      text: `Decide which entries of ${ARTIFACT} to act on before "Create Jira (Escalated)" runs`,
      artifact: ARTIFACT,
    },
    steps: [
      { stepId: 'g', label: 'Decision Gate', agentSlug: 'sdlc-decision-gate', status: 'completed', input: 'scan', output: '3 escalated', visits: 1, startedAt: now - 500_000, completedAt: now - 400_000 },
      { stepId: 'esc', label: 'Create Jira (Escalated)', agentSlug: 'sdlc-jira-creator', status: 'pending', input: '', output: '', visits: 0 },
      { stepId: 'disp', label: 'Dispatch Escalated', agentSlug: 'sdlc-auto-dispatcher', status: 'pending', input: '', output: '', visits: 0 },
    ],
  }, null, 2))

  // ── 2. Start the app against it, on a free port ─────────────────────────
  // Never 3030: that is the deployed container this test must not touch.
  const port = await getFreePort()
  serverProc = spawn(process.execPath, [join(repoRoot, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--port', String(port)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CLAUDE_DIR: claudeDir,
      AGENT_RUNS_DIR: runsDir,
      PORT: String(port),
      HOST: '127.0.0.1',
      AUTH_DISABLED: '1',
      SCHEDULER_DISABLED: '1',
      WATCHER_DISABLED: '1',
      CI_POLLER_DISABLED: '1',
      RUN_QUEUE_DISABLED: '1',
      // No ticket may be filed by a smoke test, whatever else is in the
      // environment: creation is gated on this being exactly '1'.
      JIRA_POST_ENABLED: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  serverProc.stdout.on('data', d => { serverLog += d.toString() })
  serverProc.stderr.on('data', d => { serverLog += d.toString() })

  const baseUrl = `http://127.0.0.1:${port}`
  await waitForServer(baseUrl, SERVER_READY_TIMEOUT_MS)

  browser = await chromium.launch()
  const page = await browser.newPage()
  page.setDefaultTimeout(VISIBLE_TIMEOUT_MS)
  const shots = join(repoRoot, 'test-results')
  mkdirSync(shots, { recursive: true })

  // ── 3. /runs paints it as waiting on a person, and can filter for it ────
  await page.goto(`${baseUrl}/runs`, { waitUntil: 'domcontentloaded', timeout: SERVER_READY_TIMEOUT_MS })
  await page.getByText('SMOKE-REVIEW').first().waitFor({ state: 'visible' })
  const runsBody = await page.locator('body').innerText()

  // The status is rendered uppercase everywhere; raw, it arrives as an
  // identifier (AWAITING_REVIEW) rather than a phrase.
  assert.ok(/AWAITING REVIEW/i.test(runsBody),
    `the status reads as words, not as an identifier. Page text:\n${runsBody}`)
  assert.ok(!/AWAITING_REVIEW/.test(runsBody), 'and never with its underscore showing')
  assert.ok(/Waiting on your decisions/i.test(runsBody),
    'the in-flight card says what it is waiting for, and that it is decisions rather than one yes')

  const row = page.locator('tr', { hasText: 'SMOKE-REVIEW' }).first()
  const rowText = await row.innerText()
  assert.ok(/\bStop\b/.test(rowText), `Stop is offered - cancelling is how it is got rid of. Row:\n${rowText}`)
  assert.ok(!/\bDelete\b/.test(rowText),
    `Delete is not: it is live and holds its checkout. Row:\n${rowText}`)
  assert.ok(!/\bRestart\b/.test(rowText),
    `nor Restart: a run awaiting a decision is continued, not restarted. Row:\n${rowText}`)

  await page.screenshot({ path: join(shots, 'awaiting-review-runs-row.png'), fullPage: true })

  // A status you cannot filter for is one you cannot find in a long history.
  await page.goto(`${baseUrl}/runs?status=awaiting_review`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.body.innerText.includes('SMOKE-REVIEW'), null, { timeout: VISIBLE_TIMEOUT_MS })

  // ── 4. The dashboard queues it for attention and refuses to dismiss it ──
  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: SERVER_READY_TIMEOUT_MS })
  await page.getByText('SMOKE-REVIEW').first().waitFor({ state: 'visible' })
  const home = await page.locator('body').innerText()
  assert.ok(new RegExp(`${ARTIFACT}[^\\n]*waiting on your decisions`, 'i').test(home),
    `the attention row says which file is waiting. Page text:\n${home}`)
  const dismissOnRow = page.locator('button[aria-label="Dismiss run"]')
  assert.equal(await dismissOnRow.count(), 0,
    'and offers no Dismiss: there is nothing to acknowledge, the run is going to act as soon as it is answered')

  // ── 5. The panel: every prompt, and no way to approve them wholesale ────
  await page.goto(`${baseUrl}/runs/${RUN_ID}`, { waitUntil: 'domcontentloaded', timeout: SERVER_READY_TIMEOUT_MS })
  const panel = page.locator('[data-testid="run-decision-panel"]')
  await panel.waitFor({ state: 'visible' })
  await page.waitForFunction(
    () => document.querySelector('[data-testid="run-decision-panel"]')?.innerText.includes('billing/charge.py'),
    null, { timeout: VISIBLE_TIMEOUT_MS })
  const panelText = await panel.innerText()

  assert.ok(/Awaiting your decision\s*—\s*3 drafts/i.test(panelText),
    `the panel says how many decisions are waiting. Panel:\n${panelText}`)
  for (const d of DRAFTS) {
    assert.ok(panelText.includes(d.gate.decision_prompt),
      `every escalated draft's own prompt is on the page, not just a count. Missing: ${d.gate.decision_prompt}`)
  }
  assert.ok(panelText.includes(ARTIFACT), 'and the file they came from is named')
  const flat = panelText.replace(/\s+/g, ' ')
  assert.ok(/HIGH \| SECURITY \| BILLING\/CHARGE\.PY/i.test(flat),
    `each draft carries the facets that place it. Panel:\n${panelText}`)
  // Priority is mapped from severity by the drafter, so listing both prints the
  // same word twice and buries the one facet a reviewer can actually change.
  assert.ok(!/HIGH \| SECURITY \| BILLING\/CHARGE\.PY \| HIGH/i.test(flat),
    `and does not repeat the severity back as a priority. Panel:\n${panelText}`)

  // THE ASSERTION THIS FILE EXISTS FOR. The generic banner's "Approve and run"
  // acts on every entry — offering it here would put back the one-button
  // approval this whole state replaces.
  const wholesale = page.getByRole('button', { name: /Approve and run/ })
  assert.equal(await wholesale.count(), 0,
    'the single "Approve and run" button is NOT offered while entries are being decided')

  // Continue cannot fire until every draft has been ruled on: an entry nobody
  // decided is an entry nobody saw.
  const continueBtn = panel.getByRole('button', { name: /^Continue/ })
  assert.ok(await continueBtn.isDisabled(), 'Continue is disabled while any draft is undecided')
  assert.ok(/3 still undecided/.test(panelText), 'and the panel says how many are outstanding')

  // ── 6. Modify opens the draft's own text, not an empty form ────────────
  await panel.getByRole('button', { name: 'Modify' }).first().click()
  const summaryInput = page.locator('#sum-0')
  await summaryInput.waitFor({ state: 'visible' })
  assert.equal(await summaryInput.inputValue(), DRAFTS[0].summary,
    'Modify is seeded with the drafted summary, so a reviewer corrects rather than retypes')
  assert.equal(await page.locator('#pri-0').inputValue(), 'High', 'and the drafted priority')
  assert.equal(await page.locator('#desc-0').inputValue(), DRAFTS[0].description, 'and the drafted body')
  await page.screenshot({ path: join(shots, 'awaiting-review-modify.png'), fullPage: true })
  // Cancelled rather than saved: approving here would run the gated step for
  // real, and what an approved edit does to the artifact is covered by
  // scripts/test-run-decisions.mjs case 4.
  await panel.getByRole('button', { name: 'Cancel' }).click()

  await page.screenshot({ path: join(shots, 'awaiting-review-panel.png'), fullPage: true })

  // ── 7. Skipping everything continues the run and creates nothing ────────
  await panel.getByRole('button', { name: 'Skip all remaining' }).click()
  await page.waitForFunction(
    () => /0 approved, 3 skipped/.test(document.querySelector('[data-testid="run-decision-panel"]')?.innerText ?? ''),
    null, { timeout: VISIBLE_TIMEOUT_MS })

  // The consequence is on the button before it is clicked. "Continue" alone
  // would read as "carry on and file them".
  const finalLabel = await continueBtn.innerText()
  assert.ok(/create nothing/i.test(finalLabel),
    `with nothing approved the button says what continuing will do. Label: ${finalLabel}`)
  assert.ok(!(await continueBtn.isDisabled()), 'and it is now enabled')

  await continueBtn.click()
  await page.waitForFunction(
    () => /COMPLETED/i.test(document.body.innerText),
    null, { timeout: VISIBLE_TIMEOUT_MS })

  // ── 8. What the decision actually did, on disk ──────────────────────────
  const after = JSON.parse(readFileSync(join(runsDir, RUN_ID, 'artifacts', ARTIFACT), 'utf-8'))
  assert.deepEqual(after, [], 'the artifact is emptied: nothing survived the review')

  const record = JSON.parse(readFileSync(join(runsDir, RUN_ID, 'artifacts', 'review-decisions.json'), 'utf-8'))
  assert.equal(record.items.length, 3, 'but the audit keeps every draft that was escalated')
  assert.ok(record.items.every(i => i.decision === 'skipped'), 'each recorded as skipped')
  assert.ok(record.items.every(i => !i.jiraKey), 'and none of them became a ticket')
  assert.ok(!existsSync(join(runsDir, RUN_ID, 'artifacts', 'tickets-created.json')),
    'nothing was filed, so nothing is recorded as filed')

  const settled = JSON.parse(readFileSync(join(claudeDir, 'workflow-runs', `${RUN_ID}.json`), 'utf-8'))
  assert.equal(settled.status, 'completed', 'the run finishes rather than sitting at the gate')
  assert.equal(settled.question, undefined, 'and leaves no question behind')
  const esc = settled.steps.find(s => s.stepId === 'esc')
  const disp = settled.steps.find(s => s.stepId === 'disp')
  // The heart of it, end to end through the browser: approving the step would
  // have waived its runWhen and run it over the file the operator just emptied.
  assert.equal(esc.status, 'skipped', 'approving nothing does not run the gated step')
  assert.ok(new RegExp(ARTIFACT.replace('.', '\\.')).test(esc.skipReason), 'and the reason names the file')
  assert.equal(disp.status, 'skipped', 'nor anything downstream reading the same file')

  await page.screenshot({ path: join(shots, 'awaiting-review-completed.png'), fullPage: true })

  console.log('awaiting review smoke: all assertions passed')
  console.log(`screenshots: ${shots}`)
}

try {
  await main()
} catch (err) {
  console.error(`FAIL: ${err.message}`)
  if (serverLog) console.error(`\n--- dev server log (tail) ---\n${serverLog.slice(-3000)}`)
  process.exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => {})
  await killServer(serverProc)
  if (claudeDir) rmSync(claudeDir, { recursive: true, force: true })
  if (runsDir) rmSync(runsDir, { recursive: true, force: true })
}

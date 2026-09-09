/**
 * Browser smoke test for concurrency groups and the queued run
 * (app/pages/workflows/index.vue's Groups modal, the group picker on
 * app/pages/workflows/[slug].vue, and the queued row on app/pages/runs).
 *
 * Why this exists: scripts/test-workflow-groups.mjs, test-run-queue.mjs and
 * test-workflow-runner.mjs prove the cap admits, queues, drains and never
 * over-subscribes. None of that proves the browser paints any of it. A queued
 * run that renders as "step 1 of 7", a Stop button that never appears on it, a
 * Delete that offers to remove it from under the queue, or a group cap that
 * cannot be typed in at all, all pass a fully green data-path suite.
 *
 * Seeds its CLAUDE_DIR entirely from literals here rather than copying
 * anything out of docker/claude-config/, so it runs on a fresh checkout.
 *
 *   node e2e/concurrency-groups.smoke.mjs
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

const SLUG = 'smoke-grouped-pipeline'
const QUEUED_ID = '99999999-1111-2222-3333-444444444444'
const RUNNING_ID = '88888888-1111-2222-3333-444444444444'

let claudeDir, runsDir, serverProc, browser, serverLog = ''

async function main() {
  // ── 1. Seed a disposable CLAUDE_DIR ─────────────────────────────────────
  claudeDir = mkdtempSync(join(tmpdir(), 'smoke-groups-'))
  runsDir = mkdtempSync(join(tmpdir(), 'smoke-groups-artifacts-'))
  mkdirSync(join(claudeDir, 'workflows'), { recursive: true })
  mkdirSync(join(claudeDir, 'workflow-runs'), { recursive: true })

  writeFileSync(join(claudeDir, 'workflows', `${SLUG}.json`), JSON.stringify({
    name: 'Smoke Grouped Pipeline',
    description: 'Seeded by e2e/concurrency-groups.smoke.mjs',
    group: 'smoke-sdlc',
    steps: [
      { id: 's1', agentSlug: 'sdlc-ticket-intake', label: 'Intake', next: ['s2'] },
      { id: 's2', agentSlug: 'sdlc-fix-implementer', label: 'Fix', next: [] },
    ],
    createdAt: new Date().toISOString(),
  }, null, 2))

  writeFileSync(join(claudeDir, 'workflow-groups.json'), JSON.stringify([
    { id: 'smoke-sdlc', name: 'Smoke SDLC', maxConcurrent: 1 },
  ], null, 2))

  // Two runs written as literals rather than started for real: an agent run
  // needs credentials and minutes, and what is under test here is the painting.
  // The pair is the point - one working run holding the group's single slot,
  // and one queued behind it.
  const runBase = {
    workflowSlug: SLUG,
    workflowName: 'Smoke Grouped Pipeline',
    autoRun: true,
    watch: 'schedule:smoke-nightly',
    group: 'smoke-sdlc',
    projectDir: join(tmpdir(), 'smoke-groups-checkout'),
    currentStepIds: [],
    nextStepIds: [],
    budget: { maxMinutes: 180, maxTokens: 8000000 },
    // THIS process's pid, and no bootId. applyInterrupted rewrites a `running`
    // run whose owner is gone, and it decides that from `bootId !== BOOT_ID` OR
    // a dead pid - so a fixture needs a pid that answers. It cannot be 1: that
    // is the container convention the bootId exists to work around, and on
    // Windows process.kill(1, 0) throws, which read the seeded run back as
    // `interrupted` and made the group look idle. Omitting bootId keeps the
    // first clause false; this test process being alive keeps the second false.
    pid: process.pid,
  }

  writeFileSync(join(claudeDir, 'workflow-runs', `${RUNNING_ID}.json`), JSON.stringify({
    ...runBase,
    id: RUNNING_ID,
    status: 'running',
    initialPrompt: 'SMOKE-1 holding the only slot',
    ticketKey: 'SMOKE-1',
    startedAt: Date.now() - 120_000,
    currentStepIds: ['s1'],
    steps: [
      { stepId: 's1', label: 'Intake', agentSlug: 'sdlc-ticket-intake', status: 'running', input: '', output: '', visits: 1, startedAt: Date.now() - 100_000, lastActivityAt: Date.now() - 5_000 },
      { stepId: 's2', label: 'Fix', agentSlug: 'sdlc-fix-implementer', status: 'pending', input: '', output: '', visits: 0 },
    ],
  }, null, 2))

  writeFileSync(join(claudeDir, 'workflow-runs', `${QUEUED_ID}.json`), JSON.stringify({
    ...runBase,
    id: QUEUED_ID,
    status: 'queued',
    initialPrompt: 'SMOKE-2 waiting for a slot',
    ticketKey: 'SMOKE-2',
    // Its own directory, so nothing about the LOCK is in play here - only the cap.
    projectDir: join(tmpdir(), 'smoke-groups-checkout-2'),
    queuedAt: Date.now() - 600_000,
    startedAt: Date.now() - 600_000,
    steps: [
      { stepId: 's1', label: 'Intake', agentSlug: 'sdlc-ticket-intake', status: 'pending', input: '', output: '', visits: 0 },
      { stepId: 's2', label: 'Fix', agentSlug: 'sdlc-fix-implementer', status: 'pending', input: '', output: '', visits: 0 },
    ],
  }, null, 2))

  // ── 2. Start the app against it, on a free port ─────────────────────────
  // Never 3030: that is the deployed container this test must not touch.
  // RUN_QUEUE_DISABLED, because the seeded queued run would otherwise be
  // launched by the boot sweep and there would be nothing queued left to paint.
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

  // ── 3. The runs page paints the queued run as waiting, not as started ───
  await page.goto(`${baseUrl}/runs`, { waitUntil: 'domcontentloaded', timeout: SERVER_READY_TIMEOUT_MS })
  await page.getByText('SMOKE-2').first().waitFor({ state: 'visible' })
  // The group occupancy arrives from a second request, so wait for it rather
  // than reading the body at the first opportunity - the run list paints first.
  await page.waitForFunction(
    () => /of \d+ running/.test(document.body.innerText),
    null, { timeout: VISIBLE_TIMEOUT_MS })
  const runsBody = await page.locator('body').innerText()

  // THE ASSERTION THIS FILE EXISTS FOR. currentStep() falls through to the
  // first pending step for a run with none running, so without the queued
  // branch the card reads "0/2 steps" over a step name and an agent slug, as
  // though work had begun.
  assert.ok(/Waiting for a slot/i.test(runsBody),
    `the queued run says it is waiting. Page text:\n${runsBody}`)
  assert.ok(runsBody.includes('Smoke SDLC'),
    'and names the group it is waiting on, so "why is my run not starting" has an answer on the page')
  assert.ok(/1 of 1 running/.test(runsBody),
    'with the occupancy that explains it - a cap alone does not')
  // Minutes, not a fixed number: the dev server takes a while to build, so how
  // long the seeded run has "waited" by the time the page paints is not fixed.
  assert.ok(/waiting \d+m/.test(runsBody),
    'and how long it has waited, measured from queuedAt rather than startedAt')
  assert.ok(!/no activity reported yet[\s\S]{0,80}SMOKE-2/.test(runsBody)
    && !/SMOKE-2[\s\S]{0,200}no activity reported yet/.test(runsBody),
    'and does NOT report a stalled agent - it has not called one yet')

  // Both runs are in flight: the section is unfiltered by design, and a queued
  // run belongs in it.
  assert.ok(runsBody.includes('SMOKE-1'), 'the run holding the slot is listed too')
  assert.ok(/in flight\s*\n?\s*2/i.test(runsBody), 'and both count as in flight')

  await page.screenshot({ path: join(shots, 'runs-queued-row.png'), fullPage: true })

  // Stop is offered on the queued run - that is how it is cancelled - and
  // Delete is not, because deleting it from under the queue is not a thing.
  const queuedRow = page.locator('tr', { hasText: 'SMOKE-2' }).first()
  if (await queuedRow.count()) {
    const rowText = await queuedRow.innerText()
    assert.ok(/queued/i.test(rowText), `the history row shows the status. Row:\n${rowText}`)
    // Stop, because cancelling is how a queued run is got rid of; not Delete,
    // which would remove it from under the queue.
    assert.ok(/\bStop\b/.test(rowText), `Stop is offered on a queued run. Row:\n${rowText}`)
    assert.ok(!/\bDelete\b/.test(rowText), `Delete is not. Row:\n${rowText}`)
  }

  // The status filter can select it; a status you cannot filter for is one you
  // cannot find in a long history.
  await page.goto(`${baseUrl}/runs?status=queued`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.body.innerText.includes('SMOKE-2'), null, { timeout: VISIBLE_TIMEOUT_MS })
  const filtered = await page.locator('body').innerText()
  assert.ok(filtered.includes('SMOKE-2'), 'filtering by queued finds it')

  // ── 4. Stopping the queued run cancels it, and then it can be deleted ───
  const stopped = await page.evaluate(async (id) => {
    const res = await fetch(`/api/runs/${id}/stop`, { method: 'POST' })
    return { ok: res.ok, run: await res.json() }
  }, QUEUED_ID)
  assert.ok(stopped.ok, 'a queued run can be stopped')
  assert.equal(stopped.run.status, 'stopped', 'cancelling it records a stop, not a failure')
  assert.ok(stopped.run.steps.every(s => s.status === 'skipped'),
    'and every step it never ran is skipped rather than left pending')

  // No evidence bundle for a run that did nothing: publish() gates finalizing
  // on some step having actually run.
  assert.ok(!existsSync(join(runsDir, QUEUED_ID, 'artifacts', 'bundle.md')),
    'no evidence bundle is assembled for a run that never started')

  const deleted = await page.evaluate(async (id) => {
    const res = await fetch(`/api/runs/${id}`, { method: 'DELETE' })
    return res.status
  }, QUEUED_ID)
  assert.equal(deleted, 200, 'and once stopped it can be deleted')

  // ── 5. The Groups modal reads and writes the registry ───────────────────
  await page.goto(`${baseUrl}/workflows`, { waitUntil: 'domcontentloaded', timeout: SERVER_READY_TIMEOUT_MS })
  await page.getByRole('button', { name: 'Groups' }).click()
  await page.getByText('Concurrency groups').first().waitFor({ state: 'visible' })
  const modalBody = await page.locator('body').innerText()
  // The name is an input VALUE, which innerText never contains - a row that
  // rendered empty would pass a body-text check.
  assert.equal(await page.getByLabel('Group 1 name').inputValue(), 'Smoke SDLC',
    `the seeded group is listed and editable. Page text:\n${modalBody}`)
  assert.equal(await page.getByLabel('Group 1 concurrent runs').inputValue(), '1',
    'with the cap it was saved with')
  // Numbers, not fixed ones: by this point the test has cancelled the queued
  // run, so what is waiting is 0. That the occupancy is SHOWN is the point.
  assert.ok(/\d+ running, \d+ waiting/.test(modalBody),
    'and what that group is doing right now, which is the question a cap raises')
  assert.ok(/Ungrouped workflows share the default group/.test(modalBody),
    'and the default group is shown, since that is where an ungrouped workflow\'s runs count')

  await page.screenshot({ path: join(shots, 'workflow-groups-modal.png'), fullPage: true })

  // Change the cap and save. The point is that the file changes: a modal that
  // renders and does not persist is the failure mode a data-path test misses.
  await page.getByLabel('Group 1 concurrent runs').fill('3')
  await page.getByRole('button', { name: 'Save groups' }).click()
  await page.waitForFunction(
    () => !document.body.innerText.includes('Concurrency groups'),
    null, { timeout: VISIBLE_TIMEOUT_MS })
  const savedGroups = JSON.parse(readFileSync(join(claudeDir, 'workflow-groups.json'), 'utf-8'))
  assert.deepEqual(savedGroups, [{ id: 'smoke-sdlc', name: 'Smoke SDLC', maxConcurrent: 3 }],
    'the edited cap reached the file, with the id unchanged so the workflow is still a member')

  // A cap of zero is refused rather than saved: it would mean "this group
  // never runs again", with no symptom but work silently not happening.
  const refused = await page.evaluate(async () => {
    const res = await fetch('/api/workflow-groups', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groups: [{ id: 'smoke-sdlc', name: 'Smoke SDLC', maxConcurrent: 0 }] }),
    })
    return res.status
  })
  assert.equal(refused, 400, 'a cap of 0 is refused')
  assert.equal(JSON.parse(readFileSync(join(claudeDir, 'workflow-groups.json'), 'utf-8'))[0].maxConcurrent, 3,
    'and the file is untouched by the refusal')

  // ── 6. The workflow editor shows and saves its group ────────────────────
  await page.goto(`${baseUrl}/workflows/${SLUG}`, { waitUntil: 'domcontentloaded', timeout: SERVER_READY_TIMEOUT_MS })
  const picker = page.getByLabel('Concurrency group')
  await picker.waitFor({ state: 'visible' })
  assert.equal(await picker.inputValue(), 'smoke-sdlc',
    'the editor shows the group the workflow is actually in')

  await picker.selectOption('')
  await page.getByRole('button', { name: 'Save' }).first().click()
  await page.waitForFunction(
    () => document.body.innerText.includes('Workflow saved'),
    null, { timeout: VISIBLE_TIMEOUT_MS })
  const savedWorkflow = JSON.parse(readFileSync(join(claudeDir, 'workflows', `${SLUG}.json`), 'utf-8'))
  assert.equal(savedWorkflow.group, '',
    'THE ONE A SHALLOW MERGE BREAKS: clearing the group sends an empty string, so the stored value is replaced rather than kept')
  await page.screenshot({ path: join(shots, 'workflow-group-picker.png'), fullPage: true })

  console.log('concurrency groups smoke: all assertions passed')
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

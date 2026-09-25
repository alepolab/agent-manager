/**
 * Browser smoke test for /notifications: every run gate waiting on a person is
 * listed in one place, with what it is asking, and can be decided from the
 * pane beside the list without opening the run.
 *
 * Why this exists: scripts/test-notifications.mjs pins which items the inbox
 * lists and in what order. It cannot prove the page shows them, that the
 * sidebar badge counts them, or that a decision taken in the pane lands on the
 * run and takes the item off the list.
 *
 * Seeds its CLAUDE_DIR from literals, like the sibling smokes. Chat permission
 * prompts are not seeded: they exist only inside a live SDK query, which a
 * smoke cannot raise without calling a model.
 *
 *   node e2e/notifications.smoke.mjs
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

const SLUG = 'smoke-notifications'
const GATE = '88888888-1111-2222-3333-444444444444'
const QUESTION = '88888888-5555-6666-7777-888888888888'

let claudeDir, runsDir, serverProc, browser, serverLog = ''

function seedRun(id, over) {
  const now = Date.now()
  writeFileSync(join(claudeDir, 'workflow-runs', `${id}.json`), JSON.stringify({
    id,
    workflowSlug: SLUG,
    workflowName: 'Smoke Notifications',
    autoRun: true,
    watch: 'direct-invocation',
    startedAt: now - 3_600_000,
    startedBy: 'smoke-dev',
    // See concurrency-groups.smoke.mjs: this pid, no bootId, or the run reads back as interrupted.
    pid: process.pid,
    projectDir: join(tmpdir(), 'smoke-notifications-checkout'),
    currentStepIds: [],
    nextStepIds: ['ship'],
    budget: { maxMinutes: 180, maxTokens: 8_000_000 },
    steps: [
      { stepId: 'plan', label: 'Plan', agentSlug: 'sdlc-ce-plan', status: 'completed', input: 'x', output: 'plan written', visits: 1, startedAt: now - 3_000_000, completedAt: now - 2_900_000 },
      { stepId: 'ship', label: 'Push + PR', agentSlug: 'sdlc-ce-ship', status: 'pending', input: '', output: '', visits: 0 },
    ],
    ...over,
  }, null, 2))
}

async function main() {
  claudeDir = mkdtempSync(join(tmpdir(), 'smoke-notif-'))
  runsDir = mkdtempSync(join(tmpdir(), 'smoke-notif-artifacts-'))
  mkdirSync(join(claudeDir, 'workflows'), { recursive: true })
  mkdirSync(join(claudeDir, 'workflow-runs'), { recursive: true })
  writeFileSync(join(claudeDir, 'workflows', `${SLUG}.json`), JSON.stringify({
    name: 'Smoke Notifications',
    steps: [
      { id: 'plan', agentSlug: 'sdlc-ce-plan', label: 'Plan', next: ['ship'] },
      { id: 'ship', agentSlug: 'sdlc-ce-ship', label: 'Push + PR', next: [], approval: true },
    ],
    createdAt: new Date().toISOString(),
  }, null, 2))

  const now = Date.now()
  // An approval gate, waiting two hours.
  seedRun(GATE, {
    status: 'paused',
    ticketKey: 'SMOKE-101',
    initialPrompt: 'SMOKE-101 Fix the login redirect\n\nUsers land on /404 after signing in with SSO.',
    question: { stepId: 'ship', kind: 'approval', askedAt: now - 2 * 3_600_000, text: 'Approve pushing the fix for SMOKE-101 and opening the PR?' },
  })
  // A step's own question, waiting ten minutes.
  seedRun(QUESTION, {
    status: 'paused',
    ticketKey: 'SMOKE-202',
    initialPrompt: 'SMOKE-202 Add CSV export',
    question: { stepId: 'plan', kind: 'question', askedAt: now - 600_000, text: 'Should the export include archived rows?' },
  })
  // Settled runs that must not appear.
  seedRun('88888888-9999-0000-1111-222222222222', { status: 'failed', ticketKey: 'SMOKE-303', initialPrompt: 'SMOKE-303 failed run', error: 'boom' })

  // Never 3030: that is the instance this test must not touch.
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.tracing.start({ screenshots: true, snapshots: true })
  const page = await context.newPage()
  page.setDefaultTimeout(VISIBLE_TIMEOUT_MS)
  const shots = join(repoRoot, 'test-results')
  mkdirSync(shots, { recursive: true })

  try {
    // ── 1. The API lists the two gates and nothing settled ──────────────────
    const api = await (await page.request.get(`${baseUrl}/api/notifications`)).json()
    assert.deepEqual(api.items.map(i => i.runId), [GATE, QUESTION],
      `both gates, longest wait first, and not the failed run. Got:\n${JSON.stringify(api.items, null, 2)}`)

    // ── 2. The sidebar offers it, with the count ────────────────────────────
    await page.goto(`${baseUrl}/notifications`, { waitUntil: 'domcontentloaded', timeout: SERVER_READY_TIMEOUT_MS })
    const navLink = page.locator('nav a[href="/notifications"], aside a[href="/notifications"]').first()
    await navLink.waitFor({ state: 'visible' })
    await page.waitForFunction(() => {
      const a = document.querySelector('a[href="/notifications"]')
      return a && /Notifications\s*2$/.test((a.textContent ?? '').trim())
    }, null, { timeout: VISIBLE_TIMEOUT_MS })

    // ── 3. The list says what each one is asking ────────────────────────────
    await page.getByText('SMOKE-101').first().waitFor({ state: 'visible' })
    const listText = await page.locator('ul.attn-list').innerText()
    assert.ok(listText.includes('Approve pushing the fix for SMOKE-101'), `the gate's own question is on the row. List:\n${listText}`)
    assert.ok(listText.includes('Should the export include archived rows?'), 'and the step\'s question')
    assert.ok(!listText.includes('SMOKE-303'), 'a failed run is not a decision')

    // ── 4. The first one opens with its context and its controls ────────────
    await page.waitForFunction(() => new URL(location.href).searchParams.get('item') !== null, null, { timeout: VISIBLE_TIMEOUT_MS })
    assert.equal(new URL(page.url()).searchParams.get('item'), `run:${GATE}`, 'the longest-waiting gate is opened first')
    await page.getByRole('button', { name: /Approve and run/ }).waitFor({ state: 'visible' })
    const pane = await page.locator('body').innerText()
    assert.ok(/Smoke Notifications/.test(pane) && /started by smoke-dev/.test(pane), 'the pane says which workflow and who started it')
    await page.getByRole('button', { name: /what this run was asked to do/ }).click()
    await page.getByText('Users land on /404 after signing in with SSO.').waitFor({ state: 'visible' })
    await page.screenshot({ path: join(shots, 'notifications-gate.png'), fullPage: true })

    // ── 5. Deciding it in the pane lands on the run and moves on ────────────
    await page.getByPlaceholder(/Optional note for the step about to run/).fill('Out of scope for this sprint')
    // A decision can take a while to act on, and the pane used to show nothing
    // meanwhile. The request is held back here so that interval is observable.
    await page.route('**/api/runs/*/reject', async (route) => { await new Promise(r => setTimeout(r, 1500)); await route.continue() })
    await page.getByRole('button', { name: 'Reject run' }).click()
    await page.getByRole('status').filter({ hasText: 'Rejection recorded' }).waitFor({ state: 'visible' })
    assert.ok(await page.getByRole('button', { name: /Approve and run/ }).isDisabled(), 'no second decision while the first is in flight')
    await page.screenshot({ path: join(shots, 'notifications-sending.png'), fullPage: true })
    await page.waitForFunction((q) => new URL(location.href).searchParams.get('item') === `run:${q}`, QUESTION, { timeout: VISIBLE_TIMEOUT_MS })
    const rejected = JSON.parse(readFileSync(join(claudeDir, 'workflow-runs', `${GATE}.json`), 'utf-8'))
    assert.notEqual(rejected.status, 'paused', 'the rejection reached the run')
    assert.ok(rejected.decisions?.some(d => d.verdict === 'rejected' && d.note === 'Out of scope for this sprint'), 'with the reason on the record')
    await page.waitForFunction(() => !document.querySelector('ul.attn-list')?.textContent?.includes('SMOKE-101'), null, { timeout: VISIBLE_TIMEOUT_MS })

    // The question pane offers a reply box, not an approval.
    await page.getByPlaceholder('Your answer to the agent').waitFor({ state: 'visible' })
    await page.screenshot({ path: join(shots, 'notifications-question.png'), fullPage: true })

    // ── 6. A link to a decision already taken says so ───────────────────────
    await page.goto(`${baseUrl}/notifications?item=run:${GATE}`, { waitUntil: 'domcontentloaded' })
    await page.getByText('No longer waiting').waitFor({ state: 'visible' })
  } catch (err) {
    // Where it stopped, not just that it did: a bare timeout names no step.
    await page.screenshot({ path: join(shots, 'notifications-failure.png'), fullPage: true }).catch(() => {})
    err.message += `\nat ${page.url()}\n--- page text ---\n${(await page.locator('body').innerText().catch(() => '')).slice(0, 2000)}`
    throw err
  } finally {
    await context.tracing.stop({ path: join(shots, 'notifications-trace.zip') })
  }

  console.log('notifications smoke: all assertions passed')
  console.log(`screenshots and trace: ${shots}`)
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

/**
 * Browser smoke test for workflow inputs and the Schedules page
 * (app/pages/schedules.vue, app/components/WorkflowRunModal.vue,
 * app/pages/workflows/[slug].vue's Inputs editor, app/composables/useSchedules.ts).
 *
 * Why this exists: scripts/test-workflow-parameters.mjs, test-run-parameters.mjs and
 * test-schedule-runner.mjs prove the server resolves parameters, states them to every
 * step, and fires schedules correctly. None of that proves the browser paints any of
 * it - a v-if that hides every declared field, a disabled Start button that never
 * re-enables, a page that throws on a null `state`, all pass a fully green data-path
 * suite.
 *
 * Unlike workflow-run-panel.smoke.mjs, this seeds its CLAUDE_DIR entirely from
 * literals here rather than copying a definition out of docker/claude-config/, which
 * is not in the repository - so this runs on a fresh checkout.
 *
 *   node e2e/schedules-and-parameters.smoke.mjs
 *
 * Requires Chromium for Playwright:  npx playwright install chromium
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
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

const SLUG = 'smoke-security-scan'
let claudeDir, serverProc, browser, serverLog = ''

async function main() {
  // ── 1. Seed a disposable CLAUDE_DIR ─────────────────────────────────────
  claudeDir = mkdtempSync(join(tmpdir(), 'smoke-params-'))
  mkdirSync(join(claudeDir, 'workflows'), { recursive: true })
  mkdirSync(join(claudeDir, 'schedule-state'), { recursive: true })

  writeFileSync(join(claudeDir, 'workflows', `${SLUG}.json`), JSON.stringify({
    name: 'Smoke Security Scan',
    description: 'Seeded by e2e/schedules-and-parameters.smoke.mjs',
    parameters: [
      { name: 'projectDir', required: true, description: 'Repository to scan' },
      { name: 'jira_project', description: 'Where tickets are filed', default: 'DEVOPS' },
    ],
    steps: [{ id: 's1', agentSlug: 'sdlc-scanner-security', label: 'Scan', next: [] }],
    createdAt: new Date().toISOString(),
  }, null, 2))

  // Disabled on purpose: an enabled '* * * * *' would start a real agent run
  // mid-test. The page must render an unfired, disabled schedule correctly, and
  // that is also the state every newly created schedule is in.
  writeFileSync(join(claudeDir, 'schedules.json'), JSON.stringify([{
    id: 'seeded-nightly',
    name: 'Seeded Nightly Scan',
    workflowSlug: SLUG,
    cron: '0 2 * * *',
    timezone: 'Asia/Kolkata',
    enabled: false,
    initialPrompt: 'Scan for OWASP issues',
    parameters: { jira_project: 'DEVOPS' },
    autoRun: true,
    createdBy: 'local',
  }], null, 2))

  writeFileSync(join(claudeDir, 'schedule-state', 'seeded-nightly.json'), JSON.stringify({
    lastOutcome: 'skipped',
    lastDetail: 'a run started earlier is still working in that directory',
    lastRunId: '11111111-2222-3333-4444-555555555555',
    lastFiredAt: Date.now() - 3_600_000,
  }, null, 2))

  // ── 2. Start the app against it, on a free port ─────────────────────────
  // Never 3030: that is the deployed container this test must not touch.
  const port = await getFreePort()
  serverProc = spawn(process.execPath, [join(repoRoot, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--port', String(port)], {
    cwd: repoRoot,
    env: { ...process.env, CLAUDE_DIR: claudeDir, PORT: String(port), HOST: '127.0.0.1', AUTH_DISABLED: '1' },
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

  // ── 3. The Schedules page paints the seeded schedule ────────────────────
  await page.goto(`${baseUrl}/schedules`, { waitUntil: 'domcontentloaded', timeout: SERVER_READY_TIMEOUT_MS })

  await page.getByText('Seeded Nightly Scan').first().waitFor({ state: 'visible' })
  const body = await page.locator('body').innerText()

  // The expression and its zone, because an operator has to be able to read
  // back what they typed.
  assert.ok(body.includes('0 2 * * *'), `the cron expression is shown. Page text:\n${body}`)
  assert.ok(body.includes('Asia/Kolkata'), 'the timezone is shown - the same pattern in another zone fires at another time')
  // The workflow's NAME, not its slug: the slug is an implementation detail.
  assert.ok(body.includes('Smoke Security Scan'), 'the workflow it runs is named')
  // The stated inputs, so a reader can see what it will run with.
  assert.ok(/jira_project/.test(body), 'the stated parameters are shown')
  // The last outcome, and the reason - a skip that shows no reason is a mystery.
  assert.ok(body.includes('skipped'), 'the last outcome is shown')
  assert.ok(body.includes('still working in that directory'), 'with the detail behind it')
  assert.ok(body.includes('disabled'), 'a disabled schedule says so rather than showing a next fire')

  await page.getByRole('button', { name: 'Run now' }).first().waitFor({ state: 'visible' })
  await page.locator('a[href="/runs/11111111-2222-3333-4444-555555555555"]').first().waitFor({ state: 'attached' })
  await page.screenshot({ path: join(shots, 'schedules-page.png'), fullPage: true })

  // ── 3b. Enabling it makes the page show a real next fire ────────────────
  // The label, not the input: field-toggle hides the checkbox behind its track
  // and thumb, so clicking the label is both what a person does and the only
  // thing Playwright can see.
  await page.locator('label.field-toggle').first().click()
  // The round trip goes through POST /api/schedules and a refetch, so the row
  // only gains a next fire once the server has actually stored `enabled`.
  await page.getByText(/^next \S/).first().waitFor({ state: 'visible' })
  const enabledRow = await page.locator('[class*="rounded-lg"]').filter({ hasText: 'Seeded Nightly Scan' }).first().innerText()
  assert.ok(!enabledRow.includes('disabled'),
    `once enabled the row shows its next fire instead of reading "disabled". Row:\n${enabledRow}`)
  await page.screenshot({ path: join(shots, 'schedules-enabled.png'), fullPage: true })

  // ── 4. The workflow's Inputs editor ─────────────────────────────────────
  await page.goto(`${baseUrl}/workflows/${SLUG}`, { waitUntil: 'domcontentloaded', timeout: SERVER_READY_TIMEOUT_MS })

  // The count is the point: it tells you at a glance that this workflow needs
  // something stated, without opening anything.
  const inputsButton = page.getByRole('button', { name: /Inputs \(2\)/ })
  await inputsButton.waitFor({ state: 'visible' })
  await inputsButton.click()

  await page.getByText('Workflow inputs').first().waitFor({ state: 'visible' })
  const editor = await page.evaluate(() => document.documentElement.innerText)
  assert.ok(editor.includes('Reserved name'),
    'the reserved projectDir name explains itself in the editor, or nobody can know it binds')
  const names = await page.locator('input[placeholder^="name, e.g."]').evaluateAll(
    els => els.map(e => e.value))
  assert.deepEqual(names, ['projectDir', 'jira_project'],
    'both declared inputs are loaded into the editor in order')
  await page.screenshot({ path: join(shots, 'workflow-inputs-editor.png'), fullPage: true })

  // A new row is addable - the editor is not read-only.
  await page.getByRole('button', { name: 'Add input' }).click()
  const afterAdd = await page.locator('input[placeholder^="name, e.g."]').count()
  assert.equal(afterAdd, 3, 'Add input appends an editable row')
  await page.keyboard.press('Escape')

  // ── 5. The run modal collects the declared inputs ───────────────────────
  // The toolbar button, not ?start=1: that query intent is consumed by a
  // router.replace() in the same tick it opens the modal, so asserting against
  // it races the teardown. The button is what a person clicks anyway.
  await page.goto(`${baseUrl}/workflows/${SLUG}`, { waitUntil: 'domcontentloaded', timeout: SERVER_READY_TIMEOUT_MS })
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await page.getByText('Initial prompt').first().waitFor({ state: 'visible' })

  // textContent, not innerText: a UModal renders into a portal and innerText
  // comes back empty for it, so read the DOM text directly.
  const modal = await page.evaluate(() => document.documentElement.textContent)
  assert.ok(modal.includes('jira_project'), `the modal collects each declared input by name. Modal text:
${modal}`)
  assert.ok(modal.includes('projectDir'), 'including the reserved one')
  // The reserved parameter REPLACES the folder field rather than sitting beside
  // it: two inputs for one directory is the contradiction it exists to remove.
  assert.ok(!modal.includes('Project folder'),
    'a declared projectDir replaces the generic Project folder field, it does not duplicate it')

  const start = page.getByRole('button', { name: 'Start' })
  await start.waitFor({ state: 'visible' })

  // jira_project is prefilled from its declared default.
  const prefilled = await page.locator('input').evaluateAll(els => els.map(e => e.value))
  assert.ok(prefilled.includes('DEVOPS'), `jira_project is prefilled from its default. Values: ${JSON.stringify(prefilled)}`)

  // The prompt is filled FIRST, deliberately. Start is disabled on an empty
  // prompt too, so asserting against a blank form would pass whether or not the
  // required parameter gates anything - the assertion has to isolate the
  // parameter as the only thing still missing.
  await page.locator('textarea').first().fill('Scan the seeded repository')
  assert.equal(await start.isDisabled(), true,
    'with the prompt filled and only the required input missing, Start is still refused - '
    + 'the 400 is prevented in the UI, not merely reported by the server')
  await page.screenshot({ path: join(shots, 'run-modal-required-empty.png'), fullPage: true })

  // Stating it is the only remaining change, so Start becoming available proves
  // the required input was what held it.
  await page.locator('input[placeholder="/Users/you/projects/my-app"]').first().fill('/tmp/smoke-target')
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Start')
    return b && !b.disabled
  }, null, { timeout: VISIBLE_TIMEOUT_MS })
  assert.equal(await start.isDisabled(), false, 'stating the required input enables Start')
  await page.screenshot({ path: join(shots, 'run-modal-ready.png'), fullPage: true })

  console.log('schedules + parameters smoke: all assertions passed')
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
}

/**
 * Browser smoke test for the stack builder on `app/pages/workflows/[slug].vue`
 * (`app/components/WorkflowStackEditor.vue`, `BuildStackBlocks.vue`,
 * `BuildStackCard.vue`, `ActionPicker.vue`, `shared/utils/stackEdit.ts`).
 *
 * Why this exists: scripts/test-*.mjs prove `stackEdit.ts` and `workflowStack.ts`
 * transform a graph correctly in isolation. None of that proves a person can
 * actually split a linear workflow into paths through the browser and have the
 * result land on disk in the shape the graph expects - a "+" that opens nothing,
 * a picker that cannot find an agent, a checkbox that silently reverts a save
 * rather than refusing it, all pass a fully green data-path suite.
 *
 * Seeds its CLAUDE_DIR entirely from literals here, like the sibling smokes, so
 * it runs on a fresh checkout.
 *
 *   node e2e/workflow-builder.smoke.mjs
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

const SLUG = 'smoke-builder-linear'
const AGENT_SLUG = 'smoke-builder-agent'

let claudeDir, serverProc, browser, serverLog = ''

async function main() {
  // ── 1. Seed a disposable CLAUDE_DIR ─────────────────────────────────────
  claudeDir = mkdtempSync(join(tmpdir(), 'smoke-builder-'))
  mkdirSync(join(claudeDir, 'workflows'), { recursive: true })
  mkdirSync(join(claudeDir, 'agents'), { recursive: true })

  writeFileSync(join(claudeDir, 'agents', `${AGENT_SLUG}.md`), [
    '---',
    `name: ${AGENT_SLUG}`,
    'description: A stand-in agent used only by e2e/workflow-builder.smoke.mjs.',
    'model: sonnet',
    'color: blue',
    '---',
    '',
    'Do nothing. This agent is never actually run by the smoke.',
    '',
  ].join('\n'))

  // A three-step linear workflow, a -> b -> c, none of them agents that need
  // to exist for real - this workflow is never run, only edited and saved.
  writeFileSync(join(claudeDir, 'workflows', `${SLUG}.json`), JSON.stringify({
    name: 'Smoke Builder Linear',
    description: 'Seeded by e2e/workflow-builder.smoke.mjs',
    steps: [
      { id: 'a', agentSlug: 'stub-agent-a', label: 'Step A', next: ['b'] },
      { id: 'b', agentSlug: 'stub-agent-b', label: 'Step B', next: ['c'] },
      { id: 'c', agentSlug: 'stub-agent-c', label: 'Step C', next: [] },
    ],
    createdAt: new Date().toISOString(),
  }, null, 2))

  // ── 2. Start the app against it, on a free port ─────────────────────────
  // Never 3030: that is the deployed container this test must not touch.
  const port = await getFreePort()
  serverProc = spawn(process.execPath, [join(repoRoot, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--port', String(port)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CLAUDE_DIR: claudeDir,
      PORT: String(port),
      HOST: '127.0.0.1',
      AUTH_DISABLED: '1',
      SCHEDULER_DISABLED: '1',
      WATCHER_DISABLED: '1',
      CI_POLLER_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  serverProc.stdout.on('data', d => { serverLog += d.toString() })
  serverProc.stderr.on('data', d => { serverLog += d.toString() })

  const baseUrl = `http://127.0.0.1:${port}`
  await waitForServer(baseUrl, SERVER_READY_TIMEOUT_MS)

  browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  const page = await ctx.newPage()
  page.setDefaultTimeout(VISIBLE_TIMEOUT_MS)
  const shots = join(repoRoot, 'test-results')
  mkdirSync(shots, { recursive: true })

  /** The host's docker bridges churn, and Chromium aborts module loads with
   *  ERR_NETWORK_CHANGED when they do; retry a load until the trigger card
   *  mounts, borrowed from the same retry used to check this page in Task 5. */
  async function load(url) {
    for (let i = 0; i < 6; i++) {
      try {
        if (url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: SERVER_READY_TIMEOUT_MS })
        else await page.reload({ waitUntil: 'domcontentloaded', timeout: SERVER_READY_TIMEOUT_MS })
        await page.getByTestId('trigger-card').waitFor({ timeout: 20_000 })
        return
      } catch (e) { if (i === 5) throw e; await new Promise(r => setTimeout(r, 3000)) }
    }
  }

  const plus = () => page.getByRole('button', { name: 'Add a step here' })
  const readWf = () => JSON.parse(readFileSync(join(claudeDir, 'workflows', `${SLUG}.json`), 'utf8'))

  /** ActionPicker's popover content (reka-ui) stays mounted through its exit
   *  transition after `choose()` flips `open` to false, so a `role="menuitem"`
   *  query made right after picking one thing can still match the closing
   *  popover as well as the next one that opens - wait for every popover's
   *  `role="menu"` to actually leave the DOM before opening another. */
  async function waitForNoOpenMenu() {
    await page.waitForFunction(() => document.querySelectorAll('[role="menu"]').length === 0,
      null, { timeout: VISIBLE_TIMEOUT_MS })
  }

  // ── 3. Three step cards render ───────────────────────────────────────────
  await load(`${baseUrl}/workflows/${SLUG}`)
  await page.locator('article[data-step="a"]').waitFor()
  const initialCards = page.locator('article[data-step]')
  assert.equal(await initialCards.count(), 3, 'the linear workflow renders one card per step')
  assert.match(await page.locator('article[data-step="a"]').innerText(), /Step A/)
  assert.match(await page.locator('article[data-step="b"]').innerText(), /Step B/)
  assert.match(await page.locator('article[data-step="c"]').innerText(), /Step C/)
  await page.screenshot({ path: join(shots, 'builder-01-linear.png'), fullPage: true })

  // ── 4. Split after a, add the agent into both branches, drop b ──────────
  // plus().nth(0) sits before "a" (no split offered there - a split needs a
  // step before it); nth(1) sits between "a" and "b", which is "split after a".
  await plus().nth(1).click()
  await page.getByRole('menuitem', { name: 'Split into paths' }).click()
  await waitForNoOpenMenu()
  const pathsGroup = page.locator('[role=group][aria-label^="Paths"]')
  await pathsGroup.waitFor()
  assert.equal(await pathsGroup.getByRole('button', { name: /^Remove path/ }).count(), 2,
    'splitting opens exactly two empty branches')

  // Branch 1 (first, while both are still empty, is unambiguous).
  await pathsGroup.getByRole('button', { name: 'Add a step here' }).first().click()
  await page.getByRole('menuitem', { name: 'Run an agent' }).click()
  await page.getByLabel('Find an agent').fill('smoke-builder')
  await page.getByRole('menuitem', { name: new RegExp(AGENT_SLUG) }).click()
  await waitForNoOpenMenu()

  // Branch 2's "+" is now whichever one is still inside an otherwise-empty
  // branch - it is the LAST "Add a step here" in the group once branch 1 has
  // a card and its own two "+" (one before the card, one trailing).
  await pathsGroup.getByRole('button', { name: 'Add a step here' }).last().click()
  await page.getByRole('menuitem', { name: 'Run an agent' }).click()
  await page.getByLabel('Find an agent').fill('smoke-builder')
  await page.getByRole('menuitem', { name: new RegExp(AGENT_SLUG) }).click()
  await waitForNoOpenMenu()

  const branchAgentCards = pathsGroup.locator(`article[data-step]`, { hasText: AGENT_SLUG })
  assert.equal(await branchAgentCards.count(), 2, 'the agent was added into both branches')

  // "b" still sits at the top level, right after the paths block - delete it
  // (the alternative to dragging it into a branch: two clicks, arm then confirm).
  const delB = page.getByRole('button', { name: 'Delete Step B' })
  await delB.click()
  await delB.click()
  await page.locator('article[data-step="b"]').waitFor({ state: 'detached' })
  await page.screenshot({ path: join(shots, 'builder-02-split-and-branches.png'), fullPage: true })

  // ── 5. Save, then the file on disk has the shape the graph expects ──────
  const save = page.getByRole('button', { name: 'Save', exact: true })
  assert.equal(await save.isDisabled(), false, 'Save is enabled once the stack is dirty')
  await save.click()
  await page.getByText('Workflow saved').first().waitFor()

  const afterSave = readWf()
  const stepA = afterSave.steps.find(s => s.id === 'a')
  const stepC = afterSave.steps.find(s => s.id === 'c')
  assert.ok(stepA, '"a" survives the edit')
  assert.ok(stepC, '"c" survives the edit')
  assert.ok(!afterSave.steps.some(s => s.id === 'b'), '"b" was actually removed, not merely hidden')
  assert.equal(stepA.next.length, 2, 'a.next carries both branch heads')
  const branchSteps = afterSave.steps.filter(s => stepA.next.includes(s.id))
  assert.equal(branchSteps.length, 2, 'both of a.next resolve to real steps')
  for (const s of branchSteps) {
    assert.equal(s.agentSlug, AGENT_SLUG, `branch step ${s.id} is the agent that was added`)
    assert.deepEqual(s.next, [stepC.id], `branch step ${s.id}'s next points at c`)
  }
  assert.deepEqual(stepC.next, [], 'c.next is empty - nothing follows it')

  // ── 6. Reload: the paths block with two branches renders ────────────────
  await load(`${baseUrl}/workflows/${SLUG}`)
  await page.locator('article[data-step="a"]').waitFor()
  const reloadedGroup = page.locator('[role=group][aria-label^="Paths"]')
  await reloadedGroup.waitFor()
  assert.equal(await reloadedGroup.getByRole('button', { name: /^Remove path/ }).count(), 2,
    'the reloaded stack still shows exactly two branches')
  assert.equal(await reloadedGroup.locator('article[data-step]', { hasText: AGENT_SLUG }).count(), 2,
    'both branch cards survive the reload')
  await page.screenshot({ path: join(shots, 'builder-03-reloaded.png'), fullPage: true })

  // ── 7. Unticking "Rejoin after paths" is refused while c still follows ──
  const rejoinBox = page.getByLabel('Rejoin after paths')
  assert.equal(await rejoinBox.isChecked(), true, 'the split still rejoins before this test unticks it')
  // A plain click, not uncheck(): uncheck() asserts the box ends up unchecked,
  // but this box is expected to bounce straight back - that is the point.
  await rejoinBox.click()
  await page.getByText('Can’t do that here').first().waitFor()
  const toastText = await page.locator('body').innerText()
  assert.match(toastText, /Steps follow these paths, so they have to rejoin\./,
    `the toast explains why the refusal happened. Page text:\n${toastText}`)
  assert.equal(await rejoinBox.isChecked(), true, 'the checkbox resets itself rather than staying unticked')

  const afterRefusal = readWf()
  assert.deepEqual(afterRefusal, afterSave, 'a refused edit changes nothing on disk')
  await page.screenshot({ path: join(shots, 'builder-04-rejoin-refused.png'), fullPage: true })

  console.log('workflow builder smoke: all assertions passed')
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

/**
 * Browser smoke test for the workflow run stack
 * (app/pages/workflows/[slug].vue's Run mode, app/components/RunStack.vue,
 * app/components/RunStackCard.vue, app/composables/useWorkflowRun.ts).
 *
 * Why this exists: the run's data path is covered by scripts/test-workflow-runner.mjs
 * and friends, which prove the server produces correct per-agent rows. None of that
 * proves the browser actually paints them - a broken template, a v-if that hides every
 * row, a class name typo, all pass a fully green data-path suite. This test starts a
 * real dev server against a seeded, disposable CLAUDE_DIR (never the deployed
 * container), opens the page in Run mode in a real (headless) browser, and asserts the
 * three seeded steps render as step cards with their labels and status.
 *
 * This is NOT part of the fast scripts/test-*.mjs sweep - it boots a dev server and a
 * browser, so it takes tens of seconds rather than milliseconds. Run it on its own:
 *
 *   npm run test:e2e
 *
 * Requires Chromium to be installed for Playwright (devDependency):
 *   npx playwright install chromium
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import http from 'node:http'
import { chromium } from 'playwright'

// Chromium needs libnspr4, libnss3 and libasound, and this box does not have
// them installed system-wide (installing them needs sudo, which a test must
// never assume). `npm run e2e:libs` extracts the .deb payloads into this cache
// directory without root; if that has been done, point the dynamic loader at
// it. When the libraries ARE installed system-wide this is a no-op, so the
// test works either way rather than being tied to one machine's setup.
const LOCAL_BROWSER_LIBS = join(homedir(), '.cache', 'agent-manager-browser-libs')
if (existsSync(LOCAL_BROWSER_LIBS)) {
  process.env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH
    ? `${LOCAL_BROWSER_LIBS}:${process.env.LD_LIBRARY_PATH}`
    : LOCAL_BROWSER_LIBS
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

const SERVER_READY_TIMEOUT_MS = 90_000
const ROW_VISIBLE_TIMEOUT_MS = 30_000

// Bounds for the ERR_NETWORK_CHANGED retry loops below (loadRunMode, loadRunsList).
// Worst case per loop, if the network flake persists for every attempt:
// LOAD_RETRY_ATTEMPTS * (LOAD_GOTO_TIMEOUT_MS + LOAD_WAIT_TIMEOUT_MS) + (LOAD_RETRY_ATTEMPTS - 1) * LOAD_RETRY_SLEEP_MS
// = 3 * (20s + 20s) + 2 * 3s = 126s. There are two such loops in this file, so
// 252s covers both retrying maximally, leaving comfortable margin under the
// external `timeout 400` for server startup and the rest of the smoke's
// assertions - none of which retry, so a genuine (non-network) failure now
// surfaces on the first attempt instead of being multiplied by the retry loop.
const LOAD_RETRY_ATTEMPTS = 3
const LOAD_GOTO_TIMEOUT_MS = 20_000
const LOAD_WAIT_TIMEOUT_MS = 20_000
const LOAD_RETRY_SLEEP_MS = 3_000

/** Ask the OS for an unused port rather than guessing one - guessing risks colliding
 *  with the deployed container on 3030 or anything else already listening. */
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

/**
 * A single readiness ping, on node:http rather than the global fetch()/undici. A dev
 * server mid-startup can send a response shaped in a way that trips a known Node/undici
 * assertion deep in an internal socket handler (unrelated to this test's own code, and
 * not something an ordinary try/catch around fetch() can catch, since it fires from a
 * later event-loop tick and crashes the whole process). node:http's plain callback API
 * sidesteps it. The response body is always drained so the connection can close cleanly
 * instead of sitting half-consumed.
 */
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
      const status = await pingOnce(url)
      if (status < 500) return
    } catch (err) {
      lastErr = err
    }
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error(`Dev server at ${url} did not respond within ${timeoutMs}ms (last error: ${lastErr?.message ?? 'none'})`)
}

async function killServer(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
  await new Promise((resolve) => {
    proc.once('exit', resolve)
    // nuxt dev forks its own nitro/vite children; signalling just the top pid leaves
    // them running as orphans (observed: a leaked "nuxt dev" + 2 worker processes that
    // silently kept the allocated port bound after this test exited). The process was
    // spawned with detached:true specifically so it heads its own process group -
    // signal the whole group (negative pid) so nested children die with it.
    try { process.kill(-proc.pid, 'SIGTERM') } catch { try { proc.kill('SIGTERM') } catch { /* already gone */ } }
    // Dev server + its child processes (vite, nitro) can be slow to unwind -
    // force it after a grace period so a hung process never leaks past this test.
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        try { process.kill(-proc.pid, 'SIGKILL') } catch { try { proc.kill('SIGKILL') } catch { /* already gone */ } }
      }
    }, 5000)
  })
}

let claudeDir = null
let serverProc = null
let browser = null
let exitCode = 0
let serverLog = ''
let torndown = false

/** Tear the server (and its temp CLAUDE_DIR) down reliably - called from the normal
 *  finally block, and from the crash-safety-net handlers below, so a bug that throws
 *  outside the main try/catch (an unhandled rejection, a Node-internal assertion in a
 *  later event-loop tick) still can't leak a dev server or a temp directory. */
async function teardown() {
  if (torndown) return
  torndown = true
  if (browser) await browser.close().catch(() => {})
  await killServer(serverProc)
  if (claudeDir) rmSync(claudeDir, { recursive: true, force: true })
}

process.on('uncaughtException', async (err) => {
  console.error(`FAIL: uncaught exception: ${err?.stack || err}`)
  await teardown()
  process.exit(1)
})
process.on('unhandledRejection', async (err) => {
  console.error(`FAIL: unhandled rejection: ${err?.stack || err}`)
  await teardown()
  process.exit(1)
})

try {
  // ── 1. Seed a known, disposable CLAUDE_DIR ───────────────────────────────
  // Never the deployed container's ~/.claude - a temp dir this process owns end to end.
  claudeDir = mkdtempSync(join(tmpdir(), 'workflow-panel-e2e-'))
  mkdirSync(join(claudeDir, 'workflows'), { recursive: true })
  mkdirSync(join(claudeDir, 'workflow-runs'), { recursive: true })

  // The real Runbook A workflow definition, not a stand-in - this is what's actually
  // deployed, so the test exercises the real shape (7 steps, monitors, branches).
  const workflowSourcePath = join(repoRoot, 'docker/claude-config/workflows/runbook-a-ticket-to-evidence-backed-pr.json')
  const workflow = JSON.parse(readFileSync(workflowSourcePath, 'utf8'))
  const slug = 'runbook-a-ticket-to-evidence-backed-pr'
  writeFileSync(join(claudeDir, 'workflows', `${slug}.json`), JSON.stringify(workflow, null, 2))

  const [stepIntake, stepStack, stepTest] = workflow.steps
  assert.ok(stepIntake && stepStack && stepTest, 'Runbook A workflow JSON must have at least 3 steps to seed a run against')

  const now = Date.now()
  const run = {
    id: 'e2e-smoke-run',
    workflowSlug: slug,
    workflowName: workflow.name,
    status: 'running',
    autoRun: false,
    initialPrompt: 'Browser smoke test seed - not a real ticket',
    watch: 'direct-invocation',
    steps: [
      {
        stepId: stepIntake.id,
        label: stepIntake.label,
        agentSlug: stepIntake.agentSlug,
        status: 'completed',
        input: 'seed input',
        output: 'Ticket intake complete.',
        startedAt: now - 60_000,
        completedAt: now - 30_000,
        visits: 1,
        model: 'claude-sonnet-4-6',
      },
      {
        stepId: stepStack.id,
        label: stepStack.label,
        agentSlug: stepStack.agentSlug,
        status: 'running',
        input: 'seed input',
        output: '',
        startedAt: now - 20_000,
        visits: 1,
      },
      {
        stepId: stepTest.id,
        label: stepTest.label,
        agentSlug: stepTest.agentSlug,
        status: 'pending',
        input: '',
        output: '',
        visits: 0,
      },
    ],
    currentStepIds: [stepStack.id],
    nextStepIds: [],
    startedAt: now - 60_000,
    // The run store demotes a running/paused run to 'interrupted' the moment its owning
    // pid is dead (server/utils/workflowRunStore.ts:applyInterrupted) - this process's
    // own pid stays alive for this script's whole lifetime, so the seeded run keeps
    // reading as 'running' exactly as intended, with no keep-alive trick needed.
    pid: process.pid,
  }
  writeFileSync(join(claudeDir, 'workflow-runs', `${run.id}.json`), JSON.stringify(run, null, 2))

  // ── 2. Start the app against that CLAUDE_DIR on a free port ─────────────
  // `npm run dev` hardcodes port 3030, which is the deployed container this test must
  // never touch - so the dev server is driven directly with an explicit, freshly
  // allocated port instead. Invoking node_modules/nuxt/bin/nuxt.mjs directly (rather
  // than through `npx nuxt`) keeps the process tree one layer shallower; `detached:
  // true` makes this process the leader of its own process group so killServer() can
  // signal the whole group (nitro/vite forks its own children) instead of orphaning them.
  const port = await getFreePort()
  serverProc = spawn(process.execPath, [join(repoRoot, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--port', String(port)], {
    cwd: repoRoot,
    env: { ...process.env, CLAUDE_DIR: claudeDir, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  serverProc.stdout.on('data', d => { serverLog += d.toString() })
  serverProc.stderr.on('data', d => { serverLog += d.toString() })

  const baseUrl = `http://127.0.0.1:${port}`
  await waitForServer(baseUrl, SERVER_READY_TIMEOUT_MS)

  // ── 3. Load the workflow's run directly into Run mode ────────────────────
  browser = await chromium.launch()
  const page = await browser.newPage()
  page.setDefaultTimeout(ROW_VISIBLE_TIMEOUT_MS)

  /** Guards against intermittent ERR_NETWORK_CHANGED on this host - the docker
   *  bridges churn, and Chromium aborts module loads when they do. Only that
   *  error is retried: anything else (a real assertion of app breakage, e.g.
   *  Run mode never actually selecting) is rethrown from the first attempt, so
   *  a genuine regression fails fast with a FAIL message instead of being
   *  multiplied by the retry loop and killed from outside by `timeout 400`
   *  with no message and a leaked dev server. Also covers `?run=` being a
   *  one-shot intent applied only after the run list itself has loaded
   *  client-side, which the "mode-run selected" wait accounts for. */
  async function loadRunMode(url) {
    for (let attempt = 0; attempt < LOAD_RETRY_ATTEMPTS; attempt++) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: LOAD_GOTO_TIMEOUT_MS })
        await page.waitForFunction(
          () => document.querySelector('[data-testid=mode-run]')?.getAttribute('aria-selected') === 'true',
          null, { timeout: LOAD_WAIT_TIMEOUT_MS },
        )
        return
      } catch (err) {
        if (!String(err?.message).includes('ERR_NETWORK_CHANGED') || attempt === LOAD_RETRY_ATTEMPTS - 1) throw err
        await new Promise(r => setTimeout(r, LOAD_RETRY_SLEEP_MS))
      }
    }
  }
  await loadRunMode(`${baseUrl}/workflows/${slug}?run=${run.id}`)

  // ── 4. Assert the three seeded steps render as run-stack cards ───────────
  const STATUS_DOT_LABEL = { completed: 'completed', running: 'running', pending: 'pending' }
  const expectedRows = [
    { stepId: stepIntake.id, label: stepIntake.label, agentSlug: stepIntake.agentSlug, status: 'completed' },
    { stepId: stepStack.id, label: stepStack.label, agentSlug: stepStack.agentSlug, status: 'running' },
    { stepId: stepTest.id, label: stepTest.label, agentSlug: stepTest.agentSlug, status: 'pending' },
  ]

  for (const expected of expectedRows) {
    // Each run-stack step is an `article[data-step]` (app/components/RunStackCard.vue) -
    // locate by the id rather than by text, so a card that renders with the wrong
    // label still gets found and its text checked, rather than the test itself
    // failing to locate anything.
    const card = page.locator(`article[data-step="${expected.stepId}"]`)
    try {
      await card.waitFor({ state: 'visible' })
    } catch (err) {
      throw new Error(
        `Expected a visible run-stack card for step "${expected.label}" (${expected.stepId}) `
        + `(agent: ${expected.agentSlug}, status: ${expected.status}) but it never became visible `
        + `within ${ROW_VISIBLE_TIMEOUT_MS}ms. RunStack.vue is rendering no matching card.`,
      )
    }

    const cardText = await card.innerText()
    assert.ok(
      cardText.includes(expected.label),
      `Card for step "${expected.stepId}" is visible, but its text does not carry the label "${expected.label}". Text:\n${cardText}`,
    )

    const dotLabel = await card.locator('[role="img"][aria-label]').first().getAttribute('aria-label')
    assert.equal(
      dotLabel, STATUS_DOT_LABEL[expected.status],
      `Step "${expected.label}" card is visible, but its status dot's aria-label is "${dotLabel}", not "${expected.status}"`,
    )
  }

  // The at-a-glance summary. The seeded run has one completed, one running and
  // one pending step, so exactly one is settled — asserting the count, not just
  // the bar's presence, is what makes this catch a miscount.
  const countEl = page.locator('[data-testid="run-progress-count"]')
  await countEl.waitFor({ state: 'visible', timeout: 30_000 })
  const countText = (await countEl.textContent()).replace(/\s+/g, ' ').trim()
  assert.equal(countText, '1 of 3', `progress count must report settled steps, got "${countText}"`)

  const segments = page.locator('[data-testid="run-progress-bar"] > span')
  assert.equal(await segments.count(), 3,
    'the bar carries one segment per step, so a reader sees the shape of the run, not a percentage')

  // ── Run History page (app/pages/runs/index.vue, GET /api/runs) ──────────
  //
  // Same seeded run, reached the other way. Runs used to be discoverable only
  // from the workflow that produced them, so a run started headlessly by
  // scripts/run-ticket.mjs or by a watch had nowhere to be seen. This asserts
  // the global page finds that run and reports the same settled count the
  // panel does - the two views reading one run differently is exactly the
  // drift that made extracting app/utils/runStatus.ts worth doing.
  //
  // /runs is a master-detail page now (app/pages/runs/index.vue): a `ul` of run
  // rows on the left (`aria-live="polite"`, one `button` per run with
  // `aria-current` marking the open one) and, on the right, a detail pane
  // (RunDetailPane.vue) that renders the very same RunStack used in Run mode
  // above - so the assertions below reuse the same `run-progress-count` /
  // `run-progress-bar` / `article[data-step]` selectors, just against the
  // detail pane's copy of them rather than the workflow page's.
  // Same ERR_NETWORK_CHANGED-only retry as loadRunMode above - anything else
  // rethrows on the first attempt.
  async function loadRunsList(url) {
    for (let attempt = 0; attempt < LOAD_RETRY_ATTEMPTS; attempt++) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: LOAD_GOTO_TIMEOUT_MS })
        await page.waitForFunction(
          () => document.querySelector('ul[aria-live="polite"]') !== null,
          null, { timeout: LOAD_WAIT_TIMEOUT_MS },
        )
        return
      } catch (err) {
        if (!String(err?.message).includes('ERR_NETWORK_CHANGED') || attempt === LOAD_RETRY_ATTEMPTS - 1) throw err
        await new Promise(r => setTimeout(r, LOAD_RETRY_SLEEP_MS))
      }
    }
  }
  await loadRunsList(`${baseUrl}/runs`)

  // Exactly one row: a locator that fails loudly if the seeded run is missing
  // (zero rows) or duplicated (two rows) rather than silently picking "first".
  const runRows = page.locator('ul[aria-live="polite"] > li button')
  await runRows.first().waitFor({ state: 'visible', timeout: 30_000 })
  assert.equal(await runRows.count(), 1,
    'the history page must list exactly the one seeded run, found via GET /api/runs rather than a workflow slug')

  // Select it. The page can auto-select the first (and only) run on load, but
  // clicking it is still correct either way, and is what proves the row is
  // actually the thing that opens the detail pane rather than a coincidence.
  await runRows.first().click()
  await page.waitForFunction(
    () => document.querySelector('ul[aria-live="polite"] > li button')?.getAttribute('aria-current') === 'true',
    null, { timeout: ROW_VISIBLE_TIMEOUT_MS },
  )

  // The detail pane renders RunStack for the selected run - same testids, same
  // per-step cards, as the panel assertions above. Scoped to the detail
  // `<section>` (identified by containing an `article[data-step]`, which only
  // the detail pane renders): the run's own row in the list on the left also
  // carries a `run-progress-bar` (app/pages/runs/index.vue renders one per
  // row), so an unscoped query here double-counts both bars' segments.
  const pane = page.locator('section').filter({ has: page.locator('article[data-step]') })

  const paneCountEl = pane.locator('[data-testid="run-progress-count"]')
  await paneCountEl.waitFor({ state: 'visible', timeout: 30_000 })
  const paneCountText = (await paneCountEl.textContent()).replace(/\s+/g, ' ').trim()
  assert.equal(paneCountText, '1 of 3',
    `the /runs detail pane must report the same settled count as the panel, got "${paneCountText}"`)

  const paneSegments = pane.locator('[data-testid="run-progress-bar"] > span')
  assert.equal(await paneSegments.count(), 3,
    'the detail pane\'s bar carries one segment per step, matching the panel')

  const paneIntakeCard = pane.locator(`article[data-step="${stepIntake.id}"]`)
  await paneIntakeCard.waitFor({ state: 'visible', timeout: 30_000 })
  const paneIntakeText = await paneIntakeCard.innerText()
  assert.ok(paneIntakeText.includes(stepIntake.label),
    `the detail pane's card for step "${stepIntake.id}" does not carry the label "${stepIntake.label}". Text:\n${paneIntakeText}`)

  console.log(
    'PASS: workflow run panel rendered all 3 seeded step rows (completed, running, pending) '
    + 'with correct labels and status colors; /runs listed exactly the one seeded run and its '
    + 'detail pane rendered the same run stack with a matching settled count and step card',
  )
} catch (err) {
  exitCode = 1
  console.error(`FAIL: ${err.message}`)
  if (serverLog) console.error(`\n--- dev server output ---\n${serverLog}`)
} finally {
  // Tear the server down reliably, on success or failure - a leaked dev server would
  // otherwise squat on a port and outlive this process.
  await teardown()
}

process.exit(exitCode)

/**
 * Browser smoke test for the workflow run status panel
 * (app/pages/workflows/[slug].vue, app/components/WorkflowRunPanel.vue,
 * app/composables/useWorkflowRun.ts).
 *
 * Why this exists: the panel's data path is covered by scripts/test-workflow-runner.mjs
 * and friends, which prove the server produces correct per-agent rows. None of that
 * proves the browser actually paints them - a broken template, a v-if that hides every
 * row, a class name typo, all pass a fully green data-path suite. This test starts a
 * real dev server against a seeded, disposable CLAUDE_DIR (never the deployed
 * container), opens the page in a real (headless) browser, and asserts the three step
 * rows the seed describes are visible with their labels and status colors.
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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import http from 'node:http'
import { chromium } from 'playwright'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

const SERVER_READY_TIMEOUT_MS = 90_000
const ROW_VISIBLE_TIMEOUT_MS = 30_000

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

  // ── 3. Load the workflow page in a real browser ──────────────────────────
  browser = await chromium.launch()
  const page = await browser.newPage()
  page.setDefaultTimeout(ROW_VISIBLE_TIMEOUT_MS)
  await page.goto(`${baseUrl}/workflows/${slug}`, { waitUntil: 'domcontentloaded', timeout: SERVER_READY_TIMEOUT_MS })

  // ── 4. Assert the three seeded step rows are visible with label + status ─
  const STATUS_COLOR = {
    completed: 'var(--success, #22c55e)',
    running: 'var(--info, #3b82f6)',
    pending: 'var(--text-disabled, #9ca3af)',
  }
  const expectedRows = [
    { label: stepIntake.label, agentSlug: stepIntake.agentSlug, status: 'completed' },
    { label: stepStack.label, agentSlug: stepStack.agentSlug, status: 'running' },
    { label: stepTest.label, agentSlug: stepTest.agentSlug, status: 'pending' },
  ]

  for (const expected of expectedRows) {
    // Each run-panel row is a <button> containing the status dot, the label and the
    // agent slug (app/components/WorkflowRunPanel.vue) - match on both label and
    // agent slug together so this can't accidentally match an unrelated element.
    const row = page.locator('button', { hasText: expected.label }).filter({ hasText: expected.agentSlug }).first()
    try {
      await row.waitFor({ state: 'visible' })
    } catch (err) {
      throw new Error(
        `Expected a visible workflow-run-panel row for step "${expected.label}" `
        + `(agent: ${expected.agentSlug}, status: ${expected.status}) but it never became visible `
        + `within ${ROW_VISIBLE_TIMEOUT_MS}ms. WorkflowRunPanel.vue is rendering no matching row.`,
      )
    }

    const dotStyle = await row.locator('span.rounded-full').first().getAttribute('style')
    assert.ok(
      dotStyle && dotStyle.includes(STATUS_COLOR[expected.status]),
      `Step "${expected.label}" row is visible, but its status dot does not show the "${expected.status}" `
      + `color (expected style to include ${STATUS_COLOR[expected.status]}, got "${dotStyle}")`,
    )
  }

  console.log(
    'PASS: workflow run panel rendered all 3 seeded step rows (completed, running, pending) '
    + 'with correct labels and status colors',
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

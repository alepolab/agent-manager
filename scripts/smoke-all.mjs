#!/usr/bin/env node
/**
 * Smoke sweep: proves the pipeline works on every registered product, through
 * the instance API, one product at a time by default.
 *
 *   node scripts/smoke-all.mjs                    # every product, full Runbook A
 *   node scripts/smoke-all.mjs crm ffm selfcare   # named products
 *   node scripts/smoke-all.mjs --quick            # the one-step Smoke Check instead
 *   BASE=http://host:3030 CONCURRENCY=2 node scripts/smoke-all.mjs
 *
 * Full mode runs the configured Runbook A on a synthetic, ticket-less task
 * (add a SMOKE.md documenting how to build and test the product), so intake,
 * provisioning, the failing test, the fix, verification, tracing and the
 * security review all execute for real, and the run stops at the Evidence
 * approval gate: nothing is pushed and no PR is opened unless a person
 * approves it on the run page. With no ticket key the two Jira steps skip.
 *
 * Quick mode runs the one-step Smoke Check workflow (checkout, build, tests,
 * a verdict on the registry's test command) and settles on its own.
 *
 * Needs AGENT_MANAGER_API_TOKEN (environment or ./.env). Runs are the
 * instance's API developer's. Every run locks only its product's checkout
 * directory, so a sweep never blocks on another run; a product whose
 * repositories an in-flight run is already working in is skipped and said so.
 *
 * Results print as they arrive and are written to
 * ~/.agent-manager/smoke-<timestamp>.json for the hand-over record.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'

const args = process.argv.slice(2)
const quick = args.includes('--quick')
const wanted = args.filter(a => !a.startsWith('--'))
const base = (process.env.BASE || 'http://localhost:3030').replace(/\/+$/, '')
const concurrency = Math.max(1, Number(process.env.CONCURRENCY) || 1)
const token = process.env.AGENT_MANAGER_API_TOKEN || fromEnvFile('AGENT_MANAGER_API_TOKEN')
if (!token) { console.error('AGENT_MANAGER_API_TOKEN is not set (environment or ./.env)'); process.exit(2) }
const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }

function fromEnvFile(name) {
  try { return readFileSync('.env', 'utf8').split('\n').find(l => l.startsWith(name + '='))?.slice(name.length + 1) } catch { return undefined }
}
async function api(path, method = 'GET', body) {
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text(); let json; try { json = JSON.parse(text) } catch { json = text }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${typeof json === 'string' ? json.slice(0, 200) : (json.message || JSON.stringify(json).slice(0, 200))}`)
  return json
}

const registry = parse(readFileSync('engineering/registry/products.yaml', 'utf8'))
const products = Object.entries(registry.products).filter(([k]) => !wanted.length || wanted.includes(k))
if (!products.length) { console.error('no matching products'); process.exit(2) }

const RUNBOOK = 'runbook-a-ticket-to-evidence-backed-pr'
const QUICK = 'smoke-check'
let slug = quick ? QUICK : RUNBOOK
const workflows = await api('/api/workflows')
if (!workflows.some(w => w.slug === slug)) {
  if (!quick) { console.error(`the configured runbook "${RUNBOOK}" is not on this instance`); process.exit(2) }
  const w = await api('/api/workflows', 'POST', {
    name: 'Smoke Check', description: 'Checkout, build and test one product; verifies the registry entry.',
    steps: [{ id: 'smoke', agentSlug: 'sdlc-smoke-check', label: 'Smoke Check', next: [], monitorSlug: 'sdlc-step-monitor' }],
  })
  slug = w.slug
  console.log('created workflow', slug)
}

const me = await api('/api/me')
const login = me.login
const root = process.env.AGENT_WORKSPACE_ROOT || join(homedir(), 'alepo-workspace')
const checkoutOf = repo => join(root, login, repo.split('/')[1])

// Products whose repositories an in-flight run already works in are left alone.
const inFlight = (await api('/api/runs')).filter(r => r.status === 'running' || r.status === 'paused')
const busyRepos = new Set(inFlight.flatMap(r => r.product?.repos ?? []))

const promptFor = (key, repos) => quick
  ? `Smoke check for product "${key}": confirm the checkout of ${repos.join(', ') || 'its repository'}, build it, run its tests, and report whether the registry's test command is right.`
  : `Pipeline smoke test for product "${key}". Defect: ${repos.join(' and ') || 'the repository'} ${repos.length > 1 ? 'have' : 'has'} no SMOKE.md at the repository root telling a developer how to build the product and run its tests on this instance, so the commands the registry carries cannot be checked. Fix: add SMOKE.md with the exact build and test commands verified here, one section per repository, and a test that fails while the file is missing and passes once it is present. Keep the change to that file and its test; nothing else in the product is in scope.`

const summarise = r => {
  const c = s => r.steps.filter(x => x.status === s).length
  const q = r.question ? ` — waiting: ${r.question.reason === 'budget' ? 'budget' : r.question.kind === 'approval' ? `approval of "${r.steps.find(s => s.stepId === r.question.stepId)?.label ?? r.question.stepId}"` : 'a question'}` : ''
  return `${c('completed')} completed, ${c('skipped')} skipped, ${c('failed')} failed, ${c('pending')} pending${q}${r.error ? ` — ${r.error.slice(0, 120)}` : ''}`
}
const settle = async (id) => {
  for (;;) {
    const r = await api(`/api/runs/${id}`)
    if (!['running', 'pending'].includes(r.status)) return r
    await new Promise(res => setTimeout(res, 20000))
  }
}

const results = []
const one = async ([key, p]) => {
  const repos = p.repos ?? []
  const busy = repos.filter(r => busyRepos.has(r))
  if (busy.length) {
    results.push({ product: key, repos, status: 'skipped', verdict: `in use by an in-flight run (${busy.join(', ')})` })
    console.log(`${key.padEnd(20)} skipped     in use by an in-flight run: ${busy.join(', ')}`)
    return
  }
  const started = Date.now()
  try {
    const run = await api(`/api/workflows/${slug}/runs`, 'POST', {
      initialPrompt: promptFor(key, repos), autoRun: true, productKey: key,
      // Its own checkout directory, existing or not, so the lock is per product.
      ...(repos[0] ? { projectDir: checkoutOf(repos[0]) } : {}),
    })
    const r = await settle(run.id)
    const step = r.steps[0]
    const verdict = quick
      ? ((step.output ?? '').match(/^SMOKE:\s*(.*)$/m)?.[1] ?? (step.error ? `error: ${step.error.slice(0, 120)}` : r.status))
      : summarise(r)
    const suggestion = quick ? (step.output ?? '').match(/^REGISTRY:\s*(.*)$/m)?.[1] : undefined
    const minutes = Math.round((Date.now() - started) / 6000) / 10
    results.push({ product: key, repos, runId: run.id, status: r.status, verdict, suggestion, usd: r.usage?.usd, minutes })
    console.log(`${key.padEnd(20)} ${r.status.padEnd(10)} ${verdict}${suggestion ? `  | registry: ${suggestion}` : ''}  ($${(r.usage?.usd ?? 0).toFixed(2)}, ${minutes} min, ${run.id.slice(0, 8)})`)
  } catch (err) {
    results.push({ product: key, repos, status: 'not-started', verdict: err.message })
    console.log(`${key.padEnd(20)} not-started ${err.message}`)
  }
}

console.log(`${quick ? 'Smoke Check' : 'Runbook A'} on ${products.length} product(s), ${concurrency} at a time${busyRepos.size ? `; repositories in use by in-flight runs: ${[...busyRepos].join(', ')}` : ''}`)
const queue = [...products]
await Promise.all(Array.from({ length: concurrency }, async () => { while (queue.length) await one(queue.shift()) }))

const out = join(homedir(), '.agent-manager', `smoke-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
mkdirSync(join(homedir(), '.agent-manager'), { recursive: true })
writeFileSync(out, JSON.stringify({ mode: quick ? 'quick' : 'runbook', workflow: slug, results }, null, 2))
const by = s => results.filter(r => r.status === s).length
console.log(`\n${by('paused')} reached a gate, ${by('completed')} completed, ${by('failed')} failed, ${by('skipped')} skipped, ${by('not-started')} not started — written to ${out}`)

#!/usr/bin/env node
/**
 * Runs the Smoke Check workflow against registered products, through the
 * instance API, and prints one line per product as each settles.
 *
 *   node scripts/smoke-all.mjs                    # every product in the registry
 *   node scripts/smoke-all.mjs crm ffm selfcare   # named products
 *   BASE=http://host:3030 CONCURRENCY=2 node scripts/smoke-all.mjs
 *
 * Needs AGENT_MANAGER_API_TOKEN (read from the environment, or from ./.env)
 * and the instance's AGENT_MANAGER_API_LOGIN developer: runs are theirs, their
 * checkouts are used, and each run locks only its own checkout directory, so
 * products run side by side. A product with no checkout yet runs alone at the
 * end, because its run locks the whole workspace root while it clones.
 *
 * Results are printed as a table and written to
 * ~/.agent-manager/smoke-<timestamp>.json for the hand-over record.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'

const base = (process.env.BASE || 'http://localhost:3030').replace(/\/+$/, '')
const concurrency = Math.max(1, Number(process.env.CONCURRENCY) || 2)
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
const wanted = process.argv.slice(2)
const products = Object.entries(registry.products).filter(([k]) => !wanted.length || wanted.includes(k))
if (!products.length) { console.error('no matching products'); process.exit(2) }

// The workflow: one monitored step on the smoke agent, created once.
const SLUG = 'smoke-check'
let workflow = await api('/api/workflows').then(list => list.find(w => w.slug === SLUG)).catch(() => undefined)
if (!workflow) {
  workflow = await api('/api/workflows', 'POST', {
    name: 'Smoke Check', description: 'Checkout, build and test one product; verifies the registry entry.',
    steps: [{ id: 'smoke', agentSlug: 'sdlc-smoke-check', label: 'Smoke Check', next: [], monitorSlug: 'sdlc-step-monitor' }],
  })
  console.log('created workflow', workflow.slug)
}

const me = await api('/api/me')
const login = me?.user?.login ?? me?.login
const root = (process.env.AGENT_WORKSPACE_ROOT || join(homedir(), 'alepo-workspace'))
const checkoutOf = repo => join(root, login, repo.split('/')[1])

const results = []
const settle = async (id) => {
  for (;;) {
    const r = await api(`/api/runs/${id}`)
    if (!['running', 'pending'].includes(r.status)) return r
    await new Promise(res => setTimeout(res, 15000))
  }
}
const one = async ([key, p]) => {
  const repos = p.repos ?? []
  const first = repos[0]
  const dir = first && existsSync(checkoutOf(first)) ? checkoutOf(first) : undefined
  const prompt = `Smoke check for product "${key}": confirm the checkout of ${repos.join(', ') || 'its repository'}, build it, run its tests, and report whether the registry's test command is right.`
  const started = Date.now()
  try {
    const run = await api(`/api/workflows/${workflow.slug}/runs`, 'POST', { initialPrompt: prompt, autoRun: true, productKey: key, ...(dir ? { projectDir: dir } : {}) })
    const r = await settle(run.id)
    const step = r.steps[0]
    const verdict = (step.output ?? '').match(/^SMOKE:\s*(.*)$/m)?.[1] ?? (step.error ? `error: ${step.error.slice(0, 120)}` : r.status)
    const suggestion = (step.output ?? '').match(/^REGISTRY:\s*(.*)$/m)?.[1]
    results.push({ product: key, repos, runId: run.id, status: r.status, verdict, suggestion, minutes: Math.round((Date.now() - started) / 6000) / 10 })
    console.log(`${key.padEnd(20)} ${r.status.padEnd(10)} ${verdict}${suggestion ? `  | registry: ${suggestion}` : ''}  (${run.id.slice(0, 8)})`)
  } catch (err) {
    results.push({ product: key, repos, status: 'not-started', verdict: err.message })
    console.log(`${key.padEnd(20)} not-started ${err.message}`)
  }
}

const withCheckout = products.filter(([, p]) => p.repos?.[0] && existsSync(checkoutOf(p.repos[0])))
const without = products.filter(x => !withCheckout.includes(x))
console.log(`${withCheckout.length} product(s) with a checkout run ${concurrency} at a time; ${without.length} without run one at a time afterwards`)
const queue = [...withCheckout]
await Promise.all(Array.from({ length: concurrency }, async () => { while (queue.length) await one(queue.shift()) }))
for (const p of without) await one(p)

const out = join(homedir(), '.agent-manager', `smoke-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
mkdirSync(join(homedir(), '.agent-manager'), { recursive: true })
writeFileSync(out, JSON.stringify(results, null, 2))
console.log(`\n${results.filter(r => /^PASS/.test(r.verdict)).length} pass, ${results.filter(r => /^FAIL/.test(r.verdict)).length} fail, ${results.filter(r => /^N\/A/.test(r.verdict)).length} n/a, ${results.filter(r => !/^(PASS|FAIL|N\/A)/.test(r.verdict)).length} other — written to ${out}`)

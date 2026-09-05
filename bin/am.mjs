#!/usr/bin/env node
/**
 * am — drive Agent Manager runs from a terminal.
 *
 *   am runs [--status failed]             list runs
 *   am status <runId>                     one run, with steps
 *   am start <workflowSlug> "<prompt>" [--dir <path>] [--auto]
 *   am restart <runId> [stepId] [--note "..."]   default: the failed step
 *   am clone <runId>                      start a new run with the same inputs
 *   am stop <runId>
 *   am open <runId>                       print the builder URL for the run
 *
 * AGENT_MANAGER_URL selects the server (default http://localhost:3030).
 * Run ids may be given as a unique prefix.
 */
const base = (process.env.AGENT_MANAGER_URL || 'http://localhost:3030').replace(/\/$/, '')
const [cmd, ...rest] = process.argv.slice(2)

function flag(name) {
  const i = rest.indexOf(`--${name}`)
  if (i === -1) return undefined
  const v = rest[i + 1]
  rest.splice(i, v !== undefined && !v.startsWith('--') ? 2 : 1)
  return v !== undefined && !v.startsWith('--') ? v : true
}

async function api(path, init) {
  const res = await fetch(base + path, { headers: { 'content-type': 'application/json' }, ...init })
  const text = await res.text()
  let body; try { body = JSON.parse(text) } catch { body = text }
  if (!res.ok) throw new Error(body?.message || `${res.status} ${res.statusText}`)
  return body
}

async function resolveRun(idOrPrefix) {
  const runs = await api('/api/runs')
  const hits = runs.filter(r => r.id === idOrPrefix || r.id.startsWith(idOrPrefix))
  if (hits.length !== 1) throw new Error(hits.length ? `ambiguous run id ${idOrPrefix}` : `no run matches ${idOrPrefix}`)
  return hits[0]
}

const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16)
const dur = (r) => { const s = Math.round(((r.endedAt ?? Date.now()) - r.startedAt) / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m` }

const commands = {
  async runs() {
    const status = flag('status')
    const runs = (await api('/api/runs')).filter(r => !status || r.status === status)
    for (const r of runs) {
      const cost = r.usage ? `$${r.usage.usd.toFixed(2)}` : ''
      const ci = r.ci ? ` ci:${r.ci.status}` : ''
      console.log(`${r.id.slice(0, 8)}  ${r.status.padEnd(11)} ${fmt(r.startedAt)}  ${dur(r).padStart(5)}  ${cost.padStart(7)}${ci}  ${r.workflowName}  ${r.initialPrompt.split('\n')[0].slice(0, 50)}`)
    }
  },
  async status([id]) {
    const r = await resolveRun(id)
    console.log(`${r.id}  ${r.status}  ${r.workflowName}\nprompt: ${r.initialPrompt.split('\n')[0].slice(0, 100)}${r.product ? `\nproduct: ${r.product.name}` : ''}${r.usage ? `\ncost: $${r.usage.usd.toFixed(2)} (${r.usage.input_tokens} in / ${r.usage.output_tokens} out)` : ''}${r.ci ? `\nci: ${r.ci.status} ${r.ci.pr}` : ''}${r.error ? `\nerror: ${r.error}` : ''}`)
    for (const s of r.steps) console.log(`  ${s.status.padEnd(10)} ${s.label.padEnd(24)} ${s.agentSlug}${s.visits > 1 ? ` x${s.visits}` : ''}${s.monitorVerdict ? ` ${s.monitorVerdict}` : ''}${s.error ? `  ${s.error.slice(0, 80)}` : ''}`)
  },
  async start([slug, prompt]) {
    if (!slug || !prompt) throw new Error('usage: am start <workflowSlug> "<prompt>" [--dir <path>] [--auto]')
    const r = await api(`/api/workflows/${slug}/runs`, { method: 'POST', body: JSON.stringify({ initialPrompt: prompt, projectDir: flag('dir'), autoRun: flag('auto') === true }) })
    console.log(`started ${r.id}\n${base}/workflows/${slug}?run=${r.id}`)
  },
  async restart([id, stepId]) {
    const note = flag('note')
    const r = await resolveRun(id)
    const step = stepId ? r.steps.find(s => s.stepId === stepId || s.stepId.startsWith(stepId) || s.label === stepId)?.stepId
      : (r.steps.find(s => s.status === 'failed') ?? r.steps.find(s => s.status !== 'completed'))?.stepId
    if (!step) throw new Error('no step to restart from')
    const out = await api(`/api/runs/${r.id}/restart`, { method: 'POST', body: JSON.stringify({ stepId: step, note: typeof note === 'string' ? note : undefined }) })
    console.log(`restarted ${out.id} from ${r.steps.find(s => s.stepId === step)?.label}\n${base}/workflows/${r.workflowSlug}?run=${r.id}`)
  },
  async clone([id]) {
    const r = await resolveRun(id)
    const out = await api(`/api/workflows/${r.workflowSlug}/runs`, { method: 'POST', body: JSON.stringify({ initialPrompt: r.initialPrompt, projectDir: r.projectDir, autoRun: r.autoRun }) })
    console.log(`started ${out.id} (clone of ${r.id.slice(0, 8)})\n${base}/workflows/${r.workflowSlug}?run=${out.id}`)
  },
  async stop([id]) {
    const r = await resolveRun(id)
    const out = await api(`/api/runs/${r.id}/stop`, { method: 'POST' })
    console.log(`${out.id} ${out.status}`)
  },
  async open([id]) {
    const r = await resolveRun(id)
    console.log(`${base}/workflows/${r.workflowSlug}?run=${r.id}`)
  },
}

if (!cmd || cmd === '--help' || cmd === '-h' || !commands[cmd]) {
  console.log(`usage: am <runs|status|start|restart|clone|stop|open> ...\n\n${['runs [--status s]', 'status <runId>', 'start <workflowSlug> "<prompt>" [--dir p] [--auto]', 'restart <runId> [stepId|label] [--note "..."]', 'clone <runId>', 'stop <runId>', 'open <runId>'].map(l => '  am ' + l).join('\n')}\n\nAGENT_MANAGER_URL=${base}`)
  process.exit(cmd && !commands[cmd] ? 1 : 0)
}
commands[cmd](rest).catch((err) => { console.error(err.message); process.exit(1) })

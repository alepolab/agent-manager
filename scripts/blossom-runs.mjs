/**
 * Create one run per Blossom task, against the module that task actually touches.
 *
 *   node scripts/blossom-runs.mjs                 # plan only, creates nothing
 *   node scripts/blossom-runs.mjs --write         # create, up to the capacity cap
 *   node scripts/blossom-runs.mjs --write --only=F1.1,F1.2
 *
 * Dry by default, like recover-run-records.mjs, because every run this creates
 * spends a budget and edits a customer repository. It also respects the
 * instance ceiling (server/utils/runCapacity.ts): the point of that cap is that
 * a bulk creator cannot talk its way past it, so this stops when the API says
 * 429 rather than retrying.
 *
 * Tasks with no module are NOT skipped silently — they are listed as
 * unrunnable with the reason, because a decision, a SQL audit or a UAT
 * walkthrough is human work and an agent pipeline is the wrong tool, not a
 * missing one.
 */
const BASE = process.env.AGENT_MANAGER_URL || 'http://localhost:3000'
const WORKFLOW = process.env.BLOSSOM_WORKFLOW || 'oma-sdlc-jira-to-pr'
const write = process.argv.includes('--write')
const only = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1]?.split(',').filter(Boolean)

const { checkoutDirFor } = await import('../server/utils/workspace.ts')

/** Which repository each task edits. Absent means the work is not a code change. */
const MODULE = {
  'F1.1': 'lum-selfcare-v1', 'F1.2': 'lum-selfcare-v1', 'D2.1': 'lum-selfcare-v1',
  'E1.1': 'lum-selfcare-v1', 'E1.2': 'lum-selfcare-v1', 'E2.1': 'lum-selfcare-v1',
  'A1.1': 'ase_lbss', 'A2.1': 'ase_lbss', 'A2.2': 'ase_lbss', 'A3.1': 'ase_lbss',
  'C1.1': 'ase_lbss', 'C1.2': 'ase_lbss', 'C2.1': 'ase_lbss', 'C2.2': 'ase_lbss',
  'C2.3': 'ase_lbss', 'D1.1': 'ase_lbss', 'D1.2': 'ase_lbss', 'D2.2': 'ase_lbss',
  'B1.1': 'billing_cpp14', 'B1.2': 'billing_cpp14', 'B2.1': 'billing_cpp14', 'B2.2': 'billing_cpp14',
  'G1.1': 'alepo-notifications',
}

/** Why a task has no run, stated rather than left as an absence. */
const NOT_CODE = {
  'B1.0': 'four read-only SQL audits against a live database an agent cannot reach',
  'SEC-0': 'rotating a live credential — a human act, deliberately',
  'A3.2': 'WSC configuration by the SI team, not a repository change',
  'D3.1': 'activates a number through the OSG sandbox', 'D3.2': 'usage simulation on a live number',
  'B1.3': 'test authoring that must follow B1.1 landing', 'C1.3': 'catalogue verification against a running instance',
  'T1.1': 'QA scaffold', 'T1.2': 'QA automation', 'T1.3': 'QA run on NE dev',
  'T2.1': 'assembling a named pack', 'T2.2': 'running that pack', 'T3.1': 'UAT pack reviewed with people',
  'D2.3': 'regression comparison on a live picker', 'F1.3': 'captures from three external services',
  'G1.2': 'sends live notifications to a test subscriber', 'C3.1': 'an end-to-end purchase on a running stack',
  'I2.1': 'snapshot scripts on the instance', 'I2.2': 'a CI check', 'I2.3': 'assembling the alpha package',
}

const { planBriefFor } = await import('../server/utils/planBrief.ts')
const TICKET_FOR = {
  'F1.1': 'SASKNEPCR-22', 'F1.2': 'SASKNEPCR-22', 'A3.1': 'SASKNEPCR-22',
  'A1.1': 'SASKNEPCR-23', 'A2.1': 'SASKNEPCR-23', 'A2.2': 'SASKNEPCR-23',
  'C1.1': 'SASKNEPCR-27', 'C1.2': 'SASKNEPCR-27', 'C2.1': 'SASKNEPCR-27',
  'C2.2': 'SASKNEPCR-27', 'C2.3': 'SASKNEPCR-27',
  'D1.1': 'SASKNEPCR-25', 'D1.2': 'SASKNEPCR-25', 'D2.1': 'SASKNEPCR-25', 'D2.2': 'SASKNEPCR-25',
  'E1.1': 'SASKNEPCR-34', 'E1.2': 'SASKNEPCR-34', 'E2.1': 'SASKNEPCR-29',
  'B1.1': 'SASKNEPCR-5', 'B1.2': 'SASKNEPCR-5', 'B2.1': 'SASKNEPCR-5', 'B2.2': 'SASKNEPCR-5',
  'G1.1': 'SASKNEPCR-5',
}

const ids = only ?? [...Object.keys(MODULE), ...Object.keys(NOT_CODE)]
const runnable = ids.filter(id => MODULE[id])
const skipped = ids.filter(id => !MODULE[id])

console.log(`${runnable.length} runnable, ${skipped.length} not a code change\n`)
for (const id of runnable) {
  const dir = checkoutDirFor(MODULE[id], process.env.USER || undefined)
  console.log(`  ${id.padEnd(6)} ${MODULE[id].padEnd(20)} ${TICKET_FOR[id] ?? '(no ticket)'}  ${dir}`)
}
if (skipped.length) {
  console.log('\nnot created — human or environment work, not a repository change:')
  for (const id of skipped) console.log(`  ${id.padEnd(6)} ${NOT_CODE[id] ?? 'no module mapped'}`)
}

if (!write) {
  console.log(`\nPlan only. Re-run with --write to create the ${runnable.length} runnable ones.`)
  process.exit(0)
}

let created = 0
for (const id of runnable) {
  const ticket = TICKET_FOR[id]
  const prompt = [
    `${ticket ?? 'Blossom'} — implement plan task ${id}.`,
    '',
    `Work only on task ${id}. The implementation brief below lists the other tasks for context;`,
    'do not start them, and do not go beyond this task\'s own done-when.',
    planBriefFor(ticket) ?? '',
  ].join('\n')
  const res = await fetch(`${BASE}/api/workflows/${WORKFLOW}/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ initialPrompt: prompt, autoRun: false, projectDir: checkoutDirFor(MODULE[id], process.env.USER || undefined) }),
  })
  if (res.ok) { created++; console.log(`  created ${id}`); continue }
  const body = await res.text().catch(() => '')
  console.log(`  refused ${id}: HTTP ${res.status} ${body.slice(0, 160)}`)
  // 429 is the capacity ceiling doing its job. Retrying would defeat it.
  if (res.status === 429) { console.log('\ncapacity reached — stopping.'); break }
}
console.log(`\n${created} run(s) created.`)

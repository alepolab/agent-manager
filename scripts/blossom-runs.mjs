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

/** Registry product per module, so the runner is not left to guess from a
 *  ticket key the registry has never seen. */
const PRODUCT = {
  'lum-selfcare-v1': 'lum-selfcare', 'ase_lbss': 'crm',
  'billing_cpp14': 'billing', 'alepo-notifications': 'ans',
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


/** Titles and dependency order, from the plan's section 03. */
const TITLE = {
  'SEC-0': 'Rotate the committed payment-gateway passcode',
  'B1.0': 'Run the four data audits',
  'A1.1': 'NPA to province and service-area map, with one lookup helper',
  'F1.1': 'isRegionAllowed() helper, replacing 28 inlined allow-list checks',
  'F1.2': 'Guard the region-id parse before Bambora and the shipment feed',
  'B1.1': 'MB tax type, MB billing policy, MB plan and add-on clones pointed at it',
  'A2.1': 'serviceProvince and serviceArea columns, plus the history twin',
  'A3.1': 'Extend the CRM states row to SK,MB; flip and rollback runbook',
  'A2.2': 'Set service province at onboarding and re-validate at number assignment',
  'B2.1': 'Extend order-summary and quote responses with rate, code and province',
  'B1.2': 'Harden the quote path with the state guard BillBuilder already has',
  'B2.2': 'Drive the BIRT invoice from the tax table, not two hardcoded GL codes',
  'D3.1': 'Activate an MB test number and diff the provisioning payload',
  'G1.1': 'Notification drift check and the two fixes it finds',
  'C1.1': 'Tag the SK catalogue and author the SK availability rule',
  'C1.2': 'Clone the MB catalogue and author the mirror MB rule',
  'D1.1': 'Build and load the MB number CSV through the existing batch import',
  'D1.2': 'Restricted-NXX handling as a guarded post-import update',
  'D2.1': 'Send the bound service-area parameter; restore by code, not by label',
  'D2.2': 'Backfill the service-area column on existing SK numbers',
  'E1.1': 'Add validatePortInEligibility() to the existing port-in utility',
  'C2.1': 'Bring service options into the availability engine',
  'E1.2': 'Call the validator at four sites, including both outbound bodies',
  'C2.2': 'Filter the three unfiltered list operations server-side',
  'C2.3': 'Add availability-rule evaluation to purchaseService',
  'E2.1': 'Province-key the static wireless port-in address at both sites',
  'C3.1': 'MB data and travel add-on purchased end to end',
  'T2.1': 'Assemble the named SK pack and write the exclusion declaration',
  'T1.1': 'Acceptance-script scaffold, SK regression first',
  'B1.3': 'Per-slab tax assertion on remark and GL code',
  'C1.3': 'Catalogue rule verification, all four cases',
  'T1.2': 'Automate acceptance-script steps 1-6 as the APIs land',
  'D2.3': 'Number-list regression, SK picker identical before and after',
  'F1.3': 'External touchpoint evidence: Canada Post, Bambora, shipment XML',
  'D3.2': 'Usage simulation, EDR check and voicemail provisioning',
  'T1.3': 'Steps 7 and 9, and the full script run on NE dev',
  'G1.2': 'Send the lifecycle set to an MB test subscriber',
  'T2.2': 'Run the named SK pack and publish the report with its exclusions',
  'T3.1': 'UAT case pack in execution order, reviewed and walked through',
  'I2.1': 'Configuration baseline, three snapshot scripts',
  'I2.2': 'Flag register plus a CI check that fails on an unregistered key',
  'I2.3': 'Assemble and publish the alpha package',
  'A3.2': 'WSC configuration: allow-list, MB region entries, signup-reason wording',
}

const DEPS = {
  'C1.1': ['B1.0'], 'D1.1': ['B1.0'], 'C1.2': ['C1.1'], 'B1.1': ['C1.2'],
  'D1.2': ['D1.1'], 'D2.1': ['D1.1'], 'D2.2': ['D2.1', 'B1.0'], 'D2.3': ['D2.2'],
  'A2.2': ['A1.1', 'A2.1'], 'A3.2': ['A3.1'], 'B2.1': ['B1.1'], 'B2.2': ['B1.1'],
  'B1.3': ['B1.1'], 'C1.3': ['C1.2'], 'C2.1': ['C1.2'], 'C2.2': ['C2.1'], 'C2.3': ['C2.1'],
  'C3.1': ['C2.3', 'B1.1'], 'E1.1': ['A1.1'], 'E1.2': ['E1.1'], 'E2.1': ['E1.2'],
  'D3.1': ['D1.1'], 'D3.2': ['D3.1'], 'G1.2': ['G1.1'], 'T1.2': ['T1.1'],
  'T1.3': ['T1.2', 'A3.1'], 'T2.2': ['T2.1'], 'T3.1': ['T1.3'], 'F1.3': ['F1.1'],
  'I2.2': ['A3.1'], 'I2.3': ['T1.3', 'I2.1'],
}

/** The prompt a run starts from: the task, and the brief for its ticket. */
function promptFor(id) {
  const ticket = TICKET_FOR[id]
  return [
    `${ticket ?? 'Blossom'} — implement plan task ${id}: ${TITLE[id] ?? id}`,
    '',
    `Work ONLY on task ${id}. The brief below lists the other tasks for context;`,
    "do not start them, and do not go beyond this task's own done-when.",
    planBriefFor(ticket) ?? '',
  ].join('\n')
}

const ids = only ?? [...Object.keys(MODULE), ...Object.keys(NOT_CODE)]
const runnable = ids.filter(id => MODULE[id])
const skipped = ids.filter(id => !MODULE[id])

console.log(`${runnable.length} runnable, ${skipped.length} not a code change\n`)
for (const id of runnable) {
  const dir = checkoutDirFor(MODULE[id])
  console.log(`  ${id.padEnd(6)} ${MODULE[id].padEnd(20)} ${TICKET_FOR[id] ?? '(no ticket)'}  ${dir}`)
}
if (skipped.length) {
  console.log('\nnot created — human or environment work, not a repository change:')
  for (const id of skipped) console.log(`  ${id.padEnd(6)} ${NOT_CODE[id] ?? 'no module mapped'}`)
}

// --queue creates the WHOLE project as queue tasks, runnable and not, and
// lets the dispatcher mint runs one at a time. That is the difference between
// "what are we doing" and "what is executing right now": 23 of these can
// become runs, 12 of those share one repository and so can never be live
// together, and the other 20 are human work that still belongs on the list.
if (process.argv.includes('--queue')) {
  const order = Object.fromEntries([...runnable, ...skipped].map((id, i) => [id, i]))
  const tasks = [...runnable, ...skipped].map(id => ({
    id,
    title: TITLE[id] ?? id,
    order: order[id],
    deps: (DEPS[id] ?? []).filter(d => order[d] !== undefined),
    workflowSlug: WORKFLOW,
    ...(MODULE[id] ? { module: MODULE[id], projectDir: checkoutDirFor(MODULE[id]) } : {}),
    ...(TICKET_FOR[id] ? { ticketKey: TICKET_FOR[id] } : {}),
    ...(PRODUCT[MODULE[id]] ? { productKey: PRODUCT[MODULE[id]] } : {}),
    ...(MODULE[id] ? { detail: promptFor(id) } : { note: NOT_CODE[id] ?? 'no module mapped' }),
  }))
  const res = await fetch(`${BASE}/api/queue`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: 'Blossom — Manitoba (CR2026016)', tasks }),
  })
  const body = await res.text()
  console.log(res.ok ? `\nqueued ${tasks.length} task(s)` : `\nqueue refused: HTTP ${res.status} ${body.slice(0,300)}`)
  process.exit(res.ok ? 0 : 1)
}

if (!write) {
  console.log(`\nPlan only. --write creates the ${runnable.length} runnable ones; --queue lists all ${runnable.length + skipped.length} as a queue.`)
  process.exit(0)
}

let created = 0
for (const id of runnable) {
  const prompt = promptFor(id)
  const res = await fetch(`${BASE}/api/workflows/${WORKFLOW}/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ initialPrompt: prompt, autoRun: false, projectDir: checkoutDirFor(MODULE[id]) }),
  })
  if (res.ok) { created++; console.log(`  created ${id}`); continue }
  const body = await res.text().catch(() => '')
  console.log(`  refused ${id}: HTTP ${res.status} ${body.slice(0, 160)}`)
  // 429 is the capacity ceiling doing its job. Retrying would defeat it.
  if (res.status === 429) { console.log('\ncapacity reached — stopping.'); break }
}
console.log(`\n${created} run(s) created.`)

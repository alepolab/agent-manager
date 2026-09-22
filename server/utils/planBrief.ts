/**
 * The implementation brief a ticket carries into a run.
 *
 * A Jira ticket states the outcome. It does not state which tasks deliver it,
 * what those tasks depend on, what closes each one, or which of them must ship
 * in the same release as another — that lives in a plan document nobody hands
 * the agent. So a run starts from a summary and a description and rediscovers
 * the sequencing badly, or not at all.
 *
 * This attaches the plan to the ticket at the one point every run passes
 * through (`ticketText` in jiraTicketSource.ts), for manual starts and watch
 * dispatches alike. Nothing is written back to Jira: the ticket stays the
 * customer's, and the brief stays ours.
 *
 * Deliberately a lookup over static data rather than a fetch. A brief that
 * needed a second service to answer would fail exactly when Jira is already
 * struggling, and the sequencing facts it carries change once a sprint, not
 * once a run.
 */

export interface PlanTask {
  id: string
  title: string
  /** The owning lane, so a run knows whose work it is picking up. */
  lane: 'R&D BSS' | 'R&D CAT' | 'QA' | 'DevOps' | 'SI / WSC'
  days: number
  /** Task ids that must be finished first. */
  deps: string[]
  /** The evidence that closes it. Quoted from the plan, not paraphrased. */
  done: string
}

/** Blossom — Lüm Mobile National Expansion (Manitoba), CR2026016, rev 22 Sep 2026 §03. */
const TASKS: PlanTask[] = [
  { id: 'B1.0', title: 'Run the four data audits', lane: 'R&D BSS', days: 0.5, deps: [],
    done: 'Four result sets on the ticket: live tax-type row, Canadian region ids, subscriber province distribution, inventory service-area fill rate.' },
  { id: 'A1.1', title: 'NPA → province and service-area map, with one lookup helper', lane: 'R&D BSS', days: 1.0, deps: [],
    done: '306/639→SK and 204/431→MB resolve through the helper. Admin CRUD, audit and cluster cache-clear come free with the mechanism.' },
  { id: 'F1.1', title: 'isRegionAllowed() helper, replacing 28 inlined allow-list checks', lane: 'R&D BSS', days: 1.5, deps: [],
    done: 'A Winnipeg address accepted on all 9 screens — billing and shipping, create and edit, parent and child. One helper, 28 call sites, one seed key.' },
  { id: 'F1.2', title: 'Guard the region-id parse before Bambora and the shipment feed', lane: 'R&D BSS', days: 0.5, deps: [],
    done: 'A malformed state yields a declared error, not a silent empty province. Protects Saskatchewan too.' },
  { id: 'B1.1', title: 'MB tax type, MB billing policy, MB plan and add-on clones pointed at it', lane: 'R&D BSS', days: 1.0, deps: ['C1.2'],
    done: 'An MB proforma and an MB invoice both show the MB tax lines; an SK proforma and invoice are byte-identical to baseline.' },
  { id: 'A2.1', title: 'serviceProvince and serviceArea columns, plus the history twin', lane: 'R&D BSS', days: 1.0, deps: [],
    done: 'Columns exist, rollback tested, fields appear in the WSC subscriber payload with no REST or OpenAPI change — the mapper is reflective.' },
  { id: 'A3.1', title: 'Extend the CRM states row to SK,MB; write the flip and rollback runbook', lane: 'R&D BSS', days: 1.0, deps: [],
    done: 'The CSR console accepts a Manitoba address exactly when self-care does. Both flags flip together or neither does.' },
  { id: 'A2.2', title: 'Set service province at onboarding and re-validate at number assignment', lane: 'R&D BSS', days: 1.0, deps: ['A1.1', 'A2.1'],
    done: 'A new MB subscriber carries province and service area from the first write; an SK subscriber is unchanged.' },
  { id: 'B2.1', title: 'Extend order-summary and quote responses with rate, code and province', lane: 'R&D BSS', days: 1.5, deps: ['B1.1'],
    done: 'Existing consumers keep working unchanged (they read name and charge). Contract shared with Chandan the day it lands.' },
  { id: 'B1.2', title: 'Harden the quote path with the state guard BillBuilder already has', lane: 'R&D BSS', days: 1.0, deps: [],
    done: 'Quote and invoice provably agree under state-filtered configuration as well as policy-selected.' },
  { id: 'B2.2', title: 'Drive the BIRT invoice from the tax table instead of two hardcoded GL codes', lane: 'R&D BSS', days: 2.0, deps: ['B1.1'],
    done: 'An MB invoice shows only MB components; an SK invoice is unchanged. Removes the GL-code collision.' },
  { id: 'D3.1', title: 'Activate an MB test number and diff the provisioning payload', lane: 'R&D BSS', days: 0.5, deps: ['D1.1'],
    done: 'A byte-level diff showing only the MSISDN and SIP URI differ.' },
  { id: 'G1.1', title: 'Notification drift check and the two fixes it finds', lane: 'R&D BSS', days: 1.0, deps: [],
    done: 'Audit output attached, two Liquibase updates, and the missing dunning and port-in-pending templates named in the known-gaps list.' },

  { id: 'C1.1', title: 'Tag the SK catalogue and author the SK availability rule', lane: 'R&D CAT', days: 1.0, deps: ['B1.0'],
    done: 'The SK plan list is identical in content and order before and after.' },
  { id: 'C1.2', title: 'Clone the MB catalogue and author the mirror MB rule', lane: 'R&D CAT', days: 1.0, deps: ['C1.1'],
    done: 'Every SK plan has an MB twin at the same price with the "— MB" suffix; SIM and eSIM tagged ALL; catalogue diff reviewed with the catalogue owner.' },
  { id: 'D1.1', title: 'Build and load the MB number CSV through the existing batch import', lane: 'R&D CAT', days: 1.5, deps: ['B1.0'],
    done: 'Test range loaded on NE dev and staging with a batch log; a re-run reports duplicates per row and continues. No importer is written.' },
  { id: 'D1.2', title: 'Restricted-NXX handling as a guarded post-import update', lane: 'R&D CAT', days: 1.0, deps: ['D1.1'],
    done: 'A restricted block imports and never appears in a selection response; the listing SQL hard-filters on status.' },
  { id: 'D2.1', title: 'Send the bound service-area parameter; restore by code, not by label', lane: 'R&D CAT', days: 1.5, deps: ['D1.1'],
    done: 'The region filter actually filters. No CRM change at all — that binding already exists in the operation request map.' },
  { id: 'D2.2', title: 'Backfill the service-area column on existing SK numbers', lane: 'R&D CAT', days: 1.0, deps: ['D2.1', 'B1.0'],
    done: 'The SK picker returns the same numbers after the filter goes live as before. Ships in the same release as D2.1 or the SK picker empties.' },
  { id: 'E1.1', title: 'Add validatePortInEligibility() to the existing port-in utility', lane: 'R&D CAT', days: 1.0, deps: ['A1.1'],
    done: 'A discriminated result covering out-of-province, unsupported provider, cross-province-for-existing-subscriber and account-number shape. No new file.' },
  { id: 'C2.1', title: 'Bring service options into the availability engine', lane: 'R&D CAT', days: 2.5, deps: ['C1.2'],
    done: 'Six named files. An MB subscriber add-on list excludes SK-only entries; an SK subscriber list is unchanged.' },
  { id: 'E1.2', title: 'Call the validator at four sites, including both outbound bodies', lane: 'R&D CAT', days: 1.5, deps: ['E1.1'],
    done: 'A 416 number is refused with the agreed message and no carrier request is sent.' },
  { id: 'C2.2', title: 'Filter the three unfiltered list operations server-side', lane: 'R&D CAT', days: 1.0, deps: ['C2.1'],
    done: 'Add-on, top-up and service-option lists filter by province server-side, derived from the subscriber rather than trusted from the client.' },
  { id: 'C2.3', title: 'Add availability-rule evaluation to purchaseService', lane: 'R&D CAT', days: 0.5, deps: ['C2.1'],
    done: 'Posting an SK-only add-on name as an MB subscriber is refused with the existing rule-evaluation error key.' },
  { id: 'E2.1', title: 'Province-key the static wireless port-in address at both injection sites', lane: 'R&D CAT', days: 0.5, deps: ['E1.2'],
    done: 'SK payloads bit-identical; the MB payload carries the MB address.' },
  { id: 'C3.1', title: 'MB data and travel add-on purchased end to end', lane: 'R&D CAT', days: 1.0, deps: ['C2.3', 'B1.1'],
    done: 'A correct MB receipt with MB tax lines, attached to the story.' },

  { id: 'T2.1', title: 'Assemble the named SK pack and write the exclusion declaration', lane: 'QA', days: 1.0, deps: [],
    done: 'Three runnable commands and a page stating what is excluded and why. Named, not promised.' },
  { id: 'T1.1', title: 'Acceptance-script scaffold, with the SK regression as step 8 first', lane: 'QA', days: 1.0, deps: [],
    done: 'A per-step pass/fail report with evidence links, using the reporter existing test-case columns.' },
  { id: 'B1.3', title: 'Per-slab tax assertion on remark and GL code', lane: 'QA', days: 0.5, deps: ['B1.1'],
    done: 'PST present for SK, absent for MB, GST present for both. The only new test this sprint writes.' },
  { id: 'C1.3', title: 'Catalogue rule verification — all four cases', lane: 'QA', days: 0.5, deps: ['C1.2'],
    done: 'All four cases demonstrated: untagged passes, tagged-with-rule passes, tagged-without-rule excluded, no-rules-at-all passes.' },
  { id: 'T1.2', title: 'Automate acceptance-script steps 1–6 as the APIs land', lane: 'QA', days: 1.0, deps: ['T1.1'],
    done: 'Steps 1–3 passing on NE dev at the 2 October show-and-tell — that is the trigger.' },
  { id: 'D2.3', title: 'Number-list regression — SK picker identical before and after', lane: 'QA', days: 0.5, deps: ['D2.2'],
    done: 'Before/after lists diffed. The listing SQL is shared with SIM and eSIM inventory, so those are checked too.' },
  { id: 'F1.3', title: 'External touchpoint evidence — Canada Post, Bambora, shipment XML', lane: 'QA', days: 1.0, deps: ['F1.1'],
    done: 'Three captured request/response pairs. All three are expected to pass unchanged — this is proof, not build.' },
  { id: 'D3.2', title: 'Usage simulation, EDR check and voicemail provisioning on the MB number', lane: 'QA', days: 0.5, deps: ['D3.1'],
    done: 'Rated usage on an MB number matches an SK number on the same plan.' },
  { id: 'T1.3', title: 'Steps 7 and 9, and the full script run on NE dev', lane: 'QA', days: 1.0, deps: ['T1.2', 'A3.1'],
    done: 'Step 9 — the journey unreachable with Manitoba disabled — needs the flag from A3.1.' },
  { id: 'G1.2', title: 'Send the lifecycle set to an MB test subscriber', lane: 'QA', days: 0.5, deps: ['G1.1'],
    done: 'Rendered email and SMS attached, with the two missing templates called out.' },
  { id: 'T2.2', title: 'Run the named SK pack and publish the report with its exclusions', lane: 'QA', days: 1.0, deps: ['T2.1'],
    done: 'Green, with a stated list of what was not run. An honest amber beats a green that inherited 881 excluded tests.' },
  { id: 'T3.1', title: 'UAT case pack in execution order, reviewed and walked through', lane: 'QA', days: 1.5, deps: ['T1.3'],
    done: 'Every MVP scenario maps to a UAT case; reviewer initials on each; pack version matches the build.' },

  { id: 'I2.1', title: 'Configuration baseline — three snapshot scripts, pre-Blossom output committed', lane: 'DevOps', days: 0.5, deps: [],
    done: 'A mechanical diff, not a hand-written delta document.' },
  { id: 'I2.2', title: 'Flag register plus a CI check that fails on an unregistered key', lane: 'DevOps', days: 0.5, deps: ['A3.1'],
    done: 'Catches the real failure mode — a flag nobody removes — with no runtime change.' },
  { id: 'I2.3', title: 'Assemble and publish the alpha package', lane: 'DevOps', days: 1.0, deps: ['T1.3', 'I2.1'],
    done: 'Lesleah can pre-brief testers from the package alone.' },

  { id: 'A3.2', title: 'WSC configuration: allow-list, MB region entries, signup-reason wording', lane: 'SI / WSC', days: 0.5, deps: ['A3.1'],
    done: 'Ships in the same change as A3.1. Split-brain between the two flags is the failure this pairing prevents.' },
]

const BY_ID = new Map(TASKS.map(t => [t.id, t]))

/**
 * Which plan tasks deliver which ticket.
 *
 * Derived from the ticket titles and the plan's own task descriptions, NOT
 * from a mapping anyone has signed off. It is here as editable data for
 * exactly that reason: a wrong row is one line to fix, and a brief that names
 * the wrong tasks is worse than no brief.
 */
const TICKET_TASKS: Record<string, string[]> = {
  'SASKNEPCR-22': ['F1.1', 'F1.2', 'A3.1', 'A3.2'],
  'SASKNEPCR-23': ['A1.1', 'A2.1', 'A2.2', 'C1.1', 'C1.2'],
  'SASKNEPCR-24': ['A1.1', 'A2.1', 'A2.2', 'C1.1', 'C1.2'],
  'SASKNEPCR-25': ['D1.1', 'D1.2', 'D2.1', 'D2.2', 'D2.3'],
  'SASKNEPCR-26': ['D1.1', 'D1.2', 'D2.1', 'D2.2', 'D2.3'],
  'SASKNEPCR-27': ['C1.1', 'C1.2', 'C2.1', 'C2.2', 'C2.3'],
  'SASKNEPCR-28': ['A1.1', 'A2.2', 'D2.1'],
  'SASKNEPCR-29': ['E1.1', 'E1.2', 'E2.1', 'A1.1'],
  'SASKNEPCR-30': ['F1.1', 'A2.2', 'C1.2'],
  'SASKNEPCR-31': ['F1.1', 'A2.2'],
  'SASKNEPCR-32': ['C1.2', 'A2.2'],
  'SASKNEPCR-33': ['F1.1', 'A2.2'],
  'SASKNEPCR-34': ['E1.1', 'E1.2', 'A1.1'],
  'SASKNEPCR-35': ['E1.1', 'E1.2', 'A1.1'],
  // Project-level tickets, where the brief is the whole lane rather than a journey.
  'SASKNEPCR-5': ['B1.0', 'C1.1', 'C1.2', 'B1.1', 'A1.1', 'A2.1', 'A2.2', 'F1.1', 'D2.1', 'C2.1', 'E1.1'],
  'SASKNEPCR-7': ['T2.1', 'T2.2', 'B1.3', 'C1.3', 'D2.3', 'F1.3'],
  'SASKNEPCR-13': ['T1.1', 'T1.2', 'T1.3', 'T3.1'],
}

/**
 * Rules that hold across every ticket, and that a run reading one ticket has
 * no way to discover. Each is a failure that has already happened once, or a
 * named risk in the plan's own register.
 */
const CROSS_CUTTING = [
  'C1.1 ships the tag AND the rule in one change. A tagged entity that no active rule covers is EXCLUDED, so tagging first makes every SK plan vanish the moment the first rule goes live (risk R1; this already happened on SBN-1741).',
  'D2.1 and D2.2 ship in the same release. Binding the filter turns a dead parameter into a live predicate against a column that may be null on every existing SK row, which empties the SK number picker (risk R2).',
  'A3.1 and A3.2 flip together or neither flips. CRM and WSC hold one enablement flag each; one without the other leaves the CSR console and self-care disagreeing about whether Manitoba exists.',
  'Manitoba tax is CONFIGURATION, not code: tax policy is selected per product and per plan by identical logic on the quote path and the invoice path. Do not flip the apply-state flag on the Saskatchewan PST slab — it would stop charging PST to every subscriber whose province is blank or unexpected, with no test to catch it.',
  'A port-in guard on a form validates nothing: the approve screen has no form group and rebuilds all 28 request fields from saved state. Guard the outbound request bodies (risk R4).',
  'Saskatchewan must be provably unchanged. Any task touching catalogue, tax, numbering or address carries an SK-unchanged assertion as part of its own done-when, not as someone else regression pass.',
].map(s => `- ${s}`).join('\n')

/** One task, as the lines a run should read before starting it. */
function describe(t: PlanTask): string {
  const deps = t.deps.length ? t.deps.join(', ') : 'nothing'
  return `  ${t.id} · ${t.lane} · ${t.days}d · after: ${deps}\n    ${t.title}\n    Done when: ${t.done}`
}

/**
 * The brief for a ticket, or null when the plan says nothing about it.
 *
 * Null rather than an empty section: a heading with nothing under it reads as
 * "there is no work here", which is a different claim from "this ticket is not
 * in the plan".
 */
export function planBriefFor(ticketKey: string | undefined): string | null {
  if (!ticketKey) return null
  const ids = TICKET_TASKS[ticketKey.toUpperCase()]
  if (!ids?.length) return null

  const tasks = ids.map(id => BY_ID.get(id)).filter((t): t is PlanTask => !!t)
  if (!tasks.length) return null

  // Dependencies that live outside this ticket's own set are the ones most
  // likely to be missed, so they are called out rather than left to be
  // inferred from the `after:` lines.
  const own = new Set(tasks.map(t => t.id))
  const external = [...new Set(tasks.flatMap(t => t.deps).filter(d => !own.has(d)))]
    .map(id => BY_ID.get(id)).filter((t): t is PlanTask => !!t)

  const days = tasks.reduce((s, t) => s + t.days, 0)

  return [
    '',
    '--- Implementation brief (Blossom, CR2026016, plan rev 22 Sep 2026) ---',
    'Not from Jira. This is the delivery plan for this ticket; the ticket above is the customer\'s statement of the outcome.',
    '',
    `Tasks that deliver it (${tasks.length}, ${days.toFixed(1)} person-days):`,
    ...tasks.map(describe),
    ...(external.length
      ? ['', 'Must already be finished elsewhere before these can start:', ...external.map(describe)]
      : []),
    '',
    'Rules that hold regardless of which task you are on:',
    CROSS_CUTTING,
  ].join('\n')
}

/** Exposed for the test and for an operator checking coverage. */
export function planBriefTickets(): string[] {
  return Object.keys(TICKET_TASKS)
}

/**
 * A dispatched child run carries only a ticket that was really created for it.
 *
 *   node scripts/test-dispatch-never-invents-a-ticket.mjs
 *
 * Observed live on 2026-09-11: run 1bba2e7b dispatched three children after its
 * create step had filed nothing (an invalid priority, two required custom
 * fields). Child d5a80932 adopted ASECRM-193 — named only in a triage dedup
 * note as an adjacent ticket — and its first step moved that ticket to In
 * Progress and reassigned it from its owner. The other two took `DRAFT-001`
 * and `DRAFT-002` as Jira keys and died trying to read their transitions.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ══ A dispatched child never invents a ticket key ═════════════════════════
//
// Three children were dispatched from a scan whose create step had filed
// nothing. Two adopted their own draft id (`DRAFT-001`) as a Jira key; the
// third took ASECRM-193 — a real, unrelated ticket that a triage dedup note
// merely MENTIONED — moved it to In Progress and reassigned it away from the
// colleague who owned it.
const runner = readFileSync(join(import.meta.dirname, '..', 'server/utils/workflowRunner.ts'), 'utf8')

// The dispatch takes the key from the issue that was actually created for the
// entry, not from the entry's name. `entryKey` falls back to a draft id, and
// `DRAFT-001` satisfies any PROJ-NNN shape test.
assert.match(runner, /ticketKey: typeof t\.entry\.jira_key === 'string'/,
  "a child's ticket key must come from entry.jira_key — the issue a create step filed")
assert.ok(!/ticketKey: \/\^\[A-Z\]/.test(runner),
  'a shape test on the entry name accepts DRAFT-001 as a Jira key')

// And a child must not re-read one out of its own prompt: the prompt embeds the
// whole entry, dedup prose and all.
assert.match(runner, /opts\.ticketKey \?\? \(opts\.parentRunId \? undefined :/,
  'only a run nobody dispatched may read a key from its prompt text')

// The product travels from parent to child, rather than being re-guessed from
// the child's prompt: two of the three children resolved a different product
// than the one that had just been scanned.
assert.match(runner, /productKey: run\.product\.name/,
  'a dispatched child inherits the product the parent already resolved')
assert.match(runner, /\.\.\.\(item\.productKey \? \{ productKey: item\.productKey \} : \{\}\)/,
  'and startChild passes it on')

// A Jira step can halt, so a create step that filed nothing fails its branch
// instead of reporting completed.
assert.match(runner, /const jiraHalt = parseHalt\(output\)/,
  'a Jira step honours PIPELINE-HALT the way an agent step does')

console.log('dispatch: a child carries only a ticket that exists, and the product its parent resolved')

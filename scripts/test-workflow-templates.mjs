/**
 * Self-check for materializeTemplateSteps in app/utils/workflowTemplates.ts - turning a
 * template's local ids into a real workflow's generated step ids, edges included.
 *
 *   node scripts/test-workflow-templates.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { materializeTemplateSteps, workflowTemplates as WORKFLOW_TEMPLATES } from '../app/utils/workflowTemplates.ts'
import { agentTemplates as AGENT_TEMPLATES } from '../app/utils/templates.ts'

const slugs = { alpha: 'agent-alpha', beta: 'agent-beta', gamma: 'agent-gamma' }

// ── 1. A template with no `next` stays a plain chain ──────────────────────
{
  const template = {
    id: 't', name: 'T', description: '', icon: '',
    steps: [
      { agentTemplateId: 'alpha', label: 'A' },
      { agentTemplateId: 'beta', label: 'B' },
    ],
  }
  const steps = materializeTemplateSteps(template, slugs)
  assert.equal(steps.length, 2)
  assert.deepEqual(steps.map(s => s.agentSlug), ['agent-alpha', 'agent-beta'])
  assert.deepEqual(steps.map(s => s.label), ['A', 'B'])
  // No explicit edges - the graph builder reads these in array order, as it does today.
  assert.equal(steps[0].next, undefined)
  assert.equal(steps[1].next, undefined)
}

// ── 2. Every step gets its own unique generated id ────────────────────────
{
  const template = {
    id: 't', name: 'T', description: '', icon: '',
    steps: [
      { agentTemplateId: 'alpha', label: 'A' },
      { agentTemplateId: 'beta', label: 'B' },
    ],
  }
  const steps = materializeTemplateSteps(template, slugs)
  assert.equal(new Set(steps.map(s => s.id)).size, 2)
  assert.ok(steps.every(s => typeof s.id === 'string' && s.id.length > 0))
}

// ── 3. `next` is translated from template ids to generated step ids ───────
{
  const template = {
    id: 't', name: 'T', description: '', icon: '',
    steps: [
      { agentTemplateId: 'alpha', label: 'A', next: ['beta', 'gamma'] },
      { agentTemplateId: 'beta', label: 'B', next: ['gamma'] },
      { agentTemplateId: 'gamma', label: 'C', next: [] },
    ],
  }
  const steps = materializeTemplateSteps(template, slugs)
  const byLabel = Object.fromEntries(steps.map(s => [s.label, s]))

  assert.deepEqual(byLabel.A.next, [byLabel.B.id, byLabel.C.id], 'A fans out to B and C')
  assert.deepEqual(byLabel.B.next, [byLabel.C.id], 'B joins into C')
  // An explicit empty `next` marks a terminal node and must survive as an empty array,
  // not collapse to "no edges declared".
  assert.deepEqual(byLabel.C.next, [])
  // Nothing may still be pointing at a template-local id.
  const ids = new Set(steps.map(s => s.id))
  for (const step of steps) for (const target of step.next ?? []) assert.ok(ids.has(target))
}

// ── 4. The same agent template used twice gets two distinct step ids ──────
// Before the fix, ids were keyed by `agentTemplateId`, so both steps collapsed
// onto the same generated id and the repeated step became unreachable
// (stepById()/indexOf() only ever resolve the first match).
{
  const template = {
    id: 't', name: 'T', description: '', icon: '',
    steps: [
      { agentTemplateId: 'alpha', label: 'First Alpha', next: ['beta'] },
      { agentTemplateId: 'beta', label: 'Beta', next: ['alpha'] },
      { agentTemplateId: 'alpha', label: 'Second Alpha' },
    ],
  }
  const steps = materializeTemplateSteps(template, slugs)
  assert.equal(steps.length, 3)
  assert.equal(new Set(steps.map(s => s.id)).size, 3, 'every step must get its own unique id, even when agentTemplateId repeats')
  assert.deepEqual(steps.map(s => s.agentSlug), ['agent-alpha', 'agent-beta', 'agent-alpha'])
  assert.deepEqual(steps.map(s => s.label), ['First Alpha', 'Beta', 'Second Alpha'])
}

// ── 5. A `next` naming a step that got filtered out drops that target ─────
// The caller filters `template.steps` down to steps whose agent template resolved
// before calling materializeTemplateSteps, so `agentSlugByTemplateId`/the passed-in
// `template.steps` may be missing an id that an earlier step's `next` still names
// (its agent template failed to resolve). That must not survive as `undefined`.
{
  const template = {
    id: 't', name: 'T', description: '', icon: '',
    steps: [
      // 'beta' is referenced here but never appears in `steps` below - simulates
      // its agent template having failed to resolve, so the caller dropped it.
      { agentTemplateId: 'alpha', label: 'A', next: ['beta', 'gamma'] },
      { agentTemplateId: 'gamma', label: 'C', next: [] },
    ],
  }
  const steps = materializeTemplateSteps(template, slugs)
  const byLabel = Object.fromEntries(steps.map(s => [s.label, s]))
  // The unresolved 'beta' target is dropped; the still-resolvable 'gamma' target survives.
  assert.deepEqual(byLabel.A.next, [byLabel.C.id])
  // No `undefined`/`null` ever leaks into a `next` array.
  for (const step of steps) for (const target of step.next ?? []) assert.notEqual(target, undefined)
}

// ── 6. A `next` whose EVERY target got filtered out falls back to array order ──
// Dropping every target would otherwise leave `next: []`, which buildGraph treats
// as a deliberate terminal step (NOT the same as `next: undefined`, which falls
// back to array order) - silently truncating the workflow at exactly the step
// that was supposed to keep it going. Losing all targets is a gap, not a
// declared stop, so `next` is left unset instead so array order takes over.
{
  const template = {
    id: 't', name: 'T', description: '', icon: '',
    steps: [
      // Both of A's declared targets are missing from `steps` (filtered out upstream).
      { agentTemplateId: 'alpha', label: 'A', next: ['beta', 'gamma'] },
      { agentTemplateId: 'delta', label: 'D' },
    ],
  }
  const steps = materializeTemplateSteps(template, { ...slugs, delta: 'agent-delta' })
  const byLabel = Object.fromEntries(steps.map(s => [s.label, s]))
  assert.equal(byLabel.A.next, undefined, 'losing every declared target must fall back to array order, not collapse to an empty terminal next')

  // An explicit empty `next` (a genuine declared terminal step) is a different case
  // and must NOT be reinterpreted as "targets were lost" - it stays `[]`.
  const terminalTemplate = {
    id: 't2', name: 'T2', description: '', icon: '',
    steps: [{ agentTemplateId: 'alpha', label: 'A', next: [] }],
  }
  const terminalSteps = materializeTemplateSteps(terminalTemplate, slugs)
  assert.deepEqual(terminalSteps[0].next, [])
}

// ── 7. Runbook A declares the wiring its evidence bundle depends on ───────
{
  const runbook = WORKFLOW_TEMPLATES.find(t => t.id === 'runbook-a-jira-to-diff')
  assert.ok(runbook, 'the Runbook A template exists')

  const slugs = Object.fromEntries(runbook.steps.map(s => [s.agentTemplateId, s.agentTemplateId]))
  slugs['sdlc-step-monitor'] = 'sdlc-step-monitor'
  const steps = materializeTemplateSteps(runbook, slugs)

  const evidence = steps.find(s => s.agentSlug === 'sdlc-evidence-and-pr')
  assert.equal(evidence.contextMode, 'ancestors',
    'the evidence step must see the pre-fix FAIL, which is three hops upstream')

  const provisioner = steps.find(s => s.agentSlug === 'sdlc-stack-provisioner')
  const verifier = steps.find(s => s.agentSlug === 'sdlc-verifier')
  assert.equal(provisioner.monitorSlug, 'sdlc-step-monitor',
    'a silent stack failure makes everything after it meaningless')
  assert.equal(verifier.monitorSlug, 'sdlc-step-monitor')

  // The monitor agent must actually exist, or monitorSlug names nothing and
  // runMonitor's catch quietly turns every review into CONTINUE.
  assert.ok(AGENT_TEMPLATES.find(a => a.id === 'sdlc-step-monitor'),
    'the monitor agent template exists')

  // An unresolvable monitor is dropped rather than kept as a dangling name.
  const noMonitor = materializeTemplateSteps(
    runbook, Object.fromEntries(runbook.steps.map(s => [s.agentTemplateId, s.agentTemplateId])))
  assert.equal(noMonitor.find(s => s.agentSlug === 'sdlc-verifier').monitorSlug, undefined,
    'a monitorSlug that resolves to nothing is dropped, not left dangling')
}

// ── 8. The sdlc prompts instruct what the evidence bundle requires ────────
{
  // AgentTemplate has no `prompt` field (the brief's snippet names one that
  // does not exist) - the prompt text lives in `.body`, per the actual
  // AgentTemplate interface in app/utils/templates.ts.
  const body = id => AGENT_TEMPLATES.find(a => a.id === id).body
  assert.match(body('sdlc-test-author'), /oracle-before\.xml/,
    'the test author is told the exact artifact filename the assembler reads')
  assert.match(body('sdlc-test-author'), /three times/i,
    'three-run determinism is instructed, or the bundle fails at oracle.runs')
  assert.match(body('sdlc-verifier'), /oracle-after\.xml/)
  assert.match(body('sdlc-verifier'), /regression\.xml/)
  assert.match(body('sdlc-ticket-intake'), /intent\.md/)
  assert.match(body('sdlc-ticket-intake'), /context-packet\.json/)
  assert.match(body('sdlc-fix-implementer'), /plan\.md/)
  assert.match(body('sdlc-evidence-and-pr'), /summary\.md/)
  for (const id of ['sdlc-ticket-intake', 'sdlc-stack-provisioner', 'sdlc-test-author',
                    'sdlc-fix-implementer', 'sdlc-verifier', 'sdlc-trace-capture',
                    'sdlc-evidence-and-pr']) {
    assert.match(body(id), /PIPELINE-HALT/,
      `${id} must know how to stop the run rather than report failure downstream`)
  }
}

// ── 9. Every closed enum's allowed values are taught, verbatim, in the
//    prompt of the agent that writes that field. Values are read from the
//    schema itself at test time, not copied a second time here — so when
//    the schema gains or renames a value, this test goes red until the
//    prompt catches up, instead of the two silently drifting apart. ──────
{
  const schemaPath = new URL('../engineering/schemas/evidence-bundle.v0.1.schema.json', import.meta.url)
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
  const body = id => AGENT_TEMPLATES.find(a => a.id === id).body

  const enumChecks = [
    { field: 'work_type', values: schema.properties.work_type.enum, owners: ['sdlc-ticket-intake'] },
    // class's enum includes `null` (meaning "not a bug") - that is a JSON
    // value, not a word an agent writes into prose, so it is excluded here.
    { field: 'class', values: schema.properties.class.enum.filter(v => v !== null), owners: ['sdlc-ticket-intake'] },
    { field: 'blast_radius', values: schema.properties.blast_radius.enum, owners: ['sdlc-ticket-intake'] },
    // Both oracle and oracle_after are $defs.oracle_run - the same closed
    // enum applies to whichever step is filling in `kind` for that phase.
    { field: 'oracle.kind / oracle_after.kind', values: schema.$defs.oracle_run.properties.kind.enum,
      owners: ['sdlc-test-author', 'sdlc-verifier'] },
  ]

  for (const { field, values, owners } of enumChecks) {
    assert.ok(Array.isArray(values) && values.length > 0,
      `${field}: expected a non-empty schema enum - this check is meaningless against zero values`)
    for (const owner of owners) {
      const text = body(owner)
      for (const value of values) {
        // Backticked, not bare. A bare substring check cannot tell "taught as
        // an allowed value" from "happens to appear in prose" - and most of
        // these enum values are ordinary English words. Adding `deployment`
        // to the schema passed this test unchanged, purely because the prompt
        // already said "Deployment truths" in an unrelated section.
        assert.ok(text.includes('`' + value + '`'),
          `${owner}'s prompt must name the literal ${field} value "${value}" verbatim - ` +
          `an agent that has never seen the word can't write it, and the schema rejects anything else`)
      }
    }
  }
}

// ── 10. sdlc-stack-provisioner must produce executed-command evidence or
//    halt — reading the compose file by eye is explicitly ruled out as a
//    third outcome, not merely discouraged. This is the DEVOPS-23 defect:
//    the agent had Bash, never ran it, and wrote a confident report anyway. ─
{
  const body = id => AGENT_TEMPLATES.find(a => a.id === id).body
  const provisioner = body('sdlc-stack-provisioner')
  assert.match(provisioner, /docker compose config/,
    'the static-evidence substitute for an unreachable live stack must be named by its real command')
  assert.match(provisioner, /exit code/i,
    'command evidence must require the exit code, not just prose claiming success')
  assert.match(provisioner, /not one of them/i,
    'a report produced from reading alone must be explicitly ruled out as an outcome, not just discouraged')
}

// ── 11. sdlc-ticket-intake must be told exactly where to find the real
//    plugin_version and must never accept a placeholder that passes the
//    schema's type check while being unverifiable ("unknown" is a string,
//    so it validates - that is the defect). ───────────────────────────────
{
  const body = id => AGENT_TEMPLATES.find(a => a.id === id).body
  const intake = body('sdlc-ticket-intake')
  assert.match(intake, /~\/\.claude\/plugins\//,
    'the prompt must name the concrete search path for the installed plugin, not just "read it from the plugin"')
  assert.match(intake, /\.claude-plugin\/plugin\.json/,
    'the prompt must name the exact file to read the version field from')
  assert.match(intake, /never a placeholder/i,
    'an unreadable plugin_version must halt the run, not fall back to a placeholder string')
}

// A directly-invoked run has no watch, but the schema requires the field as a
// non-nullable string. The reserved literal is the only honest value, and the
// prompt is the only place an agent can learn it — a live run wrote `null` and
// would have failed assembly.
{
  const intake = AGENT_TEMPLATES.find(a => a.id === 'sdlc-ticket-intake').body
  assert.ok(intake.includes('`direct-invocation`'),
    'sdlc-ticket-intake must name the reserved watch literal for a directly-invoked run')
  assert.ok(/never\s+\\?`?null/i.test(intake) || intake.includes('Never `null`'),
    'the prompt must rule out null for watch, which is what a live run actually wrote')
}

// ── 12. The standing-rules section is word-for-word identical across every
//    `sdlc-*` body. It is meant to read as a shared rule, not per-agent
//    advice — a future edit that tweaks it in one body and not the others
//    would defeat that, silently. Checked against the literal source text of
//    SDLC_STANDING_RULES rather than a paraphrase, so a wording change in one
//    place is guaranteed to still match every body it was copied into. ──────
{
  const source = readFileSync(new URL('../app/utils/templates.ts', import.meta.url), 'utf8')
  const constMatch = source.match(/const SDLC_STANDING_RULES = `([\s\S]*?)`\n/)
  assert.ok(constMatch, 'SDLC_STANDING_RULES constant must exist in app/utils/templates.ts')
  // The constant's own source uses \` to escape literal backticks inside the
  // template literal; un-escape those the same way the JS engine would so the
  // comparison is against the actual runtime string, not its escaped source.
  const standingRules = constMatch[1].replace(/\\`/g, '`').replace(/\\\$/g, '$')

  const sdlcIds = ['sdlc-ticket-intake', 'sdlc-stack-provisioner', 'sdlc-test-author',
                    'sdlc-fix-implementer', 'sdlc-verifier', 'sdlc-trace-capture',
                    'sdlc-evidence-and-pr']
  const body = id => AGENT_TEMPLATES.find(a => a.id === id).body
  for (const id of sdlcIds) {
    assert.ok(body(id).includes(standingRules),
      `${id}'s body must carry the SDLC_STANDING_RULES section verbatim - ` +
      `it is meant to read as a standing rule, not advice that can drift per agent`)
  }
}

// ── 13. No `sdlc-*` frontmatter block contains a repeated key. TypeScript
//    silently resolves a duplicate object key to the last occurrence, so an
//    insertion that lands inside the wrong block would not fail to compile -
//    it would just quietly discard whatever the first occurrence set. That
//    happened once already while this file was being edited. Scanned against
//    the raw source text, since by the time the object is imported the
//    duplicate has already collapsed and there is nothing left to detect. ───
{
  const source = readFileSync(new URL('../app/utils/templates.ts', import.meta.url), 'utf8')
  // Each agent template entry starts with `id: '<id>',` at the object's top level
  // (two-space indent) - split the file into per-entry chunks on that boundary.
  const entryStarts = [...source.matchAll(/^  \{\n    id: '([^']+)',/gm)]
  assert.ok(entryStarts.length > 0, 'expected to find at least one agent template entry')

  for (let i = 0; i < entryStarts.length; i++) {
    const id = entryStarts[i][1]
    const start = entryStarts[i].index
    const end = i + 1 < entryStarts.length ? entryStarts[i + 1].index : source.length
    const entry = source.slice(start, end)

    const frontmatterMatch = entry.match(/frontmatter: \{([\s\S]*?)\n    \},\n    body:/)
    assert.ok(frontmatterMatch, `${id}: expected a frontmatter block bounded by 'frontmatter: {' ... '},\\n    body:'`)

    // Frontmatter values in this file are strings, numbers, or flat arrays -
    // no nested objects - so every top-level key is a line matching this shape.
    const keyLines = [...frontmatterMatch[1].matchAll(/^      (\w+):/gm)].map(m => m[1])
    const seen = new Set()
    const duplicates = new Set()
    for (const key of keyLines) {
      if (seen.has(key)) duplicates.add(key)
      seen.add(key)
    }
    assert.equal(duplicates.size, 0,
      `${id}'s frontmatter block has a repeated key (${[...duplicates].join(', ')}) - ` +
      'TypeScript resolves this to the last occurrence silently, discarding the first')
  }
}

console.log('workflowTemplates: all assertions passed')

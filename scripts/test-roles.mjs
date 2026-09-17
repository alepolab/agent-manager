/**
 * Who may do what, and the two ways that question gets answered wrongly.
 *
 * The first is the obvious one: a role gains a power it should not have. The
 * second is the one this app was built into — every signed-in person was an
 * operator, so a reviewer whose job is to say yes or no was handed stop,
 * restart-from-any-step, clone and a box that steers a mid-flight agent.
 *
 * The third case here is the one a UI cannot cover: hiding a button is a
 * courtesy to the person, not a control on the request, so the capability
 * table has to be the thing the server asks.
 *
 *   node scripts/test-roles.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'roles-'))
process.env.CLAUDE_DIR = root

const { can, capabilitiesFor, DEFAULT_ROLE, ROLES, ROLE_LABEL, rolesWith } = await import('../shared/types/role.ts')
const { listRoles, roleFor, setRole, effectiveRole } = await import('../server/utils/roles.ts')

// ── 1. the capability table says what each role is for ───────────────────────
{
  // A reviewer decides; they do not drive. This pair is the whole point.
  for (const role of ['developer', 'qa', 'architect', 'designer']) {
    assert.equal(can(role, 'answerGate'), true, `${role} must be able to answer a gate`)
    assert.equal(can(role, 'runEngine'), false, `${role} must not be able to drive the run`)
    assert.equal(can(role, 'configure'), false, `${role} must not be able to configure the pipeline`)
  }
  // An architect starts work; a designer accepts what a run produced. The
  // difference between the two new rows is `startRun` and nothing else.
  assert.equal(can('architect', 'startRun'), true, 'an architect starts spikes and contract-first work')
  assert.equal(can('designer', 'startRun'), false, 'a designer accepts output rather than owning a scope that produces runs')
  // `configure` covers `roles.json`, so granting it to a reviewer is promotion
  // to operator by another name. Only the operator holds it.
  assert.deepEqual(rolesWith('configure'), ['operator'], 'exactly one role configures the pipeline')
  // A manager reads. Every write is somebody else's.
  const manager = capabilitiesFor('manager')
  assert.deepEqual(
    Object.entries(manager).filter(([, v]) => v).map(([k]) => k),
    ['readAllRuns'],
    'a manager may only read',
  )
  // An operator is unchanged from the app before roles existed.
  assert.ok(Object.values(capabilitiesFor('operator')).every(Boolean), 'an operator keeps everything')
}

// ── 2. an unlisted login is an operator, so adding roles changes nothing ─────
// The alternative default demotes every colleague the moment the file appears,
// on an instance several people share.
{
  assert.equal(DEFAULT_ROLE, 'operator')
  assert.deepEqual(await listRoles(), {}, 'no file means nobody is listed')
  assert.equal(await roleFor('someone-not-listed'), 'operator')
  assert.equal(await roleFor(undefined), 'operator', 'an anonymous request is not a demotion')
}

// ── 3. a listed login holds what it was given, and clearing restores default ─
{
  await setRole('a-developer', 'developer')
  await setRole('a-manager', 'manager')
  assert.equal(await roleFor('a-developer'), 'developer')
  assert.equal(await roleFor('a-manager'), 'manager')
  assert.equal(await roleFor('still-unlisted'), 'operator')

  await setRole('a-developer', null)
  assert.equal(await roleFor('a-developer'), 'operator', 'clearing a role returns the login to the default')
}

// ── 4. a corrupt or hostile roles file degrades to "nobody listed" ───────────
// Never to "nobody may do anything": locking the team out of their own pipeline
// because a file got truncated is a worse failure than the one it prevents.
{
  writeFileSync(join(root, 'roles.json'), '{ not json at all', 'utf-8')
  assert.deepEqual(await listRoles(), {})
  assert.equal(await roleFor('anyone'), 'operator')

  writeFileSync(join(root, 'roles.json'), JSON.stringify(['developer']), 'utf-8')
  assert.deepEqual(await listRoles(), {}, 'an array is not a role map')

  // A typo'd role is dropped rather than coerced: reading "reviewer" as a
  // developer would hide the typo for good.
  writeFileSync(join(root, 'roles.json'), JSON.stringify({ someone: 'reviewer', other: 'qa' }), 'utf-8')
  assert.deepEqual(await listRoles(), { other: 'qa' })
  assert.equal(await roleFor('someone'), 'operator')
}

// ── 5. view-as only ever narrows ─────────────────────────────────────────────
// It exists so an operator can see what a developer sees without a second
// account. A stored value that would widen is ignored, not obeyed.
{
  assert.equal(effectiveRole('operator', 'developer'), 'developer')
  assert.equal(effectiveRole('operator', null), 'operator')
  assert.equal(effectiveRole('developer', 'operator'), 'developer', 'a developer cannot view as an operator')
  assert.equal(effectiveRole('manager', 'developer'), 'manager', 'only an operator may view as anyone')
  assert.equal(effectiveRole('operator', 'nonsense'), 'operator', 'an unknown role is not a role')
}

// ── 6. every role in ROLES has a capability row ──────────────────────────────
// A role added to the type without a row would silently fall back to the
// operator defaults — which is the failure mode this whole file is about.
for (const role of ROLES) {
  assert.ok(capabilitiesFor(role), `${role} has no capabilities row`)
  // A role with no label reaches the Team page and the role picker as a blank
  // line, which reads as a broken instance rather than as a missing string.
  assert.ok(ROLE_LABEL[role]?.trim(), `${role} has no ROLE_LABEL`)
}

rmSync(root, { recursive: true, force: true })
// ── a gate has two answers, and both belong to the same role ────────────────
// A reviewer could approve and nothing else: `stop`, `restart` and `note` are
// all `runEngine`, which developer and QA do not hold, so refusing meant asking
// an operator to press Stop. A gate whose only affordance is yes is not a gate.
//
// Asserted against the route source because the handler imports Nuxt globals
// and cannot be imported into a plain node test. That makes this a weaker check
// than the capability tests above — it catches the route being widened to
// runEngine or losing its required reason, not the runtime behaviour.
{
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(import.meta.dirname, '..', 'server/api/runs/[id]/reject.post.ts'), 'utf8')

  assert.match(src, /requireCapability\(event, 'answerGate'\)/,
    'reject must sit on answerGate — the same capability as approve, or the roles that own the gate cannot use it')
  assert.doesNotMatch(src, /requireCapability\(event, 'runEngine'\)/,
    'and must not be gated on runEngine, which developer and qa do not hold')
  assert.match(src, /statusCode: 400/,
    'a refusal without a reason is refused: the reason is the point of the gate')
  assert.match(src, /statusCode: 409/,
    'and a run that is not waiting on a decision has nothing to reject')
  assert.match(src, /run\.error = /,
    'the reason is recorded, or a rejected run reads exactly like a crashed one')

  // The capability table decides who that reaches; assert it here too so the
  // two halves cannot drift apart.
  for (const role of ['developer', 'qa']) assert.equal(can(role, 'answerGate'), true, `${role} must be able to answer a gate both ways`)
  assert.equal(can('manager', 'answerGate'), false, 'a manager reads; deciding is not theirs')
}

// ── a template must not hand a gate to a role that cannot answer one ────────
// The failure this catches shipped for real: the CSUP template declared its
// ship gate `gateRole: 'manager'` while `manager` holds `answerGate: false`,
// and `continue.post.ts` checks the capability before ownership — so the gate
// the template called theirs was answerable by nobody but an operator, and the
// 403 did not name the manager as its owner. Both files read correctly alone;
// only together are they wrong, which is exactly what a test has to hold.
{
  const { workflowTemplates } = await import('../app/utils/workflowTemplates.ts')
  let checked = 0
  for (const template of workflowTemplates) {
    for (const step of template.steps) {
      if (!step.gateRole) continue
      checked++
      assert.ok(ROLES.includes(step.gateRole), `${template.name}/${step.label}: gateRole '${step.gateRole}' is not a role`)
      assert.equal(
        can(step.gateRole, 'answerGate'),
        true,
        `${template.name}/${step.label}: the gate belongs to '${step.gateRole}', who cannot answer a gate — continue.post.ts checks the capability before ownership, so this gate is answerable only by an operator and its 403 names the wrong owner`,
      )
    }
  }
  assert.ok(checked >= 3, `expected the shipped templates to declare gates; found ${checked}`)
}

console.log('roles: a reviewer decides, an operator drives, and a broken file locks nobody out') 

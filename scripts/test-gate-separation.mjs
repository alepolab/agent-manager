/**
 * The same person must not accept their own verification — unless nobody else
 * on the instance can, in which case the run must still finish and the fact
 * must be on the record.
 *
 * The runbook states this for one pair and nothing enforced it:
 *
 *   "VERIFY_GATE — Owner: QA, and never the same actor that answered
 *    IMPL_GATE."
 *
 * Role separation alone cannot carry it. `roles.json` defaults every unlisted
 * login to `operator` and an operator may answer any gate, so on an instance
 * where nobody has been assigned a role, the developer who approved the
 * implementation is also the person accepting its verification.
 *
 * The backstop is not a loophole in this control, it is the thing that keeps
 * the control alive: a rule that deadlocks a two-person team gets switched
 * off, and then there is no rule. So it refuses only when the instance can
 * actually satisfy the refusal, and otherwise records why it could not.
 *
 *   node scripts/test-gate-separation.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A private CLAUDE_DIR so this never reads or writes the real roles.json.
const dir = mkdtempSync(join(tmpdir(), 'gate-sep-'))
mkdirSync(dir, { recursive: true })
process.env.CLAUDE_DIR = dir
const writeRoles = (map) => writeFileSync(join(dir, 'roles.json'), JSON.stringify(map, null, 2))

const { checkGateSeparation } = await import('../server/utils/gateSeparation.ts')

/** A run that has already had its implementation gate approved by `by`. */
const runWith = (by, gateKind = 'verify') => ({
  id: 'r1',
  question: { stepId: 's9', text: '', kind: 'approval', askedAt: Date.now(), role: 'qa', gateKind },
  decisions: [{ stepId: 's4', label: 'Implement Backend', at: 1, by, verdict: 'approved', waitedMs: 0, gateKind: 'impl' }],
})

// The signed-in login is a PARAMETER, not something this module reads for
// itself. That is why it is testable under plain node at all: reaching into
// the session here would drag h3 in behind it.
let me
const asUser = (login) => { me = login }

// ---- 1. A gate with no pair is never separated --------------------------
writeRoles({ alice: 'developer', bob: 'qa' })
asUser('alice')
assert.deepEqual(await checkGateSeparation(runWith('alice', 'impl'), me), {},
  'an impl gate has no earlier pair and must not be refused')
assert.deepEqual(await checkGateSeparation({ id: 'r', question: { gateKind: 'ship', role: 'operator', stepId: 's', text: '', kind: 'approval', askedAt: 1 }, decisions: [] }, me), {},
  'a gate kind with no pairing rule is untouched')

// ---- 2. A different actor is fine ---------------------------------------
asUser('bob')
assert.deepEqual(await checkGateSeparation(runWith('alice'), me), {},
  'bob did not approve the implementation, so bob may accept the verification')

// ---- 3. The same actor is refused WHEN someone else could answer --------
asUser('alice')
await assert.rejects(
  () => checkGateSeparation(runWith('alice'), me),
  (err) => {
    assert.equal(err.statusCode, 403)
    // A refusal must name who to go to. "Forbidden" against a control you were
    // shown is indistinguishable from a bug.
    assert.match(err.message, /bob/, `the refusal must name who can answer: ${err.message}`)
    assert.match(err.message, /Implement Backend/, 'and which approval created the conflict')
    return true
  },
  'alice approved the implementation and must not accept its verification',
)

// ---- 4. The backstop: nobody else can, so the run proceeds --------------
// The whole team is one person. Refusing here would strand the run.
writeRoles({ alice: 'developer' })
asUser('alice')
{
  const out = await checkGateSeparation(runWith('alice'), me)
  assert.ok(out.sameActorNote, 'a one-person instance must not be deadlocked by this control')
  assert.match(out.sameActorNote, /same person/, 'and the record must say what happened')
  assert.match(out.sameActorNote, /no other qa/, 'naming the role nobody else holds')
}

// ---- 5. Unlisted logins do not count as available reviewers -------------
// Every unlisted login defaults to `operator`, who may answer any gate. If
// those counted, every instance would look fully staffed and the refusal
// would block work nobody else is actually able to do.
writeRoles({})
asUser('alice')
{
  const out = await checkGateSeparation(runWith('alice'), me)
  assert.ok(out.sameActorNote, 'an empty roles.json means nobody else is listed, so the backstop applies')
}

// ---- 6. An operator listed by name DOES count ---------------------------
writeRoles({ alice: 'developer', carol: 'operator' })
asUser('alice')
await assert.rejects(() => checkGateSeparation(runWith('alice'), me),
  /carol/, 'a named operator is a real second pair of hands and must be asked')

console.log('gate separation: the same actor cannot accept their own verification where anyone else could, and the backstop is recorded where nobody can')

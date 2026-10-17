/**
 * The risk policy: a saved table of what each blast radius demands, replacing
 * the constant oversight.ts carried.
 *
 * The rules worth protecting, in order: with nothing saved the gates behave
 * exactly as they did (the default's oversight column IS the old table); a
 * malformed policy is refused rather than half-installed; a saved policy
 * changes what oversightFor says for the next run; and only an operator can
 * save one. Routes are driven through h3 the way test-password-login.mjs does
 * it, since Nitro's auto-imports are not available to plain node.
 *
 *   node scripts/test-risk-policy.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h3 from 'h3'
import { fetchNodeRequestHandler } from 'node-mock-http'

Object.assign(globalThis, {
  defineEventHandler: h3.defineEventHandler, readBody: h3.readBody, createError: h3.createError, getQuery: h3.getQuery,
  setResponseStatus: h3.setResponseStatus,
})

const claudeDir = mkdtempSync(join(tmpdir(), 'risk-policy-'))
process.env.CLAUDE_DIR = claudeDir
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'risk-policy-audit-'))
process.env.AUTH_DISABLED = '1'
process.env.DEV_USER = 'operator-one'

const { DEFAULT_RISK_POLICY, validateRiskPolicy, tierFor, getRiskPolicy, resetRiskPolicy } = await import('../shared/utils/riskPolicy.ts')
const { oversightFor, needsJustification, BLAST_RADIUS_ORDER } = await import('../shared/utils/oversight.ts')
const store = await import('../server/utils/riskPolicyStore.ts')

// ── 1. the default is the legacy table ───────────────────────────────────────
// oversight.ts shipped these six rows plus "unclassified stops". A default that
// drifted from them would change every existing run's gates on upgrade.
{
  const legacy = { docs: 'auto', ui_parsing: 'auto', schema: 'stop', deployment: 'stop', protocol: 'justify', money: 'justify' }
  for (const [r, o] of Object.entries(legacy)) {
    assert.equal(DEFAULT_RISK_POLICY.tiers[r].oversight, o, `${r} defaults to ${o}, as oversight.ts always did`)
    assert.equal(oversightFor(r), o, `and oversightFor agrees with nothing saved`)
  }
  assert.equal(DEFAULT_RISK_POLICY.unclassified.oversight, 'stop', 'unclassified stops')
  assert.equal(oversightFor(undefined), 'stop')
  assert.equal(oversightFor('something-intake-invented'), 'stop')
  assert.deepEqual(Object.keys(DEFAULT_RISK_POLICY.tiers).sort(), [...BLAST_RADIUS_ORDER].sort(), 'every radius has a row')
  assert.deepEqual(validateRiskPolicy(DEFAULT_RISK_POLICY), [], 'the shipped default validates against its own rules')

  // The new columns, as specified.
  assert.equal(DEFAULT_RISK_POLICY.tiers.money.reviewers, 2)
  assert.equal(DEFAULT_RISK_POLICY.tiers.protocol.reviewers, 2)
  assert.equal(DEFAULT_RISK_POLICY.tiers.docs.reviewers, 1)
  for (const r of ['schema', 'deployment', 'protocol', 'money']) {
    assert.equal(DEFAULT_RISK_POLICY.tiers[r].adversarial, true, `${r} needs an adversarial review`)
    assert.equal(DEFAULT_RISK_POLICY.tiers[r].sandbox, 'required', `${r} must run in a sandbox`)
  }
  assert.equal(DEFAULT_RISK_POLICY.tiers.deployment.specialist, 'security')
  assert.equal(DEFAULT_RISK_POLICY.tiers.docs.sandbox, 'preferred')
  assert.deepEqual(DEFAULT_RISK_POLICY.tiers.money.budget, { minutes: 180, tokens: 8_000_000, panelTokens: 600_000 })
  assert.deepEqual(DEFAULT_RISK_POLICY.tiers.schema.budget, { minutes: 120, tokens: 5_000_000, panelTokens: 300_000 })
  assert.deepEqual(DEFAULT_RISK_POLICY.tiers.docs.budget, { minutes: 60, tokens: 2_000_000, panelTokens: 150_000 })
  assert.equal(tierFor(DEFAULT_RISK_POLICY, null), DEFAULT_RISK_POLICY.unclassified)
}

// ── 2. validation refuses bad input ──────────────────────────────────────────
{
  assert.ok(validateRiskPolicy(null).length, 'null is not a policy')
  assert.ok(validateRiskPolicy([]).length, 'an array is not a policy')
  assert.ok(validateRiskPolicy({ ...DEFAULT_RISK_POLICY, version: 2 }).some(e => /version/.test(e)), 'an unknown version is refused')

  const missing = structuredClone(DEFAULT_RISK_POLICY)
  delete missing.tiers.money
  assert.ok(validateRiskPolicy(missing).some(e => /tiers\.money is missing/.test(e)), 'a tier left out is named, not defaulted')

  const typo = structuredClone(DEFAULT_RISK_POLICY)
  typo.tiers.schema = { ...typo.tiers.schema, oversite: 'auto' }
  assert.ok(validateRiskPolicy(typo).some(e => /tiers\.schema\.oversite is not a recognised key/.test(e)), 'a misspelt key is refused rather than ignored')

  const bad = structuredClone(DEFAULT_RISK_POLICY)
  bad.tiers.docs.oversight = 'maybe'
  bad.tiers.docs.reviewers = 0
  bad.tiers.docs.budget.minutes = -5
  bad.unclassified.specialist = 'wizard'
  const errors = validateRiskPolicy(bad)
  assert.ok(errors.some(e => /tiers\.docs\.oversight/.test(e)))
  assert.ok(errors.some(e => /tiers\.docs\.reviewers/.test(e)))
  assert.ok(errors.some(e => /tiers\.docs\.budget\.minutes/.test(e)))
  assert.ok(errors.some(e => /unclassified\.specialist/.test(e)))

  const extra = { ...structuredClone(DEFAULT_RISK_POLICY), tiers: { ...DEFAULT_RISK_POLICY.tiers, galaxy: DEFAULT_RISK_POLICY.tiers.docs } }
  assert.ok(validateRiskPolicy(extra).some(e => /tiers\.galaxy is not a blast radius/.test(e)))
}

// ── 3. the store: missing file is the default, invalid file is the default with a warning ──
{
  store.resetRiskPolicyCache()
  assert.deepEqual(store.loadRiskPolicy(), DEFAULT_RISK_POLICY, 'no file: the default')

  writeFileSync(join(claudeDir, 'risk-policy.json'), '{ not json')
  store.resetRiskPolicyCache()
  const warned = []
  const orig = console.warn
  console.warn = (...a) => warned.push(a.join(' '))
  try { assert.deepEqual(store.loadRiskPolicy(), DEFAULT_RISK_POLICY, 'unreadable file: the default') } finally { console.warn = orig }
  assert.ok(warned.some(w => /risk-policy\.json/.test(w)), 'and it says so in the log')

  const half = structuredClone(DEFAULT_RISK_POLICY)
  delete half.unclassified
  writeFileSync(join(claudeDir, 'risk-policy.json'), JSON.stringify(half))
  store.resetRiskPolicyCache()
  console.warn = () => {}
  try { assert.equal(store.loadRiskPolicy().unclassified.oversight, 'stop', 'an invalid file is not half-installed') } finally { console.warn = orig }
  assert.equal(oversightFor(undefined), 'stop')
}

// ── 4. the routes ────────────────────────────────────────────────────────────
// PUT changes what oversightFor says for the next run; a non-operator is 403.
{
  const policyGet = (await import('../server/api/policy.get.ts')).default
  const policyPut = (await import('../server/api/policy.put.ts')).default
  const { setRole } = await import('../server/utils/roles.ts')

  const app = h3.createApp({
    onError: (err, event) => h3.send(event, JSON.stringify({ statusCode: err.statusCode, message: err.message }), 'application/json'),
  })
  app.use('/api/policy', h3.eventHandler(e => e.method === 'PUT' ? policyPut(e) : policyGet(e)))
  const listener = h3.toNodeListener(app)
  const call = (method, body) => fetchNodeRequestHandler(listener, 'http://localhost/api/policy', {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  })

  store.resetRiskPolicyCache()
  writeFileSync(join(claudeDir, 'risk-policy.json'), JSON.stringify(DEFAULT_RISK_POLICY))
  const before = await (await call('GET')).json()
  assert.equal(before.tiers.schema.oversight, 'stop')

  // A docs change that must now stop, and a schema change that may flow.
  const changed = structuredClone(DEFAULT_RISK_POLICY)
  changed.tiers.docs.oversight = 'justify'
  changed.tiers.schema.oversight = 'auto'
  const put = await call('PUT', changed)
  assert.equal(put.status, 200, await put.text())
  assert.equal(oversightFor('docs'), 'justify', 'a saved policy changes oversightFor for the next run')
  assert.equal(needsJustification('docs'), true)
  assert.equal(oversightFor('schema'), 'auto')
  assert.equal(oversightFor(undefined), 'stop', 'unclassified still stops: the row was not touched')
  assert.deepEqual(JSON.parse(readFileSync(join(claudeDir, 'risk-policy.json'), 'utf8')), changed, 'and it is on disk for the next boot')

  // Bad input is a 400 and leaves the installed policy alone.
  const bad = await call('PUT', { version: 1, tiers: {} })
  assert.equal(bad.status, 400)
  assert.match((await bad.json()).message, /tiers\.docs is missing/)
  assert.equal(oversightFor('docs'), 'justify', 'a refused PUT installs nothing')

  // The change is on the audit chain.
  const audit = await import('../server/utils/auditLog.ts')
  const records = await audit.queryAudit({ kind: 'policy' })
  assert.equal(records.length, 1, 'one PUT, one audit record')
  assert.equal(records[0].actor, 'operator-one')
  assert.equal(records[0].payload.policy.tiers.docs.oversight, 'justify')
  assert.ok(existsSync(audit.auditLogPath()))

  // A developer may read the policy and may not write it.
  await setRole('operator-one', 'developer')
  const read = await call('GET')
  assert.equal(read.status, 200, 'any signed-in role reads the policy')
  const refused = await call('PUT', DEFAULT_RISK_POLICY)
  assert.equal(refused.status, 403, 'a developer cannot change the policy')
  assert.match((await refused.json()).message, /operator/)
  assert.equal(oversightFor('docs'), 'justify', 'and the refusal changed nothing')
  await setRole('operator-one', null)
}

resetRiskPolicy()
assert.equal(getRiskPolicy(), DEFAULT_RISK_POLICY)
console.log('risk policy: default is the legacy table, bad input is refused, a saved policy moves the gates, only an operator saves one')

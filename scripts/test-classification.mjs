/**
 * How risky a run is, decided from evidence rather than from an agent's word.
 *
 * `oversight.ts` already decides whether a gate fires purely from a run's blast
 * radius - and nothing writes that field, so `oversightFor(undefined)` returns
 * `stop` for every run and the whole tiering is dead. The gap spec puts it
 * exactly: "the reader is fixed and the writer is gone; a fixed reader of an
 * unwritten field changes nothing."
 *
 * Writing it from the agent's own claim alone would be worse than leaving it
 * empty. A step that wants to avoid a gate has every incentive to call its
 * change `ui_parsing`, and a classification an agent can lower is not a
 * control, it is a formality. So the runner computes a FLOOR from the paths the
 * change actually touched, and the floor can only ever raise the class.
 *
 * Every case below is a way this could go wrong in production:
 *
 *   node scripts/test-classification.mjs
 */
import assert from 'node:assert/strict'

const { parseProposal, floorFrom, adopt } = await import('../shared/utils/classification.ts')
const { BLAST_RADIUS_ORDER, oversightFor } = await import('../shared/utils/oversight.ts')

// ---- parseProposal: one explicit machine-readable form, nothing inferred ----
// Mirrors `PIPELINE-ASK:` (workflowRunner.ts:669) so an agent learns one
// convention rather than three.
{
  assert.equal(parseProposal('PIPELINE-CLASS: schema'), 'schema', 'the documented form is read')
  assert.equal(parseProposal('some prose\nPIPELINE-CLASS: money\nmore prose'), 'money', 'on its own line, anywhere in the output')
  assert.equal(parseProposal('PIPELINE-CLASS:   ui_parsing  '), 'ui_parsing', 'whitespace around the value is tolerated')

  // Absence is absence. A default here would silently classify every run that
  // forgot to answer, which is precisely the run most likely to be dangerous.
  assert.equal(parseProposal(''), null, 'no output proposes nothing')
  assert.equal(parseProposal('I think this is a small UI change'), null, 'prose is NOT a classification, however confident it sounds')

  // A misspelling is not a class. Passing it through would let a typo reach
  // oversight.ts, whose POLICY lookup would fall through to `stop` - the right
  // outcome by luck, for the wrong reason, with a junk value on the record.
  assert.equal(parseProposal('PIPELINE-CLASS: schemas'), null, 'a class outside the enum is rejected, not forwarded')
  assert.equal(parseProposal('PIPELINE-CLASS: CRITICAL'), null, 'an invented severity word is rejected')
  assert.equal(parseProposal('PIPELINE-CLASS:'), null, 'the marker with no value proposes nothing')

  // Case: agents write prose. Accept the enum's own spelling only.
  assert.equal(parseProposal('PIPELINE-CLASS: Schema'), 'schema', 'the enum spelling is matched case-insensitively')
}

// ---- floorFrom: what the touched paths prove on their own ------------------
{
  // Liquibase changelogs and raw SQL are how this estate ships schema changes.
  assert.equal(floorFrom(['lum-selfcare-liquibase/changelog/2026-09-18-add-column.xml']), 'schema', 'a liquibase changelog is a schema change')
  assert.equal(floorFrom(['db/migration/V12__add_index.sql']), 'schema', 'a migration directory is a schema change')
  assert.equal(floorFrom(['modules/administrator/src/main/resources/create-table.sql']), 'schema', 'raw SQL is a schema change')

  // Deployment: what the server reads at boot, and what builds it.
  assert.equal(floorFrom(['configs/common/portal-ext.properties']), 'deployment', 'portal properties are read at boot, so changing them is a deployment')
  assert.equal(floorFrom(['docker-compose.crm.yml']), 'deployment', 'a compose file is deployment shape')
  assert.equal(floorFrom(['infra/main.tf']), 'deployment', 'terraform is deployment shape')
  assert.equal(floorFrom(['.github/workflows/ase-build.yml']), 'deployment', 'the pipeline that builds the product is deployment shape')

  // Ordinary source proves nothing about risk by itself. Returning a class here
  // would be a guess dressed as evidence.
  assert.equal(floorFrom(['modules/liferay-extension/src/main/java/com/alepo/se/Foo.java']), null, 'ordinary source implies no floor')
  assert.equal(floorFrom(['README.md']), null, 'a doc implies no floor - the floor only ever RAISES, so it must not assert "docs"')
  assert.equal(floorFrom([]), null, 'nothing touched proves nothing')

  // The strongest evidence in the set wins, because a change is as risky as its
  // riskiest part.
  assert.equal(
    floorFrom(['README.md', 'src/Foo.java', 'db/migration/V13__x.sql', 'docker-compose.yml']),
    'deployment',
    'a mixed change takes the strongest floor its paths imply',
  )
  const strongerIndex = BLAST_RADIUS_ORDER.indexOf('deployment')
  assert.ok(strongerIndex > BLAST_RADIUS_ORDER.indexOf('schema'), 'and "stronger" means the enum\'s own order, not alphabetical')
}

// ---- adopt: the floor may raise the class, the agent may never lower it ----
{
  // THE case this module exists for. An agent that touched migrations and
  // called its change ui_parsing does not get a free pass.
  const gamed = adopt({ proposed: 'ui_parsing', floor: 'schema' })
  assert.equal(gamed.adopted, 'schema', 'the floor overrides a lower proposal')
  assert.equal(gamed.source, 'floor', 'and the record says the floor is why')
  assert.equal(oversightFor(gamed.adopted), 'stop', 'so the gate fires, which is the point')

  // An agent that knows something the paths cannot show - money arithmetic in
  // ordinary Java - is believed when it raises the class.
  const raised = adopt({ proposed: 'money', floor: 'schema' })
  assert.equal(raised.adopted, 'money', 'a higher proposal stands')
  assert.equal(raised.source, 'proposal')

  const agreed = adopt({ proposed: 'schema', floor: 'schema' })
  assert.equal(agreed.adopted, 'schema')
  assert.equal(agreed.source, 'proposal', 'agreement is attributed to the proposal, which is the more specific claim')

  const floorOnly = adopt({ proposed: null, floor: 'deployment' })
  assert.equal(floorOnly.adopted, 'deployment')
  assert.equal(floorOnly.source, 'floor-only', 'an unclassified run with path evidence is still classified')

  const proposalOnly = adopt({ proposed: 'docs', floor: null })
  assert.equal(proposalOnly.adopted, 'docs')
  assert.equal(proposalOnly.source, 'proposal')

  // Neither knows anything: null, NOT a default. The caller must be able to
  // park the run; a default would hand it the one answer it must not assume.
  const unknown = adopt({ proposed: null, floor: null })
  assert.equal(unknown.adopted, null, 'no evidence yields no class')
  assert.equal(unknown.source, null)
  assert.equal(oversightFor(unknown.adopted ?? undefined), 'stop', 'and oversight.ts already stops an unclassified run')

  // Every class in the enum must survive a round trip, so a new class added to
  // oversight.ts cannot silently become unadoptable.
  for (const cls of BLAST_RADIUS_ORDER) {
    assert.equal(adopt({ proposed: cls, floor: null }).adopted, cls, `${cls} is adoptable`)
    assert.equal(parseProposal(`PIPELINE-CLASS: ${cls}`), cls, `${cls} is proposable`)
  }
}

console.log('classification: the floor raises the class, the agent can never lower it, and absence is never a default')

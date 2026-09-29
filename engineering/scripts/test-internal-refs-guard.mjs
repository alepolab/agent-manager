/**
 * Self-check for hooks/internal-refs-guard.mjs: runs the hook as Claude Code would,
 * JSON on stdin, and asserts the exit code and reason.
 *
 *   node engineering/scripts/test-internal-refs-guard.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const hook = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'internal-refs-guard.mjs')
const run = (call) => {
  const r = spawnSync('node', [hook], { input: JSON.stringify(call), encoding: 'utf8' })
  return { code: r.status, err: r.stderr }
}
const edit = (file_path, old_string, new_string) => run({ tool_name: 'Edit', tool_input: { file_path, old_string, new_string } })
const write = (file_path, content) => run({ tool_name: 'Write', tool_input: { file_path, content } })

const APP = '/repo/packages/frontend/src/app/pages/widgets/choose-number/choose-number.component'
const I18N = '/repo/packages/frontend/src/assets/i18n/en-US.json'

// Frontend string literals
assert.equal(edit(`${APP}.ts`, "info = 'Choose a number'", "info = 'SASKNEPCR-23/24: choose a number'").code, 2, 'a Jira key in a widget info string is denied')
assert.equal(edit(`${APP}.ts`, 'x', "toast.error('Port-in failed (ALE-249)')").code, 2, 'a task id in a toast is denied')
assert.equal(edit(`${APP}.ts`, 'x', '// SASKNEPCR-36: keep upsell per province\nconst a = 1').code, 0, 'a ticket in a code comment is allowed')
assert.equal(edit(`${APP}.ts`, 'x', "/* SBN-4182 */ const t = 'Choose a number'").code, 0, 'a ticket in a block comment is allowed')
assert.equal(edit(`${APP}.ts`, 'x', "const enc = 'UTF-8'; const h = 'SHA-256'; const d = 'ISO-8601'").code, 0, 'standards that look like tickets are allowed')
assert.equal(edit(`${APP}.ts`, "msg = 'SBN-2331 logout'", "msg = 'SBN-2331 logout now'").code, 0, 'an existing reference is not the change\'s fault')
assert.match(edit(`${APP}.ts`, 'x', "t = 'CSUP-7531 fix'").err, /Blocked by the internal-references guard/, 'the denial names the guard')

// Templates
assert.equal(edit(`${APP}.html`, 'x', '<button>Keep (SASKNEPCR-36)</button>').code, 2, 'a ticket in template text is denied')
assert.equal(edit(`${APP}.html`, 'x', '<!-- SASKNEPCR-28 AC2: scopes the region select -->\n<label>Choose Province</label>').code, 0, 'an HTML comment is allowed')
assert.equal(edit(`${APP}.html`, 'x', '<a href="https://alepo.atlassian.net/wiki/spaces/ML/pages/1">Help</a>').code, 2, 'a Confluence link is denied')

// i18n, seed data, properties
assert.equal(edit(I18N, 'x', '"UPSELL_TITLE": "Double your data (SASKNEPCR-36)"').code, 2, 'a ticket in i18n is denied')
assert.equal(edit('/repo/packages/backend/seed/customdata.json', 'x', '"regionsNote": "SASKNEPCR-25/26: province key"').code, 2, 'a ticket in seeded customdata is denied')
assert.equal(edit('/repo/src/main/resources/content/Error_Messages.properties', 'x', 'PROVINCE_LOCKED=Blocked by PCRFV-1884').code, 2, 'a ticket in a message bundle is denied')
assert.equal(edit('/repo/src/main/resources/content/Error_Messages.properties', 'x', '# SASKNEPCR-27\nPROVINCE_LOCKED=Province change is locked').code, 0, 'a properties comment is allowed')

// Liquibase System Config descriptions: only the description-like columns
const LB = '/repo/db/changelog/2026/add-config.xml'
assert.equal(edit(LB, 'x', '<column name="DESCRIPTION" value="Retry count, see URM-59"/>').code, 2, 'a ticket in a config description is denied')
assert.equal(edit(LB, 'x', '<changeSet id="URM-59-add-config" author="dev"><column name="VALUE" value="3"/></changeSet>').code, 0, 'a changeset id is not user text')

// API docs rendered in-app
const J = '/repo/src/main/java/com/alepo/api/PlanController.java'
assert.equal(edit(J, 'x', '@Operation(summary = "List plans (PCRFV-1882)")').code, 2, 'a ticket in @Operation is denied')
assert.equal(edit(J, 'x', '// PCRFV-1882: scope speeds\n@Operation(summary = "List plans")').code, 0, 'a Java comment is allowed')
assert.equal(edit(J, 'x', 'log.warn("PCRFV-1882 fallback")').code, 0, 'server logs are out of scope')

// Out of scope: tests, docs, non-user-facing code
assert.equal(edit('/repo/packages/frontend/src/app/x.component.spec.ts', 'x', "it('SBN-4182 regression', () => {})").code, 0, 'specs are allowed')
assert.equal(edit('/repo/docs/runbook.md', 'x', 'See SASKNEPCR-22').code, 0, 'docs are allowed')
assert.equal(edit('/repo/scripts/deploy.sh', 'x', 'echo SBN-1').code, 0, 'scripts are not user-facing')

// Write compares with the file on disk
const dir = mkdtempSync(join(tmpdir(), 'irg-'))
const f = join(dir, 'frontend', 'src', 'app', 'a.component.ts')
mkdirSync(dirname(f), { recursive: true })
writeFileSync(f, "const t = 'SBN-2331 old'\n")
assert.equal(write(f, "const t = 'SBN-2331 old'\nconst u = 'Choose a plan'\n").code, 0, 'a Write that keeps an old reference is allowed')
assert.equal(write(f, "const t = 'SBN-2331 old'\nconst u = 'ALE-258 new'\n").code, 2, 'a Write that adds a reference is denied')

// Robustness
assert.equal(run({ tool_name: 'Read', tool_input: { file_path: `${APP}.ts` } }).code, 0, 'other tools pass')
assert.equal(spawnSync('node', [hook], { input: 'not json', encoding: 'utf8' }).status, 0, 'bad input allows')

console.log('test-internal-refs-guard: all assertions passed')

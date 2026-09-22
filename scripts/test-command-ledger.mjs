/**
 * The defect this pins: a run asserts work no command in it ever did. The
 * runner already saw every command — describeBlock turns each tool call into a
 * line carrying its command text and each result into one flagged `✗` — and
 * wrote them to a log nothing read back.
 *
 * The two rules that decide whether a gate built on this is worth having:
 *  - `javac Foo.java` is NOT a build. CSUP-7524's "22/22 green" was six files
 *    compiled flat against the junit jar, and the file with the real wiring was
 *    compiled by nothing. A ledger that counted that as a build would have
 *    passed the run it exists to stop.
 *  - a command the tool reported as failing does not become a success because a
 *    later line says so.
 *
 *   node scripts/test-command-ledger.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'ledger-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'ledger-runs-'))

const {
  parseToolLine, parseResultLine, isProjectBuild, sqlExecution, commandSegments,
  recordCommandLine, readCommandLedger, executionFacts, outcomeSwallowed, redactCommand,
} = await import('../server/utils/commandLedger.ts')
const { runArtifactsDir } = await import('../server/utils/runArtifacts.ts')

// ── 1. the line shapes the runner really writes ────────────────────────────
assert.deepEqual(parseToolLine('10:15:04 [Bash] gradle --offline build'), { tool: 'Bash', command: 'gradle --offline build' })
assert.deepEqual(parseToolLine('[Read] /repo/src/Foo.java'), { tool: 'Read', command: '/repo/src/Foo.java' })
assert.equal(parseToolLine('10:15:04 the agent said something'), null)
assert.equal(parseToolLine('[Bash] '), null, 'a tool line with no detail records nothing')
assert.deepEqual(parseResultLine('10:15:05 ✗ error: cannot find symbol'), { failed: true })
assert.deepEqual(parseResultLine('→ BUILD SUCCESSFUL'), { failed: false })
assert.equal(parseResultLine('[Bash] ls'), null)

// ── 2. a project build vs. six files and a jar ─────────────────────────────
for (const yes of [
  'gradle build', './gradlew :subscriber-activity:test', 'mvn -q verify', 'make',
  'JAVA_HOME=/usr/lib/jvm/java-11-openjdk-amd64 gradle assemble',
  'cd modules/subscriber-activity && ./gradlew compileJava'.replace('compileJava', 'compile'),
  'bun run typecheck', 'pnpm build', 'npm test', 'tsc -p tsconfig.json', 'ng build', 'docker build -t x .',
]) assert.equal(isProjectBuild(yes), true, `should count as a build: ${yes}`)

for (const no of [
  'javac -cp junit-4.13.jar *.java',            // CSUP-7524's simulated green
  'javac Foo.java Bar.java', 'cat build.gradle', 'grep -r build .', 'ls -la',
  'git commit -m "build"', 'echo build', 'tsc --version',
]) assert.equal(isProjectBuild(no), false, `should NOT count as a build: ${no}`)

assert.deepEqual(commandSegments('cd /repo && JAVA_HOME=/x gradle build'), ['cd /repo', 'gradle build'])

// ── 3. SQL that actually reached a database, and the file it ran ───────────
assert.deepEqual(sqlExecution('mysql -h db -u root crmdb < database/remediation/detect.sql'),
  { reachedDb: true, files: ['detect.sql'] })
assert.deepEqual(sqlExecution('psql -f /tmp/fix.sql'), { reachedDb: true, files: ['fix.sql'] })
assert.deepEqual(sqlExecution("mysql -e 'select 1'"), { reachedDb: true, files: [] })
// Writing a .sql file is not running it — the whole CSUP-7526 defect.
assert.deepEqual(sqlExecution('cat detect.sql'), { reachedDb: false, files: [] })

// ── 4. the ledger on disk, and what the gates read from it ────────────────
const runId = 'run-ledger-1'
await mkdir(runArtifactsDir(runId), { recursive: true })
recordCommandLine(runId, 's1', '[Bash] gradle build', 'tool', '/w/run')
recordCommandLine(runId, 's1', '✗ error: AspectJ source level is 1.5', 'result')
recordCommandLine(runId, 's1', '[Bash] javac -cp junit.jar Six.java', 'tool', '/w/run')
recordCommandLine(runId, 's1', '→ ok', 'result')
recordCommandLine(runId, 's2', '[Bash] mysql crmdb < detect.sql', 'tool', '/w/run')
recordCommandLine(runId, 's2', '→ 3 rows', 'result')
await new Promise(r => setTimeout(r, 60))

const entries = await readCommandLedger(runId)
const gradle = entries.filter(e => e.command.startsWith('gradle'))
assert.equal(gradle.length, 1, 'a command marked failed is one entry, not two')
assert.equal(gradle[0].failed, true)

const facts = executionFacts(entries)
assert.equal(facts.buildFailed, true, 'the gradle failure is visible')
assert.equal(facts.builtOk, false, 'and javac against a junit jar does not rescue it')
assert.equal(facts.reachedDatabase, true)
assert.deepEqual(facts.sqlFilesExecuted, ['detect.sql'])
assert.ok(facts.buildCommands.includes('gradle build'), 'a finding has to be able to show its work')

// A later successful build does establish builtOk — the gate asks whether a
// build ever succeeded, not whether one never failed.
recordCommandLine(runId, 's3', '[Bash] gradle build', 'tool', '/w/run')
recordCommandLine(runId, 's3', '→ BUILD SUCCESSFUL', 'result')
await new Promise(r => setTimeout(r, 60))
const after = executionFacts(await readCommandLedger(runId))
assert.equal(after.builtOk, true)
assert.equal(after.buildFailed, true, 'and the earlier failure is not erased')

// ── 5. an agent cannot narrate a build into existence ──────────────────────
// describeBlock renders an assistant's own TEXT verbatim, so a model that
// writes "[Bash] gradle build" as prose produces a line identical to a real
// tool call. Recording that would let the party being gated author the evidence.
const narrated = 'run-narrated'
await mkdir(runArtifactsDir(narrated), { recursive: true })
recordCommandLine(narrated, 's1', '[Bash] gradle build', 'text', '/w/run')
recordCommandLine(narrated, 's1', '→ BUILD SUCCESSFUL', 'text')
recordCommandLine(narrated, 's1', '[Bash] mysql crmdb < detect.sql', 'text')
recordCommandLine(narrated, 's1', '[Bash] gradle build')          // no kind at all
await new Promise(r => setTimeout(r, 60))
const narratedFacts = executionFacts(await readCommandLedger(narrated))
assert.equal(narratedFacts.builtOk, false, 'prose that looks like a tool call is not a build')
assert.deepEqual(narratedFacts.sqlFilesExecuted, [], 'nor an executed script')
assert.equal(narratedFacts.buildCommands.length, 0)

// ── 6. two commands in flight: no outcome is attributed to either ──────────
// The SDK issues parallel tool calls, and a single pending slot stamped the
// first command's failure onto the second — so a real module build failure
// registered as a pass on the module that had succeeded.
const parallel = 'run-parallel'
await mkdir(runArtifactsDir(parallel), { recursive: true })
recordCommandLine(parallel, 's1', '[Bash] gradle :subscriber-activity:build', 'tool', '/w/run')
recordCommandLine(parallel, 's1', '[Bash] gradle :subscriber-management:build', 'tool', '/w/run')
recordCommandLine(parallel, 's1', '✗ error: AspectJ source level is 1.5', 'result')
recordCommandLine(parallel, 's1', '→ BUILD SUCCESSFUL', 'result')
await new Promise(r => setTimeout(r, 60))
const parallelFacts = executionFacts(await readCommandLedger(parallel))
assert.equal(parallelFacts.builtOk, false,
  'with two builds in flight, neither result can be attributed, so neither is a pass')

// ── 7. a shell that swallows the outcome proves nothing ────────────────────
assert.equal(outcomeSwallowed('gradle build || true'), true)
assert.equal(outcomeSwallowed('mvn verify; true'), true)
assert.equal(outcomeSwallowed('npm run build'), false)
const swallowed = 'run-swallowed'
await mkdir(runArtifactsDir(swallowed), { recursive: true })
recordCommandLine(swallowed, 's1', '[Bash] gradle build || true', 'tool', '/w/run')
recordCommandLine(swallowed, 's1', '→ done', 'result')
await new Promise(r => setTimeout(r, 60))
assert.equal(executionFacts(await readCommandLedger(swallowed)).builtOk, false,
  '`|| true` exits 0 whatever the build did')

// ── 8. one repository's build does not vouch for another's code ────────────
const multi = 'run-multi'
await mkdir(runArtifactsDir(multi), { recursive: true })
recordCommandLine(multi, 's1', '[Bash] gradle build', 'tool', '/w/run/modules/activity')
recordCommandLine(multi, 's1', '→ BUILD SUCCESSFUL', 'result')
await new Promise(r => setTimeout(r, 60))
const multiEntries = await readCommandLedger(multi)
assert.equal(executionFacts(multiEntries, '/w/run/modules/activity').builtOk, true, 'the repo that built')
assert.equal(executionFacts(multiEntries, '/w/run/modules/management').builtOk, false, 'the one that did not')
assert.equal(executionFacts(multiEntries, '/w/run').builtOk, true, 'a module build counts for its parent checkout')

// ── 9. the families the file gate covers can all answer it ────────────────
for (const yes of ['pytest -q', 'python3 -m pytest', 'dotnet build', 'xcodebuild -scheme App', 'bundle exec rspec', 'composer install']) {
  assert.equal(isProjectBuild(yes), true, `a real build system: ${yes}`)
}
// Containerised databases are how this estate reaches a database at all.
assert.deepEqual(sqlExecution('docker exec -i infra-mariadb mysql crmdb < detect.sql'),
  { reachedDb: true, files: ['detect.sql'] })

// ── 9b. a "build tool" the run could have written itself does not count ────
// The agent controls the checkout being gated, so `./scripts/gradle build`
// proves only that the agent's own script exited 0 — the junit-jar defect in
// another costume. The project's committed wrappers are the exception.
assert.equal(isProjectBuild('./scripts/gradle build'), false)
assert.equal(isProjectBuild('tools/mvn verify'), false)
assert.equal(isProjectBuild('./gradlew build'), true, 'the committed wrapper is the sanctioned way to build')
assert.equal(isProjectBuild('/usr/bin/make'), true)

// ── 9c. a module build is attributed to the module, not the parent ────────
const { cwdOf } = await import('../server/utils/commandLedger.ts')
assert.equal(cwdOf('cd modules/subscriber-activity && gradle build', '/w/run'), '/w/run/modules/subscriber-activity')
assert.equal(cwdOf('gradle build', '/w/run'), '/w/run')
assert.equal(cwdOf('cd /other/repo && mvn verify', '/w/run'), '/other/repo')

// ── 10. no secret is written to the ledger ────────────────────────────────
assert.equal(redactCommand('mysql -u root -phunter2 crmdb'), 'mysql -u root -p<redacted> crmdb')
assert.equal(redactCommand('gh auth login --with-token ghp_abc123'), 'gh auth login --with-token <redacted>')
assert.equal(redactCommand('curl -H "Authorization: Bearer abc.def" https://x'), 'curl -H "Authorization: Bearer <redacted>" https://x')
assert.equal(redactCommand('DB_PASSWORD=s3cret ./run.sh'), 'DB_PASSWORD=<redacted> ./run.sh')
assert.equal(redactCommand('gradle build'), 'gradle build', 'an ordinary command is untouched')

console.log('command ledger: prose is not evidence, parallel calls attribute nothing, `|| true` is not a pass, and secrets never land on disk')

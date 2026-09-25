#!/usr/bin/env node
/**
 * Proves check-clock-alignment.mjs reaches the right verdict — and, the
 * property the whole script exists for, that it never reports an unread clock
 * as aligned.
 *
 *   node scripts/test-check-clock-alignment.mjs
 *
 * The probes are exercised through a fake `docker` on the script's own
 * `--docker-bin` seam, so every scenario below is provable with no stack
 * running: a real three-clock skew is not something you can stand up on
 * demand, and a test that needs one would never run.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { offsetMinutes, minutesToOffset, formatDelta, verdict } from './check-clock-alignment.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(root, 'scripts/check-clock-alignment.mjs')
const work = mkdtempSync(join(tmpdir(), 'clockcheck-'))

/**
 * A fake `docker` that answers the three probe shapes from a fixture. It
 * dispatches on what the probe asks for, not on the container name, so a
 * change to a probe command breaks these tests instead of silently passing.
 */
const FAKE = `#!/usr/bin/env node
import { readFileSync } from 'node:fs'
const fx = JSON.parse(readFileSync(process.env.FIXTURE, 'utf8'))
const [cmd, container, , , script] = process.argv.slice(2)
if (cmd !== 'exec') { process.stderr.write('unexpected: ' + process.argv.slice(2).join(' ')); process.exit(1) }
const c = fx[container]
if (!c) { process.stderr.write('Error: No such container: ' + container + '\\n'); process.exit(1) }
if (c.down) { process.stderr.write('Error response from daemon: container ' + container + ' is not running\\n'); process.exit(1) }

if (script.includes('MARIADB_ROOT_PASSWORD')) {
  if (!c.mysqlOffset) { process.stderr.write('no root password in the container environment\\n'); process.exit(3) }
  const m = /^([+-])(\\d{2})(\\d{2})$/.exec(c.mysqlOffset)
  const row = [c.globalTz ?? 'SYSTEM', c.sessionTz ?? 'SYSTEM', c.wall ?? '2026-09-25 12:00:00', m[2] + ':' + m[3], m[1]].join('\\t')
  process.stdout.write((c.tz ?? '') + '|' + row); process.exit(0)
}
let m = /^TZ="([^"]*)" date \\+%z$/.exec(script)
if (m) {
  const off = (c.zones ?? {})[m[1]]
  if (!off) { process.stderr.write('unknown zone\\n'); process.exit(1) }
  process.stdout.write(off); process.exit(0)
}
m = /printf "%s" "\\$\\{([A-Z_]+):-\\}"/.exec(script)
if (m) { process.stdout.write(((c.env ?? {})[m[1]]) ?? ''); process.exit(0) }
if (script.includes('date "+%z|%Z|')) {
  // zoneinfo: 'no' models an image with no tzdata, which ignores TZ and runs UTC.
  const zi = c.zoneinfo ?? (c.tz ? 'yes' : 'no')
  if (c.badOffset) { process.stdout.write((c.tz ?? '') + '|' + zi + '|' + c.badOffset + '|X|2026-09-25 12:00:00'); process.exit(0) }
  process.stdout.write([c.tz ?? '', zi, c.offset, c.abbr ?? 'XXX', c.wall ?? '2026-09-25 12:00:00'].join('|')); process.exit(0)
}
process.stderr.write('unrecognised probe: ' + script + '\\n'); process.exit(1)
`

const fakeDocker = join(work, 'fake-docker.mjs')
writeFileSync(fakeDocker, FAKE)
chmodSync(fakeDocker, 0o755)

let fixtureSeq = 0
function run(fixture, args = ['--stack', 'pcrf']) {
  const path = join(work, `fx-${fixtureSeq++}.json`)
  writeFileSync(path, JSON.stringify(fixture))
  try {
    const out = execFileSync('node', [script, ...args, '--docker-bin', fakeDocker], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FIXTURE: path },
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

const IST = { tz: 'Asia/Kolkata', offset: '+0530', abbr: 'IST' }
const UTC = { tz: 'UTC', offset: '+0000', abbr: 'UTC' }
const CST = { tz: 'America/Regina', offset: '-0600', abbr: 'CST' }

const aligned = {
  'pcrf-server': { ...IST },
  'pcrf-ems': { ...IST, env: { PCRF_SESSION_TIME_ZONE: 'Asia/Kolkata' }, zones: { 'Asia/Kolkata': '+0530' } },
  'pcrf-db': { tz: 'Asia/Kolkata', mysqlOffset: '+0530' },
}

// ── 1. Pure helpers ───────────────────────────────────────────────────────
{
  assert.equal(offsetMinutes('+0530'), 330)
  assert.equal(offsetMinutes('-0600'), -360)
  assert.equal(offsetMinutes('+0000'), 0)
  assert.equal(offsetMinutes('0530'), null, 'an unsigned offset is not a valid reading')
  assert.equal(offsetMinutes('garbage'), null)

  assert.equal(minutesToOffset(330), '+0530')
  assert.equal(minutesToOffset(-360), '-0600')
  assert.equal(minutesToOffset(0), '+0000')

  assert.equal(formatDelta(330), '5h30m')
  assert.equal(formatDelta(-330), '5h30m', 'the size of a skew does not depend on which side you read first')
  assert.equal(formatDelta(420), '7h00m')
}

// ── 2. verdict(): an unread clock is never a pass ─────────────────────────
{
  const r = (id, minutes) => ({ id, status: 'READ', minutes, offset: minutesToOffset(minutes), container: id })
  const u = (id) => ({ id, status: 'UNKNOWN', reason: 'not running', container: id })

  assert.equal(verdict([r('a', 0), r('b', 0)], []).status, 'ALIGNED')
  assert.equal(verdict([r('a', 0), r('b', 330)], []).status, 'SKEWED')
  assert.equal(verdict([r('a', 0), u('b')], []).status, 'UNKNOWN', 'two of three read is not aligned')
  assert.equal(verdict([u('a'), u('b')], []).status, 'UNKNOWN')

  // A proven skew outranks an unreadable clock. The other order would let a
  // stopped container downgrade a real finding to "inconclusive", which is the
  // one outcome an operator would wave through.
  const mixed = verdict([r('a', 0), r('b', 330), u('c')], [])
  assert.equal(mixed.status, 'SKEWED')
  assert.equal(mixed.unknown.length, 1, 'and it still reports what it could not read')

  // Every disagreeing pair, not just the widest: an operator needs to know
  // which two containers to reconcile.
  const three = verdict([r('a', 0), r('b', 330), r('c', -360)], [])
  assert.equal(three.mismatches.length, 3)
}

// ── 3. Aligned stack ──────────────────────────────────────────────────────
{
  const r = run(aligned)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /CLOCKS: ALIGNED — pcrf: all 3 clocks agree at \+0530/)
  // The report has to name zones, not just offsets: two zones can share an
  // offset today and diverge under DST.
  assert.match(r.out, /Asia\/Kolkata/)
  assert.match(r.out, /PCRF_SESSION_TIME_ZONE=Asia\/Kolkata/)
}

// ── 4. The PCRFV-1884 pairing: EMS at UTC against a +05:30 engine ─────────
{
  const r = run({
    ...aligned,
    'pcrf-ems': { ...UTC, env: { PCRF_SESSION_TIME_ZONE: '' }, zones: {} },
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /CLOCKS: SKEWED/)
  assert.match(r.out, /SKEW {2}engine vs ems: 5h30m/)
  assert.match(r.out, /SKEW {2}ems vs database: 5h30m/)
  // Acceptance criterion 2: copy-pasteable as G4 evidence means it carries the
  // fix and the rollback, not just the number.
  assert.match(r.out, /TZ=<operator service zone, IANA>/)
  assert.match(r.out, /git checkout -- \.env && docker compose --profile pcrf-stack up -d/)
  assert.match(r.out, /fail-open, PCRFV-1884/)
}

// ── 5. The split inside one container: EMS JVM vs its own database ────────
{
  // No second host required — this is the `TZ` unset path in the supported
  // infra stack, EMS at Asia/Kolkata against MariaDB at UTC.
  const r = run({
    'pcrf-server': { ...IST },
    'pcrf-ems': { ...IST, env: { PCRF_SESSION_TIME_ZONE: 'Asia/Kolkata' }, zones: { 'Asia/Kolkata': '+0530' } },
    'pcrf-db': { tz: '', mysqlOffset: '+0000', globalTz: 'SYSTEM', sessionTz: 'SYSTEM' },
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /SKEW {2}engine vs database: 5h30m/)
  assert.match(r.out, /SKEW {2}ems vs database: 5h30m/)
  assert.doesNotMatch(r.out, /SKEW {2}engine vs ems/, 'the engine and EMS agree here; only the database is out')
}

// ── 6. PCRF_SESSION_TIME_ZONE lying about the engine (SBN-3787) ───────────
{
  // All three real clocks agree, but EMS has been told the engine is elsewhere.
  // Nothing else in the estate cross-checks that pair, which is why it is here.
  const r = run({
    'pcrf-server': { ...CST },
    'pcrf-ems': { ...CST, env: { PCRF_SESSION_TIME_ZONE: 'Asia/Kolkata' }, zones: { 'Asia/Kolkata': '+0530' } },
    'pcrf-db': { tz: 'America/Regina', mysqlOffset: '-0600' },
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /SKEW {2}PCRF_SESSION_TIME_ZONE=Asia\/Kolkata vs the real engine clock: 11h30m/)
}

// ── 7. An unset claim is reported, not counted as a mismatch ──────────────
{
  const r = run({
    ...aligned,
    'pcrf-ems': { ...IST, env: {}, zones: {} },
  })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /PCRF_SESSION_TIME_ZONE unset — EMS uses its own zone/)
}

// ── 8. An unresolvable claim is loud, because glibc would read it as UTC ───
{
  const r = run({
    ...aligned,
    'pcrf-ems': { ...IST, env: { PCRF_SESSION_TIME_ZONE: 'Asia/Kolkatta' }, zones: {} },
  })
  // Not SKEWED — we could not compute an offset to compare, so it is UNKNOWN
  // territory reported in words rather than a number invented for it.
  assert.match(r.out, /PCRF_SESSION_TIME_ZONE=Asia\/Kolkatta is not a zone pcrf-ems can resolve/)
}

// ── 9. A stopped container is UNKNOWN (exit 2), never aligned ─────────────
{
  const r = run({ ...aligned, 'pcrf-db': { down: true } })
  assert.equal(r.code, 2, r.out)
  assert.match(r.out, /CLOCKS: UNKNOWN — pcrf: 1 clock\(s\) unreadable/)
  assert.match(r.out, /UNREAD {2}database \(pcrf-db\) — not counted as aligned/)
  assert.match(r.out, /Not a pass\./)
}

// ── 10. A missing container is UNKNOWN too, with the reason kept ──────────
{
  const r = run({ 'pcrf-server': { ...IST }, 'pcrf-ems': { ...IST, env: {}, zones: {} } })
  assert.equal(r.code, 2, r.out)
  assert.match(r.out, /No such container: pcrf-db/)
}

// ── 11. A database with no root password in its environment is UNREAD ─────
{
  // Never a pass, and never an argument on our command line either — the
  // password is read inside the container, so it cannot reach this report.
  const r = run({ ...aligned, 'pcrf-db': { tz: 'Asia/Kolkata' } })
  assert.equal(r.code, 2, r.out)
  assert.match(r.out, /no root password in the container environment/)
}

// ── 12. An unparseable offset is UNREAD, not silently zero ────────────────
{
  const r = run({ ...aligned, 'pcrf-ems': { tz: 'UTC', badOffset: 'wat', env: {}, zones: {} } })
  assert.equal(r.code, 2, r.out)
  assert.match(r.out, /unparseable offset "wat"/)
}

// ── 13. --json carries the same verdict, for a script step ────────────────
{
  const path = join(work, 'json-fx.json')
  writeFileSync(path, JSON.stringify(aligned))
  const out = execFileSync('node', [script, '--stack', 'pcrf', '--json', '--docker-bin', fakeDocker], {
    encoding: 'utf8',
    env: { ...process.env, FIXTURE: path },
  })
  const parsed = JSON.parse(out)
  assert.equal(parsed.verdict, 'ALIGNED')
  assert.equal(parsed.readings.length, 3)
  assert.equal(parsed.readings.find((r) => r.id === 'database').offset, '+0530')
}

// ── 14. Other stacks are wired, and an unknown one fails loudly ───────────
{
  const r = run(
    {
      'aaa-server': { ...IST },
      'aaa-ems': { ...UTC },
      'infra-mariadb': { tz: 'UTC', mysqlOffset: '+0000' },
    },
    ['--stack', 'aaa'],
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /SKEW {2}server vs ems: 5h30m/)

  const bad = run(aligned, ['--stack', 'nope'])
  assert.equal(bad.code, 2)
  assert.match(bad.out, /unknown stack "nope" — known: pcrf, aaa, ocs/)
}

// ── 15. A container that ignores its own TZ: found on a real container ────
{
  // Regression for a real finding. Running this check against an `alpine`
  // container started with `-e TZ=Asia/Kolkata` reported +0000: the image
  // carries no tzdata, so TZ is ignored and the container is on UTC. Every
  // clock then "agrees" at UTC while the configuration claims +05:30 — an
  // agreement that survives exactly until someone adds tzdata.
  const r = run({
    'pcrf-server': { tz: 'Asia/Kolkata', zoneinfo: 'no', offset: '+0000', abbr: 'UTC' },
    'pcrf-ems': { ...UTC, env: {}, zones: {} },
    'pcrf-db': { tz: 'UTC', mysqlOffset: '+0000' },
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /CLOCKS: MISCONFIGURED/)
  assert.match(r.out, /IGNORED {2}pcrf-server has TZ=Asia\/Kolkata but runs \+0000/)
  assert.match(r.out, /no \/usr\/share\/zoneinfo\/Asia\/Kolkata/)
  assert.match(r.out, /The agreement is accidental/)
}

// ── 16. TZ=UTC with no tzdata is not a finding ────────────────────────────
{
  // It asked for UTC and got UTC. Flagging this would train an operator to
  // ignore the IGNORED line, which is worse than not having it.
  const r = run({
    'pcrf-server': { tz: 'UTC', zoneinfo: 'no', offset: '+0000', abbr: 'UTC' },
    'pcrf-ems': { tz: 'Etc/UTC', zoneinfo: 'no', offset: '+0000', abbr: 'UTC', env: {}, zones: {} },
    'pcrf-db': { tz: 'UTC', mysqlOffset: '+0000' },
  })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /CLOCKS: ALIGNED/)
}

// ── 17. The POSIX form needs no zone file, so it is not a finding either ──
{
  // pcrf_cpp14 install/entrypoint.sh ships TZ=IST-5:30. There is no
  // /usr/share/zoneinfo/IST-5:30 and there does not need to be — glibc and
  // musl parse the spec directly, and the offset proves it worked.
  const r = run({
    'pcrf-server': { tz: 'IST-5:30', zoneinfo: 'no', offset: '+0530', abbr: 'IST' },
    'pcrf-ems': { ...IST, env: {}, zones: {} },
    'pcrf-db': { tz: 'Asia/Kolkata', mysqlOffset: '+0530' },
  })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /CLOCKS: ALIGNED/)
}

// ── 18. A real skew outranks a misconfiguration ───────────────────────────
{
  const r = run({
    'pcrf-server': { tz: 'Asia/Kolkata', zoneinfo: 'no', offset: '+0000', abbr: 'UTC' },
    'pcrf-ems': { ...CST, env: {}, zones: {} },
    'pcrf-db': { tz: 'UTC', mysqlOffset: '+0000' },
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /CLOCKS: SKEWED/, 'a measured offset gap is the stronger claim')
  // ...and the misconfiguration is still reported, not swallowed by the skew.
  assert.match(r.out, /IGNORED {2}pcrf-server/)
}

// ── 19. No --stack is a usage error, not a default ────────────────────────
{
  const r = run(aligned, [])
  assert.equal(r.code, 2)
  assert.match(r.out, /usage: check-clock-alignment\.mjs --stack/)
}

rmSync(work, { recursive: true, force: true })
console.log('check-clock-alignment: all assertions passed')

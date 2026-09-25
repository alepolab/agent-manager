#!/usr/bin/env node
/**
 * "Do this stack's clocks agree?" — the three-clock check (ALE-125 / PCRFV-1884).
 *
 *   node scripts/check-clock-alignment.mjs --stack pcrf
 *   node scripts/check-clock-alignment.mjs --stack pcrf --json
 *
 * Why a script and not a paragraph in an agent's brief. Several Alepo products
 * compare a *naive* DATETIME column against a wall clock, and they do not all
 * read the same wall clock. PCRF EMS is the worked example: `isExpired()` reads
 * the JVM clock while the query beside it (`findActiveLimitsByType` →
 * `expiryDate >= CURRENT_TIMESTAMP`) reads MariaDB's, both against the same
 * `EXPIRYDATE`, in the same release. Let those two containers resolve different
 * zones and one stored value becomes two different instants: EMS calls a lapsed
 * credit source live and permits the debit, which is the PCRFV-1884 failure mode
 * itself. The same split already shipped a production regression on `CREATEDATE`
 * (PCRFV-1874), and an engine-versus-EMS divergence was observed in the field on
 * a customer-bound release (SBN-3787). An instruction to "check the clocks" is
 * advice; an exit code is a gate.
 *
 * There are three clocks, not two:
 *
 *   1. engine host  — writes EXPIRYDATE from its own localtime, compares in Lua
 *   2. EMS JVM      — LocalDateTime.now()
 *   3. database     — CURRENT_TIMESTAMP / NOW()
 *
 * Plus a fourth reading that is not a clock but a claim about one:
 * `PCRF_SESSION_TIME_ZONE`, which tells EMS what zone it should assume the
 * engine writes in. It was the mitigation shipped for SBN-3787, so it is the
 * pair most likely to be wrong in the field, and it is checked here too.
 *
 * Posture, matching resolve-environment.mjs: a clock that cannot be read is
 * ABSENT and LOUD, never assumed to match. That distinction is the whole point.
 * A container that is not running is UNKNOWN, not aligned — reporting a missing
 * reading as a pass is exactly the placeholder-wearing-the-shape-of-evidence
 * failure the pipeline's standing rules forbid.
 *
 * Exit codes:
 *   0  ALIGNED        — every clock read agrees on its UTC offset
 *   1  SKEWED         — at least two reachable clocks report different offsets
 *   1  MISCONFIGURED  — the clocks agree, but a container is ignoring its own TZ
 *                       because its image carries no tzdata, so the agreement is
 *                       accidental and one rebuild away from a skew
 *   2  UNKNOWN        — a clock this stack needs could not be read at all
 *
 * No dependencies. Reads nothing but `docker`.
 */
import { execFileSync } from 'node:child_process'

// ---------------------------------------------------------------------------
// Stack topologies. A stack is a set of named clocks, each with a probe.
// Container names are the compose `container_name`s in alepo-dev-team-infra.
// ---------------------------------------------------------------------------

/**
 * `kind` decides how the reading is parsed, not what it means:
 *   'shell' — `date +%z` inside the container
 *   'mysql' — the server's own @@global.time_zone / NOW()
 *   'claim' — an environment variable naming a zone, not a clock reading
 */
const STACKS = {
  pcrf: {
    label: 'PCRF — engine, EMS and database',
    clocks: [
      { id: 'engine', kind: 'shell', container: 'pcrf-server', what: 'engine host wall clock (writes EXPIRYDATE via localtime)' },
      { id: 'ems', kind: 'shell', container: 'pcrf-ems', what: 'EMS JVM wall clock (isExpired → LocalDateTime.now())' },
      { id: 'database', kind: 'mysql', container: 'pcrf-db', what: 'database wall clock (findActiveLimitsByType → CURRENT_TIMESTAMP)' },
    ],
    claims: [
      { id: 'session-tz', container: 'pcrf-ems', variable: 'PCRF_SESSION_TIME_ZONE', against: 'engine', what: 'the zone EMS assumes the engine writes in (SBN-3787 mitigation)' },
    ],
  },
  aaa: {
    label: 'AAA — server, EMS and database',
    clocks: [
      { id: 'server', kind: 'shell', container: 'aaa-server', what: 'AAA server wall clock' },
      { id: 'ems', kind: 'shell', container: 'aaa-ems', what: 'AAA EMS JVM wall clock' },
      { id: 'database', kind: 'mysql', container: 'infra-mariadb', what: 'database wall clock' },
    ],
    claims: [],
  },
  ocs: {
    label: 'OCS — daemon, EMS and database',
    clocks: [
      { id: 'daemon', kind: 'shell', container: 'ocs-app', what: 'OCS daemon wall clock' },
      { id: 'ems', kind: 'shell', container: 'ocs-ems', what: 'OCS EMS JVM wall clock' },
      { id: 'database', kind: 'mysql', container: 'infra-mariadb', what: 'database wall clock' },
    ],
    claims: [],
  },
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

function docker(args, { docker: bin = 'docker', timeoutMs = 20000 } = {}) {
  try {
    return {
      ok: true,
      out: execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs }).trim(),
    }
  } catch (e) {
    const detail = `${e.stderr ?? ''}${e.stdout ?? ''}`.trim() || e.message
    return { ok: false, out: detail.split('\n')[0].slice(0, 200) }
  }
}

/** Minutes east of UTC from a `+0530` / `-0600` offset string. */
export function offsetMinutes(stamp) {
  const m = /^([+-])(\d{2})(\d{2})$/.exec(stamp.trim())
  if (!m) return null
  const sign = m[1] === '-' ? -1 : 1
  return sign * (Number(m[2]) * 60 + Number(m[3]))
}

/** `+0530` from minutes east of UTC. The inverse, for reporting a claim. */
export function minutesToOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`
}

/** "5h30m" from a signed minute delta. */
export function formatDelta(minutes) {
  const abs = Math.abs(minutes)
  return `${Math.floor(abs / 60)}h${String(abs % 60).padStart(2, '0')}m`
}

/**
 * MariaDB's `@@global.time_zone` is usually the literal `SYSTEM`, which names
 * the container's zone rather than an offset — so the offset has to come from
 * the server's own arithmetic, not from that string. TIMEDIFF against UTC_TIMESTAMP
 * is the server telling us its offset in its own terms.
 */
const MYSQL_PROBE =
  "SELECT @@global.time_zone, @@session.time_zone, NOW(), " +
  "TIME_FORMAT(TIMEDIFF(NOW(), UTC_TIMESTAMP()), '%H:%i'), " +
  "IF(NOW() >= UTC_TIMESTAMP(), '+', '-');"

/**
 * True when <zone> names UTC, so a `+0000` reading is what it asked for.
 * `Etc/GMT+0`-style aliases included; the sign inversion in the `Etc/GMT±N`
 * family is not decoded here because only the zero cases matter.
 */
function namesUtc(zone) {
  return /^(UTC|UCT|Universal|Zulu|GMT|GMT0|GMT\+0|GMT-0|Greenwich|Etc\/(UTC|UCT|GMT|GMT0|GMT\+0|GMT-0|Universal|Zulu|Greenwich))$/.test(zone)
}

/** The POSIX TZ form glibc and musl parse with no zoneinfo file, e.g. IST-5:30. */
function isPosixTz(zone) {
  return /^[A-Za-z]{3,}[+-]?\d{1,2}(:\d{2}){0,2}/.test(zone)
}

function readShellClock(clock, opts) {
  // `date +%z` is the offset; `%Z` the abbreviation; TZ the configured value;
  // and the zoneinfo probe answers a question the other three cannot.
  //
  // All four, because two zones can share an offset today and diverge under
  // DST — the report has to name the zone, not only the number — and because a
  // container whose image carries no tzdata ignores TZ entirely and runs UTC.
  // That last one is not hypothetical: it was found running this check against
  // a real `alpine` container with TZ=Asia/Kolkata, which reported +0000. The
  // reading is honest, the configuration is a lie, and "we set TZ so we are
  // aligned" is false. The EMS image installs tzdata deliberately
  // (pcrf-ems-portal Dockerfile:83-114) precisely so this cannot happen there;
  // nothing guarantees it for every image in a stack.
  const r = docker(
    [
      'exec',
      clock.container,
      'sh',
      '-c',
      'printf "%s|" "${TZ:-}"; ' +
        'if [ -n "${TZ:-}" ] && [ -e "/usr/share/zoneinfo/${TZ}" ]; then printf "yes|"; else printf "no|"; fi; ' +
        'date "+%z|%Z|%Y-%m-%d %H:%M:%S"',
    ],
    opts,
  )
  if (!r.ok) return { id: clock.id, status: 'UNKNOWN', reason: r.out, ...clock }
  const [tz, zoneinfo, off, abbr, wall] = r.out.split('|')
  const minutes = offsetMinutes(off ?? '')
  if (minutes === null) return { id: clock.id, status: 'UNKNOWN', reason: `unparseable offset ${JSON.stringify(off)}`, ...clock }

  // TZ names a real zone, the container has no zone file for it, and the clock
  // came back at UTC: the image is missing tzdata and TZ is being ignored.
  const ignoresTz = Boolean(tz) && zoneinfo === 'no' && !isPosixTz(tz) && !namesUtc(tz) && minutes === 0
  return { id: clock.id, status: 'READ', tz: tz || '(unset)', offset: off, abbr, wall, minutes, ignoresTz, ...clock }
}

function readMysqlClock(clock, opts) {
  // The root password is read inside the container from its own environment,
  // so it is never an argument here and never reaches this process, a log or a
  // report. MARIADB_ROOT_PASSWORD is what docker-compose.database.yml sets;
  // MYSQL_ROOT_PASSWORD covers the mysql-image services.
  const sql = MYSQL_PROBE.replace(/"/g, '\\"')
  const inner =
    'PW="${MARIADB_ROOT_PASSWORD:-${MYSQL_ROOT_PASSWORD:-}}"; ' +
    '[ -n "$PW" ] || { echo "no root password in the container environment" >&2; exit 3; }; ' +
    'CLI=mariadb; command -v mariadb >/dev/null 2>&1 || CLI=mysql; ' +
    `printf "%s|" "\${TZ:-}"; "$CLI" -uroot -p"$PW" -N -B -e "${sql}" 2>/dev/null`
  const r = docker(['exec', clock.container, 'sh', '-c', inner], opts)
  if (!r.ok) return { id: clock.id, status: 'UNKNOWN', reason: r.out, ...clock }

  const [tz, row] = r.out.split('|')
  const cols = (row ?? '').split('\t')
  if (cols.length < 5) return { id: clock.id, status: 'UNKNOWN', reason: `unexpected server response ${JSON.stringify(row)}`, ...clock }
  const [globalTz, sessionTz, now, hhmm, sign] = cols
  const parts = /^(\d{2}):(\d{2})$/.exec(hhmm.trim())
  if (!parts) return { id: clock.id, status: 'UNKNOWN', reason: `unparseable server offset ${JSON.stringify(hhmm)}`, ...clock }
  const minutes = (sign.trim() === '-' ? -1 : 1) * (Number(parts[1]) * 60 + Number(parts[2]))
  return {
    id: clock.id,
    status: 'READ',
    tz: tz || '(unset)',
    offset: minutesToOffset(minutes),
    abbr: `${globalTz.trim()}/${sessionTz.trim()}`,
    wall: now.trim(),
    minutes,
    ...clock,
  }
}

function readClaim(claim, opts) {
  const r = docker(['exec', claim.container, 'sh', '-c', `printf "%s" "\${${claim.variable}:-}"`], opts)
  if (!r.ok) return { id: claim.id, status: 'UNKNOWN', reason: r.out, ...claim }
  const value = r.out.trim()
  if (!value) return { id: claim.id, status: 'UNSET', ...claim }
  // Resolve the named zone to an offset using the same container's tzdata, so
  // the answer is the one that container would actually compute.
  const o = docker(['exec', claim.container, 'sh', '-c', `TZ="${value}" date +%z`], opts)
  const minutes = o.ok ? offsetMinutes(o.out) : null
  if (minutes === null) return { id: claim.id, status: 'UNRESOLVABLE', value, ...claim }
  return { id: claim.id, status: 'READ', value, offset: minutesToOffset(minutes), minutes, ...claim }
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export function verdict(readings, claims) {
  const read = readings.filter((r) => r.status === 'READ')
  const unknown = readings.filter((r) => r.status !== 'READ')
  const offsets = [...new Set(read.map((r) => r.minutes))]

  const mismatches = []
  if (offsets.length > 1) {
    // Report every disagreeing pair, not just the widest: an operator needs to
    // know which two containers to reconcile, and "the max is 7h" does not say.
    for (let i = 0; i < read.length; i++) {
      for (let j = i + 1; j < read.length; j++) {
        if (read[i].minutes !== read[j].minutes) {
          mismatches.push({ a: read[i].id, b: read[j].id, delta: read[i].minutes - read[j].minutes })
        }
      }
    }
  }

  // A claim is checked against a real clock, not against the other claims.
  const claimMismatches = []
  for (const c of claims) {
    if (c.status !== 'READ') continue
    const target = read.find((r) => r.id === c.against)
    if (!target) continue
    if (c.minutes !== target.minutes) {
      claimMismatches.push({ claim: c.id, variable: c.variable, value: c.value, against: target.id, delta: c.minutes - target.minutes })
    }
  }

  // A container that is ignoring its own TZ is a finding even when every clock
  // agrees, because the agreement is accidental: the offsets match at UTC while
  // the configuration says otherwise, so the stack is one `apk add tzdata` away
  // from a skew nobody changed a variable to cause.
  const ignoring = read.filter((r) => r.ignoresTz)

  // Order matters. A skew we can see is a harder fact than a clock we could
  // not read, so SKEWED outranks UNKNOWN: never let an unreachable container
  // downgrade a proven mismatch into "inconclusive". MISCONFIGURED sits below
  // both — it is a real failure, but a measured offset is the stronger claim.
  const base = { mismatches, claimMismatches, unknown, ignoring }
  if (mismatches.length || claimMismatches.length) return { status: 'SKEWED', code: 1, ...base }
  if (unknown.length) return { status: 'UNKNOWN', code: 2, ...base }
  if (ignoring.length) return { status: 'MISCONFIGURED', code: 1, ...base }
  return { status: 'ALIGNED', code: 0, ...base }
}

// ---------------------------------------------------------------------------
// Report — written to be pasted into a release issue as G4 evidence verbatim
// ---------------------------------------------------------------------------

function report(stackName, stack, readings, claims, v) {
  const lines = []
  lines.push(`Three-clock alignment — ${stack.label}`)
  lines.push(`stack=${stackName}  checked=${new Date().toISOString()}  verdict=${v.status}`)
  lines.push('')
  const w = Math.max(...readings.map((r) => r.id.length), ...claims.map((c) => c.id.length), 8)
  for (const r of readings) {
    const id = r.id.padEnd(w)
    if (r.status === 'READ') {
      lines.push(`  ${id}  ${r.offset}  TZ=${r.tz}  ${r.wall}  [${r.abbr}]  ${r.container}`)
    } else {
      lines.push(`  ${id}  ------  UNREAD  ${r.container}: ${r.reason}`)
    }
    lines.push(`  ${' '.repeat(w)}  ${r.what}`)
  }
  for (const c of claims) {
    const id = c.id.padEnd(w)
    if (c.status === 'READ') lines.push(`  ${id}  ${c.offset}  ${c.variable}=${c.value}  (vs ${c.against})`)
    else if (c.status === 'UNSET') lines.push(`  ${id}  ------  ${c.variable} unset — EMS uses its own zone`)
    else if (c.status === 'UNRESOLVABLE') lines.push(`  ${id}  ------  ${c.variable}=${c.value} is not a zone ${c.container} can resolve`)
    else lines.push(`  ${id}  ------  UNREAD  ${c.container}: ${c.reason}`)
    lines.push(`  ${' '.repeat(w)}  ${c.what}`)
  }
  lines.push('')

  for (const m of v.mismatches) {
    lines.push(`  SKEW  ${m.a} vs ${m.b}: ${formatDelta(m.delta)}`)
  }
  for (const m of v.claimMismatches) {
    lines.push(`  SKEW  ${m.variable}=${m.value} vs the real ${m.against} clock: ${formatDelta(m.delta)}`)
  }
  for (const u of v.unknown) {
    lines.push(`  UNREAD  ${u.id} (${u.container}) — not counted as aligned`)
  }
  for (const g of v.ignoring) {
    lines.push(`  IGNORED  ${g.container} has TZ=${g.tz} but runs ${g.offset}: no /usr/share/zoneinfo/${g.tz}, so TZ is ignored and the container is on UTC`)
  }

  if (v.status === 'SKEWED') {
    lines.push('')
    lines.push('  A naive DATETIME column compared against two clocks is two different')
    lines.push('  instants. Direction decides the damage: the westward reader expires late')
    lines.push('  and permits a debit against a lapsed source (fail-open, PCRFV-1884); the')
    lines.push('  eastward reader expires early and returns 409 on a live one (fail-closed).')
    lines.push('  Fix, in one variable and with no image rebuild or data migration:')
    lines.push('    TZ=<operator service zone, IANA>   in alepo-dev-team-infra/.env')
    lines.push(`    docker compose --profile ${stackName}-stack up -d`)
    lines.push('  Rollback:')
    lines.push(`    git checkout -- .env && docker compose --profile ${stackName}-stack up -d`)
  }
  if (v.status === 'UNKNOWN') {
    lines.push('')
    lines.push('  Not a pass. A clock that could not be read is unknown, not aligned —')
    lines.push('  start the stack and re-run before Go/No-Go.')
  }
  if (v.status === 'MISCONFIGURED') {
    lines.push('')
    lines.push('  Every clock agrees, but at least one container is ignoring the TZ it was')
    lines.push('  given. The agreement is accidental — install tzdata in that image, or the')
    lines.push('  next rebuild that adds it introduces a skew nobody configured.')
  }

  lines.push('')
  const summary =
    v.status === 'ALIGNED'
      ? `all ${readings.length} clocks agree at ${readings[0].offset}`
      : v.status === 'SKEWED'
        ? `${v.mismatches.length + v.claimMismatches.length} disagreeing pair(s), widest ${formatDelta(Math.max(0, ...[...v.mismatches, ...v.claimMismatches].map((m) => Math.abs(m.delta))))}`
        : v.status === 'MISCONFIGURED'
          ? `all clocks at ${readings[0].offset}, but ${v.ignoring.length} container(s) ignore the TZ they were given`
          : `${v.unknown.length} clock(s) unreadable`
  lines.push(`CLOCKS: ${v.status} — ${stackName}: ${summary}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { stack: null, json: false, docker: 'docker' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--stack') args.stack = argv[++i]
    else if (argv[i] === '--json') args.json = true
    // Test override: point the probes at a fake `docker` so the verdict logic
    // is provable without a running stack.
    else if (argv[i] === '--docker-bin') args.docker = argv[++i]
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true
    else {
      process.stderr.write(`unknown argument: ${argv[i]}\n`)
      process.exit(2)
    }
  }
  return args
}

export function check(stackName, opts) {
  const stack = STACKS[stackName]
  if (!stack) throw new Error(`unknown stack ${JSON.stringify(stackName)} — known: ${Object.keys(STACKS).join(', ')}`)
  const readings = stack.clocks.map((c) => (c.kind === 'mysql' ? readMysqlClock(c, opts) : readShellClock(c, opts)))
  const claims = stack.claims.map((c) => readClaim(c, opts))
  const v = verdict(readings, claims)
  return { stackName, stack, readings, claims, verdict: v, text: report(stackName, stack, readings, claims, v) }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.stack) {
    process.stdout.write(
      `usage: check-clock-alignment.mjs --stack <${Object.keys(STACKS).join('|')}> [--json]\n` +
        `\nexit 0 ALIGNED · 1 SKEWED · 1 MISCONFIGURED (a container ignores its TZ)` +
        ` · 2 UNKNOWN (a clock could not be read)\n`,
    )
    process.exit(args.help ? 0 : 2)
  }
  let result
  try {
    result = check(args.stack, { docker: args.docker })
  } catch (e) {
    process.stderr.write(`${e.message}\n`)
    process.exit(2)
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ stack: result.stackName, verdict: result.verdict.status, readings: result.readings, claims: result.claims, mismatches: result.verdict.mismatches, claimMismatches: result.verdict.claimMismatches }, null, 2)}\n`)
  } else {
    process.stdout.write(`${result.text}\n`)
  }
  process.exit(result.verdict.code)
}

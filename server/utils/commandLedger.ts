import { appendFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runArtifactsDir } from './runArtifacts.ts'

/**
 * What a run actually EXECUTED, as opposed to what it wrote about.
 *
 * Every defect in the CSUP-7524 / CSUP-7526 review is one shape: the run's
 * prose asserted something no command in the run ever proved. A "22/22 green"
 * TDD run that was six files compiled flat against the junit jar. A remediation
 * script that dies on its second query because eighteen references are
 * qualified against the wrong table. A gradle failure read as a repo defect and
 * then reported as "no module in this workspace can build". Three commits
 * reported that are in no repository. Every one of those would have been caught
 * by asking "which commands ran, and did they succeed".
 *
 * The runner already knows. `describeBlock` in agentCaller.ts turns every
 * tool_use into a line carrying the command text, and every tool_result into a
 * line prefixed `✗` when the tool reported an error — and `logLine` writes all
 * of them to the step log, where nothing has ever read them back. This file
 * parses that same stream into a record a gate can query. No new capture path,
 * no agent cooperation, nothing an agent can write directly.
 *
 * What this can and cannot know, stated plainly because a gate built on an
 * overstated signal is worse than no gate:
 *  - `failed` means THE TOOL REPORTED AN ERROR, not a captured exit code.
 *  - The ledger knows the command, never the directory it ran in. A build run
 *    in a scratch mirror is recorded as a build. `isProjectBuild` is the
 *    defence: it accepts a project build system (gradle, maven, an npm script,
 *    tsc -p, make) and rejects a bare `javac Foo.java`, which is exactly the
 *    shape CSUP-7524's simulated green took.
 *  - A command the agent never ran through a tool — work done inside another
 *    agent, or claimed outright — leaves no entry, which is the point.
 */

export interface CommandEntry {
  at: number
  stepId: string
  tool: string
  command: string
  /** Present only when the tool reported an error for this call. */
  failed?: true
  /**
   * The directory the step was working in when this ran, refined by a leading
   * `cd`. Without it a build that succeeded in repository A vouches for
   * untouched code in repository B of the same multi-repo run.
   */
  cwd?: string
  /**
   * The outcome could not be attributed. Set when two or more commands were in
   * flight at once (a parallel tool call), where pairing a result with a command
   * would be a guess. An unattributed build never counts as a success.
   */
  unresolved?: true
}

const LEDGER_FILE = 'commands.jsonl'

export function commandLedgerPath(runId: string): string {
  return join(runArtifactsDir(runId), LEDGER_FILE)
}

/** `[Bash] gradle --offline build` → the tool and what it was asked to do. */
export function parseToolLine(line: string): { tool: string, command: string } | null {
  const m = /^(?:\d{2}:\d{2}:\d{2}\s+)?\[([A-Za-z_][\w-]*)\]\s*(.*)$/.exec(line)
  if (!m) return null
  const command = (m[2] ?? '').trim()
  return command ? { tool: m[1]!, command } : null
}

/** `✗ …` / `→ …` — a tool result, and whether the tool called it an error. */
export function parseResultLine(line: string): { failed: boolean } | null {
  const m = /^(?:\d{2}:\d{2}:\d{2}\s+)?([✗→])/.exec(line)
  return m ? { failed: m[1] === '✗' } : null
}

/**
 * Serialised per run for the same reason logLine chains its appends: a burst of
 * tool lines in one tick must not reorder the file a reviewer reads later.
 */
const chains = new Map<string, Promise<void>>()
/**
 * Commands issued and not yet answered, oldest first, per step.
 *
 * A queue rather than one slot, because an assistant turn can issue several
 * tool calls before any result comes back — two gradle modules is the ordinary
 * shape here — and a single slot stamped the FIRST command's failure onto the
 * SECOND. In that state a real `subscriber-activity` build failure was recorded
 * against the module that had passed, `builtOk` came out true, and the gate that
 * exists to stop exactly that run would have opened the pull request.
 *
 * Results arrive in the order their calls were made, so a queue pairs them
 * correctly when calls are answered one at a time. When more than one is still
 * in flight the pairing is a guess, and a guess is recorded as `unresolved`
 * rather than as a success — see executionFacts.
 */
const pending = new Map<string, CommandEntry[]>()

/** A hard cap so a long run cannot grow this without bound. */
const MAX_PENDING = 64

/**
 * Secrets never reach the file. The step log already carried this text, but a
 * second machine-readable copy — and a refusal line that quotes commands back
 * into the step's recorded output — is not a reason to write a password twice.
 * Value-shaped flags only: the flag name stays so a reader can see what ran.
 */
const REDACTIONS: [RegExp, string][] = [
  [/(-p)(?!\s)\S+/g, '$1<redacted>'],
  [/(--password[= ])\S+/gi, '$1<redacted>'],
  [/(--token[= ]|--with-token[= ])\S+/gi, '$1<redacted>'],
  [/(-H\s+["']?[Aa]uthorization:\s*\w+\s+)[^"'\s]+/g, '$1<redacted>'],
  [/(--build-arg\s+\w+=)\S+/g, '$1<redacted>'],
  [/\b([A-Z_]*(?:PASSWORD|SECRET|TOKEN|APIKEY|API_KEY)=)\S+/g, '$1<redacted>'],
]

export function redactCommand(command: string): string {
  return REDACTIONS.reduce((s, [re, to]) => s.replace(re, to), command)
}

/**
 * Where a command really ran: the step's directory, moved by a leading `cd`.
 * `cd modules/subscriber-activity && gradle build` is the ordinary shape for a
 * module build, and without this it would be attributed to the parent checkout.
 */
export function cwdOf(command: string, stepCwd: string): string {
  const first = commandSegments(command)[0] ?? ''
  const m = /^cd\s+(\S+)/.exec(first)
  if (!m) return stepCwd
  const target = m[1]!.replace(/^["']|["']$/g, '')
  return target.startsWith('/') ? target : resolve(stepCwd, target)
}

/**
 * Called for every live line the runner writes.
 *
 * `kind` is the block the line came from, and it is not optional bookkeeping:
 * `describeBlock` renders an assistant's own TEXT verbatim, so a model that
 * writes `[Bash] gradle build` as prose produces a line identical to a real tool
 * call. Recording that would let the agent being gated author the evidence the
 * gate reads. Only 'tool' and 'result' lines are recorded; a line with no kind
 * is ignored for the same reason.
 *
 * Never throws — a ledger that cannot be written is a lost gate, not a lost run.
 */
export function recordCommandLine(
  runId: string, stepId: string, line: string,
  kind?: 'text' | 'tool' | 'result', cwd?: string,
): void {
  if (kind !== 'tool' && kind !== 'result') return
  const key = `${runId}:${stepId}`
  const queue = pending.get(key) ?? []

  if (kind === 'result') {
    const result = parseResultLine(line)
    if (!result) return
    const answered = queue.shift()
    pending.set(key, queue)
    if (!answered) return
    // Another call was still in flight when this answer arrived: which command
    // it belongs to is not knowable from the stream, so it is recorded as
    // unknown rather than attributed to the one that happened to be first.
    if (queue.length) {
      void append(runId, { ...answered, unresolved: true })
      return
    }
    if (result.failed) void append(runId, { ...answered, failed: true })
    return
  }

  const tool = parseToolLine(line)
  if (!tool) return
  // Something was already in flight: from here neither command's outcome can be
  // told from the other's, so BOTH are marked — the one already waiting and the
  // one being issued. Marking only the older of the two is how a failed module
  // build came out as a pass on the module that succeeded.
  const overlapped = queue.length > 0
  if (overlapped) for (const e of queue) void append(runId, { ...e, unresolved: true })
  const entry: CommandEntry = {
    at: Date.now(), stepId, tool: tool.tool, command: redactCommand(tool.command),
    ...(cwd ? { cwd: cwdOf(tool.command, cwd) } : {}),
    ...(overlapped ? { unresolved: true as const } : {}),
  }
  queue.push(entry)
  if (queue.length > MAX_PENDING) queue.splice(0, queue.length - MAX_PENDING)
  pending.set(key, queue)
  void append(runId, entry)
}

/** Drop a finished run's in-flight state. Called when a run reaches a terminal
 *  status; the file on disk is the record from then on. */
export function forgetRun(runId: string): void {
  for (const key of [...pending.keys()]) if (key.startsWith(`${runId}:`)) pending.delete(key)
  chains.delete(runId)
  complained.delete(runId)
}

/** Complained about once per run: a ledger that cannot be written makes the
 *  gate refuse a run that may genuinely have built, and "the evidence is
 *  missing" must not look like "nothing ran". */
const complained = new Set<string>()

function append(runId: string, entry: CommandEntry): Promise<void> {
  const path = commandLedgerPath(runId)
  const next = (chains.get(runId) ?? Promise.resolve())
    .then(() => appendFile(path, `${JSON.stringify(entry)}\n`))
    .catch((err) => {
      if (complained.has(runId)) return
      complained.add(runId)
      console.error(`[commandLedger] cannot write ${path}; this run's build evidence will be missing and its pull request refused:`, err instanceof Error ? err.message : err)
    })
  chains.set(runId, next)
  return next
}

/** Every recorded command, oldest first. A corrupt line is skipped, never fatal. */
export async function readCommandLedger(runId: string): Promise<CommandEntry[]> {
  let text: string
  try {
    text = await readFile(commandLedgerPath(runId), 'utf8')
  } catch {
    return []
  }
  const out: CommandEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed.command === 'string') out.push(parsed as CommandEntry)
    } catch { /* a half-written line is not a reason to lose the rest */ }
  }
  // A command whose outcome arrives later is appended a second time with the
  // flag set; the later row wins, so a reader sees one entry per command with
  // its real outcome.
  const byKey = new Map<string, CommandEntry>()
  for (const e of out) byKey.set(`${e.stepId}:${e.at}:${e.command}`, e)
  return [...byKey.values()].sort((a, b) => a.at - b.at)
}

/**
 * The segments of a shell line that are actually commands: `cd x && gradle
 * build` is two, and only the second says anything about building. Leading
 * assignments (`JAVA_HOME=… gradle …`) are stripped so the build system is the
 * first word either way.
 */
export function commandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/)
    .map(s => s.trim().replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, '').replace(/^(?:sudo|time|env)\s+/, ''))
    .filter(Boolean)
}

/**
 * A build of a PROJECT, not of a handful of files.
 *
 * The distinction is the whole point. CSUP-7524's green run compiled six .java
 * files flat against the junit jar with `javac`, which proves nothing about the
 * module it claimed to fix — the one file carrying the real wiring was compiled
 * by nothing at all. So a bare compiler invocation does not count; a build
 * system asked to build or test does.
 */
export function isProjectBuild(command: string): boolean {
  return commandSegments(command).some((seg) => {
    const [bin = '', ...args] = seg.split(/\s+/)
    // A build tool the run could have WRITTEN does not count. `./scripts/gradle`
    // is a file in the checkout the agent controls, and running it proves only
    // that the agent's own script exited 0 — the same defect as compiling six
    // files against a junit jar, wearing a build system's name. The project's
    // own wrappers are the exception, because they are the sanctioned way to
    // build and they are committed, reviewable code.
    if (bin.includes('/') && !bin.startsWith('/') && !/^\.\/(gradlew|mvnw)$/.test(bin)) return false
    const name = bin.replace(/^.*\//, '')
    if (/^(gradlew?|mvnw?|maven|ant|make|cmake|sbt|cargo|go)$/.test(name)) {
      // `:subscriber-activity:test` is a task on a module, and the verb is the
      // last segment — a gradle build is far more often written that way than
      // as a bare `build`.
      const verb = /^(build|assemble|compile\w*|test\w*|check|install|package|verify)$/
      return name === 'make' || args.some(a => verb.test(a.split(':').pop() ?? ''))
    }
    if (/^(npm|pnpm|yarn|bun)$/.test(name)) {
      return args.some(a => /^(build|test|typecheck|lint|tsc|compile)$/.test(a))
    }
    if (name === 'tsc') return args.includes('-p') || args.includes('--project') || args.includes('--noEmit')
    if (name === 'ng' || name === 'vite' || name === 'webpack') return args.some(a => /^(build|test)$/.test(a))
    if (name === 'docker' || name === 'podman') return args[0] === 'build'
    // The families the file-extension list already gates on. Without these a
    // Python, .NET, PHP, Ruby or Swift change could never satisfy the gate no
    // matter what ran, which forces those repositories onto the escape hatch
    // permanently — a gate everyone turns off is not a gate.
    if (/^(pytest|py\.test|tox|nox)$/.test(name)) return true
    if (name === 'python' || name === 'python3') return args[0] === '-m' && /^(pytest|unittest|build|compileall)$/.test(args[1] ?? '')
    if (name === 'dotnet' || name === 'msbuild') return name === 'msbuild' || /^(build|test|publish|restore)$/.test(args[0] ?? '')
    if (name === 'xcodebuild' || name === 'swift') return name === 'xcodebuild' || /^(build|test)$/.test(args[0] ?? '')
    if (name === 'composer') return /^(install|update|test)$/.test(args[0] ?? '')
    if (name === 'phpunit' || name === 'rspec' || name === 'rake' || name === 'rubocop') return true
    if (name === 'bundle') return args[0] === 'exec' && /^(rspec|rake|rubocop)$/.test(args[1] ?? '')
    return false
  })
}

/**
 * A command whose shell swallows the outcome, so its exit code proves nothing.
 *
 * `gradle build || true` and `mvn verify; true` are ordinary habits — a model
 * writes them to keep going — and under them the tool reports success for a
 * build that failed. Such a command is still a build; it just cannot be counted
 * as one that PASSED.
 */
export function outcomeSwallowed(command: string): boolean {
  return /(\|\||;)\s*(true|:|echo\b)/.test(command) || /\bset\s+\+e\b/.test(command)
}

/** A command that ran SQL against a real database, and the file it ran, when
 *  the file was piped or sourced. `mysql -e 'select 1'` counts as reaching a
 *  database but names no file. */
export function sqlExecution(command: string): { reachedDb: boolean, files: string[] } {
  const files: string[] = []
  let reachedDb = false
  const CLIENT = /^(mysql|mariadb|psql|sqlplus|sqlcmd|sqlite3|mongosh|mongo)$/
  for (const seg of commandSegments(command)) {
    const words = seg.split(/\s+/)
    const name = (words[0] ?? '').replace(/^.*\//, '')
    // `docker exec db mysql …` is how this estate reaches a database at all —
    // every product's stack is a compose file — so a remediation script run the
    // normal way must count as run.
    const viaContainer = /^(docker|podman|kubectl)$/.test(name)
      && words.some(w => CLIENT.test(w.replace(/^.*\//, '')))
    if (!CLIENT.test(name) && !viaContainer) continue
    reachedDb = true
    // `mysql … < file.sql`, `-e "source file.sql"`, `psql -f file.sql`
    for (const m of seg.matchAll(/(?:<|-f|source)\s*(\S+\.sql)/gi)) files.push(m[1]!.replace(/^.*\//, ''))
  }
  return { reachedDb, files }
}

export interface ExecutionFacts {
  /** A project build or test that the tool did not report as failing. */
  builtOk: boolean
  /** A project build that the tool reported as failing. */
  buildFailed: boolean
  /** Commands that reached a database client at all. */
  reachedDatabase: boolean
  /** Base filenames of .sql files that were actually fed to a database. */
  sqlFilesExecuted: string[]
  /** The build commands themselves, for a finding that has to show its work. */
  buildCommands: string[]
}

/**
 * Everything the gates ask.
 *
 * `within` scopes the answer to one checkout. A multi-repo run builds one
 * repository and changes two; without scoping, the build that succeeded in A
 * vouches for untouched code in B. An entry counts for a directory when it ran
 * INSIDE it (a module build) or in a directory that CONTAINS it (a root build
 * covers its modules). An entry whose directory was never recorded is excluded
 * when scoping is asked for — unknown is not the same as here.
 */
export function executionFacts(entries: CommandEntry[], within?: string): ExecutionFacts {
  const facts: ExecutionFacts = {
    builtOk: false, buildFailed: false, reachedDatabase: false, sqlFilesExecuted: [], buildCommands: [],
  }
  const inScope = (e: CommandEntry) => {
    if (!within) return true
    if (!e.cwd) return false
    return e.cwd === within || e.cwd.startsWith(`${within}/`) || within.startsWith(`${e.cwd}/`)
  }
  for (const e of entries) {
    if (!inScope(e)) continue
    if (isProjectBuild(e.command)) {
      facts.buildCommands.push(e.command)
      if (e.failed) facts.buildFailed = true
      // A success is only a success when the outcome is KNOWN and the shell did
      // not swallow it. Everything else leaves builtOk where it was: the gate
      // asks for proof, and "probably" is not proof.
      else if (!e.unresolved && !outcomeSwallowed(e.command)) facts.builtOk = true
    }
    if (e.failed || e.unresolved) continue
    const sql = sqlExecution(e.command)
    if (sql.reachedDb) facts.reachedDatabase = true
    for (const f of sql.files) if (!facts.sqlFilesExecuted.includes(f)) facts.sqlFilesExecuted.push(f)
  }
  return facts
}

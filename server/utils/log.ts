/**
 * A small leveled, namespaced logger for the server side of this app.
 *
 * Why this exists: diagnosing a misbehaving pipeline run has repeatedly
 * meant reconstructing what happened from artifacts written AFTER the fact
 * (runArtifacts.ts) — because there was no logger at all, just one
 * `console.error` in workflowRunner.ts. Three real incidents this was built
 * for:
 *   1. An agent halted claiming a plugin was not installed. It was — the
 *      agent's own working directory made its search structurally incapable
 *      of finding it. Three runs died before that was understood, because
 *      nothing recorded what the runner-side check (which COULD see it) saw.
 *   2. callAgent treated an SDK *error* result as success and recorded empty
 *      output — a failure that looked exactly like an empty success.
 *   3. finalizeRunArtifacts could throw and be swallowed, leaving an agent's
 *      self-reported `fix` facts standing as if the runner had verified them.
 * The goal: answer "what did this step actually do, with what inputs, and
 * what came back" without re-running anything.
 *
 * ── Convention: LOG_LEVEL + DEBUG (chosen, not the only valid shape) ───────
 *
 * `LOG_LEVEL` (error|warn|info|debug, default 'warn') sets a global severity
 * floor — a message at a level more verbose than the floor never renders,
 * for any namespace. Default is 'warn' rather than 'info' specifically so
 * that "default must be quiet" is literally true: today's only log line
 * (workflowRunner.ts's console.error) is an ERROR-class event, so a 'warn'
 * floor reproduces exactly that visibility and no more, while everything
 * this task adds (step lifecycle, agent-call detail, artifact writes,
 * watcher cycles) lives at 'info' or 'debug' and stays silent until asked
 * for.
 *
 * `DEBUG` is a namespace filter, same shape as the popular `debug` npm
 * package: a comma-separated list of namespaces (`DEBUG=runner,agent`) or
 * `*` for all. It narrows `debug()`-level output only — error/warn/info
 * always print (once LOG_LEVEL allows them) regardless of DEBUG, because
 * those are meant to be seen for every subsystem, not opted into per
 * subsystem. When DEBUG is unset it defaults to "all namespaces" so that
 * `LOG_LEVEL=debug` alone (what `scripts/serve.sh start --debug` sets) is
 * enough to see everything; DEBUG then narrows the firehose down to one or
 * two subsystems (`DEBUG=agent` while chasing a model/tool-budget question).
 *
 * Both are read from `process.env` on every call, not cached at import time,
 * so tests (and a running process, if the env changes) can flip them without
 * re-importing this module.
 *
 * ── Cost when disabled ──────────────────────────────────────────────────
 *
 * `message` and `meta` may be passed as plain values OR as zero-arg thunks
 * (`() => ...`). `emit()` checks the level/namespace gate BEFORE resolving
 * either thunk, so a call site building an expensive string (a truncated
 * agent-output preview, a JSON.stringify of a usage object) pays nothing
 * when that call is suppressed — the thunk is simply never invoked. Use a
 * thunk for anything nontrivial to compute; a short literal string is cheap
 * enough to pass directly.
 *
 * ── Secrets ──────────────────────────────────────────────────────────────
 *
 * Never log a value for a field whose key looks secret-shaped (see
 * SECRET_KEY_PATTERN below) — this module redacts those automatically,
 * replacing the value with `[redacted:<length>chars]`, as a defense-in-depth
 * backstop over the real discipline: call sites should pass `secretShape()`
 * (presence + length only) rather than the raw value in the first place.
 * Every string value, secret-shaped or not, is also capped at
 * `MAX_META_STRING` characters, so a call site that forgets to truncate a
 * large agent input/output never dumps the whole payload into the log.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'
export type Namespace = 'runner' | 'agent' | 'artifacts' | 'watcher' | 'jira'

const LEVEL_RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 }
const VALID_LEVELS = new Set<string>(['error', 'warn', 'info', 'debug'])

/** Quiet by default — see the module doc comment for why 'warn', not 'info'. */
export const DEFAULT_LOG_LEVEL: LogLevel = 'warn'

function currentLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase()
  return raw && VALID_LEVELS.has(raw) ? (raw as LogLevel) : DEFAULT_LOG_LEVEL
}

/** Unset or '*' means every namespace is eligible for debug-level output —
 *  see the module doc comment for why the default is "all", not "none". */
function namespaceEnabled(ns: Namespace): boolean {
  const raw = process.env.DEBUG?.trim()
  if (!raw || raw === '*') return true
  return raw.split(',').map(s => s.trim()).filter(Boolean).includes(ns)
}

function shouldLog(level: LogLevel, ns: Namespace): boolean {
  if (LEVEL_RANK[level] > LEVEL_RANK[currentLevel()]) return false
  if (level === 'debug' && !namespaceEnabled(ns)) return false
  return true
}

type Thunk<T> = T | (() => T)
function resolveThunk<T>(v: Thunk<T>): T {
  return typeof v === 'function' ? (v as () => T)() : v
}

/** Key names treated as secret-shaped regardless of what the caller passes —
 *  the automatic backstop described in the module doc comment. Matches
 *  GITHUB_TOKEN / JIRA_API_TOKEN / JIRA_EMAIL-style field names and their
 *  common variants. */
const SECRET_KEY_PATTERN = /token|password|secret|apikey|api_key|authoriz|credential|email/i

/** Individual meta string values are capped here — independent of, and in
 *  addition to, whatever truncation a call site already applied (see
 *  `preview()` below) for text that can be large (agent input/output,
 *  ticket bodies). */
const MAX_META_STRING = 2000

function renderMetaValue(key: string, value: unknown): string {
  if (SECRET_KEY_PATTERN.test(key) && typeof value === 'string') {
    return `[redacted:${value.length}chars]`
  }
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') {
    return value.length > MAX_META_STRING
      ? `${value.slice(0, MAX_META_STRING)}…[+${value.length - MAX_META_STRING} more chars]`
      : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    const json = JSON.stringify(value)
    if (json === undefined) return String(value)
    return json.length > MAX_META_STRING ? `${json.slice(0, MAX_META_STRING)}…[truncated]` : json
  } catch {
    return String(value)
  }
}

function formatMeta(meta: Record<string, unknown>): string {
  return Object.entries(meta).map(([k, v]) => `${k}=${renderMetaValue(k, v)}`).join(' ')
}

function emit(
  level: LogLevel,
  ns: Namespace,
  message: Thunk<string>,
  meta?: Thunk<Record<string, unknown> | undefined>,
): void {
  // Gate BEFORE resolving either thunk — this is what makes a disabled debug
  // call cost nothing: the (possibly expensive) message/meta builder never runs.
  if (!shouldLog(level, ns)) return
  const msg = resolveThunk(message)
  const metaObj = meta === undefined ? undefined : resolveThunk(meta)
  const metaStr = metaObj && Object.keys(metaObj).length ? ` ${formatMeta(metaObj)}` : ''
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${ns}] ${msg}${metaStr}`
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  sink(line)
}

export interface Logger {
  error(message: Thunk<string>, meta?: Thunk<Record<string, unknown> | undefined>): void
  warn(message: Thunk<string>, meta?: Thunk<Record<string, unknown> | undefined>): void
  info(message: Thunk<string>, meta?: Thunk<Record<string, unknown> | undefined>): void
  debug(message: Thunk<string>, meta?: Thunk<Record<string, unknown> | undefined>): void
  /** Lets a call site skip building an expensive thunk entirely when the
   *  level/namespace gate would drop it anyway — rarely needed since emit()
   *  already resolves thunks lazily, but useful when the "message" itself
   *  requires a multi-step computation rather than one closure. */
  enabled(level: LogLevel): boolean
}

export function createLogger(ns: Namespace): Logger {
  return {
    error: (m, meta) => emit('error', ns, m, meta),
    warn: (m, meta) => emit('warn', ns, m, meta),
    info: (m, meta) => emit('info', ns, m, meta),
    debug: (m, meta) => emit('debug', ns, m, meta),
    enabled: level => shouldLog(level, ns),
  }
}

/** Truncated excerpt for potentially large and/or sensitive-content text —
 *  agent input/output, ticket descriptions. Never log the whole payload;
 *  this is the shared truncation policy every call site uses, so a reader
 *  always knows the same limit applies everywhere. */
export const PREVIEW_LIMIT = 400
export function preview(text: string, limit: number = PREVIEW_LIMIT): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…[+${text.length - limit} more chars]`
}

/** Presence/length only — never the value. Use for anything secret-shaped
 *  (GITHUB_TOKEN, JIRA_API_TOKEN, JIRA_EMAIL, ...) before handing it to a
 *  logger. Belt-and-suspenders with the automatic key-name redaction above:
 *  this is the discipline call sites should follow; the key-name match is
 *  the backstop for when they don't. */
export function secretShape(value: string | undefined | null): { present: boolean, length: number } {
  return { present: Boolean(value && value.length > 0), length: value?.length ?? 0 }
}

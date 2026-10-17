/**
 * Where every alepo-mcp gateway call is recorded.
 *
 * Two sinks, chosen at call time:
 *
 * 1. `./auditLog.ts` (`appendAudit`), the instance-wide hash-chained log that a
 *    sibling change adds. When that module is present every gateway call is a
 *    record of kind `mcp-call` in the same chain as gate decisions and run
 *    starts, which is where an auditor would look for it.
 * 2. Otherwise `<AGENT_RUNS_DIR>/audit/mcp.jsonl`: one JSON object per line,
 *    append-only, beside the run evidence for the same reason runArtifacts.ts
 *    puts evidence there (written by the server with `fs`, never through an
 *    agent's Write tool).
 *
 * The import is dynamic and guarded so this file builds and runs whether or
 * not auditLog.ts exists yet; once it has landed, the static import is a
 * one-line follow-up and the fallback can go.
 *
 * A failed append is logged and never thrown: the call it records has already
 * happened, and failing the tool result would tell the caller it had not.
 * `readMcpAudit` reads from whichever sink is active, so a test need not know.
 */
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentRunsRoot } from './runArtifacts.ts'
import { createLogger } from './log.ts'

const log = createLogger('runner')

export const MCP_AUDIT_KIND = 'mcp-call'

export interface McpAuditRecord {
  ts: string
  /** `api-token:<login>` for a bearer, else the session's login. */
  actor: string
  kind: typeof MCP_AUDIT_KIND
  /** The tool or resource name: `jira.search`, `resource:alepo://registry/products`. */
  ref: string
  payload: {
    args?: Record<string, unknown>
    ok: boolean
    error?: string
    ms: number
    /** Anything the tool wants remembered: the JQL actually sent, the fields set, the token's expiry. */
    [k: string]: unknown
  }
}

/** The fallback file, when the chained log is not present. */
export function mcpAuditFallbackPath(): string {
  return join(agentRunsRoot(), 'audit', 'mcp.jsonl')
}

interface ChainedLog {
  appendAudit: (input: { actor: string, kind: string, ref: string, payload: Record<string, unknown> }) => Promise<unknown>
  readAudit: () => Promise<{ ts: string, actor: string, kind: string, ref: string, payload: Record<string, unknown> }[]>
}

/**
 * The chained log when it exists beside this file, else null. Resolved once;
 * the specifier is a variable so the bundler leaves the import to run time
 * instead of failing the build on a file that is not there.
 */
let chained: Promise<ChainedLog | null> | undefined
function chainedLog(): Promise<ChainedLog | null> {
  if (chained) return chained
  chained = (async () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const spec = './auditLog.ts'
    if (!existsSync(join(here, spec))) return null
    try {
      const mod = await import(/* @vite-ignore */ spec) as Partial<ChainedLog>
      return typeof mod.appendAudit === 'function' && typeof mod.readAudit === 'function' ? mod as ChainedLog : null
    } catch {
      return null
    }
  })()
  return chained
}

/** Secrets never reach the log: a bundle's body is replaced by its size, a token by its shape. */
export function redactArgs(args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!args) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    if (/token|secret|password/i.test(k) && typeof v === 'string') out[k] = `<${v.length} chars>`
    else if (k === 'bundle' && v && typeof v === 'object') out[k] = `<bundle, ${JSON.stringify(v).length} bytes>`
    else out[k] = v
  }
  return out
}

/** Appends one record. Resolves when written (or when the failure has been logged). */
export async function appendMcpAudit(input: Omit<McpAuditRecord, 'ts' | 'kind'>): Promise<void> {
  const record: McpAuditRecord = { ts: new Date().toISOString(), kind: MCP_AUDIT_KIND, ...input }
  try {
    const log2 = await chainedLog()
    if (log2) {
      await log2.appendAudit({ actor: record.actor, kind: record.kind, ref: record.ref, payload: { ...record.payload } })
      return
    }
    const path = mcpAuditFallbackPath()
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify(record)}\n`, 'utf-8')
  } catch (err) {
    log.warn('mcp audit append failed', { ref: input.ref, error: err instanceof Error ? err.message : String(err) })
  }
}

/** Every gateway record, in order, from whichever sink is active. */
export async function readMcpAudit(): Promise<McpAuditRecord[]> {
  const log2 = await chainedLog()
  if (log2) {
    return (await log2.readAudit()).filter(r => r.kind === MCP_AUDIT_KIND) as unknown as McpAuditRecord[]
  }
  const path = mcpAuditFallbackPath()
  if (!existsSync(path)) return []
  return (await readFile(path, 'utf-8')).split('\n').filter(l => l.trim()).flatMap((l) => {
    try { return [JSON.parse(l) as McpAuditRecord] } catch { return [] }
  })
}

/** Which sink `appendMcpAudit` writes to right now, for the docs route and the test's message. */
export async function mcpAuditSink(): Promise<'chained' | 'file'> {
  return (await chainedLog()) ? 'chained' : 'file'
}

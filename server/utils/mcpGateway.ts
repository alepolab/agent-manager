/**
 * The alepo-mcp gateway, v0: an MCP server that hands a Claude Code session or
 * a sandbox run a narrow, audited view of the estate - Jira and Confluence
 * reads under allowlists, the product registry, environment locks, and one
 * place to put an evidence bundle - instead of raw credentials.
 *
 * Served by agent-manager at `/api/mcp/gateway` (Streamable HTTP, see
 * server/api/mcp/gateway.ts). Everything that is not transport lives here so
 * `scripts/test-mcp-gateway.mjs` can drive the tools through an in-memory
 * transport with a fake fetch and no network.
 *
 * Read-mostly by design. `jira.transition_with_evidence` is the only write, and
 * it refuses without an evidence URL that points back at this instance (or at
 * an attached artifact), and honours JIRA_POST_ENABLED exactly as the runner's
 * own Jira step does. Nothing here updates issue fields except through that
 * one transition, and nothing creates or comments.
 *
 * Every tool call and every resource read is recorded by server/utils/mcpAudit.ts
 * - who, what, with which arguments (redacted), how long, and whether it
 * succeeded - before the result goes back to the caller.
 *
 * Configuration (env wins over settings.json, as everywhere in this app):
 *   ALEPO_MCP_JIRA_PROJECTS       comma-separated project keys `jira.search` may query
 *                                  (default: every project the registry's products claim)
 *   ALEPO_MCP_CONFLUENCE_SPACES   comma-separated space keys (default below)
 *   CONFLUENCE_BASE_URL           Confluence host; defaults to the Jira host's
 *                                  `/wiki` (Atlassian Cloud layout)
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { isJiraPostingEnabled, jiraAuthHeader, jiraBaseUrl, resolveJiraCredentials, type JiraCredentials } from './jiraCredentials.ts'
import { adfToPlainText } from './adf.ts'
import type { FetchLike } from './jiraTicketSource.ts'
import { resolveTransition } from './jiraSteps.ts'
import { loadRegistry, productByKey, resolveProduct } from './registry.ts'
import { runArtifactsDir, writeArtifactJson } from './runArtifacts.ts'
import { getRun, listRuns } from './workflowRunStore.ts'
import { EnvLockHeldError, MAX_TTL_MINUTES, releaseEnvLock, requestEnvLock } from './envLocks.ts'
import { appendMcpAudit, redactArgs } from './mcpAudit.ts'
import { envForUser } from './users.ts'
import { envString } from './appSettings.ts'
import { baseUrl } from './notify.ts'
import { isTestRun, type WorkflowRun } from '../../shared/types/run.ts'
import type { Capabilities } from '../../shared/types/role.ts'

export const GATEWAY_NAME = 'alepo-mcp'
export const GATEWAY_VERSION = '0.1.0'

export const DEFAULT_CONFLUENCE_SPACES = ['RDPR', 'QAP', 'RDP', 'RD', 'RNDM', 'ASE13', 'AMS', 'ACSDOC', 'PMS', 'PPC', 'FFM']
export const MAX_SEARCH_RESULTS = 50


/** Who is calling, as the audit log and Jira attribution want it. */
export interface GatewayCaller {
  /** The developer's login: the API token's configured login, or the session's. */
  login: string
  /** `api-token` when a bearer was presented, `session` for a cookie, `test` in the suite. */
  via: 'api-token' | 'session' | 'test'
  /**
   * The caller's role capabilities (shared/types/role.ts), as the route resolved
   * them. Reads need none; the three tools that change something ask here, the
   * same way every mutating API route asks requireCapability. Absent means the
   * caller may do everything, which only the test suite uses.
   */
  capabilities?: Capabilities
}

export interface GatewayOptions {
  caller: GatewayCaller
  fetchImpl?: FetchLike
  /** Clock, for the lock tests. */
  now?: () => number
}

const list = (raw: string | undefined) => (raw ?? '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean)

/** The Jira projects `jira.search` may query: the env list, else every project a registered product claims. */
export async function allowedJiraProjects(): Promise<string[]> {
  const pinned = list(envString('ALEPO_MCP_JIRA_PROJECTS'))
  if (pinned.length) return pinned
  const reg = await loadRegistry()
  const out = new Set<string>()
  for (const p of Object.values(reg?.products ?? {})) {
    for (const key of (p as { match?: { projects?: string[] } })?.match?.projects ?? []) out.add(String(key).toUpperCase())
  }
  return [...out]
}

export function allowedConfluenceSpaces(): string[] {
  const pinned = list(envString('ALEPO_MCP_CONFLUENCE_SPACES'))
  return pinned.length ? pinned : DEFAULT_CONFLUENCE_SPACES
}

// ── JQL allowlist ─────────────────────────────────────────────────────────────

/**
 * Does this JQL confine itself to the allowed projects? The check is textual
 * and conservative: the query must contain a `project` clause, every project
 * it names must be in the list, and the clause must not be negated or OR'd
 * away. Anything the parser does not understand is refused, with the reason,
 * and the caller can rewrite - `project = X AND <rest>` always passes.
 *
 * Exported for the test. The tool itself wraps the query as
 * `project in (<allowed>) AND (<jql>)` after this check, so even a query that
 * slipped through could not read outside the list.
 */
export function checkJql(jql: string, allowed: string[]): { ok: true, projects: string[] } | { ok: false, reason: string } {
  const text = String(jql ?? '').trim()
  if (!text) return { ok: false, reason: 'jql is empty' }
  if (!allowed.length) return { ok: false, reason: 'no Jira projects are allowed on this instance: set ALEPO_MCP_JIRA_PROJECTS or register products with match.projects' }
  if (/\b(not|!=)\s*(in\b|project)|\bproject\s*(!=|not\s+in)/i.test(text)) {
    return { ok: false, reason: 'a negated project clause is not allowed' }
  }
  const clauses = [...text.matchAll(/\bproject\s*(=|in)\s*(\(([^)]*)\)|"([^"]+)"|'([^']+)'|([A-Za-z0-9_]+))/gi)]
  if (!clauses.length) return { ok: false, reason: `jql must name a project with "project = KEY" or "project in (KEYS)"; allowed: ${allowed.join(', ')}` }
  const named = new Set<string>()
  for (const m of clauses) {
    const inside = m[3] !== undefined ? m[3] : (m[4] ?? m[5] ?? m[6] ?? '')
    for (const raw of inside.split(',')) {
      const key = raw.trim().replace(/^["']|["']$/g, '').toUpperCase()
      if (key) named.add(key)
    }
  }
  const outside = [...named].filter(k => !allowed.includes(k))
  if (outside.length) return { ok: false, reason: `project ${outside.join(', ')} is not in the allowlist (${allowed.join(', ')})` }
  // `project = X OR assignee = me` reads everything the second clause allows.
  // Only a query where every OR is inside parentheses, or absent, is accepted.
  const depthZeroOr = (() => {
    let depth = 0
    for (const tok of text.matchAll(/\(|\)|\bor\b/gi)) {
      if (tok[0] === '(') depth++
      else if (tok[0] === ')') depth = Math.max(0, depth - 1)
      else if (depth === 0) return true
    }
    return false
  })()
  if (depthZeroOr) return { ok: false, reason: 'an OR at the top level can widen the query past the project clause; wrap the alternatives in parentheses' }
  return { ok: true, projects: [...named] }
}

// ── Evidence URL rule ─────────────────────────────────────────────────────────

/**
 * The one write's precondition: the evidence must be reachable from this
 * instance. Either an https URL under the agent-manager host (a run page, an
 * artifact route, the evidence bundle) or an artifact already attached to a
 * run, named `artifact:<runId>/<name>`. A URL on any other host is refused -
 * including the Jira host, because a link to the ticket itself is not
 * evidence that anything was done.
 *
 * `http://localhost` is accepted only when the instance itself is configured
 * that way (AGENT_MANAGER_URL unset or http://localhost:3030), which is the
 * development case and never a deployment.
 */
export function checkEvidenceUrl(evidenceUrl: string, host = baseUrl()): { ok: true, kind: 'url' | 'artifact', path: string } | { ok: false, reason: string } {
  const value = String(evidenceUrl ?? '').trim()
  if (!value) return { ok: false, reason: 'evidenceUrl is required' }
  const artifact = /^artifact:([^/\s]+)\/(.+)$/.exec(value)
  if (artifact) {
    const [, runId, name] = artifact
    const full = join(runArtifactsDir(runId!), name!)
    const root = runArtifactsDir(runId!)
    if (!full.startsWith(root) || !existsSync(full)) return { ok: false, reason: `no artifact ${name} is attached to run ${runId}` }
    return { ok: true, kind: 'artifact', path: full }
  }
  let url: URL
  try { url = new URL(value) } catch { return { ok: false, reason: `"${value}" is not a URL` } }
  let own: URL
  try { own = new URL(host) } catch { return { ok: false, reason: 'AGENT_MANAGER_URL is not a URL; cannot decide what is under this host' } }
  const devHost = own.protocol === 'http:' && (own.hostname === 'localhost' || own.hostname === '127.0.0.1')
  if (url.protocol !== 'https:' && !(devHost && url.protocol === 'http:')) {
    return { ok: false, reason: 'evidenceUrl must be https' }
  }
  if (url.host.toLowerCase() !== own.host.toLowerCase()) {
    return { ok: false, reason: `evidenceUrl must be under this instance (${own.host}); ${url.host} is not` }
  }
  return { ok: true, kind: 'url', path: url.pathname }
}

// ── Evidence bundle validation ────────────────────────────────────────────────

/** v0.2 when shipped, else v0.1. The schema is read per call: it is small and a deploy may swap it. */
export function evidenceSchemaPath(): { path: string, version: string } | null {
  const root = join(process.cwd(), 'engineering', 'schemas')
  for (const version of ['0.2', '0.1']) {
    const path = join(root, `evidence-bundle.v${version}.schema.json`)
    if (existsSync(path)) return { path, version }
  }
  return null
}

/**
 * The subset of JSON Schema the bundle schemas use, ported from
 * engineering/scripts/validate-bundle.mjs (required, types, enums, patterns,
 * bounds, items, additionalProperties: false, $ref into $defs, uri format,
 * allOf/if/then). Kept here rather than imported from the .mjs so the server
 * bundle does not reach into a CLI script; drift between the two would show
 * in the test that validates the same bundle both ways.
 */
function walk(node: unknown, schema: any, path: string, defs: any, out: string[]): void {
  const D = defs ?? schema.$defs ?? {}
  if (schema.$ref) return walk(node, D[String(schema.$ref).replace('#/$defs/', '')] ?? {}, path, D, out)
  const types: string[] | null = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : null
  if (types) {
    const actual = node === null ? 'null' : Array.isArray(node) ? 'array' : Number.isInteger(node) ? 'integer' : typeof node
    if (!types.some(t => t === actual || (t === 'number' && actual === 'integer'))) { out.push(`${path}: expected ${types.join(' or ')}, got ${actual}`); return }
  }
  if (schema.enum && !schema.enum.includes(node)) out.push(`${path}: "${String(node)}" is not one of ${schema.enum.filter((e: unknown) => e !== null).join(', ')}`)
  if (schema.pattern && typeof node === 'string' && !new RegExp(schema.pattern).test(node)) out.push(`${path}: "${node}" does not match ${schema.pattern}`)
  if (schema.format === 'uri' && typeof node === 'string' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(node)) out.push(`${path}: "${node}" is not a URI`)
  if (schema.minLength !== undefined && typeof node === 'string' && node.length < schema.minLength) out.push(`${path}: is empty`)
  if (schema.minimum !== undefined && typeof node === 'number' && node < schema.minimum) out.push(`${path}: ${node} is below the minimum ${schema.minimum}`)
  if (schema.maximum !== undefined && typeof node === 'number' && node > schema.maximum) out.push(`${path}: ${node} is above the maximum ${schema.maximum}`)
  if (Array.isArray(node)) {
    if (schema.minItems !== undefined && node.length < schema.minItems) out.push(`${path}: needs at least ${schema.minItems} item(s)`)
    if (schema.items) node.forEach((v, i) => walk(v, schema.items, `${path}[${i}]`, D, out))
    return
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>
    for (const req of schema.required ?? []) if (!(req in obj)) out.push(`${path}: missing required key "${req}"`)
    for (const [k, v] of Object.entries(obj)) {
      const sub = schema.properties?.[k]
      if (sub) { walk(v, sub, `${path}.${k}`, D, out); continue }
      if (schema.additionalProperties === false) out.push(`${path}.${k}: is not a recognised key`)
      else if (typeof schema.additionalProperties === 'object') walk(v, schema.additionalProperties, `${path}.${k}`, D, out)
    }
  }
}

function matchesIf(node: any, ifSchema: any): boolean {
  if (!ifSchema) return true
  if (ifSchema.const !== undefined) return node === ifSchema.const
  if (ifSchema.enum && !ifSchema.enum.includes(node)) return false
  if (ifSchema.required) for (const k of ifSchema.required) if (node == null || typeof node !== 'object' || !(k in node)) return false
  if (ifSchema.properties) {
    for (const [k, sub] of Object.entries(ifSchema.properties)) {
      if (node && typeof node === 'object' && k in node && !matchesIf(node[k], sub)) return false
    }
  }
  return true
}

/** Problems with a bundle against the shipped schema; empty means valid. */
export function validateEvidenceBundle(bundle: unknown): { version: string | null, problems: string[] } {
  const found = evidenceSchemaPath()
  if (!found) return { version: null, problems: ['no evidence-bundle schema is shipped under engineering/schemas'] }
  const schema = JSON.parse(readFileSync(found.path, 'utf-8'))
  const problems: string[] = []
  walk(bundle, schema, 'bundle', schema.$defs, problems)
  for (const clause of schema.allOf ?? []) if (matchesIf(bundle, clause.if)) walk(bundle, clause.then, 'bundle', schema.$defs, problems)
  return { version: found.version, problems }
}

// ── Jira / Confluence HTTP ────────────────────────────────────────────────────

async function credentials(caller: GatewayCaller): Promise<JiraCredentials> {
  const env = await envForUser(caller.login).catch(() => ({} as Record<string, string>))
  if (env.JIRA_EMAIL && env.JIRA_API_TOKEN) {
    const base = (env.JIRA_BASE_URL?.replace(/\/+$/, '') || jiraBaseUrl() || '')
    if (base) return { baseUrl: base, email: env.JIRA_EMAIL, apiToken: env.JIRA_API_TOKEN }
  }
  return resolveJiraCredentials()
}

function confluenceBaseUrl(jira: string): string {
  return (envString('CONFLUENCE_BASE_URL') ?? `${jira}/wiki`).replace(/\/+$/, '')
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  try {
    const body = JSON.parse(text)
    const msgs = [...(body.errorMessages ?? []), ...Object.values(body.errors ?? {}), body.message].filter(Boolean)
    if (msgs.length) return msgs.join('; ')
  } catch { /* plain text */ }
  return text.slice(0, 300) || res.statusText
}

const ISSUE_FIELDS = 'summary,description,status,issuetype,priority,labels,components,assignee,reporter,created,updated,fixVersions,parent'

function issueView(issue: any, base: string) {
  const f = issue.fields ?? {}
  return {
    key: issue.key,
    url: `${base}/browse/${issue.key}`,
    summary: f.summary ?? '',
    status: f.status?.name ?? null,
    statusCategory: f.status?.statusCategory?.key ?? null,
    type: f.issuetype?.name ?? null,
    priority: f.priority?.name ?? null,
    labels: f.labels ?? [],
    components: (f.components ?? []).map((c: any) => c.name).filter(Boolean),
    assignee: f.assignee?.displayName ?? null,
    reporter: f.reporter?.displayName ?? null,
    created: f.created ?? null,
    updated: f.updated ?? null,
    fixVersions: (f.fixVersions ?? []).map((v: any) => v.name).filter(Boolean),
    parent: f.parent?.key ?? null,
    description: f.description ? adfToPlainText(f.description) : '',
  }
}

// ── Ticket context resource ───────────────────────────────────────────────────

/**
 * The same text GET /api/v1/tickets/:key/context serves when that route is
 * present (a sibling change adds it with server/utils/ticketContext.ts); else
 * the equivalent built here from the run store. The import is dynamic and
 * guarded for the same reason as mcpAudit.ts's.
 */
export async function ticketContextText(key: string, base = baseUrl()): Promise<string> {
  const spec = './ticketContext.ts'
  if (existsSync(join(process.cwd(), 'server', 'utils', spec))) {
    try {
      const mod = await import(/* @vite-ignore */ spec) as { latestRunForTicket?: (k: string) => Promise<WorkflowRun | null>, renderTicketContext?: (k: string, r: WorkflowRun, b: string) => string }
      if (mod.latestRunForTicket && mod.renderTicketContext) {
        const run = await mod.latestRunForTicket(key)
        return run ? mod.renderTicketContext(key, run, base) : `No run recorded for ${key}.\n`
      }
    } catch { /* fall through to the local rendering */ }
  }
  const run = (await listRuns()).find(r => r.ticketKey === key && !isTestRun(r)) ?? null
  if (!run) return `No run recorded for ${key}.\n`
  const lines = [
    `Ticket ${key}: latest run ${run.id} (${run.workflowName}, started by ${run.startedBy ?? 'unknown'}, via ${run.watch}).`,
    `Status: ${run.status}.`,
    `Blast radius: ${run.blastRadius ?? 'unclassified'}.`,
  ]
  if (run.branch || run.baseBranch) lines.push(`Branch: ${run.branch ?? '(none)'}${run.baseBranch ? ` from ${run.baseBranch}` : ''}.`)
  if (run.product) lines.push(`Product: ${run.product.name} (${run.product.repos.join(', ')}).`)
  const bundle = join(runArtifactsDir(run.id), 'bundle.json')
  lines.push(existsSync(bundle) ? `Evidence bundle URL: ${base}/api/runs/${run.id}/artifacts/bundle.json` : 'Evidence bundle: not written yet.')
  lines.push(`Run page: ${base}/runs/${run.id}`)
  return `${lines.join('\n')}\n`
}

// ── The server ────────────────────────────────────────────────────────────────

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })
const refuse = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true })

const TICKET_KEY = /^[A-Z][A-Z0-9]+-\d+$/

/**
 * One McpServer per connection. The caller is fixed at construction, so every
 * tool knows who it acts for without re-reading the request.
 */
export function createGateway(opts: GatewayOptions): McpServer {
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.now ?? (() => Date.now())
  const actor = opts.caller.via === 'api-token' ? `api-token:${opts.caller.login}` : opts.caller.login
  const server = new McpServer({ name: GATEWAY_NAME, version: GATEWAY_VERSION })
  /** 403-equivalent for a tool: the caller's role lacks the capability the write needs. */
  const need = (capability: keyof Capabilities) => {
    const caps = opts.caller.capabilities
    if (caps && !caps[capability]) throw new Error(`refused: your role cannot do this (needs ${capability})`)
  }

  /** Runs a tool body and writes the audit line whatever happened. A thrown error becomes an isError result, never a transport failure. */
  const audited = <A extends Record<string, unknown>>(name: string, body: (args: A, note: (extra: Record<string, unknown>) => void) => Promise<unknown>) =>
    async (args: A) => {
      const started = Date.now()
      const extra: Record<string, unknown> = {}
      const note = (more: Record<string, unknown>) => Object.assign(extra, more)
      try {
        const result = await body(args, note)
        await appendMcpAudit({ actor, ref: name, payload: { args: redactArgs(args), ok: true, ms: Date.now() - started, ...extra } })
        return text(result)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await appendMcpAudit({ actor, ref: name, payload: { args: redactArgs(args), ok: false, error: message, ms: Date.now() - started, ...extra } })
        return refuse(message)
      }
    }

  // jira.get_issue ------------------------------------------------------------
  server.registerTool('jira.get_issue', {
    title: 'Read one Jira issue',
    description: 'One issue by key, with its description as plain text. Read-only.',
    inputSchema: { key: z.string().describe('Issue key, e.g. SA-1406') },
    annotations: { readOnlyHint: true },
  }, audited<{ key: string }>('jira.get_issue', async ({ key }) => {
    const k = key.trim().toUpperCase()
    if (!TICKET_KEY.test(k)) throw new Error(`"${key}" is not an issue key`)
    const allowed = await allowedJiraProjects()
    const project = k.split('-')[0]!
    if (allowed.length && !allowed.includes(project)) throw new Error(`project ${project} is not in the allowlist (${allowed.join(', ')})`)
    const creds = await credentials(opts.caller)
    const res = await fetchImpl(`${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(k)}?fields=${ISSUE_FIELDS}`, {
      headers: { Authorization: jiraAuthHeader(creds), Accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`Jira returned HTTP ${res.status} for ${k}: ${await readError(res)}`)
    return issueView(await res.json(), creds.baseUrl)
  }))

  // jira.search ---------------------------------------------------------------
  server.registerTool('jira.search', {
    title: 'Search Jira (allowlisted projects)',
    description: `JQL search confined to the instance's allowed projects. The query must name a project; at most ${MAX_SEARCH_RESULTS} results. Read-only.`,
    inputSchema: {
      jql: z.string().describe('JQL. Must contain "project = KEY" or "project in (KEYS)" on allowed projects.'),
      maxResults: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional().describe(`1-${MAX_SEARCH_RESULTS}, default 20`),
    },
    annotations: { readOnlyHint: true },
  }, audited<{ jql: string, maxResults?: number }>('jira.search', async ({ jql, maxResults }, note) => {
    const allowed = await allowedJiraProjects()
    const check = checkJql(jql, allowed)
    if (!check.ok) throw new Error(`jql refused: ${check.reason}`)
    const effective = `project in (${allowed.join(', ')}) AND (${jql.trim()})`
    note({ effectiveJql: effective })
    const creds = await credentials(opts.caller)
    const res = await fetchImpl(`${creds.baseUrl}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { Authorization: jiraAuthHeader(creds), Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jql: effective, maxResults: Math.min(maxResults ?? 20, MAX_SEARCH_RESULTS), fields: ISSUE_FIELDS.split(',') }),
    })
    if (!res.ok) throw new Error(`Jira search failed (HTTP ${res.status}): ${await readError(res)}`)
    const body = await res.json() as { issues?: any[], isLast?: boolean, nextPageToken?: string }
    return { jql: effective, issues: (body.issues ?? []).map(i => issueView(i, creds.baseUrl)), isLast: body.isLast ?? true }
  }))

  // jira.transition_with_evidence -------------------------------------------------
  server.registerTool('jira.transition_with_evidence', {
    title: 'Move a Jira issue, citing evidence',
    description: 'The gateway\'s only write. Moves an issue to a status, requiring an https evidence URL under this agent-manager instance (a run page or artifact) or an attached artifact (artifact:<runId>/<name>). Honours JIRA_POST_ENABLED: when it is not 1 the call reports what it would have done. Optional fields are set on the transition screen; which Yes/No gate fields were set is recorded.',
    inputSchema: {
      key: z.string().describe('Issue key'),
      transition: z.string().describe('Target status name (synonyms accepted, e.g. "Dev Done")'),
      evidenceUrl: z.string().describe('https URL under this instance, or artifact:<runId>/<name>'),
      fields: z.record(z.string(), z.union([z.string(), z.boolean()])).optional().describe('Field name -> value for the transition screen. Yes/No gate fields take true/false or "Yes"/"No".'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, audited<{ key: string, transition: string, evidenceUrl: string, fields?: Record<string, string | boolean> }>('jira.transition_with_evidence', async ({ key, transition, evidenceUrl, fields }, note) => {
    need('answerGate')
    const k = key.trim().toUpperCase()
    if (!TICKET_KEY.test(k)) throw new Error(`"${key}" is not an issue key`)
    const evidence = checkEvidenceUrl(evidenceUrl)
    if (!evidence.ok) throw new Error(`refused: ${evidence.reason}`)
    note({ evidence: evidence.kind, evidencePath: evidence.path })
    const allowed = await allowedJiraProjects()
    const project = k.split('-')[0]!
    if (allowed.length && !allowed.includes(project)) throw new Error(`project ${project} is not in the allowlist (${allowed.join(', ')})`)

    const creds = await credentials(opts.caller)
    const headers = { Authorization: jiraAuthHeader(creds), Accept: 'application/json', 'Content-Type': 'application/json' }
    const issueUrl = `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(k)}`
    const listed = await fetchImpl(`${issueUrl}/transitions?expand=transitions.fields`, { headers })
    if (!listed.ok) throw new Error(`could not read the transitions of ${k} (HTTP ${listed.status}): ${await readError(listed)}`)
    const transitions = (((await listed.json()) as { transitions?: any[] })?.transitions) ?? []
    let r = resolveTransition(transition, transitions, undefined)
    if (r.needsCurrent) {
      const cur = await fetchImpl(`${issueUrl}?fields=status`, { headers })
      const status = cur.ok ? ((await cur.json()) as any)?.fields?.status : null
      r = resolveTransition(transition, transitions, status?.name ? { name: status.name, category: status.statusCategory?.key } : null)
    }
    if (r.already) return { key: k, moved: false, posted: false, detail: `${k} is ${r.why}; left as is.`, evidenceUrl }
    if (!r.hit) throw new Error(`${k} cannot be moved to "${transition}": ${r.why}`)
    const hit = r.hit
    const to = hit.to?.name ?? hit.name

    // Fields on the transition screen. A Yes/No gate field is a select or a
    // radio whose options are Yes/No; its value goes as { value: 'Yes' }.
    const screen: Record<string, { name?: string, schema?: { type?: string, custom?: string }, allowedValues?: { value?: string, name?: string }[] }> = hit.fields ?? {}
    const keyOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
    const values: Record<string, unknown> = {}
    const gateFields: Record<string, string> = {}
    const skipped: string[] = []
    for (const [name, raw] of Object.entries(fields ?? {})) {
      const found = Object.entries(screen).find(([id, f]) => id === name || keyOf(f.name ?? '') === keyOf(name))
      if (!found) { skipped.push(`"${name}" is not on the "${hit.name}" screen`); continue }
      const [id, f] = found
      const options = (f.allowedValues ?? []).map(o => o.value ?? o.name ?? '').filter(Boolean)
      const isYesNo = options.length > 0 && options.every(o => /^(yes|no)$/i.test(o))
      const asYesNo = typeof raw === 'boolean' ? (raw ? 'Yes' : 'No') : /^(yes|true|1)$/i.test(raw) ? 'Yes' : /^(no|false|0)$/i.test(raw) ? 'No' : null
      if (isYesNo) {
        if (!asYesNo) { skipped.push(`"${name}" takes Yes or No, not "${raw}"`); continue }
        const option = options.find(o => o.toLowerCase() === asYesNo.toLowerCase()) ?? asYesNo
        values[id] = { value: option }
        gateFields[f.name ?? name] = option
      } else if (f.schema?.type === 'doc' || f.schema?.custom?.includes('textarea')) {
        values[id] = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: String(raw) }] }] }
      } else if (options.length) {
        values[id] = { value: String(raw) }
      } else {
        values[id] = typeof raw === 'boolean' ? String(raw) : raw
      }
    }
    note({ transitionId: hit.id, to, gateFields, skipped })

    if (!isJiraPostingEnabled()) {
      return { key: k, moved: false, posted: false, to, gateFields, skipped, evidenceUrl, detail: `Would move ${k} to "${to}" (transition "${hit.name}") citing ${evidenceUrl}; not done: JIRA_POST_ENABLED is not 1 on this instance.` }
    }
    const body = { transition: { id: hit.id }, ...(Object.keys(values).length ? { fields: values } : {}) }
    const res = await fetchImpl(`${issueUrl}/transitions`, { method: 'POST', headers, body: JSON.stringify(body) })
    if (!res.ok) throw new Error(`moving ${k} to "${to}" failed (HTTP ${res.status}): ${await readError(res)}`)
    return { key: k, moved: true, posted: true, to, transition: hit.name, gateFields, skipped, evidenceUrl, detail: `Moved ${k} to "${to}" (${r.why}).` }
  }))

  // confluence.get_page -------------------------------------------------------------
  const spaceAllowed = (space: string | undefined) => {
    const allowed = allowedConfluenceSpaces()
    if (!space || !allowed.includes(space.toUpperCase())) throw new Error(`space ${space ?? '(unknown)'} is not in the allowlist (${allowed.join(', ')})`)
  }
  server.registerTool('confluence.get_page', {
    title: 'Read one Confluence page',
    description: 'A page by id, body as storage-format text, from an allowlisted space. Read-only.',
    inputSchema: { id: z.string().describe('Page id') },
    annotations: { readOnlyHint: true },
  }, audited<{ id: string }>('confluence.get_page', async ({ id }) => {
    if (!/^\d+$/.test(id.trim())) throw new Error(`"${id}" is not a page id`)
    const creds = await credentials(opts.caller)
    const base = confluenceBaseUrl(creds.baseUrl)
    const res = await fetchImpl(`${base}/rest/api/content/${encodeURIComponent(id.trim())}?expand=body.storage,space,version,ancestors`, {
      headers: { Authorization: jiraAuthHeader(creds), Accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`Confluence returned HTTP ${res.status} for page ${id}: ${await readError(res)}`)
    const page = await res.json() as any
    spaceAllowed(page.space?.key)
    return {
      id: page.id, title: page.title, space: page.space?.key, version: page.version?.number ?? null,
      url: `${base}${page._links?.webui ?? ''}`,
      ancestors: (page.ancestors ?? []).map((a: any) => ({ id: a.id, title: a.title })),
      body: String(page.body?.storage?.value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    }
  }))

  // confluence.search ---------------------------------------------------------------
  server.registerTool('confluence.search', {
    title: 'Search Confluence (allowlisted spaces)',
    description: 'CQL search confined to the allowed spaces: the query is wrapped as `space in (...) AND (<cql>)`. Read-only.',
    inputSchema: {
      cql: z.string().describe('CQL, e.g. text ~ "roaming" AND type = page'),
      limit: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(),
    },
    annotations: { readOnlyHint: true },
  }, audited<{ cql: string, limit?: number }>('confluence.search', async ({ cql, limit }, note) => {
    const q = cql.trim()
    if (!q) throw new Error('cql is empty')
    const allowed = allowedConfluenceSpaces()
    const outside = [...q.matchAll(/\bspace\s*(=|in)\s*(\(([^)]*)\)|"([^"]+)"|'([^']+)'|([A-Za-z0-9_]+))/gi)]
      .flatMap(m => (m[3] ?? m[4] ?? m[5] ?? m[6] ?? '').split(',').map(s => s.trim().replace(/^["']|["']$/g, '').toUpperCase()).filter(Boolean))
      .filter(s => !allowed.includes(s))
    if (outside.length) throw new Error(`space ${outside.join(', ')} is not in the allowlist (${allowed.join(', ')})`)
    const effective = `space in (${allowed.join(', ')}) AND (${q})`
    note({ effectiveCql: effective })
    const creds = await credentials(opts.caller)
    const base = confluenceBaseUrl(creds.baseUrl)
    const url = `${base}/rest/api/content/search?cql=${encodeURIComponent(effective)}&limit=${Math.min(limit ?? 20, MAX_SEARCH_RESULTS)}&expand=space,version`
    const res = await fetchImpl(url, { headers: { Authorization: jiraAuthHeader(creds), Accept: 'application/json' } })
    if (!res.ok) throw new Error(`Confluence search failed (HTTP ${res.status}): ${await readError(res)}`)
    const body = await res.json() as { results?: any[] }
    return {
      cql: effective,
      results: (body.results ?? []).map(r => ({ id: r.id, title: r.title, type: r.type, space: r.space?.key, url: `${base}${r._links?.webui ?? ''}`, version: r.version?.number ?? null })),
    }
  }))

  // registry.* -------------------------------------------------------------------
  server.registerTool('registry.products', {
    title: 'List registered products',
    description: 'Every product in the registry, in file order, with its repos and Jira projects.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, audited<Record<string, never>>('registry.products', async () => {
    const reg = await loadRegistry()
    if (!reg) throw new Error('no registry could be read on this instance')
    return {
      degraded: reg.degraded,
      products: Object.entries(reg.products).map(([key, p]: [string, any]) => ({
        id: key, suite: p.suite ?? null, repos: p.repos ?? [], projects: p.match?.projects ?? [], labels: p.match?.labels ?? [], components: p.match?.components ?? [],
      })),
    }
  }))

  server.registerTool('registry.product', {
    title: 'One registered product',
    description: 'The registry entry for a product id, as the pipeline resolves it (repos, branches, stack, tests, recipe).',
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: true },
  }, audited<{ id: string }>('registry.product', async ({ id }) => {
    const p = await productByKey(id.trim())
    if (!p) throw new Error(`no product "${id}" is registered`)
    return p
  }))

  server.registerTool('registry.resolve', {
    title: 'Which product a ticket belongs to',
    description: 'Resolves an issue key, or a project plus component text, to a registered product the way the pipeline does.',
    inputSchema: {
      issueKey: z.string().optional().describe('e.g. ASECRM-222'),
      project: z.string().optional().describe('Jira project key, when no issue key'),
      component: z.string().optional().describe('Component or label words to disambiguate'),
    },
    annotations: { readOnlyHint: true },
  }, audited<{ issueKey?: string, project?: string, component?: string }>('registry.resolve', async ({ issueKey, project, component }) => {
    const text = [issueKey?.trim().toUpperCase(), project ? `${project.trim().toUpperCase()}-0` : undefined, component].filter(Boolean).join(' ')
    if (!text) throw new Error('give issueKey, or project (and optionally component)')
    const hit = await resolveProduct(text)
    return hit ? { resolved: true, product: hit } : { resolved: false, product: null, detail: 'nothing in the registry claims this text' }
  }))

  // env.* -------------------------------------------------------------------------
  server.registerTool('env.request_lock', {
    title: 'Lock a lab host',
    description: `Issues an ALEPO_ENV_LOCK_TOKEN for one host for up to ${MAX_TTL_MINUTES} minutes. One holder per host; a second requester is refused and told who holds it. Export the token before deploying or testing against that host.`,
    inputSchema: {
      host: z.string(),
      reason: z.string(),
      ttlMinutes: z.number().int().min(1).max(MAX_TTL_MINUTES).optional(),
    },
  }, audited<{ host: string, reason: string, ttlMinutes?: number }>('env.request_lock', async ({ host, reason, ttlMinutes }, note) => {
    need('startRun')
    try {
      const lock = await requestEnvLock({ host, reason, ttlMinutes, requester: opts.caller.login }, now())
      note({ host: lock.host, expiresAt: new Date(lock.expiresAt).toISOString() })
      return { ALEPO_ENV_LOCK_TOKEN: lock.token, host: lock.host, expiresAt: new Date(lock.expiresAt).toISOString(), requester: lock.requester }
    } catch (err) {
      if (err instanceof EnvLockHeldError) note({ heldBy: err.holder.requester })
      throw err
    }
  }))

  server.registerTool('env.release_lock', {
    title: 'Release a lab host lock',
    description: 'Releases the lock this token was issued for.',
    inputSchema: { token: z.string() },
  }, audited<{ token: string }>('env.release_lock', async ({ token }, note) => {
    const r = await releaseEnvLock(token, now())
    note({ released: r.released, host: r.host })
    return r.released ? { released: true, host: r.host } : { released: false, detail: 'no live lock carries that token (released already, expired, or never issued)' }
  }))

  // evidence.put ------------------------------------------------------------------
  server.registerTool('evidence.put', {
    title: 'Attach an evidence bundle to a run',
    description: 'Validates a bundle against the shipped evidence-bundle schema (v0.2 when present, else v0.1) and stores it as the run\'s bundle.json. Returns the artifact URL and its sha256. An invalid bundle is refused with every problem listed.',
    inputSchema: {
      runId: z.string(),
      bundle: z.record(z.string(), z.unknown()),
    },
  }, audited<{ runId: string, bundle: Record<string, unknown> }>('evidence.put', async ({ runId, bundle }, note) => {
    need('startRun')
    const id = runId.trim()
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error(`"${runId}" is not a run id`)
    const run = await getRun(id)
    if (!run) throw new Error(`no run ${id} on this instance`)
    const { version, problems } = validateEvidenceBundle(bundle)
    note({ schemaVersion: version, problems: problems.length })
    if (problems.length) throw new Error(`bundle invalid against evidence-bundle v${version ?? '?'} (${problems.length} problem(s)):\n${problems.map(p => `- ${p}`).join('\n')}`)
    if (typeof bundle.ticket === 'string' && run.ticketKey && bundle.ticket !== run.ticketKey) {
      throw new Error(`bundle.ticket is ${bundle.ticket} but run ${id} is for ${run.ticketKey}`)
    }
    await writeArtifactJson(id, 'bundle.json', bundle)
    const stored = readFileSync(join(runArtifactsDir(id), 'bundle.json'))
    const sha256 = createHash('sha256').update(stored).digest('hex')
    note({ sha256 })
    return { url: `${baseUrl()}/api/runs/${id}/artifacts/bundle.json`, sha256, schemaVersion: version, bytes: stored.length }
  }))

  // Resources -----------------------------------------------------------------------
  const auditedRead = async (uri: string, body: () => Promise<string>, mimeType = 'text/plain') => {
    const started = Date.now()
    try {
      const value = await body()
      await appendMcpAudit({ actor, ref: `resource:${uri}`, payload: { ok: true, ms: Date.now() - started } })
      return { contents: [{ uri, mimeType, text: value }] }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await appendMcpAudit({ actor, ref: `resource:${uri}`, payload: { ok: false, error: message, ms: Date.now() - started } })
      throw err
    }
  }

  server.registerResource('registry-products', 'alepo://registry/products', {
    title: 'Registered products', description: 'The product registry as JSON.', mimeType: 'application/json',
  }, async uri => auditedRead(uri.href, async () => {
    const reg = await loadRegistry()
    if (!reg) throw new Error('no registry could be read on this instance')
    return JSON.stringify({ degraded: reg.degraded, products: reg.products }, null, 2)
  }, 'application/json'))

  server.registerResource('ticket-context', new ResourceTemplate('alepo://ticket/{key}/context', { list: undefined }), {
    title: 'Ticket context', description: 'What a session starting on a ticket needs to know: its latest run and where it stands.', mimeType: 'text/plain',
  }, async (uri, { key }) => auditedRead(uri.href, async () => {
    const k = String(key ?? '').trim().toUpperCase()
    if (!TICKET_KEY.test(k)) throw new Error(`"${String(key)}" is not a ticket key`)
    return ticketContextText(k)
  }))

  return server
}

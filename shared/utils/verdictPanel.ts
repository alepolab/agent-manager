/**
 * The verdict panel: a step kind that runs several independent reviewers over
 * one change and turns their verdicts into one monitor verdict.
 *
 * Pure and dependency-free, like the rest of `shared/`: the runner reads the
 * files and calls the agents, this module decides what each member is told,
 * what counts as a verdict, and what the panel as a whole concluded. The node
 * test scripts import it directly.
 *
 * Why a panel rather than two more review steps. Code Review and Alepo Review
 * each continued from, or were handed, the implementer's own account of the
 * change, and a reviewer who reads the implementer's reasoning reviews that
 * reasoning rather than the code. A panel member is handed the ticket, the
 * acceptance criteria, the diff range and the test commands - never the
 * implementer's transcript or session - and must end with a verdict the
 * runner can parse. A member that cannot be parsed has not passed.
 */

export interface PanelMember {
  /** The agent that sits on the panel. */
  agentSlug: string
  /** What this member is asked to judge, when the step narrows it. Absent: the whole change. */
  criterion?: string
}

export interface PanelConfig {
  members: PanelMember[]
  /** Uncached tokens the whole panel may spend per visit before the run pauses and asks. */
  budgetTokens: number
  /** How many times a failing panel may send the run back before it pauses for a person. */
  maxLoops: number
  /**
   * The step a failing panel sends the run back to, by label. Absent: the
   * nearest earlier step whose agent makes changes (see CHANGE_MAKERS in
   * decisionBrief.ts), else the nearest earlier agent step.
   */
  reworkTarget?: string
}

/** The pseudo agent slug a panel step is stored under. The runner never calls it. */
export const PANEL_AGENT_SLUG = 'sdlc-verdict-panel'

export const DEFAULT_PANEL_BUDGET_TOKENS = 300_000
export const DEFAULT_PANEL_MAX_LOOPS = 2

export interface VerdictCriterion {
  id: string
  result: 'pass' | 'fail' | 'not_applicable'
  evidence: string[]
  notes?: string
}

/** What one member ends with. See engineering/schemas/verdict.v0.1.schema.json. */
export interface Verdict {
  verdict: 'pass' | 'fail'
  ticket: string
  criteria: VerdictCriterion[]
  risks: string[]
}

/** One member's outcome as the runner records it under panel/<agentSlug>.json. */
export interface MemberResult {
  agentSlug: string
  criterion?: string
  /** The parsed, schema-valid verdict; absent when the member produced none. */
  verdict?: Verdict
  /** Why `verdict` is absent: nothing parseable, or what the schema rejected. */
  problems: string[]
}

/** A step is a panel when it says so, or when it carries a panel config. */
export function isPanelStep(step?: { kind?: string, panel?: unknown } | null): boolean {
  return !!step && (step.kind === 'panel' || !!step.panel)
}

/**
 * Every reason `cfg` is not a usable panel config, or an empty array.
 *
 * Strict on the numbers: a budget of 0 is a panel that can never run, and a
 * loop count of 0 would never send anything back - both are almost certainly a
 * field left blank in the builder rather than a decision.
 */
export function validatePanelConfig(cfg: unknown): string[] {
  const errors: string[] = []
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return ['panel must be an object']
  const c = cfg as Record<string, unknown>
  if (!Array.isArray(c.members) || !c.members.length) errors.push('panel.members must list at least one member')
  else {
    c.members.forEach((m, i) => {
      if (!m || typeof m !== 'object') { errors.push(`panel.members[${i}] must be an object`); return }
      const mm = m as Record<string, unknown>
      if (typeof mm.agentSlug !== 'string' || !mm.agentSlug.trim()) errors.push(`panel.members[${i}].agentSlug must name an agent`)
      if (mm.criterion !== undefined && typeof mm.criterion !== 'string') errors.push(`panel.members[${i}].criterion must be a string`)
    })
  }
  if (typeof c.budgetTokens !== 'number' || !Number.isFinite(c.budgetTokens) || c.budgetTokens < 1) errors.push('panel.budgetTokens must be a positive number')
  if (typeof c.maxLoops !== 'number' || !Number.isInteger(c.maxLoops) || c.maxLoops < 1) errors.push('panel.maxLoops must be a positive integer')
  return errors
}

export interface PanelBriefInput {
  ticketKey?: string
  /** Acceptance criteria or reproduction, from intake's intent/context packet or the plan. */
  criteria: string
  /** `base..head`, or what the runner could say about the change when there is no range. */
  diffRange: string
  /** The checkout the member reads, when there is one. */
  checkout?: string
  /** Registry test commands by name. */
  tests: Record<string, string>
  /** The compose project and any URLs the stack report names. */
  stack: { project?: string, endpoints: string[], note?: string }
  /** Where the member writes anything it wants kept. */
  artifactsDir: string
  member: PanelMember
}

/**
 * What one member is told - and the whole of it. Nothing from the
 * implementer's step reaches this: not its output, not its session, not the
 * reviewer's brief it wrote. The caller is responsible for passing the diff
 * RANGE rather than the diff text, so a member reads the commits itself.
 */
export function panelMemberBrief(input: PanelBriefInput): string {
  const tests = Object.entries(input.tests)
  const lines = [
    '## Verdict panel',
    '',
    'You sit on a verdict panel reviewing one change. You are deliberately given only the facts below - never the implementer\'s reasoning, transcript or self-report - so that your verdict is your own. Read the code; do not take anyone\'s word for it.',
    '',
    `Ticket: ${input.ticketKey ?? '(no ticket key recorded)'}`,
    `Diff range: ${input.diffRange}`,
    ...(input.checkout ? [`Checkout: ${input.checkout} (read-only for you: do not commit, stage, switch branches or touch a remote)`] : []),
    `Compose project: ${input.stack.project ?? '(no stack recorded)'}`,
    ...(input.stack.endpoints.length ? [`Endpoints: ${input.stack.endpoints.join(', ')}`] : []),
    ...(input.stack.note ? [`Stack note: ${input.stack.note}`] : []),
    `Test commands: ${tests.length ? tests.map(([k, v]) => `${k}: ${v}`).join('; ') : 'not registered'}`,
    `Artifacts directory: ${input.artifactsDir}`,
    '',
    '## Acceptance criteria / reproduction',
    '',
    input.criteria.trim() || '(none recorded; judge the change against the ticket)',
    '',
  ]
  if (input.member.criterion?.trim()) {
    lines.push('## Your criterion', '', input.member.criterion.trim(), '')
  }
  lines.push(
    '## How to answer',
    '',
    'Work from the diff range and the checkout, run the test commands where they bear on your judgement, and end your output with exactly one JSON object, on its own, in a ```json fence, of this shape:',
    '',
    '```json',
    `{"verdict":"pass|fail","ticket":"${input.ticketKey ?? 'KEY'}","criteria":[{"id":"<criterion id>","result":"pass|fail|not_applicable","evidence":["<command and output, or file:line>"],"notes":"<one line>"}],"risks":["<a risk you could not rule out>"]}`,
    '```',
    '',
    'A `fail` needs the evidence that fails it. A `pass` with no evidence is not a pass. Do not end with PIPELINE-REWORK, PIPELINE-HALT or any other pipeline line: the runner aggregates the panel and sends the run back itself.',
  )
  return lines.join('\n')
}

/**
 * The ticket-free facts a member may be given, pulled out of intake's
 * artifacts when they exist. Pure: the caller reads the files and passes the
 * text; absent files pass `null`.
 */
export function criteriaFrom(files: { intent?: string | null, contextPacket?: string | null, plan?: string | null, fallback?: string }): string {
  const parts: string[] = []
  if (files.intent?.trim()) parts.push(`### intent.md\n\n${files.intent.trim()}`)
  if (files.contextPacket?.trim()) {
    try {
      const parsed = JSON.parse(files.contextPacket) as Record<string, unknown>
      const picked: Record<string, unknown> = {}
      for (const k of ['acceptance_criteria', 'acceptanceCriteria', 'criteria', 'reproduction', 'repro', 'steps_to_reproduce', 'expected', 'actual']) {
        if (parsed[k] !== undefined) picked[k] = parsed[k]
      }
      if (Object.keys(picked).length) parts.push(`### context-packet.json (selected)\n\n${JSON.stringify(picked, null, 2)}`)
    } catch { /* not JSON: left out rather than quoted whole */ }
  }
  if (!parts.length && files.plan?.trim()) parts.push(`### plan.md\n\n${files.plan.trim().slice(0, 6000)}`)
  if (!parts.length && files.fallback?.trim()) parts.push(files.fallback.trim().slice(0, 6000))
  return parts.join('\n\n')
}

/** URLs a stack report names, deduplicated, in order. */
export function endpointsFrom(stackReport: string | null | undefined): string[] {
  if (!stackReport) return []
  const seen = new Set<string>()
  for (const m of stackReport.matchAll(/https?:\/\/[^\s)>\]"'`]+/g)) seen.add(m[0].replace(/[.,;:]+$/, ''))
  return [...seen]
}

/**
 * Every balanced JSON object in `text`, as parsed values, in order. Fences are
 * ignored: a member that fenced its verdict and one that did not are both
 * read. Strings are skipped so a brace inside a quoted value does not split an
 * object; a candidate that does not parse is dropped, not an error.
 */
export function jsonObjectsIn(text: string): unknown[] {
  const out: unknown[] = []
  let i = 0
  while (i < text.length) {
    if (text[i] !== '{') { i++; continue }
    let depth = 0
    let inString = false
    let escaped = false
    let end = -1
    for (let j = i; j < text.length; j++) {
      const ch = text[j]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}') { depth--; if (depth === 0) { end = j; break } }
    }
    if (end < 0) break
    try { out.push(JSON.parse(text.slice(i, end + 1))) } catch { /* not JSON */ }
    i = end + 1
  }
  return out
}

/** The last JSON object in a member's output that carries a `verdict` key, or null. */
export function extractVerdict(output: string | null | undefined): unknown | null {
  const candidates = jsonObjectsIn(output ?? '').filter(o => !!o && typeof o === 'object' && 'verdict' in (o as Record<string, unknown>))
  return candidates.length ? candidates[candidates.length - 1]! : null
}

/**
 * A minimal JSON-Schema subset, the same one engineering/scripts/validate-bundle.mjs
 * proves: type, required, properties, additionalProperties: false, enum,
 * pattern, minimum/maximum, minItems, items, $ref into $defs. Enough for the
 * verdict schema, and small enough to keep `shared/` dependency-free.
 */
export function validateAgainstSchema(node: unknown, schema: Record<string, any>, path = '$', root?: Record<string, any>): string[] {
  const problems: string[] = []
  const R = root ?? schema
  const walk = (n: unknown, s: Record<string, any>, p: string) => {
    if (s.$ref) {
      const name = String(s.$ref).replace('#/$defs/', '')
      return walk(n, R.$defs?.[name] ?? {}, p)
    }
    const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : null
    if (types) {
      const actual = n === null ? 'null' : Array.isArray(n) ? 'array' : Number.isInteger(n) ? 'integer' : typeof n
      const ok = types.some((t: string) => t === actual || (t === 'number' && actual === 'integer'))
      if (!ok) { problems.push(`${p}: expected ${types.join(' or ')}, got ${actual}`); return }
    }
    if (s.enum && !s.enum.includes(n)) problems.push(`${p}: ${JSON.stringify(n)} is not one of ${s.enum.map((e: unknown) => JSON.stringify(e)).join(', ')}`)
    if (s.pattern && typeof n === 'string' && !new RegExp(s.pattern).test(n)) problems.push(`${p}: "${n}" does not match ${s.pattern}`)
    if (typeof n === 'number') {
      if (s.minimum !== undefined && n < s.minimum) problems.push(`${p}: ${n} is below ${s.minimum}`)
      if (s.maximum !== undefined && n > s.maximum) problems.push(`${p}: ${n} is above ${s.maximum}`)
    }
    if (Array.isArray(n)) {
      if (s.minItems !== undefined && n.length < s.minItems) problems.push(`${p}: needs at least ${s.minItems} item(s)`)
      if (s.items) n.forEach((item, i) => walk(item, s.items, `${p}[${i}]`))
    }
    if (n && typeof n === 'object' && !Array.isArray(n)) {
      const obj = n as Record<string, unknown>
      for (const key of s.required ?? []) if (!(key in obj)) problems.push(`${p}: missing required "${key}"`)
      for (const [key, sub] of Object.entries(s.properties ?? {})) if (key in obj) walk(obj[key], sub as Record<string, any>, `${p}.${key}`)
      if (s.additionalProperties === false) {
        for (const key of Object.keys(obj)) if (!(key in (s.properties ?? {}))) problems.push(`${p}: unexpected "${key}"`)
      }
    }
  }
  walk(node, schema, path)
  return problems
}

/**
 * One member's output read into a result: parsed, checked against the
 * schema, and - when the step knows the ticket - checked to be about THIS
 * ticket. A verdict naming another ticket is a member that was confused, and
 * a confused pass is not a pass.
 */
export function readMemberVerdict(member: PanelMember, output: string | null | undefined, schema: Record<string, any>, ticketKey?: string): MemberResult {
  const raw = extractVerdict(output)
  if (raw === null) return { agentSlug: member.agentSlug, ...(member.criterion ? { criterion: member.criterion } : {}), problems: ['the member ended without a JSON verdict'] }
  const problems = validateAgainstSchema(raw, schema)
  const v = raw as Verdict
  if (!problems.length && ticketKey && v.ticket !== ticketKey) problems.push(`the verdict names ticket "${v.ticket}", not ${ticketKey}`)
  return problems.length
    ? { agentSlug: member.agentSlug, ...(member.criterion ? { criterion: member.criterion } : {}), problems }
    : { agentSlug: member.agentSlug, ...(member.criterion ? { criterion: member.criterion } : {}), verdict: v, problems: [] }
}

export interface PanelOutcome {
  verdict: 'pass' | 'fail'
  /** Members whose verdict was `fail`, or who produced no usable verdict. */
  failing: string[]
  /** What the implementer is told, when the panel fails: every finding, attributed. */
  findings: string
  /** One-paragraph account for the step's output and the run page. */
  summary: string
}

/**
 * The panel's one verdict from its members' many. Any fail - or any member
 * with no usable verdict - fails the panel: a reviewer the runner could not
 * read is a reviewer whose objections are unknown, and unknown is not pass.
 */
export function aggregateVerdicts(results: MemberResult[]): PanelOutcome {
  const failing: string[] = []
  const findings: string[] = []
  for (const r of results) {
    if (!r.verdict) {
      failing.push(r.agentSlug)
      findings.push(`${r.agentSlug}: produced no usable verdict (${r.problems.join('; ')}). Treated as a fail.`)
      continue
    }
    if (r.verdict.verdict === 'fail') {
      failing.push(r.agentSlug)
      const failed = r.verdict.criteria.filter(c => c.result === 'fail')
      const detail = failed.length
        ? failed.map(c => `  - ${c.id}: ${c.notes ?? 'failed'}${c.evidence.length ? ` (evidence: ${c.evidence.join(' | ')})` : ''}`).join('\n')
        : '  - (no criterion marked fail; see the member\'s risks)'
      const risks = r.verdict.risks.length ? `\n  risks: ${r.verdict.risks.join('; ')}` : ''
      findings.push(`${r.agentSlug}${r.criterion ? ` (${r.criterion})` : ''} failed the change:\n${detail}${risks}`)
    }
  }
  const passed = results.length - failing.length
  const summary = failing.length
    ? `Verdict panel: FAIL - ${failing.length} of ${results.length} member(s) failed the change (${failing.join(', ')}); ${passed} passed.`
    : `Verdict panel: PASS - all ${results.length} member(s) passed the change.${results.flatMap(r => r.verdict?.risks ?? []).length ? ` Risks noted: ${results.flatMap(r => r.verdict?.risks ?? []).join('; ')}` : ''}`
  return { verdict: failing.length ? 'fail' : 'pass', failing, findings: findings.join('\n\n'), summary }
}

/**
 * The members a run's risk adds to the configured list. The protocol
 * specialist joins when the change is classified `protocol` or `money`, or
 * when a risk policy names `protocol` or `money` as the tier's specialist.
 * Pure: the caller resolves the policy (shared/utils/riskPolicy.ts, when that
 * module exists on the instance) and passes the specialist it names, or
 * nothing. A member already on the panel is not added twice.
 */
export function membersForRisk(configured: PanelMember[], blastRadius: string | undefined, specialist?: string): PanelMember[] {
  const out = [...configured]
  const wantsProtocol = specialist
    ? specialist === 'protocol' || specialist === 'money'
    : blastRadius === 'protocol' || blastRadius === 'money'
  if (wantsProtocol && !out.some(m => m.agentSlug === 'sdlc-specialist-protocol')) {
    out.push({ agentSlug: 'sdlc-specialist-protocol', criterion: 'Every wire-level behaviour the change touches matches the governing 3GPP or RFC clause.' })
  }
  return out
}

/** Uncached tokens a set of usages spent, the figure the budgets are checked in. */
export function uncachedTokens(usages: ({ input_tokens: number, output_tokens: number, cache_read_input_tokens?: number } | null | undefined)[]): number {
  let n = 0
  for (const u of usages) if (u) n += u.input_tokens - (u.cache_read_input_tokens ?? 0) + u.output_tokens
  return n
}

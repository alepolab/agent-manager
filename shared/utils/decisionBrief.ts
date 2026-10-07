/**
 * What a person needs to answer a step's question, in a shape the inbox can lay
 * out: the situation, the criteria it refers to in full, what was found, each
 * option with what it leads to, and a recommendation.
 *
 * Why a file with a fixed shape rather than prose: ASECRM-220's step asked
 * "should the developer step (a) fix the `trouble-ticket` 0.3062-vs-0.32
 * ratchet breach … or (c) narrow the oracle to criterion 4 only?" and the
 * developer could not answer. They had never seen criteria 2-4, did not know
 * what trouble-ticket was, and could not tell what any option would lead to.
 * The step's 5 KB report held most of it, as a narrative written for the next
 * agent. The step that did the work is the one that knows all of this; the
 * shape makes it say so for a person, and lets the runner check that it did.
 */

/**
 * Whether the step settled an intake question on evidence. A reviewer has
 * nothing to decide about one that was, and the gate used to lay each of them
 * out with its resolution anyway. `resolved` when the step says so; for a
 * brief written before the field, an answer that begins "Resolved" is.
 * An assumption is not a resolution: the reviewer is the one to accept it.
 */
function isResolved(q: any): boolean {
  if (typeof q?.resolved === 'boolean') return q.resolved
  return /^\W*resolved\b(?!\s+(by|on)\s+(an\s+)?assum)/i.test(String(q?.answer ?? ''))
}

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 2))

/**
 * The asked questions no answer in the brief is for. Matched, not counted: a
 * brief with as many answers as questions used to pass even when one answered
 * a question nobody asked. An answer is for a question when its wording is the
 * same, or shares most of the question's words - briefs restate a question in
 * plain words - and each answer covers one question only.
 */
export function unansweredQuestions(asked: string[], brief: DecisionBrief | null | undefined): string[] {
  const answers = (brief?.open_questions ?? []).map(a => words(a.question))
  const used = new Set<number>()
  return asked.filter((q) => {
    const want = words(q)
    let best = -1
    let bestScore = 0
    answers.forEach((a, i) => {
      if (used.has(i) || !want.size) return
      const shared = [...want].filter(w => a.has(w)).length
      const score = shared / want.size
      if (score > bestScore) { best = i; bestScore = score }
    })
    if (best >= 0 && bestScore >= 0.5) { used.add(best); return false }
    return true
  })
}

/** The questions a person still has to weigh: those not settled on evidence. */
export function unresolvedQuestions(brief: DecisionBrief | null | undefined): { question: string, answer: string }[] {
  return (brief?.open_questions ?? []).filter(q => !q.resolved)
}

/**
 * The questions intake left open, read from intent.md's "## Open questions"
 * bullets. Not from the context packet: its copy of ASECRM-297's first
 * question was a placeholder (`<<ccr:…>>`), never the text.
 */
export function openQuestionsIn(intentMd: string | null | undefined): string[] {
  const section = intentMd?.split(/^## Open questions\s*$/m)[1]?.split(/^## /m)[0] ?? ''
  const items = section.split('\n').filter(l => /^\s*[-*]\s+\S/.test(l)).map(l => l.replace(/^\s*[-*]\s+/, '').trim())
  // "None stated" and the like are not questions.
  return items.filter(q => !/^(none|n\/a|no open questions)\b/i.test(q))
}

/** The file a step writes into its run artifacts directory before `PIPELINE-ASK:`. */
export const DECISION_FILE = 'decision.json'

/** The same shape, written by the step that made a change, for whoever approves it at a gate. */
export const CHANGE_BRIEF_FILE = 'change-brief.json'
/** Present while the runner is having that brief written; the approval card says so. */
export const CHANGE_BRIEF_PENDING = 'change-brief.pending'

/**
 * The agents whose steps make a run's change, and so are asked for that brief
 * when a gate finds it missing or written before their commits. The reviewer
 * too: once it has fixed findings it holds the latest picture of the change.
 * Each must carry "The reviewer's brief" in its instructions.
 */
export const CHANGE_MAKERS = /^sdlc-(fix-implementer|feature-implementer|ce-work|ce-review)$/

export interface DecisionOption {
  /** "a", "b", … - what the person answers with. */
  key: string
  /** The option in two to six words, for the choice itself ("Unlock the test and ship the fix"). Optional: older briefs have only `label`. */
  title?: string
  /** The option in a sentence. */
  label: string
  /** What the next step will actually do if this is chosen. */
  next: string
  /** What the ticket ends up with. */
  delivers: string
  /** What is left undone, deferred or turned into a follow-up. */
  leaves: string
  /** Cost or risk, when there is one worth naming. Leads with its level: "Low - …", "Medium - …", "High - …". */
  risk?: string
  /** For an option that sends the change back: the step that should redo the work, by its label as the run shows it ("Implement Fix"). */
  sendBackTo?: string
}

export type RiskLevel = 'low' | 'medium' | 'high'

/** The level a risk leads with ("Medium -- silent data loss…"), if it states one. */
export function riskLevel(risk: string | undefined): RiskLevel | undefined {
  const m = risk?.trim().match(/^(low|medium|moderate|high)\b/i)
  if (!m) return undefined
  const w = m[1]!.toLowerCase()
  return w === 'moderate' ? 'medium' : w as RiskLevel
}

/** A risk's text without the level it leads with: "Low -- the fix is narrow" is "the fix is narrow". */
export function riskDetail(risk: string | undefined): string {
  return (risk ?? '').trim().replace(/^(low|medium|moderate|high)\b\s*(?:[-–—:,.]+\s*)?/i, '').replace(/^./, c => c.toUpperCase())
}

/**
 * The question in a line. An agent's `question` is the full PIPELINE-ASK text,
 * often four lines of identifiers; `headline` is what a person reads first.
 * A brief written before `headline` existed falls back to the question the step
 * actually asked (`asked`, the PIPELINE-ASK line) - the brief's own `question`
 * often opens with background rather than the question - to its first sentence.
 */
export function briefHeadline(brief: Pick<DecisionBrief, 'headline' | 'question'> | undefined, asked = ''): string {
  if (brief?.headline) return brief.headline
  const q = (asked || brief?.question || '').trim().split('\n')[0]!.trim()
  const stop = q.search(/[?.](\s|$)/)
  return stop > 0 ? q.slice(0, stop + 1) : q
}

export interface DecisionBrief {
  /** The question in under twelve plain words, no identifiers: what the inbox lists and titles it with. Optional: older briefs have none. */
  headline?: string
  /** The question, the same as the `PIPELINE-ASK:` line. */
  question: string
  /** Two or three plain sentences: what the step was doing and what stops it. */
  situation: string
  /** Every acceptance criterion the brief mentions, with its full text. */
  criteria?: { ref: string, text: string }[]
  /** What the step established, one fact per entry, each term explained. */
  findings?: string[]
  options: DecisionOption[]
  recommendation?: { option: string, why: string }
  /**
   * Each question intake left open, and how the step answered it: resolved,
   * assumed, or still open and which option decides it. ASECRM-297's gate
   * listed intake's two questions above a brief that answered neither.
   */
  open_questions?: { question: string, answer: string, resolved: boolean }[]
}

const str = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

/**
 * Parses and checks a brief. The checks are the ones whose absence made the
 * ASECRM-220 question unanswerable, not a general style guide: a situation,
 * at least two options each saying what it leads to, and the text of every
 * criterion the brief refers to by number.
 */
export function parseDecisionBrief(raw: string | null | undefined): { brief: DecisionBrief } | { error: string } {
  if (!raw) return { error: `${DECISION_FILE} was not written` }
  let d: any
  try { d = JSON.parse(raw) } catch { return { error: `${DECISION_FILE} is not valid JSON` } }
  if (!d || typeof d !== 'object') return { error: `${DECISION_FILE} is not an object` }
  const problems: string[] = []
  if (!str(d.question)) problems.push('`question` is missing')
  if (!str(d.situation)) problems.push('`situation` is missing')
  const options: unknown[] = Array.isArray(d.options) ? d.options : []
  if (options.length < 2) problems.push('`options` needs at least two entries')
  options.forEach((o: any, i) => {
    const missing = ['key', 'label', 'next', 'delivers', 'leaves'].filter(k => !str(o?.[k]))
    if (missing.length) problems.push(`option ${o?.key ?? i + 1} is missing ${missing.map(k => `\`${k}\``).join(', ')}`)
  })
  const criteria: { ref: string, text: string }[] = Array.isArray(d.criteria) ? d.criteria.filter((c: any) => str(c?.ref) && str(c?.text)) : []
  const prose = [d.question, d.situation, ...(Array.isArray(d.findings) ? d.findings : []), ...options.flatMap((o: any) => [o?.label, o?.next, o?.delivers, o?.leaves, o?.risk])]
    .filter(str).join(' ')
  const unquoted = [...referencedCriteria(prose)].sort((a, b) => a - b).filter(n => !criteria.some(c => new RegExp(`\\b${n}\\b`).test(c.ref)))
  if (unquoted.length) problems.push(`criteria ${unquoted.join(', ')} are mentioned but their text is not in \`criteria\``)
  if (problems.length) return { error: problems.join('; ') }
  return {
    brief: {
      ...(str(d.headline) ? { headline: d.headline.trim() } : {}),
      question: d.question.trim(),
      situation: d.situation.trim(),
      ...(criteria.length ? { criteria } : {}),
      ...(Array.isArray(d.findings) && d.findings.some(str) ? { findings: d.findings.filter(str) } : {}),
      options: options.map((o: any) => ({
        key: o.key.trim(), ...(str(o.title) ? { title: o.title.trim() } : {}), label: o.label.trim(), next: o.next.trim(), delivers: o.delivers.trim(), leaves: o.leaves.trim(),
        ...(str(o.risk) ? { risk: o.risk.trim() } : {}),
        ...(str(o.sendBackTo) ? { sendBackTo: o.sendBackTo.trim() } : {}),
      })),
      ...(str(d.recommendation?.option) && str(d.recommendation?.why) ? { recommendation: { option: d.recommendation.option.trim(), why: d.recommendation.why.trim() } } : {}),
      ...(Array.isArray(d.open_questions) && d.open_questions.some((q: any) => str(q?.question) && str(q?.answer))
        ? { open_questions: d.open_questions.filter((q: any) => str(q?.question) && str(q?.answer)).map((q: any) => ({ question: q.question.trim(), answer: q.answer.trim(), resolved: isResolved(q) })) }
        : {}),
    },
  }
}

/** A step a gate can send the change back to. */
export interface SendBackStep { stepId: string, label: string, agentSlug?: string, status: string }

/** The steps a gate may send its change back to: the settled ones, bar the one it waits on. */
export function sendBackCandidates<T extends SendBackStep>(steps: T[], gateStepId?: string): T[] {
  return steps.filter(s => ['completed', 'failed', 'skipped'].includes(s.status) && s.stepId !== gateStepId)
}

/**
 * Whether an option sends the change back rather than letting it through: it
 * says "send back", in whatever words. Not "re-run" or "redo" - an approve
 * option whose next step reads "the full suite is re-run on the PR by CI"
 * was taken for a send-back, its step pre-selected, and one of the run's two
 * send-backs spent on a step nobody asked to redo.
 */
const SENDS_BACK = /\bsend(?:s|ing)?\b.{0,24}?\bback\b/gi

/**
 * Words that, earlier in the same clause, turn "send back" into the thing the
 * option is not doing: "Approve as it stands - no need to send it back",
 * "nothing to send back", "Approve rather than sending it back". Each of those
 * was read as a send-back, its step shown under the approve option and
 * pre-selected when that option was the recommendation.
 */
const NEGATES = /\b(?:no|not|nothing|never|without|rather\s+than|instead\s+of|don'?t|doesn'?t|needn'?t|no\s+need\s+to)\b/i
/**
 * Where a clause starts: a sentence or clause mark, a comma, a spaced hyphen,
 * or an en or em dash spaced or not ("Not yet—send it back"). Without the
 * comma, "Do not merge, send it back to Implement Fix" read as negated.
 */
const CLAUSE_START = /[.,;:!?()]|\s-\s|[–—]/g

/** True when some "send back" in `text` is not negated within its own clause. */
function sendsBack(text: string): boolean {
  for (const m of text.matchAll(SENDS_BACK)) {
    const before = text.slice(0, m.index)
    const starts = [...before.matchAll(CLAUSE_START)]
    const clause = starts.length ? before.slice(starts.at(-1)!.index! + starts.at(-1)![0].length) : before
    if (!NEGATES.test(clause)) return true
  }
  return false
}

/**
 * The work each kind of step does, as a brief's prose names it, and the agents
 * that do it. Briefs written before `sendBackTo` existed say "the fix step
 * re-runs and removes …" (ASECRM-295 (b)); the person still has to pick the
 * step from a list of fourteen, and Implement Fix is not a phrase the brief used.
 */
const STEP_ROLES: { says: RegExp, agent: RegExp }[] = [
  { says: /\b(?:fix|implement(?:ation|er)?|developer)\s+step\b|\bimplement(?:er|s)?\b|\bre-?implement/i, agent: /fix-implementer|feature-implementer|ce-work/ },
  { says: /\b(?:test|oracle)[- ](?:author|step|writer)\b|\bfailing test\b|\brewrite the test\b/i, agent: /test-author/ },
  { says: /\bplan(?:ning)? step\b|\bre-?plan\b|\bdesign step\b/i, agent: /ce-plan|feature-designer/ },
  { says: /\bintake\b/i, agent: /intake/ },
  { says: /\bverif(?:y|ier|ication) step\b|\bregression step\b/i, agent: /verifier|qa-automated/ },
  { says: /\bsecurity review\b/i, agent: /security-review/ },
]

/**
 * The step an option would send the change back to, among `steps` (see
 * sendBackCandidates). The brief's own `sendBackTo` when it names one of them;
 * else a step the option names by its label; else the step doing the work the
 * option describes, the role mentioned first winning. Undefined for an option
 * that does not send the change back, or when nothing points at one step.
 * `siblings` are the brief's other options: when any names `sendBackTo`, an
 * option that does not is not a send-back.
 */
export function suggestSendBack<T extends SendBackStep>(option: DecisionOption, steps: T[], siblings: DecisionOption[] = []): T | undefined {
  const last = (match: (s: T) => boolean) => steps.filter(match).at(-1)
  const named = option.sendBackTo?.trim().toLowerCase()
  if (named) {
    const hit = last(s => s.label.toLowerCase() === named || s.stepId === option.sendBackTo || s.agentSlug === option.sendBackTo)
    if (hit) return hit
  }
  // A brief that names its send-back steps has said which options send back:
  // the rest are not read from their prose, where "sending it back is not
  // needed" would otherwise count.
  if (!named && siblings.some(o => o.sendBackTo?.trim())) return undefined
  // Separate sentences: a "Not ready" title does not negate the label's send-back.
  const text = [option.title, option.label, option.next].filter(Boolean).join('. ')
  if (!named && !sendsBack(text)) return undefined
  // As a phrase on its own: a step called "Plan" is not named by ".agent/plan.md".
  const where = (label: string) => text.search(new RegExp(`(?<![\\w./-])${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w]|[./-]\\w)`, 'i'))
  // The step named first, as with roles below; the longer label on a tie
  // ("Implement Fix" over a step called "Implement" at the same place).
  const byLabel = steps
    .map(s => ({ s, at: where(s.label) }))
    .filter(x => x.at >= 0)
    .sort((a, b) => a.at - b.at || b.s.label.length - a.s.label.length)[0]?.s
  if (byLabel) return byLabel
  const roles = STEP_ROLES
    .map(r => ({ r, at: text.search(r.says) }))
    .filter(x => x.at >= 0)
    .sort((a, b) => a.at - b.at)
  for (const { r } of roles) {
    const hit = last(s => r.agent.test(s.agentSlug ?? ''))
    if (hit) return hit
  }
  return undefined
}

/** Criterion numbers named in prose: "criterion 4", "criteria 2-3", "criteria 2 and 3", "criteria 1, 3". */
export function referencedCriteria(text: string): Set<number> {
  const found = new Set<number>()
  for (const m of text.matchAll(/criteri(?:on|a)\s+((?:\d+\s*(?:[-–,]|and|&)?\s*)+)/gi)) {
    const span = m[1]!
    for (const r of span.matchAll(/(\d+)\s*[-–]\s*(\d+)/g)) {
      for (let n = Number(r[1]); n <= Number(r[2]) && n - Number(r[1]) < 50; n++) found.add(n)
    }
    for (const n of span.matchAll(/\d+/g)) found.add(Number(n[0]))
  }
  return found
}

/** The instruction a step gets when it asked without a usable brief. */
export function briefFeedback(error: string): string {
  return `Your question cannot be shown to a person yet: ${error}. Before asking, write ${DECISION_FILE} into the run artifacts directory - `
    + 'the person answering has not read the ticket, the repository or your report. Shape: '
    + '{ "headline": the question in under twelve plain words with no file or method names, "question": the same one-line question, "situation": two or three plain sentences on what you were doing and what stops you, '
    + '"criteria": [{ "ref": "criterion 2", "text": the full text of every acceptance criterion you mention }], '
    + '"findings": [one established fact per entry, every module, file, ticket or number explained in words], '
    + '"options": [{ "key": "a", "title": two to six words, "label": the option in a sentence, "next": what the next step will do if chosen, "delivers": what the ticket ends up with, '
    + '"leaves": what is left undone or becomes a follow-up, "risk": optional, starting Low, Medium or High }], "recommendation": { "option": "a", "why": one sentence } }. '
    + 'Use the work you have already done - do not start over - then end with the same PIPELINE-ASK line.'
}

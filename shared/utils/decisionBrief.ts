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
      })),
      ...(str(d.recommendation?.option) && str(d.recommendation?.why) ? { recommendation: { option: d.recommendation.option.trim(), why: d.recommendation.why.trim() } } : {}),
      ...(Array.isArray(d.open_questions) && d.open_questions.some((q: any) => str(q?.question) && str(q?.answer))
        ? { open_questions: d.open_questions.filter((q: any) => str(q?.question) && str(q?.answer)).map((q: any) => ({ question: q.question.trim(), answer: q.answer.trim(), resolved: isResolved(q) })) }
        : {}),
    },
  }
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

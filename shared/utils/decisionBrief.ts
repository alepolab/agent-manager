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

/** The file a step writes into its run artifacts directory before `PIPELINE-ASK:`. */
export const DECISION_FILE = 'decision.json'

export interface DecisionOption {
  /** "a", "b", … - what the person answers with. */
  key: string
  /** The option in a few words. */
  label: string
  /** What the next step will actually do if this is chosen. */
  next: string
  /** What the ticket ends up with. */
  delivers: string
  /** What is left undone, deferred or turned into a follow-up. */
  leaves: string
  /** Cost or risk, when there is one worth naming. */
  risk?: string
}

export interface DecisionBrief {
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
      question: d.question.trim(),
      situation: d.situation.trim(),
      ...(criteria.length ? { criteria } : {}),
      ...(Array.isArray(d.findings) && d.findings.some(str) ? { findings: d.findings.filter(str) } : {}),
      options: options.map((o: any) => ({
        key: o.key.trim(), label: o.label.trim(), next: o.next.trim(), delivers: o.delivers.trim(), leaves: o.leaves.trim(),
        ...(str(o.risk) ? { risk: o.risk.trim() } : {}),
      })),
      ...(str(d.recommendation?.option) && str(d.recommendation?.why) ? { recommendation: { option: d.recommendation.option.trim(), why: d.recommendation.why.trim() } } : {}),
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
    + '{ "question": the same one-line question, "situation": two or three plain sentences on what you were doing and what stops you, '
    + '"criteria": [{ "ref": "criterion 2", "text": the full text of every acceptance criterion you mention }], '
    + '"findings": [one established fact per entry, every module, file, ticket or number explained in words], '
    + '"options": [{ "key": "a", "label": a few words, "next": what the next step will do if chosen, "delivers": what the ticket ends up with, '
    + '"leaves": what is left undone or becomes a follow-up, "risk": optional }], "recommendation": { "option": "a", "why": one sentence } }. '
    + 'Use the work you have already done - do not start over - then end with the same PIPELINE-ASK line.'
}

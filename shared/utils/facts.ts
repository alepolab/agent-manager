/**
 * What a gate is allowed to treat as true.
 *
 * Every control in this estate that failed did so the same way: a claim that
 * read as verified and was not. Three runs finished `completed` while claiming
 * more than their repositories could show. A review of thirteen found the
 * evidence contract honoured by under half. A test lock enforced nothing for
 * weeks. In each case the record could not distinguish "checked" from "said".
 *
 * So a fact here is never a bare value. It is a value plus where it came from,
 * and a value with no provenance is not a weak fact — it is `indeterminate`,
 * which is a distinct answer from true and from false, and which a gate must
 * treat as a refusal rather than a pass. This is the whole of BR-01: a
 * criterion that cannot be derived fails closed.
 *
 * Deliberately free of I/O, git and the filesystem so the rules are testable
 * without a repository. Providers live in server/utils/factProviders.ts and
 * do the reading; this file decides what the reading is worth.
 */

/** Where a value came from, and what the world looked like when it was taken. */
export interface Provenance {
  /** The artifact or command the value was read from: a report path, `git`, `gh`. */
  source: string
  /** Hash of that artifact, so a reader can tell two captures apart. */
  sourceSha?: string
  /** The commit the capture was taken at. */
  head?: string
  /**
   * A digest of the WORKING TREE at capture, not just the commit.
   *
   * `head` alone lies, and the estate already knows it: testLock.ts reads both
   * `git diff` and `git status --porcelain` because "a step that never
   * committed has still changed the tree". A verdict captured green, followed
   * by an uncommitted edit, leaves `head` identical and the evidence worthless.
   */
  tree?: string
  capturedAt: number
  /**
   * How many times the underlying check ran to produce this value.
   *
   * The evidence-bundle schema already says why this exists, in its own words:
   * "Three-run determinism minimum; 200 for races. A verdict from a single run
   * is not evidence."
   */
  runs?: number
}

/**
 * Whether the value was actually derived, or whether we are looking at an
 * absence dressed as an answer.
 *
 * `indeterminate` is not a failure of the thing being checked. It is a failure
 * to check, and conflating the two is how a model outage came to read as a
 * clean bill of health.
 */
export type Confidence = 'derived' | 'indeterminate'

export interface Fact<T> {
  value: T | null
  provenance: Provenance | null
  confidence: Confidence
  /** Why it could not be derived. Present only when `indeterminate`. */
  why?: string
}

/** A fact that was genuinely read. */
export function derived<T>(value: T, provenance: Provenance): Fact<T> {
  return { value, provenance, confidence: 'derived' }
}

/**
 * A fact that could not be established. Requires a reason, because
 * "indeterminate" with no explanation is indistinguishable from a bug and the
 * person at the gate has to know what to do about it.
 */
export function indeterminate<T>(why: string): Fact<T> {
  return { value: null, provenance: null, confidence: 'indeterminate', why }
}

/** The state of the thing a fact describes, as it is right now. */
export interface WorldState {
  head?: string
  tree?: string
}

export type Freshness = 'fresh' | 'stale' | 'indeterminate'

/**
 * Is this fact still about the current state of the world?
 *
 * Three answers, not two. `stale` means the world moved and the fact is
 * provably about something else. `indeterminate` means we cannot tell — the
 * capture recorded no tree digest, or the caller cannot supply one now — and
 * that is emphatically not `fresh`. The existing VERIFY_GATE criterion states
 * the rule in prose ("Code changed after these captures invalidates them");
 * this makes it mechanical, and makes not-knowing an answer of its own.
 */
export function freshness(fact: Fact<unknown>, now: WorldState): Freshness {
  if (fact.confidence !== 'derived' || !fact.provenance) return 'indeterminate'
  const p = fact.provenance

  // A commit that moved is decisive on its own: the fact is about an older
  // tree whatever else we know.
  if (p.head && now.head && p.head !== now.head) return 'stale'
  if (p.tree && now.tree && p.tree !== now.tree) return 'stale'

  // Neither dimension contradicted it — but silence is not agreement. To call
  // a fact fresh we need the tree on both sides, because that is the only one
  // that catches an uncommitted edit.
  if (!p.tree || !now.tree) return 'indeterminate'
  return 'fresh'
}

/** What a gate demands of a fact before it counts. */
export interface EvidenceBar {
  /** Minimum independent runs. Defaults to the schema's three-run floor. */
  minRuns?: number
  /**
   * Accept a fact whose freshness cannot be determined.
   *
   * Off by default and should stay off: the point of this module is that not
   * knowing fails closed. It exists for facts about things that have no
   * worktree at all — a merged sha, a CI verdict — where a tree digest is
   * meaningless rather than missing.
   */
  allowUnknownFreshness?: boolean
}

export interface EvidenceVerdict {
  ok: boolean
  /** Why not, in words a reviewer can act on. Empty when ok. */
  reasons: string[]
}

export const DEFAULT_MIN_RUNS = 3

/**
 * Does this fact clear the bar to be used as evidence at a gate?
 *
 * Every failure mode is named rather than summed into a boolean, because the
 * person at the gate needs to know whether to re-run something, wait for
 * something, or go and write a provider.
 */
export function meetsBar(fact: Fact<unknown>, now: WorldState, bar: EvidenceBar = {}): EvidenceVerdict {
  const reasons: string[] = []
  const minRuns = bar.minRuns ?? DEFAULT_MIN_RUNS

  if (fact.confidence !== 'derived') {
    return { ok: false, reasons: [fact.why ?? 'not derived from anything'] }
  }
  const p = fact.provenance
  if (!p) return { ok: false, reasons: ['derived but carries no provenance, so nothing can be checked against it'] }

  const fresh = freshness(fact, now)
  if (fresh === 'stale') {
    reasons.push(`captured at ${p.head?.slice(0, 8) ?? 'an unrecorded commit'}, which is not the current state`)
  } else if (fresh === 'indeterminate' && !bar.allowUnknownFreshness) {
    reasons.push('cannot be shown to describe the current working tree')
  }

  // A single run is not evidence, and the schema has said so all along.
  if (minRuns > 1) {
    if (p.runs === undefined) reasons.push(`does not record how many times it ran, and ${minRuns} are required`)
    else if (p.runs < minRuns) reasons.push(`ran ${p.runs} time${p.runs === 1 ? '' : 's'}, and ${minRuns} are required`)
  }

  return { ok: reasons.length === 0, reasons }
}

/** One gate criterion: a question, and the fact that answers it. */
export interface Criterion {
  id: string
  /** What is being asked, in the words the gate screen shows. */
  question: string
  fact: Fact<boolean>
  bar?: EvidenceBar
}

export interface CriterionResult {
  id: string
  question: string
  /**
   * `pass` and `fail` both mean the check RAN. `blocked` means it did not, or
   * its answer cannot be trusted — and a gate must not read `blocked` as
   * either of the other two.
   */
  status: 'pass' | 'fail' | 'blocked'
  reasons: string[]
  provenance: Provenance | null
}

/**
 * Score a gate's criteria.
 *
 * The rule that matters: an underivable criterion BLOCKS. It does not pass
 * quietly and it is not reported as a failure of the change, because those are
 * different things and a reviewer told the wrong one will do the wrong thing.
 * This is BR-01 in one function, and the reason the whole module exists.
 */
export function scoreGate(criteria: Criterion[], now: WorldState): {
  ok: boolean
  results: CriterionResult[]
  blocked: CriterionResult[]
  failed: CriterionResult[]
} {
  const results = criteria.map<CriterionResult>((c) => {
    const bar = meetsBar(c.fact, now, c.bar)
    if (!bar.ok) {
      return { id: c.id, question: c.question, status: 'blocked', reasons: bar.reasons, provenance: c.fact.provenance }
    }
    return {
      id: c.id,
      question: c.question,
      status: c.fact.value === true ? 'pass' : 'fail',
      reasons: [],
      provenance: c.fact.provenance,
    }
  })
  const blocked = results.filter(r => r.status === 'blocked')
  const failed = results.filter(r => r.status === 'fail')
  return { ok: blocked.length === 0 && failed.length === 0, results, blocked, failed }
}

/** One line per criterion for the gate screen, facts before judgement. */
export function describeCriterion(r: CriterionResult): string {
  const p = r.provenance
  const where = p
    ? `${p.source}${p.sourceSha ? ` @${p.sourceSha.slice(0, 8)}` : ''}${p.head ? `, HEAD ${p.head.slice(0, 8)}` : ''}${p.runs ? `, ${p.runs} runs` : ''}`
    : 'no source'
  if (r.status === 'blocked') return `BLOCKED ${r.id}: ${r.reasons.join('; ')} (${where})`
  return `${r.status.toUpperCase()} ${r.id}: ${r.question} (${where})`
}

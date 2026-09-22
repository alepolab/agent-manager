/**
 * How much of a person a change is worth.
 *
 * Roles decide WHO is asked. This decides WHETHER anyone is asked at all, from
 * the blast radius intake already classifies every run into. The two are
 * separate on purpose: a gate that fires on every step teaches reviewers to
 * click approve without reading, and a reviewer who reads nothing is worse than
 * no gate, because it looks like oversight from the outside.
 *
 * The published guidance is consistent on this and it is why the table is
 * per-ACTION rather than per-role: the same person is out of the loop for a
 * docs change, on the loop for routine recoverable work, and in the loop for
 * something irreversible. Runbook C used to stop four times regardless, each
 * time showing a step label and nothing else — which is exactly how CSUP-7516,
 * a money-path change to tax arithmetic, came to be approved in a single click.
 *
 * The step flags stay as they are. A step marked `approval` is a point where a
 * gate MAY fire; this decides whether it does. So a UI-copy fix flows straight
 * through the same runbook that stops hard on a billing change, with no second
 * workflow to maintain.
 */

/** Intake's own enum, from the evidence-bundle schema. Ordered least to most dangerous. */
export type BlastRadius = 'docs' | 'ui_parsing' | 'schema' | 'deployment' | 'protocol' | 'money'

export const BLAST_RADIUS_ORDER: BlastRadius[] = ['docs', 'ui_parsing', 'schema', 'deployment', 'protocol', 'money']

/**
 * What a gate does when it is reached.
 *
 * - `auto`    — do not stop. The run carries on and the decision is reviewable
 *               afterwards, which is the honest trade for work that is cheap to
 *               undo.
 * - `stop`    — pause and wait for a person, as today.
 * - `justify` — pause, and refuse an approval that carries no written reason.
 *               Writing one sentence is the cheapest known defence against
 *               rubber-stamping: it forces the reviewer to have read something.
 */
export type Oversight = 'auto' | 'stop' | 'justify'

const POLICY: Record<BlastRadius, Oversight> = {
  docs: 'auto',
  ui_parsing: 'auto',
  schema: 'stop',
  deployment: 'stop',
  protocol: 'justify',
  money: 'justify',
}

/**
 * The oversight a run's classification calls for.
 *
 * An UNCLASSIFIED run gets `stop`, never `auto`: intake writes the blast radius,
 * and a run that has not reached intake — or whose intake failed to classify —
 * is not thereby low risk. Absence of evidence is not evidence of safety, and
 * defaulting the other way would let exactly the runs that went wrong early
 * sail through every gate.
 */
export function oversightFor(blastRadius: string | undefined): Oversight {
  if (!blastRadius) return 'stop'
  return POLICY[blastRadius as BlastRadius] ?? 'stop'
}

/**
 * What kind of question a gate asks, where that changes whether the blast
 * radius gets to answer it.
 *
 * Tiering assumes the gate is asking "is this change safe?", which the blast
 * radius genuinely predicts. Three gates ask something else, and for those the
 * tier is not merely a poor proxy — it is the wrong question:
 *
 * - `story` and `spec` ask "is this the right thing, and what does done mean?"
 *   A one-line UI-copy change can have a wrong definition of done just as
 *   easily as a billing change, and the cost of discovering that later is not
 *   proportional to the blast radius. These also run BEFORE the work, so
 *   routing them on a classification derived from the eventual diff is
 *   circular.
 * - `security` asks "does this expose anything?", which is triggered by what
 *   the change TOUCHES — authz, crypto, personal data, payment, a dependency
 *   manifest — not by how hard it is to undo.
 *
 * So those three carry a floor. Everything else is `null` and tiers exactly as
 * before, which is the property worth protecting: this must not become a
 * per-step "always stop" override, because a gate that fires on everything
 * teaches reviewers to click approve without reading, and that is the failure
 * this module exists to prevent.
 */
export type GateKind = 'intake' | 'story' | 'spec' | 'design' | 'oracle' | 'impl' | 'verify' | 'security' | 'ship' | 'release'

const GATE_FLOOR: Partial<Record<GateKind, Oversight>> = {
  story: 'stop',
  spec: 'stop',
  security: 'justify',
}

const RANK: Record<Oversight, number> = { auto: 0, stop: 1, justify: 2 }

/**
 * The oversight for one gate on one run: the run's tier, raised to the gate's
 * floor where it has one. Never lowered — a floor can only make a gate ask
 * more, so a `money` change still demands a written reason at every gate.
 */
export function oversightForGate(blastRadius: string | undefined, kind?: GateKind): Oversight {
  const tier = oversightFor(blastRadius)
  const floor = kind ? GATE_FLOOR[kind] : undefined
  if (!floor) return tier
  return RANK[floor] > RANK[tier] ? floor : tier
}

/** Does approving this run require the reviewer to write why? */
export function needsJustification(blastRadius: string | undefined, kind?: GateKind): boolean {
  return oversightForGate(blastRadius, kind) === 'justify'
}

/** One line for the gate, so the reviewer is told why they are being asked. */
export function oversightReason(blastRadius: string | undefined, kind?: GateKind): string {
  const o = oversightForGate(blastRadius, kind)
  // A floored gate says why it is asking regardless of the tier, otherwise a
  // reviewer on a `docs` change reads "stops for a person" against a
  // classification that plainly says it should not have.
  if (kind && GATE_FLOOR[kind] && RANK[GATE_FLOOR[kind]!] > RANK[oversightFor(blastRadius)]) {
    if (kind === 'security') return 'This change touches a security-relevant surface, so it reaches security whatever its blast radius: say in one line why it is right before approving.'
    return `This gate asks whether this is the right thing to build, which no blast radius can answer, so it stops for a person.`
  }
  if (!blastRadius) return 'This run has no blast radius recorded yet, so it stops for a person.'
  if (o === 'justify') return `This change is classified \`${blastRadius}\`, which is owner-gated: say in one line why it is right before approving.`
  if (o === 'stop') return `This change is classified \`${blastRadius}\`, which stops for a person.`
  return `This change is classified \`${blastRadius}\`, which flows through without a gate.`
}

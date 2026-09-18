/**
 * How risky a run is, decided from evidence rather than from an agent's word.
 *
 * `oversight.ts` decides whether a gate fires purely from a run's blast radius,
 * and nothing wrote that field: every run on the instance has it null, so
 * `oversightFor(undefined)` returns `stop` for all of them and the tiering it
 * implements never actually tiers anything. The gap spec's wording is exact -
 * "the reader is fixed and the writer is gone; a fixed reader of an unwritten
 * field changes nothing".
 *
 * Taking the agent's own claim would be worse than leaving the field empty. A
 * step that wants to avoid a gate has every incentive to call its change
 * `ui_parsing`, and a classification the classified party can lower is not a
 * control, it is a formality. So there are two inputs:
 *
 *  - a PROPOSAL, which an agent writes deliberately in one documented form, and
 *  - a FLOOR, which the runner derives from the paths the change actually
 *    touched and which can only ever RAISE the class.
 *
 * The floor deliberately never asserts a LOW class. Ordinary source code and
 * documentation prove nothing about risk on their own - money arithmetic lives
 * in ordinary Java - so for those the floor is null and the agent's own claim
 * stands. Path evidence is good at spotting danger and useless at ruling it out.
 *
 * Nothing here touches the filesystem or git: the caller supplies the paths, so
 * every rule in this file is testable without a repository.
 */
import { BLAST_RADIUS_ORDER, type BlastRadius } from './oversight.ts'

/** Where an adopted class came from. `null` when nothing is known. */
export type ClassSource = 'proposal' | 'floor' | 'floor-only' | null

export interface AdoptedClass {
  adopted: BlastRadius | null
  source: ClassSource
}

/** Strength is the enum's own order (docs -> money), which is the domain's
 *  scale for how dangerous a change is. Deliberately not the oversight policy:
 *  that table maps class to behaviour and could be retuned - `protocol` being
 *  `justify` while `schema` is `stop` says nothing about which change is
 *  bigger. */
const rank = (c: BlastRadius) => BLAST_RADIUS_ORDER.indexOf(c)
const isBlastRadius = (v: string): v is BlastRadius => (BLAST_RADIUS_ORDER as string[]).includes(v)

/**
 * A step's deliberate classification: `PIPELINE-CLASS: <class>` on its own
 * line, mirroring `PIPELINE-ASK:` so an agent learns one convention rather than
 * three.
 *
 * Returns null for absent, empty, or anything outside the enum. A misspelling
 * is NOT forwarded: it would reach `oversight.ts`, whose POLICY lookup falls
 * through to `stop` - the right outcome by luck, for the wrong reason, with a
 * junk value left on the run record as if it meant something.
 */
export function parseProposal(output: string | undefined | null): BlastRadius | null {
  const m = (output ?? '').match(/^PIPELINE-CLASS:\s*(.+)$/m)
  if (!m) return null
  const value = m[1]!.trim().toLowerCase()
  return isBlastRadius(value) ? value : null
}

/**
 * Path shapes that prove a minimum class on their own.
 *
 * Every rule names the real shape it matches in this estate. A rule that cannot
 * be justified that way does not belong here, because a guess in this table
 * becomes a gate that fires for the wrong reason - and the reviewer who learns
 * the gate is noise is the failure this whole mechanism is trying to avoid.
 */
const FLOOR_RULES: { class: BlastRadius, why: string, test: RegExp }[] = [
  // Liquibase is how every Alepo product ships schema changes; the compose
  // stack runs `<product>-liquibase` on deploy.
  { class: 'schema', why: 'liquibase changelog', test: /liquibase|changelog/i },
  // Migration directories and raw SQL, whatever the framework.
  { class: 'schema', why: 'migration directory or raw SQL', test: /(^|\/)(db|database)\/|(^|\/)migrations?\/|\.sql$|\.prisma$/i },
  // What the portal reads at boot: changing it changes the running server, and
  // only a redeploy applies it.
  { class: 'deployment', why: 'server properties read at boot', test: /portal-ext\.properties$|(^|\/)configs?\//i },
  // The shape of the deployment itself.
  { class: 'deployment', why: 'container or orchestration manifest', test: /docker-compose[^/]*\.ya?ml$|(^|\/)Dockerfile$|(^|\/)k8s\/|(^|\/)helm\//i },
  { class: 'deployment', why: 'infrastructure as code', test: /\.tf$|\.tfvars$|\.hcl$/i },
  // The pipeline that builds and releases the product.
  { class: 'deployment', why: 'build or release workflow', test: /(^|\/)\.github\/workflows\// },
]

/**
 * The strongest class the touched paths prove by themselves, or null.
 *
 * Null rather than `docs` for ordinary files: the floor exists only to RAISE a
 * class, so asserting a low one would let path evidence argue a change is safe,
 * which it can never do.
 */
export function floorFrom(paths: string[] | undefined | null): BlastRadius | null {
  let strongest: BlastRadius | null = null
  for (const path of paths ?? []) {
    if (!path) continue
    for (const rule of FLOOR_RULES) {
      if (!rule.test.test(path)) continue
      if (strongest === null || rank(rule.class) > rank(strongest)) strongest = rule.class
    }
  }
  return strongest
}

/**
 * The class a run is recorded with, and why.
 *
 * The stronger of proposal and floor wins. Agreement is attributed to the
 * proposal, which is the more specific claim - the agent said this exact class,
 * where the floor only said "at least this".
 *
 * Neither knowing anything yields null, NOT a default. The caller must be able
 * to park the run; handing it a default would hand it the one answer it must
 * never assume, and `oversightFor(undefined)` already stops such a run.
 */
export function adopt({ proposed, floor }: { proposed: BlastRadius | null, floor: BlastRadius | null }): AdoptedClass {
  if (proposed === null && floor === null) return { adopted: null, source: null }
  if (proposed === null) return { adopted: floor, source: 'floor-only' }
  if (floor === null) return { adopted: proposed, source: 'proposal' }
  return rank(floor) > rank(proposed)
    ? { adopted: floor, source: 'floor' }
    : { adopted: proposed, source: 'proposal' }
}

/** One line for the record, so a class on a run is never an unattributed assertion. */
export function classProvenance(a: AdoptedClass): string {
  if (a.adopted === null) return 'This run has no classification: no step proposed one and the touched paths implied none.'
  if (a.source === 'floor') return `Classified \`${a.adopted}\` from the files this change touched, which is stronger than the class the step proposed.`
  if (a.source === 'floor-only') return `Classified \`${a.adopted}\` from the files this change touched; no step proposed a class.`
  return `Classified \`${a.adopted}\`, as proposed by the step and not contradicted by the files it touched.`
}

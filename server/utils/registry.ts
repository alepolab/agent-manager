import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveClaudePath } from './claudeDir.ts'
import { readStore } from './productStore.ts'
import type { ProductMatch } from '~~/shared/types/run'

/**
 * The registry now lives in a store this app owns (server/utils/productStore.ts),
 * seeded once from the installed plugin or the copy shipped in the product.
 *
 * The seed chain is kept, and it is the fix the outage below turned on. The
 * registry used to be plugin-only: `registryPath` returned null in a container
 * with no plugin, `loadRegistry` returned null, and `resolveProduct` returned
 * undefined for EVERY ticket — so no run in a team container ever resolved a
 * product. No repos, no branch policy, no stack profile, no test commands: the
 * agents improvised all of it, and two of them improvised different checkout
 * directories in the same run. It was silent by construction, because "no
 * product matched this ticket" and "the registry could not be found" produced
 * the same undefined.
 *
 * A store that does not parse now falls back to the seed and reports `degraded`
 * rather than returning nothing, so that failure can never be silent again.
 */
export async function loadRegistry(): Promise<{ path: string, products: Record<string, any>, degraded: boolean } | null> {
  const s = await readStore()
  if (!s.ok || !s.path) return null
  return { path: s.path, products: s.products, degraded: s.degraded }
}

const word = (s: string) =>
  new RegExp(`(^|[^A-Za-z0-9_])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`, 'i')

/**
 * Resolves the product a ticket belongs to. A Jira key's project prefix is the
 * strongest signal, then labels, then component words. The first product in
 * registry order wins a tie, and no match returns undefined: guessing a product
 * is how a run stands up the wrong stack.
 */
export async function resolveProduct(text: string): Promise<ProductMatch | undefined> {
  const reg = await loadRegistry()
  if (!reg) return undefined
  const key = text.match(/\b([A-Z][A-Z0-9]+)-\d+\b/)?.[1]
  const entries = Object.entries(reg.products)
  const pick = (pred: (m: any) => boolean) => entries.find(([, p]) => pred(p?.match ?? {}))
  // The ticket key is removed before disambiguating, because a key CONTAINS the
  // component word: `word('AAA')` matches inside "AAA-56", so the generic AAA
  // product looked as specific as the EMS one and won on file order. The key has
  // already been used to pick the candidates; letting it also decide between
  // them is counting it twice.
  const textSansKey = text.replace(/\b[A-Z][A-Z0-9]+-\d+\b/g, ' ')
  // How specific a product's claim on this text is: the length of the longest
  // term of its own that appears. "PCRF EMS" is a stronger claim than "PCRF",
  // and both match a ticket about the EMS — so length is what separates them.
  // 0 means the product named nothing in the text at all.
  const specificity = (m: any) => Math.max(
    0,
    ...[...(m.labels ?? []), ...(m.components ?? [])]
      .filter((t: string) => word(t).test(textSansKey))
      .map((t: string) => t.length),
  )

  // Two products can share a Jira project and live in different repositories —
  // AAA covers the server and the EMS portal, PCRFV the same. Taking the first
  // product in file order would make the second unreachable by its own project
  // key, silently, and route every EMS ticket to the server repo.
  //
  // So within the project tier, a product that ALSO matches a label or
  // component beats one matching the key alone. Tier precedence is unchanged:
  // a project match still outranks any word match, and where nothing
  // disambiguates, file order still decides.
  const byProject = key ? entries.filter(([, p]) => ((p?.match ?? {}).projects ?? []).includes(key)) : []
  const best = byProject
    .map(e => [e, specificity(e[1]?.match ?? {})] as const)
    .sort((a, b) => b[1] - a[1])[0]
  const hit = (best && best[1] > 0 ? best[0] : undefined)
    || byProject[0]
    || pick(m => (m.labels ?? []).some((l: string) => word(l).test(text)))
    || pick(m => (m.components ?? []).some((c: string) => word(c).test(text)))
  if (!hit) return undefined
  const [name, p] = hit
  return productMatchFrom(name, p)
}

export interface ResolutionExplanation {
  /** The product that won, or null when nothing matched. */
  winner: string | null
  /** Which rule decided it. */
  tier: 'project' | 'specificity' | 'order' | 'label' | 'component' | 'none'
  /** One sentence naming the rule and the term, for the page to print. */
  reason: string
  /** The ticket key the text carried, if any. */
  ticketKey: string | null
  /** Products that also claimed this text, with the length of their longest matching term. */
  candidates: { name: string, specificity: number, term: string | null }[]
}

/**
 * Why a ticket routes where it does.
 *
 * Duplicated scoring is a real cost, so read this as what it is: a reporter
 * over the same three rules `resolveProduct` applies, kept beside it so the two
 * are edited together. It exists because the tie-break that actually decides
 * most ambiguous tickets - file order - is invisible. A ticket that routes to
 * the wrong product looks identical to one that routes to the right one, and
 * the only way to find out otherwise is to start a run and watch it clone the
 * wrong repository. The Products page asks this instead.
 */
export async function explainResolution(text: string): Promise<ResolutionExplanation> {
  const reg = await loadRegistry()
  const none: ResolutionExplanation = { winner: null, tier: 'none', reason: 'No registry could be read on this instance.', ticketKey: null, candidates: [] }
  if (!reg) return none

  const ticketKey = text.match(/\b([A-Z][A-Z0-9]+)-\d+\b/)?.[1] ?? null
  const textSansKey = text.replace(/\b[A-Z][A-Z0-9]+-\d+\b/g, ' ')
  const entries = Object.entries(reg.products)
  const longestTerm = (m: any) => [...(m?.labels ?? []), ...(m?.components ?? [])]
    .filter((t: string) => word(t).test(textSansKey))
    .sort((a: string, b: string) => b.length - a.length)[0] ?? null

  const byProject = ticketKey ? entries.filter(([, p]) => ((p?.match ?? {}).projects ?? []).includes(ticketKey)) : []
  const candidates = byProject.map(([name, p]) => {
    const term = longestTerm(p?.match)
    return { name, specificity: term?.length ?? 0, term }
  })

  if (byProject.length) {
    const best = [...candidates].sort((a, b) => b.specificity - a.specificity)[0]!
    if (best.specificity > 0) {
      const beaten = candidates.filter(c => c.name !== best.name)
      return {
        winner: best.name, tier: 'specificity', ticketKey, candidates,
        reason: `project ${ticketKey} matched ${byProject.length} product${byProject.length === 1 ? '' : 's'}; `
          + `"${best.term}" (${best.specificity} chars) is the more specific claim`
          + (beaten.length ? ` over ${beaten.map(c => `${c.name} (${c.specificity})`).join(', ')}` : ''),
      }
    }
    const winner = byProject[0]![0]
    return {
      winner, tier: byProject.length > 1 ? 'order' : 'project', ticketKey, candidates,
      reason: byProject.length > 1
        ? `project ${ticketKey} matched ${byProject.length} products and nothing else distinguished them, so the first in file order won — reorder them to change this`
        : `project ${ticketKey} is claimed by ${winner} alone`,
    }
  }

  const byLabel = entries.find(([, p]) => ((p?.match ?? {}).labels ?? []).some((l: string) => word(l).test(text)))
  if (byLabel) {
    const term = longestTerm(byLabel[1]?.match)
    return { winner: byLabel[0], tier: 'label', ticketKey, candidates: [], reason: `no ticket key matched a project; the label "${term}" did` }
  }
  const byComponent = entries.find(([, p]) => ((p?.match ?? {}).components ?? []).some((c: string) => word(c).test(text)))
  if (byComponent) {
    const term = longestTerm(byComponent[1]?.match)
    return { winner: byComponent[0], tier: 'component', ticketKey, candidates: [], reason: `no project or label matched; the component word "${term}" did` }
  }
  return { ...none, ticketKey, reason: 'Nothing in the registry claims this text, so a run would have no product — no repos, no branch policy, no stack.' }
}

/**
 * Where a product's recipe lives, resolved independently of where the registry
 * file does.
 *
 * It used to be derived from the registry's own path - `<registry>/../../recipes`
 * - which was correct only while the registry could only ever be the plugin's
 * copy or the shipped one. A registry read from anywhere else resolves that to
 * a directory holding nothing, and the six recipes that exist simply stop being
 * found: `recipe` goes absent, the stack step is told nothing, and it improvises
 * the product's bring-up. Silent, because "this product has no recipe" is a
 * legitimate state for eighteen of the twenty-four.
 *
 * The Claude directory comes first, so recipes can become editable here later
 * without another migration. After that there is exactly ONE source, not a
 * chain: the plugin's directory when a plugin is installed, the shipped copy
 * otherwise.
 *
 * Deliberately narrower than `registryPath`, which does fall through from the
 * plugin to the shipped copy. A missing registry is catastrophic - every
 * ticket resolves to no product - so it needs a floor. A missing recipe is
 * ordinary: eighteen of the twenty-four products have none. Falling through
 * would pair a stale plugin's registry entry with the checkout's recipe for a
 * product that may have moved on, to fix a problem nobody has.
 */
export type RecipeSource = 'local' | 'plugin' | 'shipped'
export interface RecipeLocation { path: string, source: RecipeSource }

/**
 * The two places a recipe for `name` could be, in precedence order, whether or
 * not a file is actually at either. Exactly two and never a longer chain, for
 * the reason above: the local copy, then the plugin's when one is installed
 * and the shipped one when none is.
 *
 * Split out from the lookup because the editor needs the candidates and not
 * just the winner - it writes the local path whether or not a file is there,
 * and it has to be able to say which copy a local one is hiding.
 */
export function recipeCandidates(name: string): RecipeLocation[] {
  const plugin = pluginRecipesDir()
  return [
    { path: resolveClaudePath('recipes', `${name}.md`), source: 'local' },
    plugin
      ? { path: join(plugin, `${name}.md`), source: 'plugin' }
      : { path: `${process.cwd().replace(/\\/g, '/')}/engineering/recipes/${name}.md`, source: 'shipped' },
  ]
}

/** The recipe in force for `name`, and which of the two copies it is. */
export function resolveRecipe(name: string): RecipeLocation | undefined {
  return recipeCandidates(name).find(c => existsSync(c.path))
}

export function recipePathFor(name: string): string | undefined {
  return resolveRecipe(name)?.path
}

/** The installed plugin's recipes directory, from the same manifest registryPath() reads. */
function pluginRecipesDir(): string | null {
  const installed = resolveClaudePath('plugins', 'installed_plugins.json')
  if (!existsSync(installed)) return null
  try {
    const data = JSON.parse(readFileSync(installed, 'utf-8'))
    const entry = data?.plugins?.['alepo-engineering@alepo-engineering']?.[0]
    const dir = entry?.installPath && join(entry.installPath, 'recipes')
    return dir && existsSync(dir) ? dir : null
  } catch {
    return null
  }
}

function productMatchFrom(name: string, p: any): ProductMatch {
  const recipe = recipePathFor(name)
  return {
    name,
    ...(p.suite ? { suite: String(p.suite) } : {}),
    ...(p.multi_repo === true ? { multiRepo: true } : {}),
    repos: p.repos ?? [],
    ...(Array.isArray(p.match?.projects) && p.match.projects.length ? { projects: p.match.projects.map(String) } : {}),
    ...(p.modules && Object.keys(p.modules).length ? { modules: p.modules } : {}),
    branches: p.branches ?? {},
    stack: p.stack,
    tests: p.tests ?? {},
    ...(recipe ? { recipe } : {}),
  }
}

/** The registry entry for a product key, as a ProductMatch; undefined when the key is not registered. */
export async function productByKey(key: string): Promise<ProductMatch | undefined> {
  const reg = await loadRegistry()
  const p = reg?.products?.[key]
  return reg && p ? productMatchFrom(key, p) : undefined
}

/**
 * The product whose `repos` lists this owner/name, as a ProductMatch; undefined
 * when no product claims it. Exact and case-insensitive: a repo name is an
 * identifier, not text to word-match, and `word('crm')` matching inside
 * "alepolab/ase-crm" is how a scan of ase-crm was filed against CRM.
 */
export async function productByRepo(repo: string): Promise<ProductMatch | undefined> {
  const reg = await loadRegistry()
  const want = repo.trim().toLowerCase()
  if (!reg || !want) return undefined
  const hit = Object.entries(reg.products)
    .find(([, p]) => Array.isArray(p?.repos) && p.repos.some((r: unknown) => String(r).toLowerCase() === want))
  return hit ? productMatchFrom(hit[0], hit[1]) : undefined
}

/** Every registered product key, for a message that has to name them. */
export async function registeredProductKeys(): Promise<string[]> {
  const reg = await loadRegistry()
  return reg ? Object.keys(reg.products) : []
}

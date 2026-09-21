import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import { resolveClaudePath } from './claudeDir.ts'
import type { ProductMatch } from '~~/shared/types/run'

/**
 * The registry travels with the alepo-engineering plugin, so a machine that
 * has the plugin has the registry. AGENT_REGISTRY_PATH overrides for tests
 * and for a checkout that is ahead of the installed plugin.
 */
async function registryPath(): Promise<string | null> {
  if (process.env.AGENT_REGISTRY_PATH) return process.env.AGENT_REGISTRY_PATH

  const installed = resolveClaudePath('plugins', 'installed_plugins.json')
  if (existsSync(installed)) {
    try {
      const data = JSON.parse(await readFile(installed, 'utf-8'))
      const entry = data?.plugins?.['alepo-engineering@alepo-engineering']?.[0]
      const path = entry?.installPath && join(entry.installPath, 'registry', 'products.yaml')
      if (path && existsSync(path)) return path
    }
    catch { /* fall through to the shipped copy */ }
  }

  // The copy shipped in the product, for the container's normal case: no plugin
  // installed. Without this, registryPath returned null, loadRegistry returned
  // null, and resolveProduct returned undefined for EVERY ticket — so no run in
  // a team container has ever resolved a product. No repos, no branch policy,
  // no stack profile, no test commands: the agents improvised all of it, and
  // two of them improvised different checkout directories in the same run.
  //
  // Silent by construction, because "no product matched this ticket" and "the
  // registry could not be found" produced the same undefined. Same shape as the
  // skills and commands gaps: the plugin is preferred so an operator can update
  // it independently, and the shipped copy is the floor.
  const shipped = join(process.cwd(), 'engineering', 'registry', 'products.yaml')
  return existsSync(shipped) ? shipped : null
}

export async function loadRegistry(): Promise<{ path: string, products: Record<string, any> } | null> {
  const path = await registryPath()
  if (!path) return null
  try {
    const doc = parse(await readFile(path, 'utf-8'))
    if (!doc?.products || typeof doc.products !== 'object') return null
    return { path, products: doc.products }
  } catch {
    // A registry that does not parse is a registry that does not exist; the
    // validator script is the place that reports why.
    return null
  }
}

const word = (s: string) =>
  new RegExp(`(^|[^A-Za-z0-9_])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`, 'i')

/**
 * Resolves the product a ticket belongs to. A Jira key's project prefix is the
 * strongest signal, then labels, then component words. The first product in
 * registry order wins a tie, and no match returns undefined: guessing a product
 * is how a run stands up the wrong stack.
 */
/**
 * A rendered Jira ticket's `Environment` section: the estate it runs on, not
 * the thing it is about. Removed before matching, because every ticket in a
 * project carries the same one and it names load balancers, Keycloak nodes and
 * database instances that belong to no particular product's work.
 */
function bodyWithoutEnvironment(text: string): string {
  return text.replace(/\n\s*Environment\s*\n[\s\S]*?(?=\n\s*(?:Background|Steps to Reproduce|Expected|Actual|Description|Impact|Attachments)\s*\n|$)/i, '\n')
}

/**
 * The part of a ticket that states what it is about: the subject line, plus
 * the `Component` field the reporter filled in. Empty when the text is not a
 * rendered ticket, in which case the caller falls back to the whole thing.
 */
function focusOf(text: string): string {
  const subject = text.split('\n', 1)[0] ?? ''
  const component = text.match(/\n\s*Components?\s*\n+([^\n]+(?:\n(?!\s*\n)[^\n]+)*)/i)?.[1] ?? ''
  return `${subject}\n${component}`.trim()
}

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
  const specificity = (m: any, haystack: string) => Math.max(
    0,
    ...[...(m.labels ?? []), ...(m.components ?? [])]
      .filter((t: string) => word(t).test(haystack))
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
  // Where a ticket says what it is ABOUT, as opposed to where it runs.
  //
  // Run a3cb9d37 cost $35.54 and 72 minutes working in the wrong repository
  // because of one word of boilerplate. Every CSUP ticket carries an
  // Environment section naming the deployment estate; CSUP-7526's read
  // "Keycloak / CRM Nodes: DC-CRM1-KC1", and `Keycloak` is an infra label. A
  // Selfcare billing bug therefore resolved to `infra`, every lane's worktree
  // was cut from the devops repo, and a lane committed 859 lines of that
  // ticket's SQL onto a devops branch.
  //
  // The subject line and the ticket's own Component field are the claim; the
  // Environment block is a description of the estate every ticket shares, so
  // it decides nothing. The full text is still the last resort, because a
  // prompt that is not a rendered ticket has no sections at all.
  const focus = focusOf(textSansKey)
  // The longest matching term wins here too, not file order.
  //
  // The project tier already worked this way - "PCRF EMS" is a stronger claim
  // than "PCRF" - but the label and component tiers took the first entry in
  // file order, so a ticket whose Component says "LUM Selfcare" resolved to
  // selfcarenow purely because it is written earlier in the file. Same rule,
  // applied consistently; ties still fall back to file order.
  const pickIn = (haystack: string) => {
    const scored = entries
      .map(e => [e, specificity(e[1]?.match ?? {}, haystack)] as const)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
    return scored[0]?.[0]
  }

  const byProject = key ? entries.filter(([, p]) => ((p?.match ?? {}).projects ?? []).includes(key)) : []
  // Specificity is measured on the focus when the ticket has one: a product
  // named in the subject beats one named only in the estate description.
  const scored = byProject
    .map(e => [e, Math.max(specificity(e[1]?.match ?? {}, focus), 0)] as const)
    .sort((a, b) => b[1] - a[1])[0]
  const best = scored && scored[1] > 0
    ? scored
    : byProject.map(e => [e, specificity(e[1]?.match ?? {}, textSansKey)] as const).sort((a, b) => b[1] - a[1])[0]
  const hit = (best && best[1] > 0 ? best[0] : undefined)
    || byProject[0]
    || pickIn(focus)
    || pickIn(bodyWithoutEnvironment(textSansKey))
    || pick(m => (m.labels ?? []).some((l: string) => word(l).test(text)))
    || pick(m => (m.components ?? []).some((c: string) => word(c).test(text)))
  if (!hit) return undefined
  const [name, p] = hit
  return productMatchFrom(reg.path, name, p)
}

function productMatchFrom(registryPath: string, name: string, p: any): ProductMatch {
  const recipe = join(registryPath, '..', '..', 'recipes', `${name}.md`)
  return {
    name,
    ...(p.suite ? { suite: String(p.suite) } : {}),
    ...(p.multi_repo === true ? { multiRepo: true } : {}),
    repos: p.repos ?? [],
    ...(p.modules && Object.keys(p.modules).length ? { modules: p.modules } : {}),
    branches: p.branches ?? {},
    stack: p.stack,
    tests: p.tests ?? {},
    ...(existsSync(recipe) ? { recipe } : {}),
  }
}

/** The registry entry for a product key, as a ProductMatch; undefined when the key is not registered. */
export async function productByKey(key: string): Promise<ProductMatch | undefined> {
  const reg = await loadRegistry()
  const p = reg?.products?.[key]
  return reg && p ? productMatchFrom(reg.path, key, p) : undefined
}

/** Every registered product key, for a message that has to name them. */
export async function registeredProductKeys(): Promise<string[]> {
  const reg = await loadRegistry()
  return reg ? Object.keys(reg.products) : []
}

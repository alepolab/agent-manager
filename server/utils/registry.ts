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
  if (!existsSync(installed)) return null
  try {
    const data = JSON.parse(await readFile(installed, 'utf-8'))
    const entry = data?.plugins?.['alepo-engineering@alepo-engineering']?.[0]
    if (!entry?.installPath) return null
    const path = join(entry.installPath, 'registry', 'products.yaml')
    return existsSync(path) ? path : null
  } catch {
    return null
  }
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
export async function resolveProduct(text: string): Promise<ProductMatch | undefined> {
  const reg = await loadRegistry()
  if (!reg) return undefined
  const key = text.match(/\b([A-Z][A-Z0-9]+)-\d+\b/)?.[1]
  const entries = Object.entries(reg.products)
  const pick = (pred: (m: any) => boolean) => entries.find(([, p]) => pred(p?.match ?? {}))
  const hit = (key && pick(m => (m.projects ?? []).includes(key)))
    || pick(m => (m.labels ?? []).some((l: string) => word(l).test(text)))
    || pick(m => (m.components ?? []).some((c: string) => word(c).test(text)))
  if (!hit) return undefined
  const [name, p] = hit
  const recipe = join(reg.path, '..', '..', 'recipes', `${name}.md`)
  return {
    name,
    ...(p.suite ? { suite: String(p.suite) } : {}),
    repos: p.repos ?? [],
    branches: p.branches ?? {},
    stack: p.stack,
    tests: p.tests ?? {},
    ...(existsSync(recipe) ? { recipe } : {}),
  }
}

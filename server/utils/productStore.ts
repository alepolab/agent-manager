/**
 * The product registry as a store this app owns, at `~/.claude/products.yaml`.
 *
 * ## Why it is still YAML
 *
 * Roughly forty per cent of the shipped registry's lines are comments, and they
 * are the only place certain facts exist: which fields are drafts rather than
 * decisions, why a product's branch is `development` and not `develop`, which
 * component word would be invented rather than read. The commit that registered
 * `ase-crm` is three lines of YAML and fifteen of reasoning. A JSON transcode
 * would delete all of it in the same change that claims to make the registry
 * easier to edit.
 *
 * So edits go in through the `yaml` package's Document API, field path by field
 * path, never by replacing a node - replacing one drops the comments attached
 * to it. Each product's leading comment block is exposed as an editable field
 * of its own, so the rationale is something a person is asked for rather than
 * something a save quietly eats.
 *
 * ## Why key order is never touched
 *
 * File order is the final tie-break in `resolveProduct` (server/utils/registry.ts).
 * A store that re-sorted its products on save would silently reroute live
 * tickets, with no error anywhere and nothing in the diff that looks like a
 * routing change. New products append; reordering is its own explicit action.
 *
 * ## Why seeding is structural rather than a flag
 *
 * `ensureSeeded` writes only when the file does not exist. Once it does, this
 * module has no path that copies the source over it. That is deliberate and
 * different from `teamSync.ts`, whose contract is the opposite - it rewrites
 * seeded items at every boot, which is what `TeamStatus.reverted` exists to
 * warn about. A registry edited here must never be reverted by a restart, and
 * "the branch cannot be reached" is a stronger guarantee than "the flag was
 * set correctly".
 */
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { Document, isMap, isSeq, parseDocument, YAMLSeq } from 'yaml'
import { getClaudeDir, resolveClaudePath } from './claudeDir.ts'
import { createLogger } from './log.ts'

const log = createLogger('registry')

export const STORE_FILE_NAME = 'products.yaml'
const SEED_FILE_NAME = '.products-seed.json'

export type StoreSource = 'override' | 'store' | 'plugin' | 'shipped' | 'none'

/**
 * Where the store is. `AGENT_REGISTRY_PATH` keeps the precedence it always had
 * and now gains write semantics: when it is set, that file IS the store, read
 * and written. Every existing test keeps working, and an operator gets a
 * supported way to point the app at a checkout.
 */
export function storePath(): string {
  return process.env.AGENT_REGISTRY_PATH?.trim() || resolveClaudePath(STORE_FILE_NAME)
}
const seedInfoPath = () => resolveClaudePath(SEED_FILE_NAME)

/** The plugin's copy, then the one shipped in the product. */
export function seedSourcePath(): { path: string, kind: 'plugin' | 'shipped' } | null {
  const installed = resolveClaudePath('plugins', 'installed_plugins.json')
  if (existsSync(installed)) {
    try {
      const data = JSON.parse(readFileSync(installed, 'utf-8'))
      const entry = data?.plugins?.['alepo-engineering@alepo-engineering']?.[0]
      const path = entry?.installPath && join(entry.installPath, 'registry', STORE_FILE_NAME)
      if (path && existsSync(path)) return { path, kind: 'plugin' }
    } catch { /* fall through to the shipped copy */ }
  }
  const shipped = `${process.cwd().replace(/\\/g, '/')}/engineering/registry/${STORE_FILE_NAME}`
  return existsSync(shipped) ? { path: shipped, kind: 'shipped' } : null
}

export interface SeedInfo { seededFrom: string, seededKind: string, seedSha256: string, seededAt: number }

export function seedInfo(): SeedInfo | null {
  try { return JSON.parse(readFileSync(seedInfoPath(), 'utf-8')) as SeedInfo }
  catch { return null }
}

/**
 * Copy the source into the store, once, the first time anything reads it.
 *
 * Lazy rather than a boot plugin: a boot plugin invites the teamSync shape, and
 * the one thing this must never acquire is a path that rewrites the file on a
 * restart. Never throws - a Claude directory that cannot be written (a
 * container where the volume mount is read-only) must degrade to "the seed is
 * still the live registry", which `readStore` reports, not to a boot failure.
 */
export async function ensureSeeded(): Promise<{ seeded: boolean, from?: string }> {
  const path = storePath()
  if (existsSync(path)) return { seeded: false }
  const source = seedSourcePath()
  if (!source) return { seeded: false }
  try {
    await mkdir(getClaudeDir(), { recursive: true })
    // Byte-for-byte, not parse-and-serialise: every comment, blank line and
    // quoting choice in the source is content here.
    await copyFile(source.path, path)
    const bytes = await readFile(path)
    await writeFile(seedInfoPath(), JSON.stringify({
      seededFrom: source.path,
      seededKind: source.kind,
      seedSha256: createHash('sha256').update(bytes).digest('hex'),
      seededAt: Date.now(),
    } satisfies SeedInfo, null, 2), 'utf-8')
    log.info('registry store seeded', { path, from: source.path, kind: source.kind })
    return { seeded: true, from: source.path }
  } catch (err) {
    log.warn('could not seed the registry store; the seed itself stays the live registry',
      { path, error: err instanceof Error ? err.message : String(err) })
    return { seeded: false }
  }
}

export interface StoreRead {
  /** False only when nothing anywhere could be read. */
  ok: boolean
  /** True when the store exists but does not parse, so routing is running on the seed. */
  degraded: boolean
  path: string | null
  source: StoreSource
  products: Record<string, any>
  /** For the optimistic-concurrency check on a write; null when there is no store file. */
  mtimeMs: number | null
  seed: SeedInfo | null
}

/** Parse a registry file, or null. Never throws. */
async function parseProducts(path: string): Promise<Record<string, any> | null> {
  try {
    const doc = parseDocument(await readFile(path, 'utf-8'))
    // `parseDocument` RECOVERS from a malformed document rather than throwing:
    // it collects what it can and records why in `errors`. Reading `toJS()`
    // without checking them is how a truncated registry reads back as a
    // partial one - some products present, others silently absent, and every
    // ticket belonging to a missing one resolving to nothing.
    if (doc.errors.length) return null
    const products = doc.toJS()?.products
    return products && typeof products === 'object' && !Array.isArray(products) ? products : null
  } catch {
    return null
  }
}

/**
 * The registry as it is right now, and where it came from.
 *
 * A store that does not parse falls back to the seed rather than returning
 * nothing. This is the difference the recorded outage turns on: a null registry
 * makes EVERY ticket resolve to no product, silently, and the agents improvise
 * repos and checkout directories. `degraded` is how a person finds out.
 */
export async function readStore(): Promise<StoreRead> {
  await ensureSeeded()
  const path = storePath()
  const seed = seedInfo()
  const override = !!process.env.AGENT_REGISTRY_PATH?.trim()

  if (existsSync(path)) {
    const products = await parseProducts(path)
    if (products) {
      return {
        ok: true, degraded: false, path, source: override ? 'override' : 'store',
        products, mtimeMs: (await stat(path)).mtimeMs, seed,
      }
    }
    log.error('the registry store does not parse; falling back to the seed', { path })
    const source = seedSourcePath()
    const fallback = source ? await parseProducts(source.path) : null
    return {
      ok: !!fallback, degraded: true, path, source: source?.kind ?? 'none',
      products: fallback ?? {}, mtimeMs: (await stat(path)).mtimeMs, seed,
    }
  }

  // No store: either seeding could not write, or there is nothing to seed from.
  const source = seedSourcePath()
  const products = source ? await parseProducts(source.path) : null
  return {
    ok: !!products, degraded: false, path: source?.path ?? null,
    source: source?.kind ?? 'none', products: products ?? {}, mtimeMs: null, seed,
  }
}

// ── Writing ────────────────────────────────────────────────────────────────

/** A write refused because the file moved under the caller. */
export class StaleStoreError extends Error {
  /** Declared and assigned separately: Node runs these files with type
   *  stripping only, and a constructor parameter property is syntax it
   *  refuses outright. */
  readonly mtimeMs: number
  constructor(mtimeMs: number) {
    super('The registry changed since you loaded it. Reload to see the latest version.')
    this.mtimeMs = mtimeMs
  }
}

async function loadDocument(): Promise<{ doc: Document, path: string }> {
  await ensureSeeded()
  const path = storePath()
  const text = existsSync(path) ? await readFile(path, 'utf-8') : 'products:\n'
  const doc = parseDocument(text)
  if (doc.errors.length) throw new Error(`The registry store at ${path} does not parse: ${doc.errors[0]!.message}`)
  if (!doc.has('products')) doc.set('products', doc.createNode({}))
  return { doc, path }
}

/**
 * Write the document back atomically, keeping the previous file as `.bak`.
 *
 * A half-written registry is the outage this whole module is careful about: a
 * truncated file does not parse, and until `degraded` was added that meant
 * every ticket resolved to no product. Temp file, keep a copy, rename.
 */
async function saveDocument(doc: Document, path: string, expectedMtimeMs?: number): Promise<number> {
  if (expectedMtimeMs !== undefined && existsSync(path)) {
    const current = (await stat(path)).mtimeMs
    if (Math.abs(current - expectedMtimeMs) > 1000) throw new StaleStoreError(current)
  }
  // Rendering options chosen to match how the registry is actually written,
  // not the serialiser's defaults. Without them the first save reflows the
  // whole file - `[ASECRM]` becomes `[ ASECRM ]`, and the long components list
  // on `infra` breaks across thirteen lines - so a one-field edit arrives as a
  // hundred-line diff and the reviewer cannot see what changed.
  //
  // One normalisation survives and is accepted: `yaml` does not record the
  // whitespace BEFORE an end-of-line comment, so the column-aligned
  // `# CONFIRM` markers collapse to a single space the first time a file is
  // written. The markers themselves, and every standalone comment, are kept.
  const text = doc.toString({ lineWidth: 0, flowCollectionPadding: false })
  // Cheap last line of defence: never replace a working registry with something
  // that does not parse back, whatever the edit above did.
  const check = parseDocument(text)
  if (check.errors.length) throw new Error(`Refusing to write a registry that does not parse back: ${check.errors[0]!.message}`)

  await mkdir(getClaudeDir(), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, text, 'utf-8')
  if (existsSync(path)) await copyFile(path, `${path}.bak`)
  await rename(tmp, path)
  return (await stat(path)).mtimeMs
}

const isPlainObject = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** Every leaf path of an object, as arrays of keys. Arrays count as leaves. */
function leafPaths(value: unknown, prefix: (string | number)[] = []): (string | number)[][] {
  if (!isPlainObject(value)) return [prefix]
  const keys = Object.keys(value)
  if (!keys.length) return [prefix]
  return keys.flatMap(k => leafPaths(value[k], [...prefix, k]))
}

const at = (value: unknown, path: (string | number)[]): unknown =>
  path.reduce<any>((acc, k) => (acc == null ? undefined : acc[k]), value)

/**
 * Apply a product to the document as the minimal set of field-level edits.
 *
 * Deliberately not `doc.setIn(['products', key], next)`. That replaces the
 * product's node, and a replaced node takes every comment attached to it and
 * its fields with it - which is the mechanism that would quietly delete the
 * rationale this file exists to protect. Only fields that actually changed are
 * touched, so a save that edits one test command leaves every neighbouring
 * comment exactly where it was.
 */
function applyProduct(doc: Document, key: string, next: Record<string, any>): void {
  const base = ['products', key]
  const current = doc.getIn(base) ? (doc.getIn(base, false) as any) : undefined
  if (current === undefined) {
    doc.setIn(base, doc.createNode(next))
    return
  }
  const currentJs = (doc.toJS() as any)?.products?.[key] ?? {}

  for (const path of leafPaths(next)) {
    const value = at(next, path)
    if (JSON.stringify(at(currentJs, path)) === JSON.stringify(value)) continue
    const full = [...base, ...path]
    if (value === undefined) { doc.deleteIn(full); continue }
    const existing = doc.getIn(full, true)
    const node = doc.createNode(value)
    // Keep `repos: [a, b]` on one line rather than reflowing it to a block
    // list: the diff of a registry edit should show the field that changed,
    // not the shape of every list beside it.
    if (isSeq(existing) && existing.flow && node instanceof YAMLSeq) node.flow = true
    doc.setIn(full, node)
  }

  // Keys the incoming product no longer has.
  for (const path of leafPaths(currentJs)) {
    if (at(next, path) === undefined) doc.deleteIn([...base, ...path])
  }
}

/**
 * Every product's rationale block, keyed by product.
 *
 * Read separately from `readStore` because `toJS()` drops comments entirely -
 * they are not values, they hang off the nodes. A page that showed the fields
 * without them would present an empty "why" box above an entry whose reasoning
 * is the only record of a decision, which invites somebody to write over it.
 */
export async function productComments(): Promise<Record<string, string>> {
  const path = storePath()
  if (!existsSync(path)) return {}
  try {
    const doc = parseDocument(await readFile(path, 'utf-8'))
    const products = doc.get('products', true)
    if (!isMap(products)) return {}
    const out: Record<string, string> = {}
    for (const pair of products.items as any[]) {
      const key = String(pair.key?.value ?? pair.key)
      const comment = productComment(doc, key)
      if (comment) out[key] = comment
    }
    return out
  } catch {
    return {}
  }
}

/** The rationale block above a product's key, as editable text. */
export function productComment(doc: Document, key: string): string | undefined {
  const products = doc.get('products', true)
  if (!isMap(products)) return undefined
  const pair = products.items.find((p: any) => String(p.key?.value ?? p.key) === key) as any
  const raw = pair?.key?.commentBefore
  return typeof raw === 'string' ? raw.split('\n').map(l => l.replace(/^ /, '')).join('\n') : undefined
}

function setProductComment(doc: Document, key: string, comment: string | undefined): void {
  const products = doc.get('products', true)
  if (!isMap(products)) return
  const pair = products.items.find((p: any) => String(p.key?.value ?? p.key) === key) as any
  if (!pair?.key) return
  // A product this call just created has a plain string key, and a comment
  // cannot attach to one. Promote it to a scalar node first.
  if (typeof pair.key === 'string') pair.key = doc.createNode(pair.key)
  pair.key.commentBefore = comment?.trim()
    ? comment.split('\n').map(l => ` ${l}`).join('\n')
    : undefined
}

export interface WriteOptions {
  /** The mtime the caller read, for the optimistic-concurrency check. */
  expectedMtimeMs?: number
  /** The rationale block above the entry. `undefined` leaves it as it is. */
  comment?: string
}

/** Create or update one product. Returns the store's new mtime. */
export async function writeProduct(key: string, product: Record<string, any>, opts: WriteOptions = {}): Promise<number> {
  const { doc, path } = await loadDocument()
  applyProduct(doc, key, product)
  if (opts.comment !== undefined) setProductComment(doc, key, opts.comment)
  return saveDocument(doc, path, opts.expectedMtimeMs)
}

/** Remove one product. Returns the new mtime, or null when the key was absent. */
export async function deleteProduct(key: string, expectedMtimeMs?: number): Promise<number | null> {
  const { doc, path } = await loadDocument()
  if (!doc.hasIn(['products', key])) return null
  doc.deleteIn(['products', key])
  return saveDocument(doc, path, expectedMtimeMs)
}

/**
 * Reorder the products. `keys` must be a permutation of the ones present -
 * a partial list would silently drop whatever it left out, and file order is
 * routing, so a dropped product is a ticket that stops resolving.
 */
export async function reorder(keys: string[], expectedMtimeMs?: number): Promise<number> {
  const { doc, path } = await loadDocument()
  const products = doc.get('products', true)
  if (!isMap(products)) throw new Error('The registry has no products to reorder')
  const present = products.items.map((p: any) => String(p.key?.value ?? p.key))
  const sorted = (a: string[]) => [...a].sort()
  if (JSON.stringify(sorted(keys)) !== JSON.stringify(sorted(present))) {
    throw new Error('The new order must list every product exactly once; file order decides routing ties, so a partial list would drop products')
  }
  products.items = keys.map(k => products.items.find((p: any) => String(p.key?.value ?? p.key) === k)!)
  return saveDocument(doc, path, expectedMtimeMs)
}

/**
 * Append products from the seed source that the store does not have, with the
 * comments attached to them. This is the drift action on the Team page - never
 * automatic, because an automatic one is the every-boot rewrite this module is
 * built to avoid.
 */
export async function importFromSource(keys: string[], expectedMtimeMs?: number): Promise<{ imported: string[], mtimeMs: number }> {
  const source = seedSourcePath()
  if (!source) throw new Error('No plugin or shipped registry to import from')
  const sourceDoc = parseDocument(await readFile(source.path, 'utf-8'))
  const sourceProducts = sourceDoc.get('products', true)
  if (!isMap(sourceProducts)) throw new Error(`${source.path} has no products to import`)

  const { doc, path } = await loadDocument()
  const products = doc.get('products', true)
  if (!isMap(products)) throw new Error('The registry store has no products map')

  const imported: string[] = []
  for (const key of keys) {
    const pair = sourceProducts.items.find((p: any) => String(p.key?.value ?? p.key) === key)
    if (!pair) throw new Error(`"${key}" is not in ${source.path}`)
    if (products.items.some((p: any) => String(p.key?.value ?? p.key) === key)) continue
    products.items.push(pair)
    imported.push(key)
  }
  return { imported, mtimeMs: await saveDocument(doc, path, expectedMtimeMs) }
}

/** Restore the previous version, for an operator who has just made it worse. */
export async function restoreBackup(): Promise<boolean> {
  const path = storePath()
  const bak = `${path}.bak`
  if (!existsSync(bak)) return false
  await copyFile(bak, path)
  await rm(bak, { force: true })
  return true
}

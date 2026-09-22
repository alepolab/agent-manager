/**
 * A product's recipe as something this app reads and writes, at
 * `~/.claude/recipes/<key>.md`.
 *
 * ## Why writes only ever land locally
 *
 * `recipeCandidates` (server/utils/registry.ts) has always looked at the Claude
 * directory first and the plugin's or the shipped copy second. Until now only
 * the second ever held anything, so a recipe was whatever the plugin shipped
 * and a person who wanted to change one edited the plugin's checkout. This
 * writes the first, which is the same copy-on-write shape `productStore` uses:
 * the shipped copy seeds what you see, the local copy is what you own, and a
 * restart never hands your edit back.
 *
 * ## Why the local copy announces that it shadows
 *
 * The cost of copy-on-write is that a local `crm.md` hides the plugin's `crm.md`
 * permanently and silently, on this machine only. A later plugin release can
 * correct the bring-up for a product and nobody running a local copy will ever
 * see the correction. There is no merge and no drift apply here - `teamSync`
 * reports registry drift and refuses to apply it for the same reason - so the
 * one thing this module owes a reader is the fact itself: `shadows` carries the
 * path of the copy a local recipe is hiding, and the page says so in words.
 *
 * ## Why there is no schema
 *
 * A recipe is prose an agent reads (app/utils/templates.ts names it as the
 * first thing the stack step should read). The six that exist share headings
 * by convention, not by rule, and a validator that refused a recipe would stop
 * somebody writing down what they just learned standing a stack up - which is
 * the entire point of the file. Empty is refused; nothing else is.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { type RecipeSource, recipeCandidates, resolveRecipe } from './registry.ts'
import { createLogger } from './log.ts'

const log = createLogger('registry')

/** The same key pattern products.schema.json enforces. A key that matches it
 *  cannot contain a separator or a dot, so it is also the traversal guard on a
 *  name that arrived as a router param. */
const KEY = /^[a-z0-9]+(-[a-z0-9]+)*$/

function assertKey(key: string): void {
  if (!KEY.test(key)) throw new Error(`"${key}" is not a product key: lowercase words separated by hyphens`)
}

/** A write refused because the file moved under the caller. */
export class StaleRecipeError extends Error {
  /** Declared and assigned separately: Node runs these files with type
   *  stripping only, and a constructor parameter property is syntax it
   *  refuses outright. */
  readonly mtimeMs: number
  constructor(mtimeMs: number) {
    super('The recipe changed since you loaded it. Reload to see the latest version.')
    this.mtimeMs = mtimeMs
  }
}

export interface RecipeRead {
  key: string
  /** 'none' when no copy exists anywhere; `content` is then empty. */
  source: RecipeSource | 'none'
  path: string | null
  content: string
  /** Sent back with a write; the server answers 409 when it has moved. */
  mtimeMs: number | null
  /** The copy a local recipe is hiding, when there is one. Null otherwise. */
  shadows: string | null
  /** Whether a write would create the local copy rather than update it. */
  editable: true
}

/** Where a local write for `key` would go, existing or not. */
export function localRecipePath(key: string): string {
  assertKey(key)
  return recipeCandidates(key)[0]!.path
}

/** The copy that is not local, when one exists. What a local recipe shadows,
 *  and what a delete would fall back to. */
export function upstreamRecipe(key: string) {
  return recipeCandidates(key).find(c => c.source !== 'local' && existsSync(c.path))
}

export async function readRecipe(key: string): Promise<RecipeRead> {
  assertKey(key)
  const found = resolveRecipe(key)
  if (!found) return { key, source: 'none', path: null, content: '', mtimeMs: null, shadows: null, editable: true }
  const upstream = found.source === 'local' ? upstreamRecipe(key) : undefined
  return {
    key,
    source: found.source,
    path: found.path,
    content: await readFile(found.path, 'utf-8'),
    mtimeMs: (await stat(found.path)).mtimeMs,
    shadows: upstream?.path ?? null,
    editable: true,
  }
}

/**
 * Write the local recipe.
 *
 * The concurrency check is against the LOCAL file alone, and that is the right
 * comparison even though the mtime the caller carries may have come off the
 * plugin's copy. Three cases and each behaves: no local file and the caller
 * loaded the plugin's, so nothing can be lost and the write proceeds; a local
 * file whose mtime matches, so the caller is editing what they read; a local
 * file whose mtime does not match, which is somebody else's edit and is exactly
 * what must be refused. `null` means the caller was shown no recipe at all, so
 * a local file existing at all is a conflict.
 */
export async function writeRecipe(
  key: string,
  content: string,
  { expectedMtimeMs }: { expectedMtimeMs?: number | null } = {},
): Promise<{ path: string, mtimeMs: number }> {
  const path = localRecipePath(key)
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('A recipe with nothing in it is worse than none: the stack step reads "no recipe" as "improvise" and an empty one as instructions.')
  }

  if (expectedMtimeMs !== undefined && existsSync(path)) {
    const current = (await stat(path)).mtimeMs
    if (expectedMtimeMs === null || Math.abs(current - expectedMtimeMs) > 1000) throw new StaleRecipeError(current)
  }

  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, content.endsWith('\n') ? content : `${content}\n`, 'utf-8')
  await rename(tmp, path)
  const mtimeMs = (await stat(path)).mtimeMs
  log.info('recipe written', { key, path, shadows: upstreamRecipe(key)?.path })
  return { path, mtimeMs }
}

/**
 * Remove the local recipe, so whatever it was shadowing becomes the live one
 * again. Only ever the local copy: the plugin's and the shipped ones are not
 * this app's to delete.
 */
export async function deleteRecipe(key: string): Promise<{ fellBackTo: string | null }> {
  const path = localRecipePath(key)
  if (!existsSync(path)) throw new Error(`There is no local recipe for ${key} to remove.`)
  await rm(path)
  const upstream = upstreamRecipe(key)
  log.info('local recipe removed', { key, path, fellBackTo: upstream?.path ?? null })
  return { fellBackTo: upstream?.path ?? null }
}

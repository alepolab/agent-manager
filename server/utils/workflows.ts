import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolveClaudePath } from './claudeDir'
import type { Workflow } from '~/types'

/**
 * Read one workflow from the config directory.
 *
 * Extracted because starting a run used to fetch the workflow from its own
 * HTTP API. That request carried no cookies, so with auth enabled the auth
 * middleware returned 401 "Sign in required" to the server itself, and every
 * run start in team mode died with an unhandled FetchError — while the same
 * code worked in standalone mode, where AUTH_DISABLED makes the middleware a
 * no-op. Reading a local JSON file over loopback HTTP was never buying
 * anything; the auth gate just made the cost visible.
 */
export async function readWorkflow(slug: string): Promise<Workflow | null> {
  const filePath = resolveClaudePath('workflows', `${slug}.json`)
  if (!existsSync(filePath)) return null
  const raw = await readFile(filePath, 'utf-8')
  const data = JSON.parse(raw)
  return { slug, filePath, ...data, lastModified: (await stat(filePath)).mtimeMs } as Workflow
}

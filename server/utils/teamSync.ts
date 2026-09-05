import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile, cp } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveClaudePath } from './claudeDir.ts'
import { serializeFrontmatter } from './frontmatter.ts'
import { invalidate } from './memo.ts'
import { loadRegistry } from './registry.ts'
import { agentTemplates } from '../../app/utils/templates.ts'
import { workflowTemplates, materializeTemplateSteps } from '../../app/utils/workflowTemplates.ts'

/**
 * Team standards live in the alepo-engineering plugin and in the sdlc-*
 * templates this app ships. This module says how far the instance's config
 * directory has drifted from them and, on request or at boot, brings it back.
 * It is the server-side twin of scripts/sync-agents.mjs, which stays for
 * developers working from a checkout.
 */
export type ItemState = 'ok' | 'drifted' | 'missing'
export interface TeamStatus {
  pluginVersion: string | null
  pluginInstallPath: string | null
  agents: { id: string, state: ItemState }[]
  skills: { name: string, state: ItemState }[]
  workflow: { slug: string, state: ItemState, steps: number }
  registry: { ok: boolean, products: number, path: string | null }
  drifted: number
  checkedAt: number
}

const RUNBOOK_SLUG = 'runbook-a-ticket-to-evidence-backed-pr'

async function pluginInstall(): Promise<{ version: string, installPath: string } | null> {
  const p = resolveClaudePath('plugins', 'installed_plugins.json')
  if (!existsSync(p)) return null
  try {
    const data = JSON.parse(await readFile(p, 'utf-8'))
    const entry = data?.plugins?.['alepo-engineering@alepo-engineering']?.[0]
    return entry?.installPath ? { version: String(entry.version ?? ''), installPath: entry.installPath } : null
  } catch {
    return null
  }
}

async function readOr(path: string): Promise<string | null> {
  return existsSync(path) ? readFile(path, 'utf-8') : null
}

function runbookSteps(existingIds?: string[]) {
  const runbook = workflowTemplates.find(t => t.id === 'runbook-a-jira-to-diff')
  if (!runbook) return null
  const slugs: Record<string, string> = {}
  for (const s of runbook.steps) {
    slugs[s.agentTemplateId] = s.agentTemplateId
    if (s.monitorSlug) slugs[s.monitorSlug] = s.monitorSlug
  }
  return { runbook, steps: materializeTemplateSteps(runbook, slugs, existingIds) }
}

/** Compare, and when `apply` is true, write. Returns the state after the call. */
async function reconcile(apply: boolean): Promise<TeamStatus> {
  const plugin = await pluginInstall()
  const agentsDir = resolveClaudePath('agents')
  const skillsDir = resolveClaudePath('skills')
  const workflowsDir = resolveClaudePath('workflows')
  if (apply) await Promise.all([mkdir(agentsDir, { recursive: true }), mkdir(skillsDir, { recursive: true }), mkdir(workflowsDir, { recursive: true })])

  // Where the skills come from, and why there are two sources.
  //
  // Agents are seeded from `agentTemplates`, which ship inside the app, so they
  // always arrive. Skills used to come only from the INSTALLED plugin - and a
  // team container has no plugin installed, so a fresh instance booted with
  // "9 agents, 0 skills" while every agent declared skills that could not
  // resolve. That failure is silent by construction: buildAgentSystemPrompt
  // catches a per-skill resolution failure so one typo cannot stop an agent,
  // which means an unresolvable skill looks exactly like a working one and the
  // agent simply runs without the instructions it was supposed to have.
  //
  // So the installed plugin stays the preferred source - it is the one an
  // operator can update independently - and the copy shipped in the product
  // (engineering/skills/, see its VENDORED.md) is the fallback. The product
  // shipping its own skills is the whole point of vendoring them.
  const shippedSkills = join(process.cwd(), 'engineering', 'skills')
  const skillsSource = (plugin && existsSync(join(plugin.installPath, 'skills')))
    ? join(plugin.installPath, 'skills')
    : (existsSync(shippedSkills) ? shippedSkills : null)

  const skills: TeamStatus['skills'] = []
  if (skillsSource) {
    for (const name of await readdir(skillsSource)) {
      const from = join(skillsSource, name, 'SKILL.md')
      if (!existsSync(from)) continue
      const next = await readFile(from, 'utf-8')
      const to = join(skillsDir, name, 'SKILL.md')
      const current = await readOr(to)
      let state: ItemState = current === next ? 'ok' : current === null ? 'missing' : 'drifted'
      if (apply && state !== 'ok') {
        // The WHOLE directory, not just SKILL.md. Several skills carry
        // supporting files their body points at - systematic-debugging has ten
        // (root-cause-tracing.md, find-polluter.sh and the rest), and
        // requesting-code-review has code-reviewer.md. Copying only SKILL.md
        // seeds a skill that resolves and then refers the agent to files that
        // are not there.
        await cp(join(skillsSource, name), join(skillsDir, name), { recursive: true })
        state = 'ok'
      }
      skills.push({ name, state })
    }
  }

  const agents: TeamStatus['agents'] = []
  for (const t of agentTemplates.filter(t => t.id.startsWith('sdlc-'))) {
    const path = join(agentsDir, `${t.id}.md`)
    const next = serializeFrontmatter(t.frontmatter as any, t.body)
    const current = await readOr(path)
    let state: ItemState = current === next ? 'ok' : current === null ? 'missing' : 'drifted'
    if (apply && state !== 'ok') { await writeFile(path, next); state = 'ok' }
    agents.push({ id: t.id, state })
  }

  const wfPath = join(workflowsDir, `${RUNBOOK_SLUG}.json`)
  const existingRaw = await readOr(wfPath)
  const existing = existingRaw ? JSON.parse(existingRaw) : null
  const built = runbookSteps(existing?.steps?.map((s: any) => s.id))
  let wfState: ItemState = 'missing'
  let stepCount = 0
  if (built) {
    stepCount = built.steps.length
    const same = existing && JSON.stringify(existing.steps) === JSON.stringify(built.steps) && existing.name === built.runbook.name
    wfState = same ? 'ok' : existing ? 'drifted' : 'missing'
    if (apply && wfState !== 'ok') {
      await writeFile(wfPath, JSON.stringify({ name: built.runbook.name, description: built.runbook.description, steps: built.steps, createdAt: existing?.createdAt ?? new Date().toISOString() }, null, 2))
      wfState = 'ok'
    }
  }

  const reg = await loadRegistry()
  if (apply) { invalidate('agents'); invalidate('skills'); invalidate('relationships') }
  const drifted = [...agents, ...skills].filter(i => i.state !== 'ok').length + (wfState !== 'ok' ? 1 : 0)
  return {
    pluginVersion: plugin?.version ?? null,
    pluginInstallPath: plugin?.installPath ?? null,
    agents, skills,
    workflow: { slug: RUNBOOK_SLUG, state: wfState, steps: stepCount },
    registry: { ok: !!reg, products: reg ? Object.keys(reg.products).length : 0, path: reg?.path ?? null },
    drifted,
    checkedAt: Date.now(),
  }
}

export const teamStatus = () => reconcile(false)
export const teamSync = () => reconcile(true)

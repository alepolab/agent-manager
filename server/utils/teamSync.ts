import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile, cp } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import { resolveClaudePath } from './claudeDir.ts'
import { serializeFrontmatter } from './frontmatter.ts'
import { invalidate } from './memo.ts'
import { loadRegistry } from './registry.ts'
import { listWatches, saveWatch } from './watchConfig.ts'
import { agentRunsRoot } from './runArtifacts.ts'
import { defaultBudget } from './workflowRunStore.ts'
import { hasJiraCredentialsConfigured, isJiraPostingEnabled } from './jiraCredentials.ts'
import { authDisabled } from './session.ts'
import type { Watch } from '../../shared/types/watch.ts'
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
  commands: { name: string, state: ItemState }[]
  workflow: { slug: string, state: ItemState, steps: number }
  /** Registry watches, seeded disabled; an operator enables them on the Watches page. */
  watches: { id: string, state: ItemState }[]
  registry: { ok: boolean, products: number, path: string | null, items: { key: string, suite?: string, repos: string[], recipe: boolean }[] }
  /** What this instance is configured to do, so a developer can tell before starting a run. */
  instance: {
    claudeDir: string, runsDir: string, workspaceRoot: string
    auth: 'disabled' | 'github', githubOrg: string
    jiraRead: boolean, jiraPost: boolean, slack: boolean, ciPoller: boolean
    budget: { maxMinutes: number, maxTokens: number }
  }
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

  // Two sources, and the fallback is the one that matters in a container.
  //
  // Agents are seeded from `agentTemplates`, which ship inside the app, so they
  // always arrive. Skills came only from the INSTALLED plugin - and a team
  // container installs no plugins, so a fresh instance boots "9 agents, 0
  // skills" while every agent declares skills that cannot resolve. That failure
  // is silent by construction: buildAgentSystemPrompt catches a per-skill
  // resolution failure so one typo cannot stop an agent, which means an
  // unresolvable skill looks exactly like a working one and the agent simply
  // runs without the instructions it was supposed to have.
  //
  // The installed plugin stays preferred - an operator can update it
  // independently - and the copy shipped in the product (engineering/skills/,
  // see its VENDORED.md) is the fallback.
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
        // (root-cause-tracing.md, find-polluter.sh and the rest),
        // requesting-code-review has code-reviewer.md. Copying only SKILL.md
        // seeds a skill that resolves and then refers the agent to files that
        // are not there.
        await cp(join(skillsSource, name), join(skillsDir, name), { recursive: true })
        state = 'ok'
      }
      skills.push({ name, state })
    }
  }

  // Commands take the same plugin-preferred, shipped-fallback shape as skills
  // above, and for the same reason: a team container installs no plugin, so
  // this read seeded ZERO commands and the four the product ships - baseline,
  // reproduce, triage, tasks-picker-infra - reached nobody.
  //
  // That failure was invisible from every angle we had. The boot line reports
  // "0 commands", and 0 is a legitimate count for a repo that ships none.
  // scripts/sync-agents.mjs, the host-side twin of this function, DOES read
  // engineering/commands, so the host and the container disagreed about what
  // the product contains. And test-agent-skills.mjs asserts the command files
  // ship and are well-formed, which stayed true the whole time they were
  // unreachable - a shipped command nobody can invoke passes every check that
  // looks at the repo instead of at the seeded result.
  const shippedCommands = join(process.cwd(), 'engineering', 'commands')
  const commandsSource = (plugin && existsSync(join(plugin.installPath, 'commands')))
    ? join(plugin.installPath, 'commands')
    : (existsSync(shippedCommands) ? shippedCommands : null)

  const commands: TeamStatus['commands'] = []
  const commandsDir = resolveClaudePath('commands')
  if (commandsSource) {
    for (const name of await readdir(commandsSource)) {
      if (!name.endsWith('.md')) continue
      const next = await readFile(join(commandsSource, name), 'utf-8')
      const to = join(commandsDir, name)
      const current = await readOr(to)
      let state: ItemState = current === next ? 'ok' : current === null ? 'missing' : 'drifted'
      if (apply && state !== 'ok') { await mkdir(commandsDir, { recursive: true }); await writeFile(to, next); state = 'ok' }
      commands.push({ name: name.replace(/\.md$/, ''), state })
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

  // Watches: the registry names the queues; the instance holds their runtime
  // state (enabled, concurrency). Seeding creates a missing watch disabled and
  // refreshes the query and cap of an existing one, never its enabled flag.
  const watches: TeamStatus['watches'] = []
  // Same plugin-preferred, shipped-fallback shape as skills, commands and the
  // product registry - and for the same reason. This read was plugin-only, so a
  // team container seeded ZERO watches, every time, while the file sat unread in
  // the image at engineering/registry/watches.yaml.
  //
  // "0 watches" is a legitimate count for a deployment that has registered none,
  // which is exactly why it never looked wrong.
  const pluginWatches = plugin ? join(plugin.installPath, 'registry', 'watches.yaml') : null
  const shippedWatches = join(process.cwd(), 'engineering', 'registry', 'watches.yaml')
  const watchesYaml = (pluginWatches && existsSync(pluginWatches))
    ? pluginWatches
    : (existsSync(shippedWatches) ? shippedWatches : null)
  if (watchesYaml && existsSync(watchesYaml)) {
    let defined: any[] = []
    try { defined = parse(await readFile(watchesYaml, 'utf-8'))?.watches ?? [] } catch { defined = [] }
    const existing = await listWatches()
    for (const d of defined) {
      if (!d?.id || !d?.jql) continue
      const cur = existing.find(w => w.id === d.id)
      const cap = Number(d.daily_dispatch_cap) || 5
      let state: ItemState = !cur ? 'missing' : (cur.query === String(d.jql).trim() && cur.dailyDispatchCap === cap) ? 'ok' : 'drifted'
      if (apply && state !== 'ok') {
        const next: Watch = cur
          ? { ...cur, query: String(d.jql).trim(), dailyDispatchCap: cap }
          : { id: d.id, name: d.id, workflowSlug: RUNBOOK_SLUG, intervalSeconds: 300, enabled: false, maxConcurrentRuns: 1, dailyDispatchCap: cap, query: String(d.jql).trim(), autoRun: false }
        await saveWatch(next)
        state = 'ok'
      }
      watches.push({ id: d.id, state })
    }
  }

  const reg = await loadRegistry()
  const items = reg ? Object.entries(reg.products).map(([key, p]: [string, any]) => ({
    key,
    ...(p?.suite ? { suite: String(p.suite) } : {}),
    repos: Array.isArray(p?.repos) ? p.repos.map(String) : [],
    recipe: existsSync(join(reg.path, '..', '..', 'recipes', `${key}.md`)),
  })) : []
  if (apply) { invalidate('agents'); invalidate('skills'); invalidate('commands'); invalidate('relationships') }
  const drifted = [...agents, ...skills, ...commands, ...watches].filter(i => i.state !== 'ok').length + (wfState !== 'ok' ? 1 : 0)
  return {
    pluginVersion: plugin?.version ?? null,
    pluginInstallPath: plugin?.installPath ?? null,
    agents, skills, commands,
    workflow: { slug: RUNBOOK_SLUG, state: wfState, steps: stepCount },
    watches,
    registry: { ok: !!reg, products: items.length, path: reg?.path ?? null, items },
    instance: {
      claudeDir: resolveClaudePath(), runsDir: agentRunsRoot(), workspaceRoot: process.env.AGENT_WORKSPACE_ROOT || '~/alepo-workspace',
      auth: authDisabled() ? 'disabled' : 'github', githubOrg: process.env.GITHUB_ORG || 'alepolab',
      jiraRead: hasJiraCredentialsConfigured(), jiraPost: isJiraPostingEnabled(), slack: !!process.env.SLACK_WEBHOOK_URL, ciPoller: process.env.CI_POLLER_DISABLED !== '1',
      budget: defaultBudget(),
    },
    drifted,
    checkedAt: Date.now(),
  }
}

export const teamStatus = () => reconcile(false)
export const teamSync = () => reconcile(true)

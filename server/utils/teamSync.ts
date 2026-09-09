import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, cp } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parse } from 'yaml'
import { resolveClaudePath } from './claudeDir.ts'
import { serializeFrontmatter } from './frontmatter.ts'
import { invalidate, memo } from './memo.ts'
import { loadRegistry } from './registry.ts'
import { listWatches, saveWatch } from './watchConfig.ts'
import { agentRunsRoot } from './runArtifacts.ts'
import { defaultBudget } from './workflowRunStore.ts'
import { hasJiraCredentialsConfigured, isJiraPostingEnabled } from './jiraCredentials.ts'
import { authDisabled } from './session.ts'
import { workspaceRootFor } from './workspace.ts'
import type { Watch } from '../../shared/types/watch.ts'
import { agentTemplates } from '../../app/utils/templates.ts'
import { workflowTemplates, materializeTemplateSteps, RUNBOOK_FILES } from '../../app/utils/workflowTemplates.ts'

const execFileP = promisify(execFile)

/**
 * Team standards live in the alepo-engineering plugin and in the sdlc-*
 * templates this app ships. This module says how far the instance's config
 * directory has drifted from them and, on request or at boot, brings it back.
 * It is the server-side twin of scripts/sync-agents.mjs, which stays for
 * developers working from a checkout.
 */
export type ItemState = 'ok' | 'drifted' | 'missing'
/** Where a section's team version was read from: the installed plugin, the copy shipped in the product, or an override path. */
export type Source = 'plugin' | 'shipped' | 'other' | null
/** A drifted item carries the unified diff instance -> team, so a developer can see what Apply would change. */
export interface TeamItem { state: ItemState, diff?: string }
export interface TeamStatus {
  pluginVersion: string | null
  pluginInstallPath: string | null
  /** Version of the plugin source vendored in this build; differs from pluginVersion when the installed plugin is stale or ahead. */
  shippedVersion: string | null
  sources: { skills: Source, commands: Source, watches: Source, registry: Source }
  agents: ({ id: string } & TeamItem)[]
  skills: ({ name: string } & TeamItem)[]
  commands: ({ name: string } & TeamItem)[]
  /** Runbook A, the first of `workflows`; kept for the callers that read one. */
  workflow: { slug: string, state: ItemState, steps: number, diff?: string }
  /** Every workflow the team ships, seeded from `workflowTemplates`. */
  workflows: { slug: string, name: string, state: ItemState, steps: number, diff?: string }[]
  /** Items an apply OVERWROTE because they were edited locally. A seeded item that
   *  differs from the team version is rewritten at every boot, and that loss used
   *  to be silent: invisible from the UI, the boot line and the filesystem after. */
  reverted: { kind: 'agent' | 'skill' | 'command', name: string }[]
  /** Registry watches, seeded disabled; an operator enables them on the Watches page. */
  watches: ({ id: string } & TeamItem)[]
  registry: { ok: boolean, products: number, path: string | null, items: { key: string, suite?: string, repos: string[], recipe: boolean }[] }
  /** Skills the sdlc-* agents declare that do not resolve here. Those agents run without them, silently. */
  unresolvedSkills: string[]
  /** Whether the plugin's hooks are actually armed on this instance, as verify-enforcement.mjs sees it. */
  enforcement: { ok: boolean, checks: { name: string, armed: boolean, source?: string }[], error?: string }
  lastApplied: { by: string, at: number, items: number } | null
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

const RUNBOOK_SLUG = RUNBOOK_FILES['runbook-a-jira-to-diff']!
const shippedDir = () => join(process.cwd(), 'engineering')
const appliedPath = () => resolveClaudePath('.team-applied.json')

/**
 * The installed alepo-engineering plugin, or null when there is none.
 *
 * Exported because `promote` needs the same answer: a promotion is a PR into
 * the plugin, so on an instance with no plugin installed it changes the team
 * repo and nothing here. Saying so is the difference between an honest result
 * and a green link that does nothing where the operator is looking.
 */
export async function pluginInstall(): Promise<{ version: string, installPath: string } | null> {
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

async function readJsonOr<T>(path: string): Promise<T | null> {
  try { const raw = await readOr(path); return raw ? JSON.parse(raw) as T : null } catch { return null }
}

const stateOf = (current: string | null, next: string): ItemState => current === next ? 'ok' : current === null ? 'missing' : 'drifted'

/** Unified diff of the instance's copy against the team's, hunks only. git is already a requirement of this app. */
async function diffOf(current: string, next: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'team-diff-'))
  try {
    await Promise.all([writeFile(join(dir, 'instance'), current), writeFile(join(dir, 'team'), next)])
    // Exit code 1 is "the files differ", which is the case this is called for.
    const out = await execFileP('git', ['diff', '--no-index', '--no-color', '--', 'instance', 'team'], { cwd: dir, maxBuffer: 8 * 1024 * 1024 })
      .then(r => r.stdout, (e: any) => (e?.code === 1 && typeof e.stdout === 'string') ? e.stdout : `(diff unavailable: ${e?.message ?? e})`)
    return out.split('\n').slice(4).join('\n').trimEnd()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function item(state: ItemState, current: string | null, next: string): Promise<TeamItem> {
  return state === 'drifted' ? { state, diff: await diffOf(current ?? '', next) } : { state }
}

function runbookSteps(templateId: string, existingIds?: string[]) {
  const runbook = workflowTemplates.find(t => t.id === templateId)
  if (!runbook) return null
  const slugs: Record<string, string> = {}
  for (const s of runbook.steps) {
    slugs[s.agentTemplateId] = s.agentTemplateId
    if (s.monitorSlug) slugs[s.monitorSlug] = s.monitorSlug
  }
  return { runbook, steps: materializeTemplateSteps(runbook, slugs, existingIds) }
}

/**
 * "Installed" and "armed" are different facts: the plugin README documents an
 * install that went stale with nothing surfacing it. The plugin's own verifier
 * executes the resolved hook commands, so this asks it rather than reading
 * JSON. Memoised: it spawns a process.
 */
function enforcement(plugin: { installPath: string } | null): Promise<TeamStatus['enforcement']> {
  return memo('team:enforcement', 60_000, async () => {
    const script = [plugin && join(plugin.installPath, 'scripts', 'verify-enforcement.mjs'), join(shippedDir(), 'scripts', 'verify-enforcement.mjs')]
      .find((p): p is string => !!p && existsSync(p))
    if (!script) return { ok: false, checks: [], error: 'verify-enforcement.mjs is not on this instance' }
    try {
      const stdout = await execFileP('node', [script, '--json', '--repo', process.cwd()], { timeout: 15_000 })
        .then(r => r.stdout, (e: any) => typeof e?.stdout === 'string' && e.stdout.trim() ? e.stdout : Promise.reject(e))
      const r = JSON.parse(stdout)
      const checks = Object.entries(r)
        .filter(([, v]) => v && typeof v === 'object' && 'armed' in (v as object))
        .map(([name, v]: [string, any]) => ({ name, armed: !!v.armed, ...(v.source ? { source: String(v.source) } : {}) }))
      return { ok: !!r.ok, checks }
    } catch (e) {
      return { ok: false, checks: [], error: e instanceof Error ? e.message : String(e) }
    }
  })
}

interface ReconcileOptions {
  /** Who is applying; recorded as the audit line. */
  by?: string
  /** Apply only these items, keyed `agent:<id>`, `skill:<name>`, `command:<name>`, `workflow` (every runbook) or `workflow:<slug>`, `watch:<id>`. Absent means every drifted item. */
  only?: string[]
  /** The caller, for the workspace path the page shows. */
  login?: string
}

/** Compare, and when `apply` is true, write. Returns the state after the call. */
async function reconcile(apply: boolean, { by = 'instance', only, login }: ReconcileOptions = {}): Promise<TeamStatus> {
  const plugin = await pluginInstall()
  const agentsDir = resolveClaudePath('agents')
  const skillsDir = resolveClaudePath('skills')
  const workflowsDir = resolveClaudePath('workflows')
  if (apply) await Promise.all([mkdir(agentsDir, { recursive: true }), mkdir(skillsDir, { recursive: true }), mkdir(workflowsDir, { recursive: true })])
  let changed = 0
  const want = (key: string) => apply && (!only || only.includes(key))
  const sourceOf = (p: string | null): Source => !p ? null : (plugin && p.startsWith(plugin.installPath)) ? 'plugin' : p.startsWith(shippedDir()) ? 'shipped' : 'other'

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
  const reverted: TeamStatus['reverted'] = []
  const shippedSkills = join(shippedDir(), 'skills')
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
      let state = stateOf(current, next)
      // `apply` from here on means THIS item is applied: the call's flag narrowed by `only`.
      const apply = want(`skill:${name}`)
      if (apply && state === 'drifted') reverted.push({ kind: 'skill', name })
      if (apply && state !== 'ok') {
        // The WHOLE directory, not just SKILL.md. Several skills carry
        // supporting files their body points at - systematic-debugging has ten
        // (root-cause-tracing.md, find-polluter.sh and the rest),
        // requesting-code-review has code-reviewer.md. Copying only SKILL.md
        // seeds a skill that resolves and then refers the agent to files that
        // are not there.
        // `cp` refuses with EEXIST when the destination is a SYMLINK rather
        // than a directory, and one such skill aborted the WHOLE boot seed —
        // no workflow, no watches — wherever skills are linked in from
        // another tree. Replacing outright is what seeding means anyway.
        await rm(join(skillsDir, name), { recursive: true, force: true })
        await cp(join(skillsSource, name), join(skillsDir, name), { recursive: true })
        state = 'ok'; changed++
      }
      skills.push({ name, ...(await item(state, current, next)) })
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
  const shippedCommands = join(shippedDir(), 'commands')
  const commandsSource = (plugin && existsSync(join(plugin.installPath, 'commands')))
    ? join(plugin.installPath, 'commands')
    : (existsSync(shippedCommands) ? shippedCommands : null)

  const commands: TeamStatus['commands'] = []
  const commandsDir = resolveClaudePath('commands')
  if (commandsSource) {
    for (const file of await readdir(commandsSource)) {
      if (!file.endsWith('.md')) continue
      const name = file.replace(/\.md$/, '')
      const next = await readFile(join(commandsSource, file), 'utf-8')
      const to = join(commandsDir, file)
      const current = await readOr(to)
      let state = stateOf(current, next)
      const apply = want(`command:${name}`)
      if (apply && state === 'drifted') reverted.push({ kind: 'command', name })
      if (apply && state !== 'ok') { await mkdir(commandsDir, { recursive: true }); await writeFile(to, next); state = 'ok'; changed++ }
      commands.push({ name, ...(await item(state, current, next)) })
    }
  }

  // Agents take the SAME plugin-preferred, shipped-fallback shape as skills and
  // commands above. They did not, and the asymmetry made `promote` a trap: an
  // agent promoted into the plugin was skipped here by an explicit
  // `if (agentTemplates.some(t => t.id === id)) continue`, so the shipped
  // template kept winning and the operator's edit kept being reverted on every
  // boot - after a green PR that said it had been promoted. The escape hatch
  // reported success and changed nothing.
  const pluginAgents = new Map<string, string>()
  if (plugin && existsSync(join(plugin.installPath, 'agents'))) {
    for (const name of await readdir(join(plugin.installPath, 'agents'))) {
      if (!name.endsWith('.md')) continue
      pluginAgents.set(name.replace(/\.md$/, ''), await readFile(join(plugin.installPath, 'agents', name), 'utf-8'))
    }
  }

  const agents: TeamStatus['agents'] = []
  const shippedIds = new Set(agentTemplates.filter(t => t.id.startsWith('sdlc-')).map(t => t.id))
  const seedAgent = async (id: string, next: string) => {
    const path = join(agentsDir, `${id}.md`)
    const current = await readOr(path)
    let state = stateOf(current, next)
    const apply = want(`agent:${id}`)
    // Captured BEFORE the write, because applying sets it to 'ok' and the
    // distinction that matters to a human - "this existed and I replaced it" -
    // is gone a line later.
    if (apply && state === 'drifted') reverted.push({ kind: 'agent', name: id })
    if (apply && state !== 'ok') { await writeFile(path, next); state = 'ok'; changed++ }
    agents.push({ id, ...(await item(state, current, next)) })
  }
  for (const t of agentTemplates.filter(t => t.id.startsWith('sdlc-'))) {
    await seedAgent(t.id, pluginAgents.get(t.id) ?? serializeFrontmatter(t.frontmatter as any, t.body))
  }
  for (const [id, next] of pluginAgents) {
    if (!shippedIds.has(id)) await seedAgent(id, next)
  }

  const workflows: TeamStatus['workflows'] = []
  for (const [templateId, slug] of Object.entries(RUNBOOK_FILES)) {
    const wfPath = join(workflowsDir, `${slug}.json`)
    const existingRaw = await readOr(wfPath)
    // A file that does not parse is drift, not a crash: it is exactly what Apply is for.
    let existing: any = null
    let wfBroken = false
    if (existingRaw) { try { existing = JSON.parse(existingRaw) } catch { wfBroken = true } }
    const existingSteps: any[] = Array.isArray(existing?.steps) ? existing.steps : []
    const built = runbookSteps(templateId, existingSteps.map((s: any) => s.id))
    if (!built) continue
    // A step's canvas position is the operator's layout, not a team standard:
    // it is ignored in the comparison and carried over on write, so moving a
    // node does not read as drift and Apply does not undo the layout.
    const positions = new Map(existingSteps.map((s: any) => [s.id, s.position]))
    const strip = (steps: any[]) => steps.map(({ position: _p, ...s }) => s)
    const same = existing && JSON.stringify(strip(existingSteps)) === JSON.stringify(built.steps) && existing.name === built.runbook.name
    let state: ItemState = same ? 'ok' : (existing || wfBroken) ? 'drifted' : 'missing'
    const next = JSON.stringify({
      name: built.runbook.name,
      description: built.runbook.description,
      steps: built.steps.map(s => positions.get(s.id) ? { ...s, position: positions.get(s.id) } : s),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    }, null, 2)
    let diff: string | undefined
    if (state === 'drifted') diff = await diffOf(existingRaw ?? '', next)
    if ((want('workflow') || want(`workflow:${slug}`)) && state !== 'ok') { await writeFile(wfPath, next); state = 'ok'; diff = undefined; changed++ }
    workflows.push({ slug, name: built.runbook.name, state, steps: built.steps.length, ...(diff ? { diff } : {}) })
  }
  const wf = workflows[0] ?? { slug: RUNBOOK_SLUG, name: '', state: 'missing' as ItemState, steps: 0 }

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
  const shippedWatches = join(shippedDir(), 'registry', 'watches.yaml')
  const watchesYaml = (pluginWatches && existsSync(pluginWatches))
    ? pluginWatches
    : (existsSync(shippedWatches) ? shippedWatches : null)
  if (watchesYaml && existsSync(watchesYaml)) {
    let defined: any[] = []
    try { defined = parse(await readFile(watchesYaml, 'utf-8'))?.watches ?? [] } catch { defined = [] }
    const existing = await listWatches()
    const facts = (w: { query?: string, dailyDispatchCap?: number }) => `query: ${w.query ?? ''}\ndailyDispatchCap: ${w.dailyDispatchCap ?? ''}\n`
    for (const d of defined) {
      if (!d?.id || !d?.jql) continue
      const cur = existing.find(w => w.id === d.id)
      const cap = Number(d.daily_dispatch_cap) || 5
      const team = { query: String(d.jql).trim(), dailyDispatchCap: cap }
      let state: ItemState = !cur ? 'missing' : (cur.query === team.query && cur.dailyDispatchCap === cap) ? 'ok' : 'drifted'
      if (want(`watch:${d.id}`) && state !== 'ok') {
        const next: Watch = cur
          ? { ...cur, ...team }
          : { id: d.id, name: d.id, workflowSlug: RUNBOOK_FILES[String(d.workflow ?? '')] ?? RUNBOOK_SLUG, intervalSeconds: 300, enabled: false, maxConcurrentRuns: 1, autoRun: false, ...team }
        await saveWatch(next)
        state = 'ok'; changed++
      }
      watches.push({ id: d.id, ...(await item(state, cur ? facts(cur) : null, facts(team))) })
    }
  }

  const reg = await loadRegistry()
  const items = reg ? Object.entries(reg.products).map(([key, p]: [string, any]) => ({
    key,
    ...(p?.suite ? { suite: String(p.suite) } : {}),
    repos: Array.isArray(p?.repos) ? p.repos.map(String) : [],
    recipe: existsSync(join(reg.path, '..', '..', 'recipes', `${key}.md`)),
  })) : []

  // The boot log used to say "N declared skills do not resolve" and nothing
  // else did; the page is where a developer would look.
  const declared = new Set<string>()
  for (const t of agentTemplates.filter(t => t.id.startsWith('sdlc-'))) for (const s of (t.frontmatter as any).skills ?? []) declared.add(String(s))
  const unresolvedSkills = [...declared].filter(n => !existsSync(join(skillsDir, n))).sort()

  if (apply) {
    invalidate('agents'); invalidate('skills'); invalidate('commands'); invalidate('relationships')
    if (changed) {
      await writeFile(appliedPath(), JSON.stringify({ by, at: Date.now(), items: changed }))
      console.log(`[teamSync] ${by} applied ${changed} item(s)${only ? ` (${only.join(', ')})` : ''}`)
    }
  }
  const drifted = [...agents, ...skills, ...commands, ...watches, ...workflows].filter(i => i.state !== 'ok').length
  const shipped = await readJsonOr<{ version?: string }>(join(shippedDir(), '.claude-plugin', 'plugin.json'))
  return {
    pluginVersion: plugin?.version ?? null,
    pluginInstallPath: plugin?.installPath ?? null,
    shippedVersion: shipped?.version ? String(shipped.version) : null,
    sources: { skills: sourceOf(skillsSource), commands: sourceOf(commandsSource), watches: sourceOf(watchesYaml), registry: sourceOf(reg?.path ?? null) },
    agents, skills, commands,
    workflow: { slug: wf.slug, state: wf.state, steps: wf.steps, ...(wf.diff ? { diff: wf.diff } : {}) },
    workflows,
    watches,
    registry: { ok: !!reg, products: items.length, path: reg?.path ?? null, items },
    unresolvedSkills,
    enforcement: await enforcement(plugin),
    lastApplied: await readJsonOr<TeamStatus['lastApplied']>(appliedPath()),
    instance: {
      claudeDir: resolveClaudePath(), runsDir: agentRunsRoot(), workspaceRoot: workspaceRootFor(login),
      auth: authDisabled() ? 'disabled' : 'github', githubOrg: process.env.GITHUB_ORG || 'alepolab',
      jiraRead: hasJiraCredentialsConfigured(), jiraPost: isJiraPostingEnabled(), slack: !!process.env.SLACK_WEBHOOK_URL, ciPoller: process.env.CI_POLLER_DISABLED !== '1',
      budget: defaultBudget(),
    },
    drifted,
    reverted,
    checkedAt: Date.now(),
  }
}

export const teamStatus = (login?: string) => reconcile(false, { login })

// ponytail: one apply at a time, process-wide; watches.json is read-modify-write with no lock
let busy = false
export async function teamSync(by?: string, only?: string[]): Promise<TeamStatus> {
  if (busy) throw Object.assign(new Error('Another apply is in progress; try again in a moment'), { statusCode: 409 })
  busy = true
  try {
    return await reconcile(true, { by, only, login: by })
  } finally {
    busy = false
  }
}

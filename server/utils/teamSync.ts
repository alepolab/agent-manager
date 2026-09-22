import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, cp } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { parse } from 'yaml'
import { resolveClaudePath } from './claudeDir.ts'
import { parseFrontmatter } from './frontmatter.ts'
import { invalidate, memo } from './memo.ts'
import { loadRegistry } from './registry.ts'
import { listWatches, saveWatch } from './watchConfig.ts'
import { agentRunsRoot } from './runArtifacts.ts'
import { defaultBudget } from './workflowRunStore.ts'
import { hasJiraCredentialsConfigured, isJiraPostingEnabled } from './jiraCredentials.ts'
import { authDisabled } from './session.ts'
import { workspaceRootFor } from './workspace.ts'
import type { Watch } from '../../shared/types/watch.ts'
import { workflowTemplates, materializeTemplateSteps } from '../../app/utils/workflowTemplates.ts'

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

// No runbook workflows on this instance: the oh-my-agent estate ships markdown
// workflows, which this app's loader (which reads *.json step graphs) cannot
// run. Empty rather than a dangling id, so nothing seeds a watch pointing at a
// workflow that does not exist.
const RUNBOOK_SLUG = ''
const shippedDir = () => join(process.cwd(), 'engineering')

/**
 * The oh-my-agent SSOT. This instance seeds its whole estate from here —
 * agents, skills, and the workflows that oh-my-agent projects INTO a Claude
 * runtime as skills (verified against a real install: `oma link` writes
 * `.claude/skills/<name>/SKILL.md`, never a workflow file).
 */
const omaDir = (...parts: string[]) => join(process.cwd(), '.agents', ...parts)
const appliedPath = () => resolveClaudePath('.team-applied.json')

/**
 * The installed alepo-engineering plugin, or null when there is none.
 *
 * Exported because `promote` needs the same answer: a promotion is a PR into
 * the plugin, so on an instance with no plugin installed it changes the team
 * repo and nothing here. Saying so is the difference between an honest result
 * and a green link that does nothing where the operator is looking.
 */
export const PLUGIN_ID = 'alepo-engineering@alepo-engineering'

/** Where the install record lives; every reader of it goes through here. */
const installedPluginsPath = () => resolveClaudePath('plugins', 'installed_plugins.json')

export async function pluginInstall(): Promise<{ version: string, installPath: string, scope: string } | null> {
  const p = installedPluginsPath()
  if (!existsSync(p)) return null
  try {
    const data = JSON.parse(await readFile(p, 'utf-8'))
    const entry = data?.plugins?.[PLUGIN_ID]?.[0]
    return entry?.installPath ? { version: String(entry.version ?? ''), installPath: entry.installPath, scope: String(entry.scope ?? 'user') } : null
  } catch {
    return null
  }
}

/**
 * The plugins this image carries, and where each one lives in it.
 *
 * Only the shipped alepo-engineering plugin now. A third-party plugin was
 * fetched to /app/vendor for Runbook C's steps; that runbook and the agents
 * that ran it are gone, so nothing reads those skills.
 */
const shippedPlugins = (): { id: string, path: string, version: () => Promise<string> }[] => [
  {
    id: PLUGIN_ID,
    path: shippedDir(),
    version: async () => String((await readJsonOr<{ version?: string }>(join(shippedDir(), '.claude-plugin', 'plugin.json')))?.version ?? ''),
  },
]

/**
 * Record the copies baked into the image as the installs they already are.
 *
 * The Plugins page, its detail route and `sourceOf` below all read one file:
 * CLAUDE_DIR/plugins/installed_plugins.json. A team container installs no
 * plugin through the marketplace - there is no `claude` binary in the image
 * and /api/marketplace/sources/add shells out to one - so that file never
 * existed and the page was permanently empty, while both plugins' skills were
 * demonstrably on the instance and being read on every run. The page was right
 * about the record and wrong about the instance.
 *
 * Scope is 'shipped', not 'user', and the distinction is the honest part:
 * these update when the IMAGE is rebuilt, never when someone reinstalls a
 * plugin. `promoteToTeam` reads that field to decide whether merging a
 * promotion PR can change this box - see its note.
 *
 * Per id, not per file: an entry an operator already owns is left exactly as
 * it is, and one that is merely absent is added beside it.
 */
async function registerShippedPlugins(): Promise<void> {
  const p = installedPluginsPath()
  const current = (await readJsonOr<{ plugins: Record<string, unknown[]> }>(p)) ?? { plugins: {} }
  const now = new Date().toISOString()
  const added: { id: string, path: string }[] = []

  for (const { id, path, version } of shippedPlugins()) {
    if (current.plugins?.[id]) continue      // an install already owns this id
    if (!existsSync(path)) continue          // not in this image: nothing honest to record
    current.plugins = current.plugins ?? {}
    current.plugins[id] = [{ scope: 'shipped', installPath: path, version: await version(), installedAt: now, lastUpdated: now }]
    added.push({ id, path })
  }
  if (!added.length) return

  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, JSON.stringify(current, null, 2))

  // The page reads `enabled` from settings.json and defaults it to FALSE, so
  // recording the install alone would list a plugin as present and switched
  // off - the opposite of true, since these arm every run. Merge the flags in
  // rather than writing the file whole: settings.json also carries the
  // statusline and permission policy.
  const settingsPath = resolveClaudePath('settings.json')
  const settings = (await readJsonOr<Record<string, any>>(settingsPath)) ?? {}
  settings.enabledPlugins = { ...(settings.enabledPlugins ?? {}), ...Object.fromEntries(added.map(a => [a.id, true])) }
  await writeFile(settingsPath, JSON.stringify(settings, null, 2))
  console.log(`[teamSync] recorded ${added.length} shipped plugin(s): ${added.map(a => `${a.id} at ${a.path}`).join(', ')}`)
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
  // Before the record is read, not after: the boot that seeds the instance is
  // the boot that should show the plugin, not the one after it.
  if (apply) await registerShippedPlugins()
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
  // independently - but skills now come from the oh-my-agent SSOT in .agents/,
  // which ships with the application source and needs no fallback.
  const reverted: TeamStatus['reverted'] = []
  const skillsSource = existsSync(omaDir('skills')) ? omaDir('skills') : null

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

  // oh-my-agent workflows are projected INTO the runtime as skills.
  //
  // This is oma's own contract, not an invention here: `oma link` writes each
  // .agents/workflows/<name>.md to .claude/skills/<name>/SKILL.md, and leaves
  // any sibling resources/ directory behind. Verified against a real install.
  //
  // It matters because this app's workflow loader reads *.json step graphs
  // only, so a markdown workflow dropped in workflows/ is invisible. Seeding
  // them as skills is what makes them reachable at all.
  const workflowsSsot = omaDir('workflows')
  if (existsSync(workflowsSsot)) {
    for (const file of await readdir(workflowsSsot)) {
      if (!file.endsWith('.md')) continue
      const name = file.replace(/\.md$/, '')
      const next = await readFile(join(workflowsSsot, file), 'utf-8')
      const to = join(skillsDir, name, 'SKILL.md')
      const current = await readOr(to)
      let state = stateOf(current, next)
      const apply = want(`skill:${name}`)
      if (apply && state === 'drifted') reverted.push({ kind: 'skill', name })
      if (apply && state !== 'ok') {
        await rm(join(skillsDir, name), { recursive: true, force: true })
        await mkdir(join(skillsDir, name), { recursive: true })
        await writeFile(to, next)
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
  /**
   * Plugin agents, from the copy this image carries and from the recorded
   * install, in that order so a real install still wins.
   *
   * Reading only the recorded install meant an install that PREDATES the
   * image shipped less than the image contains, silently. On this box the
   * record is a user-scope install of alepo-engineering from 2026-09-07,
   * pinned to a git sha whose tree has no `agents/` directory at all — and
   * `registerShippedPlugins` leaves an id an operator already owns alone, by
   * design. So the six review personas in `engineering/agents/` reached no
   * instance, and nothing anywhere said why: the page listed the agents it
   * had and never mentioned the ones it was sitting on.
   *
   * The shipped copy is this repository's own plugin source, so having it
   * available is the same claim `registerShippedPlugins` already makes about
   * the image — "the copies baked into the image are the installs they
   * already are". An installed plugin still overrides it file by file.
   */
  const pluginAgents = new Map<string, string>()
  for (const base of [shippedDir(), plugin?.installPath]) {
    if (!base) continue
    const dir = join(base, 'agents')
    if (!existsSync(dir)) continue
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.md')) continue
      pluginAgents.set(name.replace(/\.md$/, ''), await readFile(join(dir, name), 'utf-8'))
    }
  }

  const agents: TeamStatus['agents'] = []
  // Agents are the oh-my-agent set, read from the SSOT rather than a template
  // array compiled into the app.
  const omaAgents = new Map<string, string>()
  if (existsSync(omaDir('agents'))) {
    for (const name of await readdir(omaDir('agents'))) {
      if (!name.endsWith('.md')) continue
      omaAgents.set(name.replace(/\.md$/, ''), await readFile(omaDir('agents', name), 'utf-8'))
    }
  }
  const shippedIds = new Set(omaAgents.keys())
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
  for (const [id, next] of omaAgents) {
    await seedAgent(id, pluginAgents.get(id) ?? next)
  }
  for (const [id, next] of pluginAgents) {
    if (!shippedIds.has(id)) await seedAgent(id, next)
  }

  const workflows: TeamStatus['workflows'] = []
  // Every shipped workflow is an app-defined template, seeded as
  // `<template id>.json` under the config dir's workflows/. There is no
  // separate id -> file-name map: the two were always equal, and the map being
  // empty is what stopped the templates seeding at all.
  for (const { id: templateId } of workflowTemplates) {
    const slug = templateId
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
  // Watches are not seeded on this instance.
  //
  // A watch exists only to dispatch a runbook: watchRunStarter resolves
  // `watch.workflowSlug` through findActiveRun() and loadWorkflow(). This
  // instance ships the oh-my-agent estate, whose workflows are markdown rather
  // than the *.json step graphs the loader runs, so there is no workflow for a
  // watch to dispatch into and every seeded row would resolve to nothing.
  // engineering/registry/watches.yaml still ships; nothing reads it here.
  const watches: TeamStatus['watches'] = []

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
  // Declared skills come from the oh-my-agent agents this instance seeds, read
  // from the SSOT rather than a template array. Parsed from frontmatter because
  // that is the only place an agent states what it declares.
  if (existsSync(omaDir('agents'))) {
    for (const name of await readdir(omaDir('agents'))) {
      if (!name.endsWith('.md')) continue
      const { frontmatter } = parseFrontmatter<{ skills?: string[] }>(await readFile(omaDir('agents', name), 'utf-8'))
      for (const skill of frontmatter.skills ?? []) declared.add(String(skill))
    }
  }
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
    sources: { skills: sourceOf(skillsSource), commands: sourceOf(commandsSource), watches: null, registry: sourceOf(reg?.path ?? null) },
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

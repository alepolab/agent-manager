/**
 * Gives back what a run took once it has an outcome: the compose stacks it
 * stood up and the git worktree it worked in.
 *
 * Nothing did this before. The provisioner's brief said "tear down what you
 * bring up", but its stack has to outlive it - the update and QA steps use it -
 * and no later step owned taking it down. A failed or stopped run never got
 * that far at all. Stacks held ports, container names and a subnet the next
 * run collided with, and worktrees piled up beside every clone.
 *
 * What it removes, and only that:
 * - compose projects named `sdlc-<run id>` (full or first eight characters),
 *   which is the name every step that stands something up is told to use. A
 *   shared stack (SSO, a product's own database) never carries that name, so
 *   it is never touched. A project comes down with its volumes (`down -v`)
 *   when its last live user lets go of it: the run's own, or one it took over
 *   from a run that has since ended. A project is never torn down twice, so
 *   the last user is the only one left to drop its volumes.
 * - the images the run built: tagged with its id, or labelled
 *   `agent-manager.run=<run id>` (every step's header asks for both). Removed
 *   with `docker rmi` and never forced, so the daemon refuses any image a
 *   container still uses. None is removed while another live run still uses
 *   one of the run's stacks; every later ending looks again (sweepEndedRunImages)
 *   and removes them once no live run does. None is removed that a live run at
 *   the same commit could deploy. Nothing removed images before this, and over
 *   three weeks the run images and volumes filled a 492 GB disk to 99%.
 * - build cache over RUN_BUILD_CACHE_MAX (40GB by default), least recently
 *   used first. Every ase-crm build adds to it and nothing took it back: it
 *   grew to 147 GB in the two days after it was last pruned by hand.
 * - the run's own worktree (`<clone>@<branch>`), and only if git agrees it is
 *   clean - an uncommitted change is kept and reported, never discarded. A
 *   fix branch is kept, since a pull request may be built on it; a scan's
 *   branch holds nothing and goes with its worktree. A failed run keeps its
 *   worktree: failing is where a run is restarted from, and the restart runs
 *   in that directory. It goes when the run ends any other way.
 *
 * Best effort and never thrown: a teardown that fails must not change how the
 * run ended. RUN_TEARDOWN_DISABLED=1 turns it off, to inspect a run's stack.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { createLogger } from './log.ts'
import type { WorkflowRun } from '../../shared/types/run'

/** A run in one of these no longer uses anything. Same list as the runner's. */
const TERMINAL_STATUSES: WorkflowRun['status'][] = ['completed', 'failed', 'stopped']

const log = createLogger('runner')
const execFileP = promisify(execFile)

export type Exec = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<string>
const realExec: Exec = async (cmd, args, opts) =>
  (await execFileP(cmd, args, { cwd: opts?.cwd, timeout: 180_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout

export interface TeardownReport {
  stacks: { project: string, removed: boolean, /** Its named volumes went with it: this run was its last user. */ volumes?: boolean, error?: string }[]
  worktree?: { path: string, removed: boolean, reason?: string }
  images?: ImageReport
  /** Images of other ended runs, kept at their endings because a live run used their stack, which none does now. */
  endedRunImages?: (ImageReport & { run: string })[]
  buildCache?: { max: string, reclaimed?: string, error?: string }
}

export interface ImageReport {
  removed: string[]
  /** The daemon refused: a container still uses it. */
  refused: { image: string, error: string }[]
  /** Set when none was touched, and why. */
  kept?: string
}

/** The label every image a run builds carries; its header asks for it. */
export const RUN_LABEL = 'agent-manager.run'

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

/**
 * Whether an image name (`repo:tag`) was named for this run: it carries the
 * run's full id, or its first eight characters standing alone. Never a name
 * that carries another run's full id, which starts with the same eight
 * characters when two ids share them, and never eight characters inside a
 * longer hex string such as a commit sha.
 */
export function imageNamedFor(runId: string, name: string): boolean {
  const id = runId.toLowerCase()
  const n = name.toLowerCase()
  const fullIds: string[] = n.match(UUID) ?? []
  if (fullIds.includes(id)) return true
  if (fullIds.length) return false
  return new RegExp(`(^|[^0-9a-f])${id.slice(0, 8)}([^0-9a-f]|$)`).test(n)
}

/** The compose project names that belong to this run and nothing else. */
export function runProjectNames(runId: string): string[] {
  const id = runId.toLowerCase()
  return [...new Set([`sdlc-${id}`, `sdlc-${id.slice(0, 8)}`])]
}

/** The compose project a run's stack steps use: the one it claimed, else its own. */
export const stackProjectOf = (run: Pick<WorkflowRun, 'id' | 'stackProject'>): string => run.stackProject ?? `sdlc-${run.id.toLowerCase()}`

type StackRun = Pick<WorkflowRun, 'id' | 'status' | 'stackProject' | 'product'> & Partial<Pick<WorkflowRun, 'projectDir'>>

/** A compose project named for a run. A shared stack never carries such a name. */
const RUN_PROJECT = /^sdlc-[0-9a-f-]+$/

/** The label a build of a commit carries, and what the image-reuse lookup matches (stackNote). */
const REVISION_LABEL = 'org.opencontainers.image.revision'

/** The live runs that use `project`: the run it was stood up for, and every run that claimed it. */
export function stackUsers(project: string, runs: StackRun[], except?: string): StackRun[] {
  return runs.filter(r => r.id !== except && !TERMINAL_STATUSES.includes(r.status)
    && (stackProjectOf(r) === project || runProjectNames(r.id).includes(project)))
}

/** How many free stacks claimableStack inspects for one already on the run's commit. */
export const PREFER_PROBES = 3

/**
 * An up stack of this run's product that it can take over rather than stand
 * up its own: one whose runs are all stopped on a person, or finished. Each
 * Runbook A run kept ~1 GiB of stack up at its gates, and a new run on the
 * same product stood up another beside them.
 *
 * Never one a run is working in right now: two runs deploying different
 * builds into one stack at the same time would each test the other's code.
 */
export async function claimableStack(
  run: Pick<WorkflowRun, 'id' | 'product'>, runs: StackRun[], exec: Exec = realExec,
  /** Among several free stacks, the first this accepts wins: one already running the run's own commit needs nothing deployed. */
  prefer?: (project: string) => Promise<boolean>,
): Promise<{ project: string, from: string } | null> {
  const product = run.product?.name
  if (!product) return null
  let listed: { Name?: string, Status?: string }[] = []
  try { listed = JSON.parse(await exec('docker', ['compose', 'ls', '--format', 'json']) || '[]') } catch { return null }
  const free: { project: string, from: string }[] = []
  for (const { Name: name, Status: status } of listed) {
    if (!name || !/^sdlc-[0-9a-f-]+$/.test(name) || name.endsWith('-verify') || !/running/i.test(status ?? '')) continue
    const owner = runs.find(r => runProjectNames(r.id).includes(name))
    if (!owner || owner.id === run.id || owner.product?.name !== product) continue
    if (stackUsers(name, runs, run.id).some(u => u.status === 'running')) continue
    if (!prefer) return { project: name, from: owner.id }
    free.push({ project: name, from: owner.id })
  }
  // Each probe is a docker inspect per container, under the claim lock every
  // other launch waits behind: three free stacks are enough to find one on the
  // run's commit, and the first free one serves when none is.
  for (const f of free.slice(0, PREFER_PROBES)) if (await prefer!(f.project).catch(() => false)) return f
  return free[0] ?? null
}

/** Whether a compose project has anything running. False when docker cannot be asked. */
export async function stackIsUp(project: string, exec: Exec = realExec): Promise<boolean> {
  try {
    const listed = JSON.parse(await exec('docker', ['compose', 'ls', '--format', 'json']) || '[]') as { Name?: string, Status?: string }[]
    return listed.some(p => p.Name === project && /running/i.test(p.Status ?? ''))
  } catch { return false }
}

/**
 * Whether another run is working in `project` right now. A run's recorded
 * stack stops being its own once another run takes it over at a gate: ASECRM-
 * 318 came back from its gate to the stack ASECRM-304 had taken, found it up,
 * and redeployed its own build into it by hand while 304 worked there.
 */
export function stackBusyElsewhere(project: string, runs: StackRun[], runId: string): boolean {
  return stackUsers(project, runs, runId).some(u => u.status === 'running')
}

/** Steps that work in the run's stack after the provisioner stood it up. */
export const STACK_USING_AGENTS = /^sdlc-(stack-update|qa-|trace-capture$|pr-follow-up$)/

/** Steps that can leave a compose stack running. A run with none of them has
 *  no stack to look for, which keeps docker out of every other run's ending. */
const STACK_AGENTS = /^sdlc-(stack-|verifier$|qa-|trace-capture$|scanner-ui$)/

/** Steps that build images: the stack steps, and every step that runs the
 *  product's tests or build in its own image. A run with none of them built
 *  nothing, and is not made to ask docker at its ending. */
const IMAGE_AGENTS = /^sdlc-(stack-|verifier$|qa-|trace-capture$|scanner-|test-author$|fix-implementer$|feature-(test-author|implementer)$|ce-(work|review)$|alepo-review$|pr-follow-up$|smoke-check$)/

/** Whether any of a run's steps builds images, so its ending or deletion has images to look for. */
export const runBuildsImages = (run: Pick<WorkflowRun, 'steps'>): boolean => run.steps.some(s => IMAGE_AGENTS.test(s.agentSlug))

export async function teardownRun(
  run: Pick<WorkflowRun, 'id' | 'branch' | 'projectDir' | 'steps' | 'stackProject'> & Partial<Pick<WorkflowRun, 'status' | 'stackClaimedFrom'>>,
  exec: Exec = realExec,
  /** Every run, to see who else uses a stack. Read from the store when not given. */
  runs?: StackRun[],
): Promise<TeardownReport> {
  const report: TeardownReport = { stacks: [] }
  if (process.env.RUN_TEARDOWN_DISABLED === '1') return report

  // ── stacks ──
  const mine = new Set([...runProjectNames(run.id), ...(run.stackProject ? [run.stackProject] : [])])
  let projects: string[] = []
  if (run.steps.some(s => STACK_AGENTS.test(s.agentSlug))) try {
    const listed = JSON.parse(await exec('docker', ['compose', 'ls', '-a', '--format', 'json']) || '[]') as { Name?: string }[]
    // Exact, or a suffix after the FULL id (`-verify`). Never a suffix after
    // the short form: `sdlc-<first 8>-` is the start of every full-id name,
    // including another run's that merely shares those eight characters.
    const full = `sdlc-${run.id.toLowerCase()}-`
    projects = listed.map(p => p.Name ?? '').filter(n => mine.has(n) || n.startsWith(full))
  } catch {
    // No docker, or no daemon: nothing this run can have stood up either.
  }
  // A stack another live run uses - the one that claimed it, or the run it was
  // claimed from - stays up: this run only lets go of it. The last user down
  // takes it down.
  let everyoneCache: StackRun[] | undefined = runs
  const everyone = async () => everyoneCache ??= (await import('./workflowRunStore.ts').then(m => m.listRuns())) ?? []
  for (const project of projects) {
    const users = stackUsers(project, await everyone(), run.id)
    if (users.length) {
      report.stacks.push({ project, removed: false, error: `kept: in use by run ${users.map(u => u.id.slice(0, 8)).join(', ')}` })
      continue
    }
    // Nobody else uses it, so this is the last down it will get: its volumes go
    // with it. That holds for one it took over too - the run it came from has
    // ended, and once the project is gone no later teardown can find them.
    // Only a project named for a run: a shared stack never is.
    const volumes = isOwnProject(run.id, project) || RUN_PROJECT.test(project)
    try {
      await exec('docker', ['compose', '-p', project, 'down', ...(volumes ? ['-v'] : []), '--remove-orphans'])
      report.stacks.push({ project, removed: true, volumes })
    } catch (err) {
      report.stacks.push({ project, removed: false, error: String(err instanceof Error ? err.message : err).slice(0, 300) })
    }
  }

  // ── the images it built ──
  if (runBuildsImages(run)) report.images = await removeRunImages(run, exec, await everyone())
  // Images an ended run kept at its ending, because a live run still used its
  // stack, are removed by nobody at that run's ending. Looking only at the run
  // this one took its stack from, and at runs that took this one's, missed
  // every run further along a hand-over chain - A's stack to B, then to C -
  // and 39 ended runs' images were still on disk two days after the fix that
  // was meant to remove them. Any ending looks at every ended run instead.
  if (runBuildsImages(run) || run.steps.some(s => STACK_AGENTS.test(s.agentSlug))) {
    const swept = await sweepEndedRunImages(run.id, exec, await everyone())
    if (swept.length) report.endedRunImages = swept
  }
  if (runBuildsImages(run)) report.buildCache = await capBuildCache(exec)

  // ── the run's own worktree ──
  // ASECRM-357: removed after its Verify step halted, `git worktree remove`
  // stopped part-way at files a container had written as another user. Half
  // the tree and git's record of it were gone, and the restart that would
  // have rerun the step was refused by a preflight that could not find a
  // repository there.
  if (run.status === 'failed' && ownsWorktree(run)) {
    report.worktree = { path: run.projectDir!, removed: false, reason: 'kept: a failed run is restarted from here' }
  } else {
    report.worktree = await removeRunWorktree(run, exec)
  }

  if (report.stacks.length || report.worktree || report.images || report.endedRunImages) log.info('run torn down', { runId: run.id, ...report })
  return report
}

/** A compose project stood up for this run, rather than taken over from another. */
function isOwnProject(runId: string, project: string): boolean {
  return runProjectNames(runId).includes(project) || project.startsWith(`sdlc-${runId.toLowerCase()}-`)
}

/**
 * Removes the images a run built: named for it (`imageNamedFor`) or labelled
 * `agent-manager.run=<run id>`. Never forced: the daemon refuses an image a
 * container still uses, and that refusal is reported, not thrown. An image
 * found by its label is checked for containers first and then loses every
 * tag, since its build was this run's. One found by name loses only that name.
 *
 * Touches nothing while another live run still uses one of this run's stacks:
 * its images may be what that stack runs, or what it rebuilds from. Never
 * throws; undefined when docker cannot be asked.
 */
export async function removeRunImages(
  run: Pick<WorkflowRun, 'id' | 'stackProject'>, exec: Exec = realExec, runs?: StackRun[],
): Promise<ImageReport | undefined> {
  if (process.env.RUN_TEARDOWN_DISABLED === '1') return undefined
  const everyone = runs ?? (await import('./workflowRunStore.ts').then(m => m.listRuns()).catch(() => [])) ?? []
  const projects = [...new Set([...runProjectNames(run.id), ...(run.stackProject ? [run.stackProject] : [])])]
  const users = [...new Set(projects.flatMap(p => stackUsers(p, everyone, run.id).map(u => u.id.slice(0, 8))))]
  if (users.length) return { removed: [], refused: [], kept: `kept: run ${users.join(', ')} still uses this run's stack` }

  let named: string[] = []
  let labelled: { id: string, names: string[] }[] = []
  try {
    named = (await exec('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}'])).split('\n')
      .map(s => s.trim()).filter(n => n && !n.includes('<none>') && imageNamedFor(run.id, n))
    const byId = new Map<string, string[]>()
    for (const line of (await exec('docker', ['images', '--filter', `label=${RUN_LABEL}=${run.id}`, '--format', '{{.ID}}\t{{.Repository}}:{{.Tag}}'])).split('\n')) {
      const [id, name] = line.trim().split('\t')
      if (!id) continue
      const names = byId.get(id) ?? []
      if (name && !name.includes('<none>')) names.push(name)
      byId.set(id, names)
    }
    labelled = [...byId].map(([id, names]) => ({ id, names }))
  } catch {
    return undefined
  }

  const report: ImageReport = { removed: [], refused: [] }
  if (!named.length && !labelled.length) return report
  // A live run deploys an image of its checkout's HEAD instead of building one
  // (stackNote's lookup by REVISION_LABEL), and that image may be this run's.
  // Removed between that run's lookup and its `compose up`, no container yet
  // holds it, so the daemon would not refuse. Keep any image built from a
  // commit a live run's checkout is on.
  const reusable = await reusableRevisions(run.id, everyone, exec)
  const revisionOf = async (image: string) => reusable.size
    ? (await exec('docker', ['image', 'inspect', '--format', `{{index .Config.Labels "${REVISION_LABEL}"}}`, image]).catch(() => '')).trim()
    : ''
  const keptForReuse = async (image: string) => {
    const rev = await revisionOf(image)
    if (!rev || !reusable.has(rev)) return false
    report.refused.push({ image, error: `kept: a live run's checkout is at ${rev.slice(0, 12)}, and may deploy it` })
    return true
  }
  const rmi = async (image: string) => {
    try {
      await exec('docker', ['rmi', image])
      report.removed.push(image)
    } catch (err) {
      report.refused.push({ image, error: String(err instanceof Error ? err.message : err).slice(0, 300) })
    }
  }
  const done = new Set<string>()
  for (const { id, names } of labelled) {
    // Untagging is allowed even when a container uses the image; only the last
    // removal is refused. Ask first, so an image a container runs keeps its names.
    const users = (await exec('docker', ['ps', '-aq', '--filter', `ancestor=${id}`]).catch(() => 'unknown')).trim()
    if (users) {
      report.refused.push({ image: names[0] ?? id, error: users === 'unknown' ? 'kept: could not check its containers' : 'kept: a container uses it' })
      names.forEach(n => done.add(n))
      continue
    }
    names.forEach(n => done.add(n))
    if (await keptForReuse(id)) continue
    for (const n of names.length ? names : [id]) await rmi(n)
  }
  for (const n of named) if (!done.has(n) && !(await keptForReuse(n))) await rmi(n)
  return report
}

/**
 * Removes the images of every ended run other than `endingId` that no live run
 * still needs, by way of removeRunImages, which keeps an image while a live run
 * uses that run's stacks. The ending run counts as ended: it lets go of its
 * stacks first. Asks docker for its images once, so only the ended runs that
 * still have one are looked at. Reports only those it removed or was refused.
 */
export async function sweepEndedRunImages(endingId: string, exec: Exec = realExec, runs: StackRun[] = []): Promise<(ImageReport & { run: string })[]> {
  const others = runs.filter(r => r.id !== endingId)
  const ended = others.filter(r => TERMINAL_STATUSES.includes(r.status))
  if (!ended.length) return []
  let names: string[] = []
  const labelledFor = new Set<string>()
  try {
    names = (await exec('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}'])).split('\n').map(s => s.trim()).filter(n => n && !n.includes('<none>'))
    const ids = [...new Set((await exec('docker', ['images', '--filter', `label=${RUN_LABEL}`, '--format', '{{.ID}}'])).split('\n').map(s => s.trim()).filter(Boolean))]
    if (ids.length) {
      for (const line of (await exec('docker', ['image', 'inspect', '--format', `{{index .Config.Labels "${RUN_LABEL}"}}`, ...ids])).split('\n')) {
        if (line.trim()) labelledFor.add(line.trim().toLowerCase())
      }
    }
  } catch {
    return []
  }
  const out: (ImageReport & { run: string })[] = []
  for (const r of ended) {
    if (!labelledFor.has(r.id.toLowerCase()) && !names.some(n => imageNamedFor(r.id, n))) continue
    const images = await removeRunImages(r, exec, others)
    if (images?.removed.length || images?.refused.length) out.push({ run: r.id, ...images })
  }
  return out
}

/**
 * Prunes the build cache down to RUN_BUILD_CACHE_MAX (default 40GB; 0 or off
 * turns it off), least recently used first. BuildKit never prunes what a build
 * in progress holds, so a run building at the same time keeps its layers.
 * Docker before 28 names the flag `--keep-storage`. Never throws.
 */
export async function capBuildCache(exec: Exec = realExec): Promise<TeardownReport['buildCache']> {
  const max = (process.env.RUN_BUILD_CACHE_MAX ?? '40GB').trim()
  if (!max || max === '0' || /^off$/i.test(max)) return undefined
  const prune = (flag: string) => exec('docker', ['builder', 'prune', '-f', flag, max])
  try {
    let out: string
    try {
      out = await prune('--max-used-space')
    } catch (err) {
      if (!/unknown flag/i.test(String(err instanceof Error ? err.message : err))) throw err
      out = await prune('--keep-storage')
    }
    const reclaimed = out.match(/Total:\s*(\S+)/)?.[1]
    return { max, ...(reclaimed ? { reclaimed } : {}) }
  } catch (err) {
    return { max, error: String(err instanceof Error ? err.message : err).slice(0, 300) }
  }
}

/**
 * The commits live runs' checkouts are on, other than this run's: what a live
 * run's image-reuse lookup can match. Empty when no other live run has a
 * checkout, so a teardown with nobody to protect asks git nothing.
 */
async function reusableRevisions(runId: string, runs: StackRun[], exec: Exec): Promise<Set<string>> {
  const heads = new Set<string>()
  for (const r of runs) {
    if (r.id === runId || TERMINAL_STATUSES.includes(r.status) || !r.projectDir || !existsSync(r.projectDir)) continue
    const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: r.projectDir }).catch(() => '')).trim()
    if (head) heads.add(head)
  }
  return heads
}

/** A run works in a worktree of its own: `<clone>@<branch>`, still on disk. */
function ownsWorktree(run: Pick<WorkflowRun, 'branch' | 'projectDir'>): boolean {
  return !!(run.branch && run.projectDir && /@[^/]+$/.test(run.projectDir) && existsSync(run.projectDir))
}

/**
 * Removes a run's own worktree, only if git agrees it is clean: an uncommitted
 * change is kept and reported, never discarded. A fix branch is kept, since a
 * pull request may be built on it; a scan's branch holds nothing and goes with
 * its worktree. Undefined when the run owns no worktree. Never throws.
 *
 * The ending's teardown uses it, and so does deleting a run: a failed run keeps
 * its worktree to be restarted from, and deleting it is the last chance to give
 * that checkout back.
 */
export async function removeRunWorktree(run: Pick<WorkflowRun, 'branch' | 'projectDir'>, exec: Exec = realExec): Promise<TeardownReport['worktree']> {
  if (!ownsWorktree(run)) return undefined
  const dir = run.projectDir!
  const clone = dir.replace(/@[^/]+$/, '')
  try {
    const dirty = (await exec('git', ['status', '--porcelain'], { cwd: dir })).trim()
    if (dirty) return { path: dir, removed: false, reason: `kept: ${dirty.split('\n').length} uncommitted change(s)` }
    await exec('git', ['worktree', 'remove', dir], { cwd: clone })
    if (run.branch!.startsWith('scan/')) await exec('git', ['branch', '-D', run.branch!], { cwd: clone }).catch(() => '')
    return { path: dir, removed: true }
  } catch (err) {
    return { path: dir, removed: false, reason: String(err instanceof Error ? err.message : err).slice(0, 300) }
  }
}

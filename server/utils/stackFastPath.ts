import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * Reusing a stack without a model call.
 *
 * 66 of 75 "Stand Up Stack" steps reused a stack - 58 of them one the runner
 * had already claimed for them - and still took 11.5 minutes on average: an
 * agent session reading meta.json, inspecting the checkout, probing health and
 * writing a report about a stack that was already up, healthy and running the
 * right code. When all of that is true and checkable, the runner checks it and
 * writes the report itself; the agent is for when something has to change.
 *
 * "The right code" is the image's own `org.opencontainers.image.revision`
 * label against the checkout's HEAD. CI's images carry it; a build an agent
 * made carries it once the agent labels it (see the provisioner's
 * build-once-per-commit rule), which is what lets the next run on the same
 * commit land here instead of building again.
 */

/**
 * Whether the fast path may take this visit of the provisioning step at all:
 * only its first, on a stack the runner claimed, in a fresh session. A
 * revisit means something downstream rejected this stack - QA's
 * `PIPELINE-REWORK: Stand Up Stack — the stack is not serving` arrives as the
 * revisit's input - and only the agent can act on that. Taken by the fast
 * path, the instruction was consumed, the step reported the stack fine, and
 * the run burned its send-backs on the same complaint.
 */
export function fastPathApplies(a: { agentSlug: string, visits: number, resume?: string, stackProject?: string, stackClaimedFrom?: string, projectDir?: string }): boolean {
  return a.agentSlug === 'sdlc-stack-provisioner' && a.visits <= 1 && !a.resume
    && !!a.stackProject && !!a.stackClaimedFrom && !!a.projectDir
}

export type Exec = (cmd: string, args: string[], cwd?: string) => Promise<string>
export const realExec: Exec = async (cmd, args, cwd) =>
  (await promisify(execFile)(cmd, args, { cwd, maxBuffer: 4 * 1024 * 1024, timeout: 30_000 })).stdout.trim()

export const REVISION_LABEL = 'org.opencontainers.image.revision'
const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project'

export interface StackContainer {
  name: string
  image: string
  /** docker's State.Status: running, exited, restarting, created... */
  state: string
  exitCode: number | null
  /** State.Health.Status, or null for a container with no healthcheck. */
  health: string | null
  revision: string | null
  /** The compose service it runs, so a stopped copy of a service that is running anyway can be told from a dead one. */
  service: string | null
}

/** Two commit ids name the same commit: one is a prefix of the other, and neither is too short to mean anything. */
export const sameCommit = (a?: string | null, b?: string | null): boolean =>
  !!a && !!b && Math.min(a.length, b.length) >= 7 && (a.startsWith(b) || b.startsWith(a))

export async function inspectStack(project: string, exec: Exec = realExec): Promise<StackContainer[]> {
  const names = (await exec('docker', ['ps', '-a', '--filter', `label=${COMPOSE_PROJECT_LABEL}=${project}`, '--format', '{{.Names}}'])).split('\n').filter(Boolean)
  const out: StackContainer[] = []
  for (const name of names) {
    const raw = JSON.parse(await exec('docker', ['inspect', '--format', '{{json .}}', name])) as {
      Config?: { Image?: string, Labels?: Record<string, string> }
      State?: { Status?: string, ExitCode?: number, Health?: { Status?: string } }

    }
    out.push({
      name,
      image: raw.Config?.Image ?? '',
      state: raw.State?.Status ?? 'unknown',
      exitCode: raw.State?.ExitCode ?? null,
      health: raw.State?.Health?.Status ?? null,
      revision: raw.Config?.Labels?.[REVISION_LABEL] || null,
      service: raw.Config?.Labels?.['com.docker.compose.service'] || null,
    })
  }
  return out
}

export type ReuseVerdict = { ok: true, app: StackContainer } | { ok: false, reason: string }

/**
 * Whether a stack can be reused exactly as it is, for a checkout at `head`.
 * Strict on purpose: anything short of "every container up, every healthcheck
 * green, and the app on this commit reporting healthy" goes to the agent,
 * which can fix what this can only notice.
 */
export function reuseVerdict(containers: StackContainer[], head: string | undefined): ReuseVerdict {
  if (!head) return { ok: false, reason: 'the checkout has no HEAD to compare with' }
  const running = containers.filter(c => c.state === 'running')
  if (!running.length) return { ok: false, reason: 'nothing in the stack is running' }
  // A stopped container whose service runs in another container is a copy an
  // agent kept to roll back to (`<app>-rollback-<run>`), not a dead service.
  const live = new Set(running.map(c => c.service).filter(Boolean))
  const bad = containers.find(c => c.state === 'restarting' || c.state === 'dead'
    || (c.state !== 'running' && c.exitCode !== 0 && !(c.service && live.has(c.service))))
  if (bad) return { ok: false, reason: `${bad.name} is ${bad.state}${bad.state === 'exited' ? ` with code ${bad.exitCode}` : ''}` }
  const unwell = running.find(c => c.health && c.health !== 'healthy')
  if (unwell) return { ok: false, reason: `${unwell.name} is ${unwell.health}` }
  const app = running.find(c => sameCommit(c.revision, head))
  if (!app) {
    const revs = [...new Set(running.map(c => c.revision?.slice(0, 9) ?? 'unlabelled'))].join(', ')
    return { ok: false, reason: `it runs ${revs}, not this checkout's ${head.slice(0, 9)}` }
  }
  // Running is not serving: the app has to say so through its own healthcheck.
  // One that declares none goes to the agent, which can make a request.
  if (app.health !== 'healthy') return { ok: false, reason: `${app.name} declares no healthcheck, so nothing here shows it is serving` }
  return { ok: true, app }
}

/** The stack shape meta.json needs, from the run that stood the stack up. Null when it did not record a usable one. */
export function inheritedStackMeta(sourceMeta: unknown): { profile: string, topology: string, liquibase_tag: string | null } | null {
  const s = (sourceMeta as { stack?: Record<string, unknown> } | null)?.stack
  if (!s || typeof s.profile !== 'string' || !s.profile || typeof s.topology !== 'string' || !s.topology) return null
  return { profile: s.profile, topology: s.topology, liquibase_tag: typeof s.liquibase_tag === 'string' ? s.liquibase_tag : null }
}

/**
 * Every locally present image built from `commit`, by its revision label. All
 * of them: one commit can build app, worker and migrator images, and naming
 * the first would tell the agent to deploy whichever docker listed first.
 */
export async function imagesForCommit(commit: string | undefined, exec: Exec = realExec): Promise<string[]> {
  if (!commit || commit.length < 40) return []
  try {
    const tags = (await exec('docker', ['images', '--filter', `label=${REVISION_LABEL}=${commit}`, '--format', '{{.Repository}}:{{.Tag}}'])).split('\n')
    return [...new Set(tags.filter(t => t && !t.includes('<none>')))]
  } catch { return [] }
}

export interface FastPathEvidence {
  project: string
  claimedFrom?: string
  checkout: { dir: string, branch?: string, head: string, remote: string, status: string }
  ps: string
  containers: StackContainer[]
  app: StackContainer
  stack: { profile: string, topology: string, liquibase_tag: string | null }
}

/** stack-report.md for a reused stack: the commands the runner ran and what they printed, nothing inferred. */
export function fastPathReport(e: FastPathEvidence): string {
  const rows = e.containers.map(c => `| \`${c.name}\` | ${c.state}${c.state === 'exited' ? ` (${c.exitCode})` : ''} | ${c.health ?? 'no healthcheck'} | \`${c.image}\` | ${c.revision ? `\`${c.revision.slice(0, 12)}\`` : 'unlabelled'} |`)
  return [
    '# Stack report',
    '',
    'Reused by the runner, without a model call: every container is running, every healthcheck reports healthy, and the app runs this checkout\'s commit and reports healthy itself, so there was nothing to stand up, build or deploy.',
    '',
    '## Checkout',
    '',
    `- \`${e.checkout.dir}\`${e.checkout.branch ? `, branch \`${e.checkout.branch}\`` : ''}`,
    '',
    '```',
    `$ git remote -v`,
    e.checkout.remote,
    `$ git rev-parse HEAD`,
    e.checkout.head,
    `$ git status --short`,
    e.checkout.status || '(clean)',
    '```',
    '',
    '## Stack',
    '',
    `Compose project \`${e.project}\`${e.claimedFrom ? `, taken over from run ${e.claimedFrom}, which stood it up for the same product` : ''}. Not brought down, not recreated, no second stack.`,
    '',
    '```',
    `$ docker ps -a --filter label=${COMPOSE_PROJECT_LABEL}=${e.project} --format '{{.Names}} {{.Status}}'`,
    e.ps,
    '```',
    '',
    '| Container | State | Health | Image | Revision |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    `\`${e.app.name}\` runs \`${e.app.image}\`, whose \`${REVISION_LABEL}\` is \`${e.app.revision}\`: the commit this checkout is at.`,
    '',
    `Health is Docker's own healthcheck for each service that declares one, as \`docker inspect\` reported it at ${new Date().toISOString()}; a service marked "no healthcheck" was checked only for running.`,
    '',
    `Not checked here: an authenticated request, and anything outside this compose project - a shared Keycloak/URM stack among them, which other products' stacks can change without touching this one.${e.claimedFrom ? ` Run ${e.claimedFrom} made the authenticated request when it stood the stack up.` : ''} A later step that finds the stack not serving sends the run back here, and that visit goes to the agent.`,
    '',
    '## Stack facts',
    '',
    `Profile \`${e.stack.profile}\`, topology \`${e.stack.topology}\`, Liquibase tag ${e.stack.liquibase_tag ? `\`${e.stack.liquibase_tag}\`` : 'none'} - as the run that stood it up recorded them.`,
    '',
    'Nothing was seeded. A later step that needs particular records seeds them itself.',
    '',
  ].join('\n')
}

export interface FastPathRun {
  project: string
  claimedFrom?: string
  projectDir: string
  branch?: string
  /** This run's artifacts directory: stack-report.md and meta.json are written here. */
  artifactsDir: string
  /** The artifacts directory of the run that stood the stack up, for its recorded stack facts. */
  sourceArtifactsDir?: string
}

export type FastPathResult =
  | { ok: true, output: string, report: string }
  | { ok: false, reason: string, /** Images already built from this checkout's commit, for the agent to deploy rather than build. */ images?: string[] }

/**
 * Reuses the claimed stack when reuseVerdict allows it: writes stack-report.md,
 * merges `stack` into meta.json, and returns the step's output. Otherwise says
 * why not, and names an image of this commit if one exists, so the agent that
 * takes over deploys it instead of building another.
 */
export async function tryStackFastPath(r: FastPathRun, fs: {
  readFile: (p: string) => Promise<string>
  writeFile: (p: string, s: string) => Promise<void>
}, exec: Exec = realExec): Promise<FastPathResult> {
  const head = await exec('git', ['rev-parse', 'HEAD'], r.projectDir).catch(() => '')
  const status = await exec('git', ['status', '--short'], r.projectDir).catch(() => '')
  // What runs is a build of HEAD; uncommitted changes are not in it.
  if (status) return { ok: false, reason: 'the checkout has uncommitted changes, so no running image is this checkout', images: await imagesForCommit(head, exec) }
  const containers = await inspectStack(r.project, exec).catch(() => [] as StackContainer[])
  const verdict = reuseVerdict(containers, head || undefined)
  if (!verdict.ok) return { ok: false, reason: verdict.reason, images: await imagesForCommit(head, exec) }
  const source = r.sourceArtifactsDir ? await fs.readFile(`${r.sourceArtifactsDir}/meta.json`).then(JSON.parse).catch(() => null) : null
  const stack = inheritedStackMeta(source)
  if (!stack) return { ok: false, reason: 'the run that stood the stack up recorded no stack profile and topology to carry over', images: [] }
  const meta = await fs.readFile(`${r.artifactsDir}/meta.json`).then(JSON.parse).catch(() => null) as Record<string, unknown> | null
  if (!meta) return { ok: false, reason: 'this run has no meta.json to merge the stack into', images: [] }

  const [remote, ps] = await Promise.all([
    exec('git', ['remote', '-v'], r.projectDir).catch(() => ''),
    exec('docker', ['ps', '-a', '--filter', `label=${COMPOSE_PROJECT_LABEL}=${r.project}`, '--format', '{{.Names}} {{.Status}}']).catch(() => ''),
  ])
  const report = fastPathReport({
    project: r.project, claimedFrom: r.claimedFrom,
    checkout: { dir: r.projectDir, branch: r.branch, head, remote, status },
    ps, containers, app: verdict.app, stack,
  })
  await fs.writeFile(`${r.artifactsDir}/stack-report.md`, report)
  await fs.writeFile(`${r.artifactsDir}/meta.json`, `${JSON.stringify({ ...meta, stack }, null, 2)}\n`)
  const output = [
    `Reused stack ${r.project}${r.claimedFrom ? ` (stood up by run ${r.claimedFrom})` : ''} without a model call:`,
    `every container is running, every healthcheck is green, and ${verdict.app.name} (healthy) runs ${verdict.app.revision?.slice(0, 12)}, this checkout's HEAD.`,
    'Not checked: an authenticated request, or anything outside this compose project.',
    `Wrote stack-report.md and merged stack ${JSON.stringify(stack)} into meta.json.`,
  ].join('\n')
  return { ok: true, output, report }
}

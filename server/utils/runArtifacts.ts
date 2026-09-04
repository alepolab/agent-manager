import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getClaudeDir } from './claudeDir.ts'
import { DEFAULT_MODEL_ALIAS } from './models.ts'
import type { WorkflowRun, RunStep } from '~~/shared/types/run'

/** Where a run's evidence lives. The assembler's --run-dir points here. */
export function runArtifactsDir(runId: string): string {
  return join(getClaudeDir(), 'workflow-runs', runId, 'artifacts')
}

/** Filenames come from agent slugs, which are user data. Keep them inert.
 *  Invalid characters (including path separators) become '-'; any run of 2+
 *  dots left behind — e.g. from "../.." once the slashes are gone — is
 *  collapsed too, so a traversal sequence can never survive reassembly. */
const safe = (s: string) =>
  s.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/\.{2,}/g, '-').replace(/^\.+/, '').slice(0, 60) || 'step'

/** Keys the RUNNER owns. An agent may write them; finalize overwrites them.
 *  Split out so there is exactly one list, used by both seed and finalize. */
function runnerOwned(run: WorkflowRun) {
  const ended = run.endedAt ?? Date.now()
  return {
    identity: run.workflowSlug,
    model: DEFAULT_MODEL_ALIAS,
    cost: {
      // The runner does not observe token usage. Zero is honest; a plausible
      // number would be a fabricated field in an evidence bundle.
      input_tokens: 0,
      output_tokens: 0,
      attempts: Math.max(1, ...run.steps.map(s => s.visits ?? 1)),
      wall_clock_min: Math.round((ended - run.startedAt) / 60000),
    },
  }
}

export async function initRunArtifacts(run: WorkflowRun, workflowName: string): Promise<void> {
  const dir = runArtifactsDir(run.id)
  await mkdir(join(dir, 'steps'), { recursive: true })
  await writeFile(join(dir, 'meta.json'),
    JSON.stringify({ ...runnerOwned(run), workflow: workflowName }, null, 2))
}

export async function writeStepArtifact(run: WorkflowRun, rec: RunStep, index: number): Promise<void> {
  const dir = join(runArtifactsDir(run.id), 'steps')
  await mkdir(dir, { recursive: true })
  const n = String(index + 1).padStart(2, '0')
  const name = `step-${n}-${safe(rec.agentSlug.replace(/^sdlc-/, ''))}.json`
  await writeFile(join(dir, name), JSON.stringify({
    stepId: rec.stepId,
    agentSlug: rec.agentSlug,
    label: rec.label,
    status: rec.status,
    error: rec.error ?? null,
    monitorVerdict: rec.monitorVerdict ?? null,
    startedAt: rec.startedAt ?? null,
    completedAt: rec.completedAt ?? null,
    input: rec.input ?? '',
    output: rec.output ?? '',
  }, null, 2))
}

/**
 * Re-assert the runner's facts over whatever the agents merged in, and
 * survive a meta.json an agent corrupted: the runner's own record is the
 * floor this whole design rests on, so it must not be lost to a bad write.
 */
export async function finalizeRunArtifacts(run: WorkflowRun): Promise<void> {
  const dir = runArtifactsDir(run.id)
  const path = join(dir, 'meta.json')
  let existing: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed
  } catch {
    /* absent or unparseable: rebuild from runner facts alone */
  }
  await mkdir(dir, { recursive: true })
  await writeFile(path, JSON.stringify({ ...existing, ...runnerOwned(run) }, null, 2))
}

/** Prepended to every step's input. The only channel an agent has for
 *  learning where to write, so it must be unmissable and literal. */
export function artifactHeader(dir: string): string {
  return [
    '## Run artifacts directory',
    '',
    `Write every artifact you produce into: ${dir}`,
    '',
    'This directory is the run\'s evidence. A file you do not write is evidence',
    'that does not exist — do not describe an artifact in prose instead of',
    'writing it, and never write a placeholder in place of a real result.',
    '',
    '---',
    '',
  ].join('\n')
}

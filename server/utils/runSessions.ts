import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { getClaudeDir, projectDirFor } from './claudeDir.ts'
import type { WorkflowRun } from '../../shared/types/run'

/**
 * Attaches Claude Code session ids to the steps of a run that predates the
 * runner recording them, from the transcripts on disk. A transcript's first
 * user message is the step's input verbatim, and the input names the run's
 * artifacts directory, so a match cannot cross runs. Parallel steps fed by
 * the same predecessor share an input, and a retried step leaves one
 * transcript per visit, so among the transcripts with a step's input the one
 * whose final assistant message is the step's recorded output wins, else the
 * newest. Steps that ran before the checkout existed live under the config
 * directory's own project folder, which is searched too. Returns true when a
 * step gained a session, so the caller knows to persist the record.
 */
export async function backfillSessions(run: WorkflowRun): Promise<boolean> {
  const missing = run.steps.filter(s => !s.sessionId && s.input)
  if (!missing.length) return false
  const encode = (dir: string) => dir.replace(/[^A-Za-z0-9]/g, '-')
  const projects = [...new Set([run.projectDir, getClaudeDir()].filter((d): d is string => !!d).map(encode))]

  type Candidate = { sessionId: string, project: string, path: string, mtime: number }
  const byInput = new Map<string, Candidate[]>()
  for (const project of projects) {
    const dir = projectDirFor(project)
    let files: string[]
    try { files = (await readdir(dir)).filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-')) } catch { continue }
    for (const file of files) {
      const path = join(dir, file)
      const [first, { mtimeMs }] = await Promise.all([transcriptText(path, 'first-user'), stat(path)])
      if (!first) continue
      const list = byInput.get(first) ?? []
      list.push({ sessionId: file.slice(0, -'.jsonl'.length), project, path, mtime: mtimeMs })
      byInput.set(first, list)
    }
  }

  let changed = false
  for (const step of missing) {
    const candidates = byInput.get(step.input.trim())
    if (!candidates?.length) continue
    let hit: Candidate | undefined
    if (candidates.length > 1 && step.output?.trim()) {
      for (const c of candidates) {
        const last = await transcriptText(c.path, 'last-assistant')
        if (last && step.output.trim().endsWith(last.slice(-400))) { hit = c; break }
      }
    }
    hit ??= candidates.reduce((a, b) => (b.mtime > a.mtime ? b : a))
    Object.assign(step, { sessionId: hit.sessionId, sessionProject: hit.project })
    changed = true
    void import('./claudeCodeHistory.ts').then(m => m.setSessionName(hit.sessionId, `${run.ticketKey ?? run.workflowSlug} · ${step.label} · run ${run.id.slice(0, 8)}`)).catch(() => {})
  }
  return changed
}

/** Text of a transcript's first user message, or of its last assistant message, read line by line. */
async function transcriptText(path: string, which: 'first-user' | 'last-assistant'): Promise<string | null> {
  const want = which === 'first-user' ? 'user' : 'assistant'
  const stream = createReadStream(path, { encoding: 'utf8' })
  const rl = createInterface({ input: stream })
  let found: string | null = null
  try {
    for await (const line of rl) {
      let entry: { type?: string, message?: { content?: unknown } }
      try { entry = JSON.parse(line) } catch { continue }
      if (entry.type !== want) continue
      const c = entry.message?.content
      const text = typeof c === 'string'
        ? c
        : Array.isArray(c) ? c.map(b => (b && typeof b === 'object' && (b as { type?: string }).type === 'text') ? (b as { text: string }).text : '').join('') : ''
      if (!text.trim()) continue
      found = text.trim()
      if (which === 'first-user') break
    }
    return found
  } finally {
    rl.close()
    stream.destroy() // readline.close() detaches; it does not release the descriptor
  }
}

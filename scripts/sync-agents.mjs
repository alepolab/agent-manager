#!/usr/bin/env node
/**
 * Write the `sdlc-*` agent templates and the Runbook A workflow out to
 * CLAUDE_DIR, so what runs on disk matches what the repo says.
 *
 *   node scripts/sync-agents.mjs [--dry-run]
 *
 * Why this exists: the agents under ~/.claude/agents are generated FROM
 * app/utils/templates.ts, but nothing kept them in step with it. A real run
 * against ticket DEVOPS-23 executed the pre-change generation of every prompt
 * — no artifact instructions, no halt instruction, no monitor on the workflow
 * — and would have produced no evidence bundle at all while looking like a
 * normal run. Editing a template is not the same as deploying it, and the gap
 * between the two is invisible unless something checks.
 *
 * --dry-run reports the drift without writing, which is the form worth putting
 * in CI: a template edited but never synced is a silent no-op.
 *
 * Only `sdlc-*` agents are touched. Everything else under ~/.claude/agents is
 * the user's own and is never overwritten.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const dryRun = process.argv.includes('--dry-run')
const claudeDir = process.env.CLAUDE_DIR || join(homedir(), '.claude')

const { agentTemplates } = await import('../app/utils/templates.ts')
const { workflowTemplates, materializeTemplateSteps } = await import('../app/utils/workflowTemplates.ts')
const { serializeFrontmatter } = await import('../server/utils/frontmatter.ts')

const sdlc = agentTemplates.filter(t => t.id.startsWith('sdlc-'))
if (!sdlc.length) {
  console.error('No sdlc-* agent templates found — refusing to write nothing over something.')
  process.exit(2)
}

mkdirSync(join(claudeDir, 'agents'), { recursive: true })
mkdirSync(join(claudeDir, 'workflows'), { recursive: true })

let drifted = 0

for (const t of sdlc) {
  const path = join(claudeDir, 'agents', `${t.id}.md`)
  const next = serializeFrontmatter(t.frontmatter, t.body)
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null
  if (current === next) { console.log(`  ok      ${t.id}`); continue }
  drifted++
  console.log(`  ${current === null ? 'missing' : 'drifted'} ${t.id}`)
  if (!dryRun) writeFileSync(path, next)
}

// The workflow's step ids are generated fresh each time, so it is never
// byte-identical and cannot be drift-compared the way the agents are. Report
// what it declares instead — the fields whose silent absence made the first
// real run meaningless.
const runbook = workflowTemplates.find(t => t.id === 'runbook-a-jira-to-diff')
if (!runbook) { console.error('Runbook A workflow template not found.'); process.exit(2) }
{
  const slugs = {}
  for (const s of runbook.steps) {
    slugs[s.agentTemplateId] = s.agentTemplateId
    if (s.monitorSlug) slugs[s.monitorSlug] = s.monitorSlug
  }
  const steps = materializeTemplateSteps(runbook, slugs)
  const wfPath = join(claudeDir, 'workflows', 'runbook-a-ticket-to-evidence-backed-pr.json')
  if (!dryRun) {
    writeFileSync(wfPath, JSON.stringify({
      name: runbook.name,
      description: runbook.description,
      steps,
      createdAt: new Date().toISOString(),
    }, null, 2))
  }
  console.log('\nworkflow steps:')
  for (const s of steps) {
    console.log(`  ${s.agentSlug.padEnd(26)} contextMode=${s.contextMode ?? '-'} monitor=${s.monitorSlug ?? '-'}`)
  }
}

if (dryRun && drifted) {
  console.error(`\n${drifted} agent(s) on disk differ from the templates. Run without --dry-run to sync.`)
  process.exit(1)
}
console.log(`\n${dryRun ? 'checked' : 'synced'} ${sdlc.length} agents in ${claudeDir}`)

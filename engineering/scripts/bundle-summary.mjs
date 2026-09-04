#!/usr/bin/env node
/**
 * Renders an evidence bundle down to the one-screen Markdown summary that
 * becomes the PR body — the first, and for most reviewers the only, thing
 * they read. Review capacity only rises if this reads faster than the diff
 * proves trust on its own; a summary a reviewer has to scroll is a summary
 * they skim, which is the exact failure mode the evidence bundle exists to
 * replace. So the layout is deliberately fixed at six rows, one per thing a
 * reviewer needs before opening the diff:
 *
 *   what was wrong · what changed · what proves it · blast radius ·
 *   deployment truths considered · cost
 *
 * A `trace: null` is rendered as an explicit "no browser evidence" line, not
 * left out. Omitting the row on null would make "no UI surface for this
 * change" look identical to "this section failed to render" — the one
 * failure mode a reviewer cannot tell apart from a bug by looking at the
 * summary, so it is spelled out instead.
 *
 * This function does not read bundle.summary_md, and assemble-bundle.mjs does
 * NOT call renderSummary(). The two are independent renderings of different
 * content: `summary.md` is the agent's own authored one-screen summary, and
 * the assembler carries it into `bundle.summary_md` verbatim — same as
 * intent.md/plan.md — precisely so assembly never depends on this script.
 * renderSummary() here instead builds the Markdown check-body from the
 * bundle's own structured fields, for whatever posts the PR check (see
 * docs/evidence-bundle.md).
 *
 *   node scripts/bundle-summary.mjs <bundle.json>   → Markdown on stdout
 *
 * No dependencies, same reasoning as validate-bundle.mjs.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const fmtInt = n => typeof n === 'number' ? n.toLocaleString('en-US') : String(n)

function renderWhatWasWrong(bundle) {
  const { ticket, work_type, class: bugClass, oracle } = bundle
  const kind = bugClass ? `${work_type}/${bugClass}` : work_type
  const oracleLine = oracle
    ? `reproduced by \`${oracle.path}\` (${oracle.kind}${oracle.rows ? `, ${oracle.rows} rows` : ''}) — ${oracle.runs} runs, verdict **${oracle.verdict}** before the fix`
    : 'no pre-fix oracle recorded'
  return `## What was wrong\n- **${ticket}** — ${kind}. ${oracleLine}.`
}

function renderWhatChanged(bundle) {
  const { fix } = bundle
  const repos = fix?.repos ?? []
  const header = `- ${repos.length} repo${repos.length === 1 ? '' : 's'}, ${fmtInt(fix?.files_changed)} files, ${fmtInt(fix?.lines_changed)} lines changed.`
  const repoLines = repos.map(r => `- \`${r.repo}\` @ ${r.commits.join(', ')} — ${r.pr}`)
  const mergeOrder = repos.length > 1
    ? [`- Merge order: ${(fix.merge_order ?? []).join(' → ') || '**not recorded**'}.`]
    : []
  const unlock = fix?.test_dirs_unlocked
    ? [`- Test directories unlocked: yes — ${fix.unlock_reason}.`]
    : []
  return ['## What changed', header, ...repoLines, ...mergeOrder, ...unlock].join('\n')
}

function renderTraceLine(trace) {
  if (trace === null || trace === undefined) {
    return '- Browser trace: **none** — recorded explicitly as no UI surface for this change, not a missing section.'
  }
  return `- Browser trace: \`${trace}\`.`
}

function renderAdversarialLine(adversarial, blastRadius) {
  if (adversarial === null || adversarial === undefined) {
    return `- Adversarial verification: **none** — not required for blast radius \`${blastRadius}\`.`
  }
  const parts = [`report \`${adversarial.report}\``]
  if (adversarial.two_node_rerun !== undefined) parts.push(`two-node rerun: ${adversarial.two_node_rerun ? 'yes' : 'no'}`)
  if (adversarial.pattern_search) parts.push(`pattern search: \`${adversarial.pattern_search}\``)
  if (adversarial.mutation_score !== null && adversarial.mutation_score !== undefined) parts.push(`mutation score: ${adversarial.mutation_score}`)
  return `- Adversarial verification: ${parts.join(', ')}.`
}

function renderWhatProvesIt(bundle) {
  const { oracle, oracle_after, regression, trace, adversarial, blast_radius } = bundle
  const oracleLine = oracle_after
    ? `- Oracle: ${oracle?.verdict ?? '?'} → **${oracle_after.verdict}** (same test, ${oracle_after.runs} runs, \`${oracle_after.path}\`).`
    : '- Oracle: no post-fix run recorded.'
  const regressionLine = regression
    ? `- Regression suite \`${regression.suite}\`: ${fmtInt(regression.passed)} passed, ${fmtInt(regression.failed)} failed.`
    : '- Regression: not recorded.'
  return [
    '## What proves it',
    oracleLine,
    regressionLine,
    renderTraceLine(trace),
    renderAdversarialLine(adversarial, blast_radius),
  ].join('\n')
}

function renderBlastRadius(bundle) {
  return `**Blast radius:** \`${bundle.blast_radius}\`   **Product:** ${bundle.product}`
}

function renderDeployment(bundle) {
  const { stack } = bundle
  const liquibase = stack?.liquibase_tag ?? 'n/a'
  return `## Deployment truths considered\n- Profile \`${stack?.profile}\`, topology \`${stack?.topology}\`, Liquibase tag: ${liquibase}.`
}

function renderCost(bundle) {
  const { cost } = bundle
  return `## Cost\n- ${fmtInt(cost?.input_tokens)} in / ${fmtInt(cost?.output_tokens)} out tokens, ${cost?.attempts} attempt${cost?.attempts === 1 ? '' : 's'}, ${cost?.wall_clock_min} min wall clock.`
}

/**
 * Render one evidence bundle to the one-screen Markdown summary. Pure
 * function of the bundle's structured fields — never reads bundle.summary_md
 * (this function is what produces it).
 */
export function renderSummary(bundle) {
  const title = `# ${bundle.ticket} — ${bundle.work_type}${bundle.class ? '/' + bundle.class : ''}`
  return [
    title,
    '',
    renderBlastRadius(bundle),
    '',
    renderWhatWasWrong(bundle),
    '',
    renderWhatChanged(bundle),
    '',
    renderWhatProvesIt(bundle),
    '',
    renderDeployment(bundle),
    '',
    renderCost(bundle),
  ].join('\n')
}

// ── CLI ──────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node scripts/bundle-summary.mjs <bundle.json>')
    process.exit(1)
  }
  let bundle
  try {
    bundle = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    console.error(`✗ could not read/parse ${file}: ${e.message}`)
    process.exit(1)
  }
  console.log(renderSummary(bundle))
}

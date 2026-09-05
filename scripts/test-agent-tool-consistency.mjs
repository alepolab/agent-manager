/**
 * Cross-references every `sdlc-*` agent template's prompt body
 * (app/utils/templates.ts) against its declared `frontmatter.tools`, so a
 * prompt can never again instruct a tool the agent does not have.
 *
 *   node scripts/test-agent-tool-consistency.mjs
 *
 * This closes a defect class that has shipped TWICE:
 *
 *   1. sdlc-ticket-intake, sdlc-stack-provisioner and sdlc-verifier were each
 *      instructed to write artifacts while `tools` omitted `Write`. Confirmed
 *      against the real SDK (scripts/test-agent-tool-policy.mjs, section 7):
 *      `tools` genuinely restricts what a query() call can do. Fixed since —
 *      this test is what stops it coming back.
 *   2. sdlc-ticket-intake was told to `run find ~/.claude/plugins ...` while
 *      its tools were `['Read','Grep','Glob','Write']` — no `Bash`. A real
 *      DEVOPS-15 run halted the pipeline at step 1 for 430 seconds because of
 *      it. Also fixed (it now uses a Glob) — kept here as a regression case,
 *      not work to redo.
 *
 * ## Detection approach
 *
 * A bare substring match is already known not to work: this repo shipped a
 * test (scripts/test-workflow-templates.mjs, section 9) that matched the
 * word `deployment` inside "Deployment truths" and mistook it for teaching an
 * enum value. "Write" and "read" are ordinary English words that show up in
 * prose having nothing to do with the Write/Read tools — so every signal
 * below requires more than a keyword hit before it counts as an instruction:
 *
 * 1. **Explicit self-reference.** The prompt names a Claude Code tool by its
 *    literal identifier, backticked, immediately followed by the word
 *    "tool" — e.g. "the `Glob` tool". Zero ambiguity: nothing else reads
 *    this way, so this signal has no realistic false-positive path. It also
 *    has essentially no reach beyond that one phrasing, which is fine — it
 *    exists as a tripwire for a future prompt that spells a tool out by name.
 *
 * 2. **A backtick-quoted shell command.** A backtick span — inline or the
 *    first line of a fenced block — whose content opens with a known CLI
 *    verb (`docker`, `git`, `find`, `gh`, `node`, `curl`, ...) followed by
 *    whitespace or the end of the span. The whitespace-or-end anchor is load
 *    bearing: it is what keeps this from matching a filename like
 *    `docker-compose.<product>.yml` (the character right after `docker`
 *    there is `-`, not whitespace). Verified empirically against every
 *    current sdlc-* body before this test was written: the only spans that
 *    match are genuine commands (`docker compose config`, `git diff --stat`,
 *    `gh pr create --body-file`, the fenced `node engineering/scripts/...`
 *    call), and every one of them already sits in an agent that declares
 *    `Bash`. Implies `Bash`.
 *
 * 3. **A write instruction with a concrete target**, checked at paragraph
 *    granularity. A write-verb (write/writes/writing/written, but not
 *    "write nothing" — trace-capture's honest no-op case) co-occurring, in
 *    the same paragraph, with either a backticked filename carrying a known
 *    artifact extension (.md/.json/.xml/.zip/...), the phrase "run
 *    artifacts directory", or the literal `meta.json`. Requiring both
 *    signals in the same paragraph is what rules out "You write the oracle"
 *    (sdlc-test-author — no filename anywhere near it) while still catching
 *    "write it to `trace.zip` in the run artifacts directory"
 *    (sdlc-trace-capture — the genuine mismatch this test found). Implies
 *    `Write`.
 *
 * ### What this deliberately leaves out, and why
 *
 * - **Grep vs. Glob vs. Bash for "search for".** All three tools can satisfy
 *   a search instruction — Bash via `grep`/`find`, Glob via a pattern, Grep
 *   directly — so "search for" names a *capability*, not one specific tool.
 *   A substring rule here would either force an arbitrary pick (false
 *   positives against agents doing it through Bash) or need enough
 *   special-casing per agent to stop being a general check. Every current
 *   sdlc-* agent that searches for anything already holds Bash, Grep or
 *   Glob, so this signal would add noise without ever finding a real gap —
 *   left out on purpose rather than shipped weak.
 * - **Bare "read" / "the file".** Every sdlc-* agent already declares
 *   `Read`, so this signal is permanently dormant against the real corpus,
 *   and "read" is common enough in ordinary prose ("read the ticket") that a
 *   bare match would be close to pure noise. Signal 1 still catches a future
 *   body that names "the `Read` tool" outright while `Read` is missing.
 * - **Edit** gets only signal 1 (self-reference) for the same reason: no
 *   current body instructs an edit in a way signal 3's machinery would need
 *   to special-case, and every agent that edits source already declares
 *   `Edit`.
 *
 * ### Honest limits
 *
 * Signal 2's CLI-verb list is closed — a shell command starting with a verb
 * not on it slips through as a false NEGATIVE. Signal 3's paragraph
 * granularity means a write instruction separated from its target filename
 * by a blank line would also be missed. Both are false negatives — the check
 * stays silent rather than blocking a merge — which is the direction this
 * task asks to err in (a false positive a human resolves beats a false
 * negative that ships). Nothing below is a bare keyword match, so anything
 * this test does report is a real, specific textual pattern worth a human's
 * attention, not noise.
 */
import assert from 'node:assert/strict'
import { agentTemplates as AGENT_TEMPLATES } from '../app/utils/templates.ts'

const TOOL_NAMES = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']

// Signal 1: "the `Glob` tool", "the `Write` tool", etc.
const SELF_REF_RE = new RegExp('`(' + TOOL_NAMES.join('|') + ')`\\s+tool\\b', 'g')

// Signal 2: a backtick span opening with a known shell verb, anchored so it
// cannot match a filename that merely starts with the same letters.
const SHELL_VERBS = [
  'docker', 'npm', 'npx', 'node', 'git', 'gh', 'curl', 'kubectl', 'helm',
  'terraform', 'find', 'grep', 'ls', 'cat', 'mv', 'cp', 'rm', 'mkdir',
  'sed', 'awk', 'python3', 'python', 'bash', 'sh', 'ansible', 'psql',
  'mysql', 'mongo', 'jq', 'wget', 'tar', 'chmod', 'ssh',
]
const SHELL_VERB_RE = new RegExp(`^(${SHELL_VERBS.join('|')})(?=\\s|$)`)

// Signal 3: a write-verb and a concrete artifact target, same paragraph.
// The negative lookahead excludes "write nothing" — an honest instruction
// NOT to write, which trace-capture's own body uses for its n/a branch.
const WRITE_VERB_RE = /\b(write|writes|writing|written)\b(?!\s+nothing)/i
const ARTIFACT_TARGET_RE = /`[^`]*\.(md|json|xml|zip|txt|csv|ya?ml)`|run artifacts directory|meta\.json/i

/** @returns {Map<string, string[]>} tool name -> excerpts of the instructions that require it */
function findRequiredTools(body) {
  const required = new Map()
  const add = (tool, evidence) => {
    if (!required.has(tool)) required.set(tool, [])
    required.get(tool).push(evidence)
  }

  for (const m of body.matchAll(SELF_REF_RE)) {
    add(m[1], `names "the \`${m[1]}\` tool" directly`)
  }

  const backtickSpans = [
    ...[...body.matchAll(/`([^`\n]+)`/g)].map(m => m[1]),
    ...[...body.matchAll(/```(?:\w*)\n([\s\S]*?)```/g)].map(m => m[1].split('\n')[0]),
  ]
  for (const span of backtickSpans) {
    if (SHELL_VERB_RE.test(span)) add('Bash', `runs \`${span.slice(0, 60)}\``)
  }

  for (const para of body.split(/\n\n+/)) {
    if (WRITE_VERB_RE.test(para) && ARTIFACT_TARGET_RE.test(para)) {
      add('Write', para.trim().slice(0, 100).replace(/\s+/g, ' '))
    }
  }

  return required
}

const sdlcTemplates = AGENT_TEMPLATES.filter(a => a.id.startsWith('sdlc-'))
assert.ok(sdlcTemplates.length >= 8, 'expected to find the sdlc-* agent templates in app/utils/templates.ts')

for (const template of sdlcTemplates) {
  const declared = template.frontmatter.tools
  // No `tools` array at all means the SDK's own full default toolset applies
  // (see scripts/test-agent-tool-policy.mjs, section 1-2) — every tool is
  // available, so there is nothing to cross-reference.
  if (declared === undefined) continue

  const required = findRequiredTools(template.body)
  for (const [tool, evidence] of required) {
    assert.ok(
      declared.includes(tool),
      `${template.id}'s prompt instructs the use of \`${tool}\`, but frontmatter.tools is ` +
      `[${declared.join(', ')}] — missing \`${tool}\`. Evidence: "${evidence[0]}"`,
    )
  }
}

console.log('agentToolConsistency: every sdlc-* prompt only instructs tools it actually declares')

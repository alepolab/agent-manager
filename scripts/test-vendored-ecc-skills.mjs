#!/usr/bin/env node
/**
 * 24 ECC skills (MIT, pinned) are vendored so the pipeline can match a skill to
 * the language a ticket actually touches.
 *
 * They are deliberately NOT declared in agent frontmatter.
 * `buildAgentSystemPrompt` inlines the full body of every declared skill, so
 * declaring all 24 measured at ~80,000 tokens added to every agent's prompt on
 * every step of every run — against ~7,000 today — most of it about languages
 * the ticket does not touch. Instead each code-touching agent carries a ~650
 * token catalogue and reads the matching skills from $SDLC_SKILLS_DIR.
 *
 * The pair most likely to drift is the catalogue in the prompts and the skills
 * on disk: a skill removed from disk leaves a catalogue row pointing at
 * nothing, and an agent following it reads a file that is not there. That is
 * the same silent-empty shape as every other failure this suite guards.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = p => readFileSync(join(root, p), 'utf8')
let failures = 0
const check = (name, ok, why) => {
  if (ok) return console.log(`  ok   ${name}`)
  failures++
  console.error(`  FAIL ${name}\n       ${why}`)
}

const templates = read('app/utils/templates.ts')
const caller = read('server/utils/agentCaller.ts')
const vendored = read('engineering/skills/VENDORED.md')
const skillsDir = join(root, 'engineering', 'skills')

// ── licence: the one MIT obligation ───────────────────────────────────────
check('the ECC licence travels with the copy',
  existsSync(join(skillsDir, 'ECC-LICENSE'))
  && /MIT License/.test(read('engineering/skills/ECC-LICENSE'))
  && /Affaan Mustafa/.test(read('engineering/skills/ECC-LICENSE')),
  'MIT permits everything we are doing on the single condition that the copyright and permission notice ship with the copy')

check('VENDORED.md records the pinned commit',
  /Pinned at `[0-9a-f]{40}`/.test(vendored),
  'a vendored copy with no recorded source commit cannot be refreshed or audited')

// ── the catalogue must match what is actually on disk ─────────────────────
const catalogue = [...templates.matchAll(/^\| \\`([a-z0-9-]+)\\`\s+\|/gm)].map(m => m[1])
check('the catalogue is non-empty',
  catalogue.length >= 20,
  'if this parses to nothing the checks below pass vacuously')

const missing = catalogue.filter(n => !existsSync(join(skillsDir, n, 'SKILL.md')))
check('every catalogue row exists on disk',
  missing.length === 0,
  `an agent told to read a skill that is not there reads nothing and says nothing: ${missing.join(', ')}`)

// The reverse: a shipped ECC skill no agent is told about is dead weight in the
// image. Derived from VENDORED.md's own list so the doc cannot drift either.
const listed = [...vendored.matchAll(/^- `([a-z0-9-]+)`$/gm)].map(m => m[1])
const unlisted = listed.filter(n => !catalogue.includes(n))
check('every vendored ECC skill appears in the catalogue',
  unlisted.length === 0,
  `shipped but unreachable, so it costs image size and buys nothing: ${unlisted.join(', ')}`)

// ── the path has to resolve from the agent's cwd ──────────────────────────
check('SDLC_SKILLS_DIR is absolute and handed to the agent',
  /export function sdlcSkillsDir\(\)/.test(caller)
  && /resolveClaudePath\('skills'\)/.test(caller)
  && /SDLC_SKILLS_DIR: sdlcSkillsDir\(\)/.test(caller),
  "the agent's cwd is the product checkout; a relative skills path resolves to nothing there — the same defect as the bundle assembler")

check('the catalogue names the variable, not a relative path',
  /\$SDLC_SKILLS_DIR\/<name>\/SKILL\.md/.test(templates),
  'a relative path in the prompt would send the agent looking inside the product repo')

// ── it must not become a second, competing rulebook ───────────────────────
check('the standing rules are declared to win',
  /where a\s*\n?language skill and this pipeline's standing rules disagree, the standing rules\s*\n?win/.test(templates),
  'a language skill that quietly relaxes the remote ban or the test-file lock would undo the guardrails the pipeline is built on')

check('the agent is told a non-match is a normal outcome',
  /If none matches, that is a normal outcome/.test(templates),
  'without this an agent reads a Java skill for a Go change — confident, detailed and wrong for the file in front of it')

// ── scope: only the agents that touch code ────────────────────────────────
for (const id of ['sdlc-stack-provisioner', 'sdlc-test-author', 'sdlc-fix-implementer', 'sdlc-verifier', 'sdlc-trace-capture', 'sdlc-security-review']) {
  const body = templates.slice(templates.indexOf(`id: '${id}'`), templates.indexOf(`id: '${id}'`) + 60000)
  const end = body.indexOf("id: 'sdlc-", 10)
  check(`${id} carries the catalogue`,
    /\$\{SDLC_LANGUAGE_SKILLS\}/.test(end > 0 ? body.slice(0, end) : body),
    'this agent reads or writes code, so a language-matched skill can change what it produces')
}
for (const id of ['sdlc-ticket-intake', 'sdlc-step-monitor', 'sdlc-evidence-and-pr']) {
  const i = templates.indexOf(`id: '${id}'`)
  const j = templates.indexOf("id: 'sdlc-", i + 10)
  check(`${id} does NOT carry it`,
    !/\$\{SDLC_LANGUAGE_SKILLS\}/.test(templates.slice(i, j > 0 ? j : undefined)),
    'this agent writes no code; the catalogue would be tokens spent on every run for nothing')
}

// ── the dropped four must stay dropped ────────────────────────────────────
for (const n of ['git-workflow', 'github-ops', 'security-scan', 'benchmark-methodology']) {
  check(`${n} is not shipped`,
    !existsSync(join(skillsDir, n)),
    'dropped deliberately — see VENDORED.md "Not taken, and why"; re-adding it silently reintroduces the collision')
}

check('the reasons for dropping are written down',
  /Not taken, and why/.test(vendored) && /rebase-merge/.test(vendored),
  'the next person to look at ECC will re-evaluate the same four skills unless the reasoning survives')

console.log(failures === 0 ? '\nvendored ECC skills: all checks passed' : `\nvendored ECC skills: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)

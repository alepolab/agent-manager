# Vendored skills

Skills in this directory that were not written here, why they are copied in
rather than depended on, and how to refresh them.

`scripts/sync-agents.mjs` seeds everything under `engineering/skills/` into
`CLAUDE_DIR/skills/`, which is the FIRST path `resolveSkill` checks. That
matters: the plugin path reads `installed_plugins.json`, and a skill shipped
in a plugin cache but not indexed there resolves to nothing.
`buildAgentSystemPrompt` swallows a per-skill resolution failure by design, so
one typo cannot stop an agent - which means a declared-but-unresolvable skill
looks exactly like a working one. The agent simply runs without the
instructions it was supposed to have, and nothing anywhere says so.
`scripts/test-agent-skills.mjs` exists to catch precisely that.

Vendoring removes the failure mode by construction: installing this product
installs its skills, with no separate marketplace step to forget.

## ponytail

- Source: https://github.com/DietrichGebert/ponytail
- Revision: `974d940`
- Licence: MIT (c) 2026 DietrichGebert - full text in `PONYTAIL-LICENSE`
- Skills: ponytail, ponytail-audit, ponytail-debt, ponytail-gain,
  ponytail-help, ponytail-review

Copied verbatim, unmodified. To refresh, re-copy `skills/*/SKILL.md` from
upstream and update the revision above. Do not edit these files in place: a
local edit is invisible at the next refresh and will be silently reverted.

## Not vendored, and why

`using-superpowers`, `systematic-debugging`, `using-git-worktrees`,
`test-driven-development`, `verification-before-completion` and
`requesting-code-review` come from the official `superpowers` plugin. They are
declared by agents but deliberately NOT copied here - they are actively
maintained upstream, and a stale vendored fork of a process skill is worse than
a missing one, because it keeps working while quietly diverging.
`scripts/test-agent-skills.mjs` fails loudly if any of them stops resolving,
which is the honest signal that the plugin needs installing.

## superpowers

- Source: the `superpowers` plugin, `claude-plugins-official` marketplace, v6.3.0
- Licence: MIT (c) 2025 Jesse Vincent — full text in `SUPERPOWERS-LICENSE`
- Skills: using-superpowers, using-git-worktrees, test-driven-development,
  verification-before-completion, requesting-code-review, systematic-debugging,
  finishing-a-development-branch (plus `agent-browser`)

Copied verbatim, whole directories including supporting files — several skills
point at siblings (`systematic-debugging` has ten, `requesting-code-review` has
`code-reviewer.md`), and seeding only `SKILL.md` produces a skill that resolves
and then refers the agent to files that are not there.

**This reverses the "not vendored" decision recorded below, and the reason it
was wrong is worth keeping.** The argument — that these are maintained upstream
and a stale fork is worse than a missing one — holds on a developer machine
where the plugin is installed. It does not hold in a container, which installs
no plugins at all: a team instance booted with eight of its twelve declared
skills simply absent, and because `buildAgentSystemPrompt` swallows a per-skill
resolution failure by design, every agent ran without those instructions while
reporting itself healthy. A stale skill is a worse skill; a missing one is no
skill, and nothing says so.

Refresh by re-copying from the plugin cache and updating the version above.

## claude-security — deliberately NOT vendored

`claude-security` is licensed "Copyright (c) 2026 Anthropic, PBC. All rights
reserved." That is not a redistribution licence, so it cannot be copied into
this repo the way the MIT-licensed skills above can. `sdlc-security-review`
therefore does not declare it: declaring a skill a container can never resolve
is exactly the silent failure this file exists to prevent. Install the plugin
on a machine licensed for it and add the declaration there.

## superpowers — the rest of the set

- Source: the `superpowers` plugin, claude-plugins-official
- Revision: 6.3.0
- Licence: MIT (c) 2025 Jesse Vincent — full text in `SUPERPOWERS-LICENSE`
- Skills added: brainstorming, dispatching-parallel-agents, executing-plans,
  receiving-code-review, subagent-driven-development, writing-plans,
  writing-skills

The seven that were not vendored with the first seven. No agent declares them
today; they are here so one *can*, and so a developer working in a container
has them. A skill an agent declares but the image does not ship resolves to
nothing, silently — which is the failure this repo has now hit three times.

## frontend-design

- Source: the `frontend-design` plugin, claude-plugins-official
- Revision: 85cce0381e78
- Licence: Apache 2.0 — full text in `FRONTEND-DESIGN-LICENSE`
- Skills: frontend-design

## Not vendored: amplitude and ui5-modernization

Both plugins ship 36 and 19 skills respectively, and **neither carries a
licence** — no LICENSE, COPYING or NOTICE in the package, and none elsewhere in
it. With no licence, no permission to redistribute has been granted, and this
repository is public: committing them would publish them.

That is the whole reason they are absent. Using them locally is what installing
the plugin is for; republishing is a different act. If they are ever wanted
here, the routes are to make this repository private first, or to ask whoever
publishes those plugins to add a licence.

One thing found while evaluating them, worth reporting upstream: amplitude's
`analyze-experiment/` directory declares `name: analyze-experiments`. Claude
Code resolves a skill by DIRECTORY and anything reading frontmatter resolves it
by NAME, so it exists under two strings and one of them always misses.
`engineering/scripts/test-skills.mjs` catches exactly this.

## ECC

`ECC-LICENSE` · MIT, © 2026 Affaan Mustafa · https://github.com/affaan-m/ECC
Pinned at `e04ea0b9cc8248686edf5ac751cadff550e162b8` (v2.2.1).

24 of ECC's 286 skills, copied verbatim. They are the ones that match
a language or technology this estate actually runs:

- `api-design`
- `architecture-decision-records`
- `cpp-testing`
- `docker-patterns`
- `e2e-testing`
- `fastapi-patterns`
- `golang-testing`
- `java-coding-standards`
- `kubernetes-patterns`
- `mysql-patterns`
- `python-patterns`
- `python-testing`
- `react-patterns`
- `react-performance`
- `react-testing`
- `redis-patterns`
- `security-review`
- `springboot-patterns`
- `springboot-security`
- `springboot-tdd`
- `springboot-verification`
- `tdd-workflow`
- `ui-to-vue`
- `vue-patterns`

MIT requires the copyright and permission notice travel with the copy; that is
what `ECC-LICENSE` is for. ECC vendors no third-party content of its own - one
LICENSE file across 3,520 files, and no embedded notices in anything taken here.

### Not taken, and why

Four candidates were dropped after reading them rather than their names:

- `git-workflow` teaches merge-versus-rebase. This estate forbids rebase-merge
  outright, and a skill arguing the other way inside an agent that must not
  touch a remote is a contradiction waiting to surface mid-run.
- `github-ops` automates PRs, releases and CI through the `gh` CLI - the same
  collision, more directly.
- `security-scan` audits a `.claude/` directory with AgentShield, a third-party
  tool. It is Claude Code configuration hygiene, not application security, and
  the name suggests otherwise.
- `benchmark-methodology` scores competitors on positioning and pricing. It is
  marketing benchmarking, not performance benchmarking, and it depends on a
  skill we do not ship.

The remaining ~245 are for stacks we do not run, or are crypto, trading and
marketing skills with no bearing here.

### These are NOT declared in agent frontmatter

`buildAgentSystemPrompt` inlines the full body of every declared skill.
Declaring all 24 would add roughly 80,000 tokens to every agent's prompt
on every step of every run - against a prompt that is about 7,000 today - and
most of it would concern languages the ticket does not touch.

Instead each code-touching agent carries a catalogue: one line per skill saying
when it applies, about 650 tokens, and an instruction to read the matching ones
from `$SDLC_SKILLS_DIR` at run time. `SDLC_SKILLS_DIR` is set in
`server/utils/agentCaller.ts` and is absolute, because the agent's cwd is the
product checkout where nothing of ours exists.

### Refreshing

Re-clone at a new tag, copy the same 24 directories, update the SHA above, and
re-run `node scripts/test-vendored-ecc-skills.mjs` - it checks the catalogue in
the agent prompts still matches what is on disk, which is the pair most likely
to drift apart.

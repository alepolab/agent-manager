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

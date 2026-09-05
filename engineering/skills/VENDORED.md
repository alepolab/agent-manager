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

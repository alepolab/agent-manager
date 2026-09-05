# Managed settings rollout (F2)

## The problem this solves

`engineering/` ships two `PreToolUse` hooks (the plan gate, the test lock)
registered in `hooks/hooks.json`. Today they only fire once a person runs:

```bash
claude plugin marketplace add /home/alepo/agent-manager/engineering
claude plugin install alepo-engineering@alepo-engineering
```

That is a manual, per-machine, per-engineer step, and it is fragile in a way
that is easy to miss: **this very machine had `alepo-engineering` installed
at some point and does not have it now.**
`~/.claude/plugins/cache/alepo-engineering/alepo-engineering/0.1.0/` still
holds the plugin's files, alongside an `.orphaned_at` marker
(`1788473168777`), but the plugin has no entry at all in
`~/.claude/plugins/installed_plugins.json`, and no `enabledPlugins` entry in
any settings file on the machine (`~/.claude/settings.json`,
`~/.claude/settings.local.json`). Someone installed it, and at some later
point it silently stopped being installed — nothing told anyone. That is
exactly the failure mode this task's brief describes for the test lock
itself: *"a control that appears configured and isn't."*

## What this installation actually supports (verified, not assumed)

Checked against the real files under `~/.claude/` on this machine and
against `code.claude.com/docs/en/settings` and
`code.claude.com/docs/en/managed-settings` (fetched during this task, not
recalled):

- **Settings precedence, highest to lowest:** managed settings → CLI
  `--settings` → project local (`.claude/settings.local.json`) → shared
  project (`.claude/settings.json`, committed) → user
  (`~/.claude/settings.json`). Note the shared project file — the one that
  ships with a `git clone` — sits **above** user settings, not below.
- **List-valued keys merge across files instead of one replacing another.**
  `hooks` and `permissions.allow` are both list-valued: a hook registered in
  a committed `.claude/settings.json` is *added* to whatever a user's own
  `~/.claude/settings.json` or an enabled plugin also registers, not
  replaced by it. This is the mechanism this rollout depends on.
- **True managed settings** (`managed-settings.json` in a system directory —
  `/etc/claude-code/managed-settings.json` on this Linux/WSL machine; MDM;
  or server-managed settings from the claude.ai admin console) sit above
  everything and cannot be overridden by a user's own files. Checked on this
  machine: `/etc/claude-code/managed-settings.json` does not exist, and
  `claude doctor` reports *"Managed settings (remote): not fetched —
  requires an Enterprise or Team subscription"* — server-managed settings
  are not even reachable on this account tier. Placing a system file there
  would require root and would apply to **every** Claude Code session on
  the machine, in every repo, not just the SDLC pipeline's target repos —
  a much wider blast radius than this task's two hooks, and a host change
  that needs sign-off before it happens, not something shipped silently by
  this task.
- **There is no managed setting that force-installs a plugin.**
  `enabledPlugins` (any scope, including managed) only toggles a plugin
  that is already present; `extraKnownMarketplaces` only registers where
  plugins may be added from. Neither auto-fetches plugin code onto a
  machine that never ran `claude plugin install`. So the managed tier
  cannot, by itself, close the "did anyone actually install it" gap this
  task is about — it can only make an *installed* plugin harder to disable,
  which is a different property.
- **`disableAllHooks: true`, set anywhere, silently defeats every hook below
  it** — including a fully and correctly wired plan gate. It is a real,
  honest gap in this rollout: a person's own `~/.claude/settings.json` can
  turn off both controls in one line, in every repo, and nothing here
  prevents that (nor should it — that key exists for the person's own
  machine). `scripts/verify-enforcement.mjs` checks for it explicitly and
  reports the source, precisely so this isn't a *silent* gap.

**Correction to the task's own framing:** the "managed/enterprise settings
that a user cannot override" tier is real, but it is not what actually
"ships with the repo" here, for two independent reasons — it needs
admin/MDM deployment this task cannot and should not perform unilaterally,
and it isn't reachable at all on this account tier. The mechanism that
genuinely ships with a `git clone` and needs zero enforcement infrastructure
is the **shared project settings file**, `.claude/settings.json`, committed
to the target repo — a real, lower, but still repo-scoped precedence tier,
not the org-wide managed tier the brief's language suggested.

## What's shipped

| Piece | Path | What it does |
|---|---|---|
| Template payload | `templates/settings.json` | The exact hook registrations (plan gate + test lock + arm), with an `__ENGINEERING_HOOKS_DIR__` placeholder |
| Installer | `scripts/install-repo-settings.mjs` | Writes/merges the template into a target repo's `.claude/settings.json`, resolving the placeholder to wherever this `engineering/` checkout actually lives. Idempotent (safe to run twice — a repeat run makes no changes); merges rather than clobbers an existing file; warns loudly if the target repo's own `.gitignore` would swallow the file |
| Verifier | `scripts/verify-enforcement.mjs` | "Is the plan gate actually armed here?" — see below |

### Rollout — where the file goes, what it overrides, what it doesn't

```bash
node /home/alepo/agent-manager/engineering/scripts/install-repo-settings.mjs \
  --repo /home/alepo/<target-repo>
```

This writes `<target-repo>/.claude/settings.json`, merging in the plan gate
(`PreToolUse`, matcher `Edit|Write`), the test lock (`PreToolUse`, matcher
`Edit|Write|Bash` — the `Bash` matcher is load-bearing, see `README.md`),
and the test-lock arm hook (`PostToolUse`, matcher `Edit|Write`). Any other
keys already in that file are left untouched. The installer then commits
nothing itself — commit the file:

```bash
git -C /home/alepo/<target-repo> add .claude/settings.json
git -C /home/alepo/<target-repo> commit -m "..."
```

**What it overrides:** nothing outside `hooks.PreToolUse`/`hooks.PostToolUse`
in that one repo. It does not touch permissions, models, MCP servers, or any
other repo's settings.

**What it deliberately does not do:**
- It does not install the `alepo-engineering` plugin, and does not need to —
  the hook commands run directly against this `engineering/` checkout's own
  `hooks/*.mjs` files, with no plugin runtime involved.
- It does not reach other machines. The path baked into the generated
  `.claude/settings.json` is this machine's absolute path to
  `engineering/hooks/`. On a different engineer's machine with a different
  checkout path, that path is wrong until they re-run the installer with
  `--engineering-root` pointed at their own checkout — a real, stated
  limitation, not a silently broken one: `verify-enforcement.mjs` reports
  "resolved path does not exist on disk" rather than pretending it's armed.
- It does not stop someone disabling it — see `disableAllHooks` above.
- It does not touch `agent-manager`'s own repo-root `.claude/` — that
  directory is gitignored in this repo on purpose (`.gitignore` line 23:
  bare `.claude`), most likely because this app *manages* a `~/.claude`-
  shaped directory as its own product surface and treats its own working
  `.claude/` as local scratch, not shipped config. This rollout targets the
  *other* repos this pipeline runs against (aaa_rhel8, pcrf_cpp14, ffm,
  pms, ...), which are separate git repositories outside this task's reach —
  `install-repo-settings.mjs` is therefore shipped as a tool a repo
  champion runs against their own checkout, never invoked here against a
  real product repo.

### Verifying enforcement on a machine

```bash
node /home/alepo/agent-manager/engineering/scripts/verify-enforcement.mjs --repo /home/alepo/<target-repo>
```

This is the check the task exists for: not "is the plugin listed
somewhere," but "does the plan gate actually deny an edit, right now, on
this machine." It:

1. Reads every settings source Claude Code would really merge for hooks —
   the managed-settings path for this OS, `~/.claude/settings.json`, the
   target repo's `.claude/settings.json` and `.claude/settings.local.json` —
   plus, if `alepo-engineering` is installed **and** its `enabledPlugins`
   entry resolves to `true` through the same precedence rules, that
   plugin's own `hooks/hooks.json`.
2. Resolves `${CLAUDE_PROJECT_DIR}` and `${CLAUDE_PLUGIN_ROOT}` the same way
   Claude Code does, and confirms the resolved file actually exists on
   disk — a stale path is reported as "does not exist," not skipped.
3. **Actually executes** the resolved `plan-gate.mjs`/`test-lock.mjs`/
   `test-lock-arm.mjs` commands against synthetic tool calls in a scratch
   directory and asserts the real exit code — deny (2) where a deny is
   expected, a written arming marker where an arm is expected. A
   registration that is present but wired to the wrong matcher, or that
   points at a file that no longer builds/parses, is caught here, not
   assumed correct because the JSON looked right.
4. Reports `disableAllHooks` if any source sets it, since that silently
   defeats a otherwise-perfect registration.

Exit 0 only if every piece is proven; exit 1 with the specific reason
otherwise. `--json` gives a machine-readable form for a pipeline step.

**This complements, and does not replace,** Claude Code's own `/status`
(interactive) and `claude doctor` — those report which settings *source*
was selected, not whether a specific hook fires. `claude doctor` was run
against this machine while building this task and confirmed it says
nothing about per-hook arming; see the command's actual output below.

```
$ claude doctor
...
Managed settings (remote): not fetched — requires an Enterprise or Team subscription
Organization policy: not applicable to Pro and Max accounts
...
No installation issues found.
```

### Two rollout paths, both real, neither perfect

| | Plugin install (existing) | Committed `.claude/settings.json` (this task) |
|---|---|---|
| Install step | `claude plugin marketplace add` + `install`, once per machine | `install-repo-settings.mjs`, once per repo, by whoever onboards it |
| Survives a fresh clone | No — proven by this machine's own orphaned state | Yes, once committed |
| Portable across machines | Yes — `${CLAUDE_PLUGIN_ROOT}` is resolved per-install | No — bakes in this machine's absolute path to `engineering/hooks/` |
| Can silently go stale | Yes (confirmed) | Only via `disableAllHooks` or deleting the committed file |

Neither is strictly better; ship both, and use `verify-enforcement.mjs` to
find out which (if either) is actually in force on a given machine, in a
given repo, right now.

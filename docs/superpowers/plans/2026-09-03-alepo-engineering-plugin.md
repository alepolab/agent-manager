# alepo-engineering Plugin Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `~/alepo-engineering` from a directory of good parts into an installable Claude Code plugin, so an engineer who clones a repo and does nothing still gets the plan gate, the test lock and the review policy.

**Architecture:** A plugin manifest and marketplace entry wrap the hooks and registry that already exist, plus the skills, workflows and templates the implementation plan's F1 names. Installation is the delivery mechanism — that is the whole point of Phase 0's "paved road": policy arrives *with the repo*, not with whoever remembered to configure it.

**Tech Stack:** Claude Code plugin format (`.claude-plugin/plugin.json`, `marketplace.json`), Markdown skills with YAML frontmatter, Node hooks. Repo: `/home/alepo/alepo-engineering` (**not** agent-manager).

**Spec:** the implementation-plan artifact's Phase 0 item **F1**, and its "Hooks shipped in the plugin" table. Companion: `/home/alepo/agent-manager/docs/superpowers/specs/2026-09-03-runbook-a-jira-to-diff-design.md` for what the pipeline agents expect.

## Global Constraints

- **All work is in `/home/alepo/alepo-engineering`**, a separate git repo. Do not touch `agent-manager`.
- **`~/alepo-engineering` currently has NO git remote.** It exists only on this machine. Do not assume `git push` works; if the plan needs a remote, stop and report rather than inventing one.
- Existing and not to be broken: `hooks/plan-gate.mjs`, `hooks/test-lock.mjs`, `registry/{watches,products}.yaml` + schemas, `scripts/validate-registry.mjs`, `scripts/test-validate-registry.mjs`, `scripts/test-hooks.mjs`, `schemas/evidence-bundle.v0.1.schema.json`. **Run `node scripts/test-hooks.mjs` and `node scripts/test-validate-registry.mjs` after every task** — they must stay green.
- Skill slugs are **bare**, never plugin-prefixed.
- Hooks must **fail open**: a broken hook must never wedge every session in the estate. The existing hooks do this; anything you add must too.
- No Node dependencies. These files are the trusted root of the pipeline; adding a package to them widens the trust boundary for no gain.

---

### Task 1: Plugin manifest and marketplace entry

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `.claude-plugin/marketplace.json`
- Create: `README.md`
- Test: `scripts/test-plugin-manifest.mjs`

**Interfaces:**
- Produces: an installable plugin named `alepo-engineering`, and a marketplace manifest listing it.

- [ ] **Step 1: Read the format from a plugin that is already installed**

Do not guess the schema. Read a real one:
```bash
cat ~/.claude/plugins/cache/claude-plugins-official/superpowers/*/.claude-plugin/plugin.json
cat ~/.claude/plugins/marketplaces/claude-plugins-official/.claude-plugin/marketplace.json | head -40
```
Match the fields those actually use. Report in your report which fields you found required versus optional.

- [ ] **Step 2: Write the failing test**

Create `scripts/test-plugin-manifest.mjs` asserting: both manifests parse as JSON; `plugin.json` has a `name` of `alepo-engineering` and a `version`; the marketplace lists that plugin; every path either manifest references exists on disk. That last assertion is the valuable one — a manifest pointing at a file that was renamed installs a plugin that silently does nothing.

- [ ] **Step 3: Run it and watch it fail**

- [ ] **Step 4: Write the manifests and a README**

The README states what the plugin gives you when installed: the plan gate, the test lock, the review template, the registry, and the evidence-bundle schema — plus the one-line install command.

- [ ] **Step 5: Run the test until it passes, plus the existing suites**

```bash
node scripts/test-plugin-manifest.mjs
node scripts/test-hooks.mjs
node scripts/test-validate-registry.mjs
```

- [ ] **Step 6: Commit**

---

### Task 2: Wire the hooks into the plugin's settings

**Files:**
- Create: `hooks/hooks.json` (or the location `plugin.json` declares)
- Modify: `.claude-plugin/plugin.json` if it must reference the hooks
- Test: extend `scripts/test-plugin-manifest.mjs`

**Interfaces:**
- Consumes: `hooks/plan-gate.mjs`, `hooks/test-lock.mjs`.
- Produces: hook registration that fires them on `PreToolUse` for `Edit|Write` (plan gate) and `Edit|Write|Bash` (test lock).

- [ ] **Step 1: Read how an installed plugin registers hooks**

```bash
grep -rl "PreToolUse" ~/.claude/plugins/cache/ | head -3
```
Read one and match its shape. Report what you found.

- [ ] **Step 2: Register both hooks**

The test lock **must** match `Bash` as well as `Edit|Write` — its whole purpose is closing the hole where an agent rewrites a test with `sed -i` instead of `Edit`. A registration that only matches `Edit|Write` reinstates the bypass the hook exists to close.

- [ ] **Step 3: Assert the registration in the test**

Extend `scripts/test-plugin-manifest.mjs`: the hook config parses, references files that exist, and the test-lock matcher includes `Bash`. Assert that last point explicitly — it is the one most likely to be silently dropped.

- [ ] **Step 4: Run all three suites**

- [ ] **Step 5: Commit**

---

### Task 3: The skills — regression matrix and intent

**Files:**
- Create: `skills/regression-matrix/SKILL.md`
- Create: `skills/intent-template/SKILL.md`
- Test: `scripts/test-skills.mjs`

**Interfaces:**
- Produces: skill slugs `regression-matrix` and `intent-template`.

- [ ] **Step 1: Write the failing test**

`scripts/test-skills.mjs`: every directory under `skills/` has a `SKILL.md`; each parses YAML frontmatter with `name` and `description`; `name` matches its directory. A skill whose `name` disagrees with its directory resolves inconsistently depending on the lookup path — worth an assertion.

- [ ] **Step 2: Write `regression-matrix` (action V6)**

Teaches writing a table-driven test from the **shape** of a bug rather than its reported example: name the dimension that varies, five or six rows minimum, and the rule that a single-row test lets a fix pass by special-casing the reported input. That is the failure mode the skill exists to prevent, so say it plainly.

- [ ] **Step 3: Write `intent-template` (action I2)**

The five questions Alepo tickets already answer well: problem, outcome, affected systems, constraints, open questions. Include the instruction that "not stated" is the correct answer for a missing field — inventing detail a ticket does not contain is the failure mode here.

- [ ] **Step 4: Run all suites**

- [ ] **Step 5: Commit**

---

### Task 4: The workflows and the REVIEW.md template

**Files:**
- Create: `commands/triage.md`, `commands/reproduce.md`, `commands/baseline.md`
- Create: `templates/REVIEW.md`
- Create: `templates/CLAUDE.md`
- Test: extend `scripts/test-skills.mjs` to cover commands and templates

**Interfaces:**
- Produces: `/triage`, `/reproduce`, `/baseline`; plus the two per-repo templates.

- [ ] **Step 1: Read the command format from an installed plugin**

```bash
find ~/.claude/plugins/cache -path "*commands*" -name "*.md" | head -3
```
Match the frontmatter those use (`name`, `description`, `argument-hint`, `allowed-tools`). Report what you found.

- [ ] **Step 2: `/triage`**

Classify a ticket's work type and, for bugs, its class; dedupe; state what is missing. **Read-only**: its `allowed-tools` must exclude `Write` and `Edit`. The triage identity is comment-only, and a workflow that can write contradicts that.

- [ ] **Step 3: `/reproduce` and `/baseline`**

`/reproduce` stands the product's stack up at the topology from the registry and runs the reported scenario. `/baseline` runs the product's ATDD subset for a feature or infra task instead. Both read `products.yaml` for the compose profile and test commands rather than hardcoding anything — that is what makes one loop serve every application.

- [ ] **Step 4: `templates/REVIEW.md`**

The passes a reviewer agent makes: bugs, security, compliance, spec conformance, **deployment truths**. What counts as important, what to skip, which paths are generated and excluded. Include the two-node AAA truth as the worked example of a deployment truth, since it is the one a reviewer caught that every automated gate missed.

- [ ] **Step 5: `templates/CLAUDE.md`**

The per-repo scaffold: what the repo is, its build and test commands, its branch policy, its deployment truths, and a pointer to its `REVIEW.md`.

- [ ] **Step 6: Run all suites, then verify the plugin actually installs**

```bash
claude plugin validate /home/alepo/alepo-engineering
```
Report the real output. If validation fails, that is a finding — fix the manifest, not the validator.

- [ ] **Step 7: Commit**

---

### Task 5: Install it and prove it enforces

**Files:** none. Verification only.

- [ ] **Step 1: Install from the local directory**

```bash
claude plugin marketplace add /home/alepo/alepo-engineering
claude plugin install alepo-engineering@alepo-engineering --scope user
```
Report actual output. If the marketplace command rejects a local path, report exactly what it wanted rather than working around it.

- [ ] **Step 2: Prove the plan gate fires**

In a scratch directory, run a session that tries to edit a source file with no `.agent/plan.md`. Expected: denied, with the message naming the required sections. **Observed, not assumed** — say exactly how you checked.

- [ ] **Step 3: Prove the test lock closes the Bash hole**

With the lock armed, attempt `sed -i` against a test file. Expected: denied. This is the assertion that matters most — an Edit-only lock is theatre when the agent has a shell.

- [ ] **Step 4: Confirm the hooks still fail open**

Feed a hook malformed input and confirm it exits 0. A hook that wedges every session in the estate is worse than no hook.

- [ ] **Step 5: Report** what enforced, what did not, and anything checked by reading rather than running.

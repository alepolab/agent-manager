---
name: defect-register-pr-opener
description: Stage 4 of the defect-register pipeline, last step for one group. Pushes the fixer's commit and opens one PR against develop with the exact defect-register PR description, then checks the base branch.
model: sonnet
color: green
tools:
  - Bash
  - Read
  - Write
---

You publish ONE fix as a pull request. You change no code.

## Inputs
`fix-report.md`, `repro.txt`, `unit-test.txt` and `verification.md` from the fixer (run artifacts directory, or `<stateDir>/fixes/<key>/`), and the group in this run's starting prompt. Parameters: `productRepo`, `productBase`, `stateDir`.

If `fix-report.md` says `stopped`, `already-fixed` or `moved`, do not push: write `pr.md` with that status and the reason, and finish.

## Do
1. Push the fix branch from its worktree. Use the token in `GH_TOKEN` (for git over https: `gh auth setup-git` in the worktree, or the equivalent credential helper). Never print it.
2. Open the PR with `gh pr create --repo <productRepo> --base <productBase> --head <branch>`. **No reviewers.** The body is EXACTLY the template below, filled from the fixer's evidence. **No "Generated with" footer.**
3. Check `gh pr view --json baseRefName,url` reports `baseRefName` = `<productBase>`. If not, fix the base with `gh pr edit --base`, and say so.

## PR description (exact format)
```
## What changes
<1–3 sentences: the behaviour before → after, and the files touched>

## Architecture
```mermaid
flowchart LR
  UI[frontend module] --> C[Controller] --> P[Processor chain] --> DB[(tables)]
  %% the real nodes on this path; the changed node is yellow, a new one green
  classDef changed fill:#fff3b0,stroke:#c9a400; classDef new fill:#c8f7c5,stroke:#2e8b57
```

## Why
Defect register ids: <ids>, area <area>. Legacy (Robot) expected: <expected>. ase-crm did: <actual>.
Root cause: <file:line, and why it was wrong>.

## Impact
- Playwright tests that now pass: <n> (<the spec paths / test titles>), including <k> knock-on.
- New or updated unit tests: <list>.
- Behaviour change visible to: <API clients / UI users / data>. Migration needed: <none / Liquibase …>.
- Risk and rollback: <revert one commit / flag>.

## Severity
| Register id | Defect | Root cause | Severity |
|---|---|---|---|
| … | … | … | High / Medium / Low |

## How verified
<the commands run and their results; the Playwright run summary>
```
Draw the Architecture diagram from the real path the fixer found, marking the changed node `changed` (and any new node `new`).

## Write (into the run artifacts directory AND `<stateDir>/fixes/<key>/`)
`pr.md`: status (`pr-open` / `stopped` / `already-fixed` / `moved`), PR URL, branch, `baseRefName` as checked, tests cleared.

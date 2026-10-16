# ase-crm Defect Register pipeline

Triages the ase-crm Defect Register against `develop` on a live stack, ranks
the fix groups, stops for a person to review the batch, then opens one PR per
root cause.

| Workflow | What it does |
|---|---|
| `defect-register-triage-and-first-batch` | ingest → triage each area → rank → plan the batch → **review gate** → fix each group → report |
| `defect-register-next-batch` | plan the next batch → **review gate** → fix each group → report |
| `defect-register-triage-area` | one area, started by the dispatcher in the first workflow |
| `defect-register-fix-group` | one group: fix and verify → open the PR |

All of them run in the `defect-register-stack` group (`maxConcurrent: 1`),
because they share one stack.

## Review gate

Triage gives each area a verdict. `moved` means the expected behaviour exists
elsewhere on `develop`. Every `fix` and `moved` verdict comes with
screenshots. The run pauses before "Fix each group" with `review.md` beside
it. The reviewer can:

- **Approve**: the batch is fixed.
- **Send back to "Plan the batch"** with a note, e.g. `drop G12 - moved to
  Customer > Billing tab`. Named groups become `rejected-by-reviewer` and
  are never offered again. A run allows two send-backs.

The fixer checks for a move once more before it writes code. If it finds one,
it stops as `moved` and no PR is opened.

## Install (on the agent-manager host)

```bash
sudo engineering/pipelines/defect-register/install.sh <developer-login>
```

The installer:

- copies the agents and workflows into the service's `CLAUDE_DIR`;
- merges the workflow group;
- installs Java 21, Node 22.20 with pnpm, and Playwright Chromium;
- adds the systemd drop-in that puts them on the service's PATH;
- restarts the service.

It is safe to run again. The register itself is uploaded in the run dialog.

## Stack

`stack/up.sh` brings up ase-crm from a `git archive` of `develop` (placed
beside it as `ase-crm-develop.tar.gz` with the commit in `COMMIT`). Ports:

| Service | Port |
|---|---|
| app | 18081 |
| Keycloak | 19091 |
| MariaDB | 13307 |
| billing | 18107 |
| S3 | 19000 |

These match the workflow defaults. The stack runs as an ordinary user with
Docker access. It shares the faketime clock file with the developer's run-as
user.

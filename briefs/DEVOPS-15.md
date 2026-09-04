Ticket DEVOPS-15 (project DEVOPS, type Task, priority Critical, status To Do).

Summary: Support running post-migrate script for Eswatini during alepo-dev-team-infra compose setup.

Context (verbatim from the ticket):
When installing the setup using the `alepo-dev-team-infra` Docker Compose stack, there is currently no supported way to run the post-migrate script for the Eswatini deployment as part of the installation flow.

Request:
Add support to execute the Eswatini post-migrate script when bringing up the setup via the `alepo-dev-team-infra` compose stack (e.g., as part of the bring-up sequence or a documented post-install step).

Acceptance criteria:
- Eswatini post-migrate script can be run as part of (or immediately after) the compose-based installation.
- Steps/automation documented in the repo (compose profile, init/one-shot service, or helper script).

From the ticket comments:
Eswatini CRM build: `ghcr.io/alepolab/alepo-crm:ESWATINI-develop-v14.0.1-rc.1`

CONTEXT AND CONSTRAINTS FOR THIS RUN — read carefully:

- The repository to change is `/home/alepo/alepo-dev-team-infra`, currently on branch `develop`. Work there, not in the agent-manager repo.
- Branch naming is enforced at push time. This is a Task, so use `feature/DEVOPS-15-<short-slug>`.
- **Read before you write.** A `crm-postmigrate` compose profile and `crm/scripts/postmigrate-verify.sh` already exist, and `setup/stacks/crm.sh`, `.env.example` and `README.md` all reference Eswatini or post-migrate already. This ticket is almost certainly an extension of existing support, not a green-field addition. Establish what already works before proposing anything, and say plainly in your report what was already there versus what you added.

- Classify this as `work_type: infra` (it changes how the system is deployed, not application behaviour). `class` is `null` — the class enum only applies to bugs. `blast_radius` is `deployment`.

- **The test framework is `bats`**, in `tests/` — there are 13 existing suites (`env_scoping.bats`, `sso_ha_overlay.bats`, `stack_detection.bats` and others) plus shell checks under `tests/compose/`. Follow that framework exactly; read a neighbouring test first. `bats` is not installed globally — run it as `npx --yes bats tests/<file>.bats` (verified working, Bats 1.13.0). Do not introduce a different framework and do not add a dependency to the repo.

- **The oracle for a Task is still test-first.** There is no bug to reproduce, so the pre-fix oracle is an acceptance test for the capability the ticket asks for: it must FAIL against the current repo (because the support does not exist yet, or is incomplete) and PASS after your change. If your test passes before you change anything, then either the capability already exists — which is a legitimate and valuable finding, report it and halt — or your test is asserting the wrong thing. Do not weaken the test to make it go red.

- `docker compose config` renders the merged compose file statically and deterministically, with no running stack. That is your evidence source for anything about profiles, services or mounts.

- **You cannot bring up the live stack.** It runs on host 172.16.115.61, to which this session has no shell access. If the stack-provisioning step cannot proceed, say so and halt rather than pretending. `docker compose config` is available locally and is the correct substitute for static claims.

- **DO NOT push any branch and DO NOT open a pull request.** Commit locally only. In place of opening a PR, write the PR body you would have submitted into the run artifacts directory as `pr-body.md`, and record the intended PR URL as null.

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

- The repository to change is `/home/alepo/alepo-dev-team-infra-devops15`, a fresh shallow clone at tag `compose-v1.23.0` (HEAD `7c2667f`), already on branch `feature/DEVOPS-15-eswatini-postmigrate` with a clean tree. Work there, not in the agent-manager repo and not in `/home/alepo/alepo-dev-team-infra` (a different, older checkout that is not part of this run).
- The branch already exists and is checked out. Do not create another one.
- **Read before you write.** A `crm-postmigrate` profile for SaskTel already exists in `docker-compose.crm.yml` (around line 457), together with `crm/scripts/postmigrate-verify.sh`. Measured at this tag: `grep -ci eswatini docker-compose.crm.yml` returns **0**, so the Eswatini support genuinely does not exist yet. Extend the established pattern rather than inventing a new one, and say plainly in your report what was already there versus what you added.

- Classify this as `work_type: infra` (it changes how the system is deployed, not application behaviour). `class` is `null` — the class enum only applies to bugs. `blast_radius` is `deployment`.

- **The test framework is `bats`**, in `tests/` — 12 suites at this tag, plus shell checks under `tests/compose/`. Follow it exactly and read a neighbouring suite first. `bats` is not installed globally — run it as `npx --yes bats tests/<file>.bats` (verified working, Bats 1.13.0). Do not introduce a different framework and do not add a dependency to the repo.

- **The house pattern for compose assertions is to pin the contract against the raw YAML**, not against a running stack. Read `tests/sso_ha_overlay.bats` before writing anything: it resolves `REPO_ROOT` from `$BATS_TEST_FILENAME`, then asserts with `grep -Fq` on the compose file directly. That needs no docker daemon, which is why those suites are fast and deterministic. `tests/compose/generate_test_env.sh` exists for the minority of checks that need a real `docker compose config` render. Follow the raw-YAML pattern unless you can say concretely why it cannot express your assertion.

- **The oracle for a Task is still test-first.** There is no bug to reproduce, so the pre-fix oracle is an acceptance test for the capability the ticket asks for: it must FAIL against the current repo (because the support does not exist yet, or is incomplete) and PASS after your change. If your test passes before you change anything, then either the capability already exists — which is a legitimate and valuable finding, report it and halt — or your test is asserting the wrong thing. Do not weaken the test to make it go red.

- `docker compose config` renders the merged compose file statically and deterministically, with no running stack. That is your evidence source for anything about profiles, services or mounts.

- **The stack step is a STATIC render, and it is deliberately small. Do not bring up any containers.**

  This ticket's acceptance criteria are that a profile exists and is documented. Both are settled by how compose *renders*, not by anything running, so a live stack would prove nothing the ticket asks for.

  Host `172.16.115.61` is reachable over SSH as `alepo` (key auth, no password) and carries real Docker 26.1.3 / Compose v2.27.0. A matching clone of this repo at the same tag is already checked out there at `~/alepo-dev-team-infra-devops15`. Render with:

      ssh alepo@172.16.115.61 'cd ~/alepo-dev-team-infra-devops15 && docker compose -f docker-compose.crm.yml --profile crm-postmigrate config'

  Record that output as your evidence and finish. **Do not run `up`, `down`, `pull`, `stop`, `rm`, or any command that starts, stops or removes a container, and do not edit files on that host.** That box runs ten containers belonging to other teams, including the shared `sso` stack (Keycloak + URM) that FFM, CRM, PCRF and VMS all depend on, and its disk is 92% full. Nothing this ticket needs requires touching any of them.

  If even the static render is unavailable, say so plainly and halt — do not substitute a claim you did not measure.

- **FOR THE FINAL STEP ONLY (evidence bundle + PR):** do not push any branch and do not open a pull request. Commit locally only; in place of opening a PR, write the PR body you would have submitted into the run artifacts directory as `pr-body.md`, and record the intended PR URL as null.

  Every other step: this constraint is not yours. Do your own step's work and nothing further. A brief describes the whole run, so it necessarily contains instructions addressed to stages other than the one reading it.

# RFC pack — template

The pack R&D hands GTAC for a customer deployment. GTAC deploys; R&D does not.
So this document is the whole of what the deploying engineer gets, and anything
not in it is not known at 02:00 on a change window.

Fill every `<…>`. A field you cannot fill honestly is **left blank with a
reason**, never guessed and never defaulted from the last release — a
placeholder wearing the shape of verified evidence is indistinguishable from
the truth to whoever reads it next.

Source of truth for this template is `engineering/templates/rfc-pack.md` in
`agent-manager`. Edit it there; a copy pasted into a ticket is a snapshot.

---

## 1. Header

| | |
|---|---|
| Release | `<portal-vX.Y.Z>` (+ `<agent-vX.Y.Z>` where the agent ships alongside) |
| Jira | `<release issue key>` · defects: `<keys>` |
| Labels | `<RELEASEddMMMyy / GENRELEASEddMMMyy>` on the RELEASE (Internal QA) issue; `<FIXddMMMyy>` on each fix |
| Customer / environment | `<customer>` · `<env name>` · `<node list>` |
| Image | `<ghcr.io/alepolab/…@sha256:…>` — digest, not a tag |
| Compose / stack version | `<alepo-dev-team-infra @ commit>` |
| Requested window | `<date, time, timezone>` |
| Prepared by | `<name>`, Release & DevOps · `<date>` |

**Freeze windows.** Name the customer's no-deploy windows explicitly and confirm
the requested window clears them. Known: SaskTel **no deploy 00:00–00:15 CST**.
`<others>`

## 2. What is in the build

One line per change, each with its Jira key and one sentence of operator-visible
effect. Not a commit log — a commit nobody can observe does not belong in a
change request, and a change an operator *can* observe must not be missing.

| Key | Change | Operator-visible effect |
|---|---|---|
| `<KEY>` | `<summary>` | `<what a support agent or subscriber would notice>` |

Anything **not** in the build that a reader might assume is: `<…>`

## 3. Impact matrix

| Component | Changed? | Restart needed | Downtime | Blast radius if wrong |
|---|---|---|---|---|
| `<EMS portal>` | `<yes/no>` | `<yes/no>` | `<seconds>` | `<…>` |
| `<PCRF engine nodes>` | | | | |
| `<Agent on each engine node>` | | | | |
| `<Database schema>` | `<changeset ids, or none>` | — | `<…>` | `<…>` |
| `<Keycloak / URM realm>` | | | | |
| `<Config / .env only>` | | | | |

Say plainly which rows are **env-only**: an env-only change needs no image
rebuild, no new tag and no data migration, which is what makes its rollback one
command. A schema change is the opposite and its rollback is a separate plan.

## 4. Preconditions

Each precondition is a **command with an expected result**, run on the target
before the change begins. A precondition an engineer has to interpret is not a
precondition.

### 4.1 Clock alignment — mandatory, every deployment

Several products compare a *naive* `DATETIME` column against a wall clock and do
not all read the same one. PCRF EMS is the worked example: `isExpired()` reads
the JVM clock while the query beside it reads the database's `CURRENT_TIMESTAMP`,
both against the same `EXPIRYDATE`, in the same release. Two clocks make one
stored value two instants. Direction decides the damage:

- **EMS west of the engine** — expires late, so a debit against an already
  lapsed credit source is **permitted**. Fail-open. This is PCRFV-1884's own
  failure mode.
- **EMS east of the engine** — expires early, so `409` on a source with time
  left. Fail-closed, visible, recoverable.

An EMS container with no `TZ` resolves to UTC, which is west of every engine east
of Greenwich — so the unset path is fail-open in our largest eastern markets.
This has shipped three times (PCRFV-1874, SBN-3787, PCRFV-1884) and was green in
CI each time.

Run:

```
node engineering/scripts/check-clock-alignment.mjs --stack <pcrf|aaa|ocs>
```

| exit | verdict | action |
|---|---|---|
| 0 | `ALIGNED` | paste the output below and proceed |
| 1 | `SKEWED` | **stop.** Name both zones, both offsets and the direction; EM signs off before the window opens |
| 1 | `MISCONFIGURED` | the clocks agree but a container ignores the `TZ` it was given (no tzdata in its image). Treat as not-aligned: one rebuild introduces a skew nobody configured |
| 2 | `UNKNOWN` | **not a pass.** A clock that could not be read is unknown. Start the stack and re-run |

Paste the verbatim output — it is written to be G4 evidence:

```
<CLOCKS: … block>
```

Where the script has no entry for this stack, read the three clocks by hand and
paste all four commands with their output:

```
docker exec <ems>    sh -c 'echo "TZ=$TZ"; date "+%Y-%m-%d %H:%M:%S %Z %z"'
docker exec <db>     mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" -N -B -e \
                       "SELECT @@global.time_zone, @@session.time_zone, NOW();"
docker exec <engine> sh -c 'echo "TZ=$TZ"; date "+%Y-%m-%d %H:%M:%S %Z %z"'
docker exec <ems>    sh -c 'echo "PCRF_SESSION_TIME_ZONE=$PCRF_SESSION_TIME_ZONE"'
```

Pass is all three wall clocks agreeing to within NTP tolerance **and** reporting
the same UTC offset. Engine nodes and the EMS host are separate machines with
separate `.env` files in production — `pcrf-server` is pinned to its own hosts by
a node-locked Padlock licence (SBN-3141) and the agent runs on each engine node —
so nothing cross-checks their `TZ` and this is measured per install, not ruled on
once.

Remediation is one variable, and it is why this is a precondition rather than a
blocker: `TZ=<operator service zone, IANA>` in the stack's `.env`, then
`docker compose --profile <stack> up -d`. No image rebuild, no new tag, no data
migration. **Not UTC** — `EXPIRYDATE` is an end-of-day value on both sides, so a
UTC writer breaks end-of-day semantics in every non-UTC market and reinterprets
every existing zoneless row with no migration path, which means no rollback.

### 4.2 Other preconditions

| # | Precondition | Command | Expected | Actual |
|---|---|---|---|---|
| 1 | Licence valid and not expiring inside the window | `<…>` | `<…>` | |
| 2 | Target image digest present on every node | `docker image inspect <digest>` | `<…>` | |
| 3 | Rollback tag present on every node | `docker image inspect <rollback digest>` | `<…>` | |
| 4 | Database backup taken and restorable | `<…>` | `<…>` | |
| 5 | Free disk / memory headroom | `<…>` | `<…>` | |
| 6 | Health endpoint green pre-change | `<…>` | `<…>` | |

## 5. Deployment — one node at a time

Never in parallel. Rolling one node at a time is what keeps the rollback cheap:
if node 1 misbehaves, nothing else has moved yet.

For each node, in order:

1. Drain / remove from the load balancer or peer list. `<command>`
2. Record the currently running digest — **this is the rollback tag**, read from
   the running container rather than from what a ticket says should be there.
   `docker inspect --format '{{.Image}}' <container>`
3. Pull the new digest and recreate. `<command>`
4. Smoke check this node before touching the next: `<command>` → `<expected>`
5. Re-clock: re-run §4.1 on this node. A recreate is exactly when a `TZ` changes.
6. Return to service. `<command>`
7. Only then: next node.

Stop the roll at the first node that fails a step and roll that node back. A
partially deployed stack is a supported state; a stack where two nodes failed
differently is not.

## 6. Rollback

**One command per node, stated before the window opens.** If it cannot be
written as one command, the change is not ready.

```
<the single command>
```

For an env-only change:

```
git checkout -- .env && docker compose --profile <stack> up -d
```

| | |
|---|---|
| Rollback digest, per node | `<node: digest>` |
| Data migration to reverse? | `<none / changeset ids + the reverse plan>` |
| Rollback tested where, when | `<environment, date>` — untested is not a rollback |
| Time to roll back, measured | `<minutes>` |
| Point of no return | `<the first irreversible step, or "none">` |

A schema change with no tested reverse path makes this an irreversible change;
say so here in those words rather than leaving the row blank.

## 7. Verification after the change

| # | Check | Command | Expected | Actual |
|---|---|---|---|---|
| 1 | Clock alignment re-run (§4.1) | `<…>` | `CLOCKS: ALIGNED` | |
| 2 | Health endpoints on every node | `<…>` | `<…>` | |
| 3 | The defect this release fixes, exercised | `<…>` | `<…>` | |
| 4 | One unrelated critical path, to catch collateral | `<…>` | `<…>` | |
| 5 | Error rate / log scan for `<window>` | `<…>` | `<…>` | |

Exercise the failure path too, not only the happy path — a swallowed error looks
identical to success in a screenshot.

## 8. Go / No-Go

Go/No-Go is not a Jira field today, so it is stated explicitly here and repeated
on the release issue.

| | |
|---|---|
| Open blockers | `<none / keys>` — a release candidate is never cut with an open blocker |
| Rollback tested | `<yes / no>` — never cut without one |
| Clock alignment | `<ALIGNED / SKEWED + EM sign-off>` |
| Regression register updated | `<yes>` — Confluence 796933029889 |
| Release Tracker row | `<yes>` — Confluence 796805922818 |
| Decision | **`<GO / NO-GO>`** · `<name>` · `<date, time>` |

## 9. Contacts during the window

| Role | Name | Reachable on |
|---|---|---|
| GTAC deploying engineer | `<…>` | `<…>` |
| R&D on call | `<…>` | `<…>` |
| Release & DevOps | `<…>` | `<…>` |
| Escalation | `<…>` | `<…>` |

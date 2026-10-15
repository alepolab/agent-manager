---
name: review
description: "Review an Alepo change before commit or pull request with a fresh-context reviewer: correctness against the ticket and plan, then a two-pass checklist for Spring/JPA, Liquibase/Flyway, MySQL/Oracle, Angular/Vue, C++ and security. Fixes mechanical findings, lists judgment calls for the person, drops anything below 80% confidence. Use after verify-done passes and before git commit."
---

# review

The author cannot review their own blind spots, so the review runs in a fresh subagent.

1. **Brief the reviewer.** Spawn a subagent with no conversation history. Give it: the Jira ticket, the
   plan (`.agent/plan.md` or the implementer's contract), the reproduction steps (bug) or the
   acceptance criteria (feature), the blast radius,
   [`references/checklist.md`](references/checklist.md), and the uncommitted change. Review runs before
   commit, so `git diff <base>...HEAD` would miss it. Give instead
   `git diff $(git merge-base origin/<base> HEAD)` (working tree against the merge base: staged and
   unstaged) plus the full contents of every new file from `git ls-files --others --exclude-standard`.
   Ask for findings only, each with `file:line`, the failure scenario, a confidence from 0 to 100, and
   a suggested fix.
2. **Filter.** Drop findings below 80 confidence and anything on the checklist's "do not flag" list.
   A finding about a repo rule must quote the rule from the repo's `CLAUDE.md` or `REVIEW.md`.
3. **Fix first.** Fix the mechanical findings (one obvious fix, under about 20 lines, no behaviour change
   outside the ticket) and re-run `developer-workflow:verify-done`. Everything else goes to the person
   as an `alepo-core:protocol` decision card carrying the reviewer's reasoning: security, concurrency,
   schema, removing behaviour, design. The session that owns the run asks it; run as a subagent, return
   the cards under `DECISION NEEDED` and stop.
4. **Always run** the security pass and, when the diff touches a migration or SQL, the data pass, however
   small the diff.

Finish with the `alepo-core:protocol` status: findings fixed, findings for the person, findings dropped
and why.

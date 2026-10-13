# Review checklist

## Pass 1 — critical (block the commit)

**Correctness against the ticket**
- Does the change fix the stated root cause, or only the reported example? Would a sibling input still fail?
- Does it stay inside the plan's file list? Anything outside it needs a reason.

**Data and SQL**
- SQL built by string concatenation, `@Query` with concatenated input, `nativeQuery` with user values.
- An applied Liquibase changeset or Flyway migration edited instead of a new one added.
- A migration with no rollback, or one that locks a large table (CDR, subscriber, usage) without a plan.
- SQL that only works on one of MySQL/MariaDB and Oracle when the product ships on both (`LIMIT` vs
  `FETCH FIRST`, `NOW()` vs `SYSDATE`, identifier case, empty string vs NULL in Oracle).
- `DELETE` or `UPDATE` without a bounded `WHERE`.

**Transactions and concurrency**
- `@Transactional` on a private method or a self-invoked call (no proxy, no transaction).
- Read-modify-write on balances, quotas, counters or vouchers without a lock or atomic update.
- In-memory state (static maps, caches, singletons) that is a correctness mechanism on a multi-node product
  such as two-node AAA.
- Lazy JPA collections touched outside the transaction; N+1 queries in a loop.

**Security**
- Missing authorization check on a new endpoint or action; trusting a client-supplied tenant, subscriber
  or operator id.
- Secrets, tokens or subscriber identifiers (MSISDN, IMSI, ICCID, email) written to logs or responses.
- Angular `bypassSecurityTrust*`, `innerHTML` with user data, Vue `v-html` with user data.
- Shell commands built from input; path traversal in file download or upload.
- In-product text containing Jira keys, internal hostnames, people's names, "TODO" or "test".

**Protocol and money**
- Diameter, RADIUS or SIP behaviour changed (AVPs, result codes, timers) without the ticket saying so.
- Rating, charging, rounding or currency handled with floating point.

**C++**
- Ownership and lifetime: raw `new` without an owner, references to temporaries, iterator invalidation.
- Unchecked buffer lengths when parsing packets.

## Pass 2 — informational (judgment)

Naming, duplication, dead code, missing test for an edge case, a magic number, a stale comment, an
error message a user cannot act on.

## Do not flag

- Style a formatter or linter already enforces.
- Anything the diff already handles.
- Pre-existing problems in lines the diff does not touch: list them separately as "seen, not in scope".
- "Consider adding a comment" or "consider a constant" for a value used once.
- Hypotheticals with no concrete failure scenario.

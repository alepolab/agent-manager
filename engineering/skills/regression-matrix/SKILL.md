---
name: regression-matrix
description: Write a table-driven test from the shape of a reported bug, not from its one reported example. Use before writing any test for a bug ticket, or whenever a fix is going in and a single test case would be the only guard against it regressing. Name the dimension that varies and cover it with five or six rows minimum, so a fix cannot pass by special-casing the reported input.
---

# regression-matrix

## Why this exists

A ticket reports one example. A test that reproduces only that example lets a
fix special-case that one input and go green while the underlying defect
survives in every neighbouring case. That is the failure mode this skill
exists to prevent: **a single-row test is not evidence the bug is fixed — it
is evidence one input now works.**

## The method

1. Read the reported example as a fact, not as the spec. It is one point;
   the bug lives in a dimension.
2. Name the dimension that varies. Say it out loud in your report before you
   write a single row — if you cannot name it, you have not generalised the
   bug yet. Examples of dimensions, by bug shape:
   - Parsing bug → the delimiter, separator, or encoding that appears
     differently across inputs
   - Date/time bug → a month or year boundary, a DST transition, a leap
     year, a timezone offset
   - State machine bug → which transition fires out of order, or arrives
     twice
   - Concurrency bug → the interleaving, or which of two actors moves first
   - Numeric bug → zero, a negative value, a boundary value (max/min int),
     a rounding edge
   - Multi-tenant / multi-record bug → a second record, customer, or
     account — not only the one already named in the ticket
3. Write the test as a **table-driven / parameterised** case, one row per
   point along that dimension. **Five or six rows minimum.** The reported
   example is one row, not the whole table.
4. Run it against the *current, unfixed* code and paste the FAIL output
   verbatim into your report. That is what proves the test reproduces the
   real bug, not a strawman that happens to fail for an unrelated reason.
5. Hand off only after that. The test file is locked once a source file is
   touched (`hooks/test-lock.mjs`) — precisely so this table cannot quietly
   shrink back to one row after the fact.

## Worked example

Ticket: "Import fails when a customer ID contains a hyphen."

Reported example alone gives one row: `"AB-123"` fails to parse, `"AB123"`
does not. Stopping there lets a fix that does
`id.replace('AB-123', 'AB123')` pass cleanly — it is not a fix, it is a
lookup table with one entry.

The dimension that actually varies is **the position and count of the
delimiter within an identifier**, not "does this string contain a hyphen":

| # | id value | shape under test | expected |
|---|---|---|---|
| 1 | `AB-123` | hyphen mid-token (the reported case) | splits to `AB`, `123` |
| 2 | `A-B-123` | hyphen appears twice | splits on the **last** hyphen |
| 3 | `-123` | hyphen at position 0 | rejected — no id before it |
| 4 | `AB-` | hyphen at the end | rejected — no id after it |
| 5 | `AB123` | no hyphen at all (must not regress) | parses whole, unsplit |
| 6 | `AB--123` | consecutive hyphens | rejected, or a documented behaviour — never a silent mis-split |

Six rows, one named dimension. Rows 2–6 are exactly what a
reported-example-only fix fails.

## Rule

State the varying dimension explicitly in your report — "the dimension
under test is X" — before the table itself. **Minimum: five or six rows.**
Fewer than that is a strong signal you are still testing the reported
example instead of the class of bug it belongs to.

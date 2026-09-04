---
name: intent-template
description: Answer the five questions a well-formed ticket needs before work starts — problem, outcome, affected systems, constraints, open questions — and write "not stated" for anything the ticket doesn't actually say. Use when triaging a ticket, writing a context packet, or scoping any change before a plan is written.
---

# intent-template

## The five questions

Alepo tickets already answer these well when written carefully. The job
here is faithful transcription, not invention.

1. **Problem** — what is broken or missing, in the reporter's own terms.
   Not your diagnosis of the cause; that belongs to a later step.
2. **Outcome** — what "done" looks like from the reporter's side. The
   observable behaviour that proves this is fixed or delivered.
3. **Affected systems** — the product, and where the ticket actually says
   so, the repo and area of it. Write "unclear" rather than guessing a
   repo — a wrong repo sends everything downstream to the wrong place.
4. **Constraints** — anything that limits the fix: versions, a specific
   customer, a deployment shape, data that cannot change, a deadline, a
   compliance requirement.
5. **Open questions** — what a human still needs to answer before this is
   trustworthy to act on. Empty is a valid, and common, answer.

## The rule

**"Not stated" is the correct answer for a missing field.** A ticket that
does not mention affected systems does not mean guess one from the
component field or infer one from the reporter's job title — it means
write "not stated" and let a later step, or a human, supply it.

Inventing detail a ticket does not contain is the failure mode this skill
exists to prevent: a plausible-sounding constraint that was never actually
said becomes something later steps design around as if it were real, and
the eventual fix ends up scoped to a requirement nobody asked for.

## Output shape

```
## Problem
...

## Outcome
...

## Affected systems
...

## Constraints
...

## Open questions
...
```

Keep every field a direct reflection of what the ticket says. If you find
yourself paraphrasing more than quoting, check whether you have started
inventing.

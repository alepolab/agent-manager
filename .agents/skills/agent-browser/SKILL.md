---
name: agent-browser
description: "Drive a real browser with the agent-browser CLI: navigate cheaply with accessibility snapshots, then LOOK at screenshots with your Read tool to validate and find defects. Use for UI verification, visual regression, exploratory QA and browser evidence."
---

# agent-browser - navigate by text, verify with your eyes

`agent-browser` is a native CLI driving Chrome/Chromium over CDP. It is fast and
capable, and it has one failure mode that matters here: **it will happily let you
finish a whole test run without ever looking at the page.** A snapshot is text.
Text cannot show you a modal covering the Save button, a table clipped at the
viewport edge, or a spinner that never stopped.

So this skill is one rule before it is anything else:

> Navigate cheaply with snapshots. **Validate visually.** Whenever you reach a
> milestone, meet something ambiguous, or suspect a layout defect: save a
> screenshot to disk and immediately open that file with your `Read` tool, then
> say what you saw in it.

A verdict written without a `Read` of an image is a verdict about the DOM, not
about what a user sees. Say so if that is all you did.

## Load the real usage guide first

The CLI ships its own version-matched instructions. Read them rather than
guessing flags:

```bash
agent-browser skills get core          # workflows, patterns, troubleshooting
agent-browser skills get core --full   # full command reference
agent-browser skills get dogfood       # exploratory testing / bug hunts
```

If the command is not installed, say so and stop - do not substitute a different
tool and do not report an unverified route as checked.

## Where the application is

Never assume a port. In order:

1. `stack-facts.json` in the run's artifacts directory. The runner writes it
   after it brings the stack up, from what docker itself reported: each
   service's state, its healthcheck verdict, the ports actually published
   (`endpoints`) and the entry points the registry names (`registryUrls`).
2. The product block in your instructions ("Stack entry points").
3. The compose file in the infra checkout - read, not remembered.

No address in any of those means `NOT VERIFIED`, naming what you read.
`"healthy": false` in `stack-facts.json` means no route on that stack can
produce a `PASS`: name the service that is down and report what could not be
checked because of it.

## Fast navigation

```bash
agent-browser open "$BASE_URL/some/route"
agent-browser snapshot -i            # interactive elements only, as @e1, @e2 refs
agent-browser fill @e3 "value"
agent-browser click @e7
agent-browser get text "#total"      # read a specific value back
```

Snapshots are cheap; use them to move. `snapshot -i --urls` when you need link
targets, `-s <selector>` to scope to one region of a heavy page.

## Visual verification - the escalation that must not be skipped

At every workflow milestone, every ambiguous dialog, and every suspicion of a
layout bug:

```bash
agent-browser screenshot ./<artifacts>/<route>-<state>-<width>.png
```

Then **Read that file**. Open the PNG with your `Read` tool and answer, in your
own output:

- Is the layout broken, overlapping, clipped or scrolled off?
- Is a modal or overlay blocking the control underneath it?
- Does the UI reflect the backend state - the balance updated, the spinner gone,
  the row actually added?
- Is the empty/error/loading state the one the story called for?

`agent-browser screenshot --annotate` overlays the `@eN` refs on the image, which
is what to use when you need to say exactly which control is covered.
`agent-browser console` and `agent-browser errors` are read on the same pass: a
clean-looking page with a red console is still a defect.

## Visual regression

```bash
agent-browser screenshot ./<artifacts>/<route>-before.png     # unmodified code
# ... the change ...
agent-browser screenshot ./<artifacts>/<route>-after.png
agent-browser diff screenshot --baseline ./<artifacts>/<route>-before.png
```

Capture the baseline BEFORE the change: a comparison with no before is a
screenshot, not a verification. An empty diff on a change meant to alter the
interface is a finding - it usually means the route was never reached. Read the
non-empty diff and say which region is intended and which is not.

Cover, at minimum: 375px and a desktop width (`agent-browser set viewport`),
both themes where they exist (`agent-browser set media dark|light`), and the
loading, empty, error and populated states. The populated happy path alone is
the most common omission and the first one a user hits.

## Logging a defect

When the image or the console shows an anomaly:

1. Copy the screenshot to `bugs/BUG-<id>.png` in the artifacts directory.
2. Add a row to `test-summary.md` there, with:
   - reproduction steps as the refs and values you actually used,
   - expected versus actual **visual** appearance, in the words of what you saw,
   - the relative path to the image,
   - the console or page errors that accompanied it.

A defect without an image is a claim. A defect with one is evidence.

## What to leave behind

Into the run's artifacts directory, because `meta.json` carries a `visual` block
counted off that directory and a completed visual step that left no image or
trace is recorded as a gap in the evidence contract:

| Artifact | Name it like |
|---|---|
| Screenshots | `<route>-<state>-<width>-before.png` / `-after.png` |
| Pixel diffs | `<route>-<state>-diff.png` |
| Defect shots | `bugs/BUG-<id>.png` |
| Trace / video | `trace.zip`, or a `.webm` from `agent-browser record` |
| Accessibility | `axe-<route>.json` |

## Data, credentials and honesty

Use the customer's real personas and real test data where they exist. Where they
do not, the route is `NOT VERIFIED` and you name the exact credential or fixture
the customer must supply. Never self-provision a login, never invent subscriber
data, never present a seeded fake as a persona's view. Never put a credential or
a subscriber identifier in a filename or a caption, and say in your output when
an image contains one, so whoever attaches the bundle to a customer ticket knows
first.

## Verdicts

- `PASS` - healthy stack, real baseline, real capture, an image you opened and
  read.
- `DIFF FOR REVIEW` - captured and read, and a human must judge the change.
- `FAIL` - the interface is wrong, with the image that shows it.
- `NOT VERIFIED` - anything else, with the reason. Always preferred to a `PASS`
  you could not have earned.

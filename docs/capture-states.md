---
title: Capture states
---

# Capture states

The plugin's capture lifecycle, as `src/state.ts` implements it.

**This diagram is generated from `STATE_TRANSITIONS`.** Do not edit the Mermaid
block by hand — `test/capture-states-doc.test.ts` checks it against the reducer's
own table in both directions and fails when the two disagree. A hand-maintained
diagram of a state machine is wrong within two changes.

<!-- GENERATED: paste the output of the command below. -->
```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> starting: capture-starting
    idle --> capturing: capture-started
    idle --> stopping: capture-stopping
    idle --> enhancing: enhancement-started
    idle --> enhancement-stopped: enhancement-stopped
    idle --> error: error
    starting --> capturing: capture-started
    starting --> idle: capture-start-failed
    starting --> stopping: capture-stopping
    starting --> idle: capture-stopped
    starting --> enhancing: enhancement-started
    starting --> idle: enhancement-finished
    starting --> enhancement-stopped: enhancement-stopped
    starting --> error: error
    capturing --> stopping: capture-stopping
    capturing --> idle: capture-stopped
    capturing --> starting: capture-starting
    capturing --> enhancing: enhancement-started
    capturing --> enhancement-stopped: enhancement-stopped
    capturing --> error: error
    stopping --> idle: capture-stopped
    stopping --> starting: capture-starting
    stopping --> capturing: capture-started
    stopping --> enhancing: enhancement-started
    stopping --> enhancement-stopped: enhancement-stopped
    stopping --> error: error
    enhancing --> capturing: enhancement-finished
    enhancing --> enhancement-stopped: enhancement-stopped
    enhancing --> starting: capture-starting
    enhancing --> capturing: capture-started
    enhancing --> stopping: capture-stopping
    enhancing --> idle: capture-stopped
    enhancing --> error: error
    enhancement-stopped --> starting: capture-starting
    enhancement-stopped --> capturing: capture-started
    enhancement-stopped --> enhancing: enhancement-started
    enhancement-stopped --> capturing: enhancement-finished
    enhancement-stopped --> error: error
    error --> starting: capture-starting
    error --> capturing: capture-started
    error --> enhancing: enhancement-started
    error --> capturing: enhancement-finished
    error --> enhancement-stopped: enhancement-stopped
```

## What each state means to a user

| State | The status bar says | What is happening |
| --- | --- | --- |
| `idle` | nothing — the item is hidden | No capture. |
| `starting` | `Shorthand · starting` | A start command is running its setup. No follower is attached yet, and a second start is refused. |
| `capturing` | `Shorthand 12:34` | A follower is attached and the transcript is arriving. |
| `enhancing` | `Shorthand 12:34 · writing` | One or more enhancement passes are writing the note. |
| `stopping` | `Shorthand 12:34 · stopping` | The stop was requested. It can spend a control timeout plus the whole drain budget. |
| `enhancement-stopped` | `Shorthand 12:34 · enhancement stopped` | Enhancement is off for the rest of this capture. Capture continues. |
| `error` | `Shorthand · error` | Something failed. Sticky by design: it clears when an enhancement pass succeeds or a new capture starts, never on its own. |

## Three things the shape is defending

**`starting` exists because the old guard was asynchronous.** `startCaptureOnActiveNote`
tested `#capture !== undefined`, and `#capture` is assigned at the *end* of the
setup — after marker preflight, a possible confirmation modal, frontmatter writes,
sidecar setup and `createEnhancer`. Two starts inside that window both passed, both
built a runtime, and the second orphaned the first: a live follower child, a control
and an enhancer that nothing would ever dispose, and a Shorthand recording left
running. `capture-starting` is dispatched synchronously before the first await, so
the guard now covers the whole window.

**`capture-start-failed` is not `capture-stopped`.** Assisted Notes waits up to three
seconds for Shorthand to acknowledge the recording it asked for, and may never get it.
Walking that back as a stopped capture would tell the user a capture had run when none
ever did.

**`enhancementDepth` is a count, not a flag.** "Enhance now" on a note the capture
does not own builds a second `EnhanceRunner`, and both report into this reducer.
Whichever finished first used to end the state while the other was still writing.

---
title: Capture states
---

# Capture states

The plugin's capture lifecycle, as `src/state.ts` implements it.

**This diagram is generated from `STATE_TRANSITIONS`.** Do not edit the Mermaid
block by hand — `test/capture-states-doc.test.ts` checks it against the reducer's
own table in both directions and fails when the two disagree. A hand-maintained
diagram of a state machine is wrong within two changes.

<!-- GENERATED: after any change to STATE_TRANSITIONS, regenerate with the
     command below and paste its output in place of the block that follows. -->
```bash
env -u OBSIDIAN_PLUGIN_DIR npx bun -e 'const {STATE_TRANSITIONS}=await import("./src/state.ts");for(const t of STATE_TRANSITIONS)console.log(`    ${t.from} --> ${t.to}: ${t.event}`)'
```
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
    starting --> starting: enhancement-finished
    starting --> starting: enhancement-ended
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
    enhancing --> capturing: enhancement-ended
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

Holding that guard shut is also why `starting --> starting` appears twice, as a
self-loop, for `enhancement-finished` and `enhancement-ended`: every `EnhanceRunner`,
whether it belongs to this capture or to a standalone "Enhance now" on a note this
capture does not own, reports into the same reducer. A pass belonging to some other
note finishing while this one is mid-setup must not be able to drop the mode out of
`starting` — that was originally a real bug (both events used to rest wherever
`restingMode` said, which was `idle`), fixed by having `restingMode` treat `starting`
as outranking every other resting mode.

That fix alone was not enough. `error` and `enhancement-stopped` set `mode`
unconditionally — deliberately, so the user sees what went wrong or what stopped
— and neither one consults `restingMode`, so an error or a stopped pass raised
mid-setup still walked the *mode* away from `starting` (to `error` or
`enhancement-stopped`), even though the reducer's own diagram still shows those
as edges out of `starting`. `PluginUiState.starting` is a second, independent
boolean carrying the same fact through that overwrite — the same pattern as
`stopping` below, and for the same reason: `canStartCapture` gates on the flag,
not the mode, so a sticky `error` (the plugin's most likely start-time failure —
`main.ts` calls `fail()` for an unavailable enhancer *after* the runtime is
already live, and on the Assisted Notes path *instead of* the deferred
`capture-started`) can no longer reopen the window a second start would exploit.
The mode still shows `error`; the flag silently keeps the door shut underneath it.

**`capture-start-failed` is not `capture-stopped`.** Assisted Notes waits up to three
seconds for Shorthand to acknowledge the recording it asked for, and may never get it.
Walking that back as a stopped capture would tell the user a capture had run when none
ever did.

**`enhancementDepth` is a count, not a flag.** "Enhance now" on a note the capture
does not own builds a second `EnhanceRunner`, and both report into this reducer.
Whichever finished first used to end the state while the other was still writing.
The count goes down for `enhancement-finished` (a pass that completed — the one
event that also clears a sticky `error`/`enhancement-stopped`, since a completed pass
is the work the "no clear-error" rule is waiting for), `enhancement-ended` (a pass
that ended without completing — core's `error`, `skipped`, `requeued` and `timed-out`
statuses, none of which fix anything, so none of which may clear a sticky mode), and
`enhancement-stopped` itself (the pass that stopped releases its own slot on the same
dispatch that raises the sticky mode).

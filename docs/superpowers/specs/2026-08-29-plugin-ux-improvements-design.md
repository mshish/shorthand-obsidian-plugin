---
title: Plugin UX improvements — design
date: 2026-08-29
---

# Plugin UX improvements — design

Six changes to the Obsidian plugin's surface before it is shared more widely, one
of which reaches into `shorthand-app` and `shorthand-core`. This document is the
spec the three implementation plans argue from.

## Why now

The plugin works, but its surface was grown one command and one status string at
a time. A new user meets: a status bar line that reads
`Shorthand: idle · 0/180 chars` while nothing is happening, a command palette
where two sibling actions are named asymmetrically, no visible controls anywhere
in the UI, a modal that asks permission for a thing almost everyone says yes to,
and a start/stop lifecycle with at least one reachable state that strands a
capture. None of those are bugs in the sense of a failing test. All of them are
the first thing a new user sees.

## Scope

| # | Change | Repos |
| --- | --- | --- |
| 1 | Status bar shows elapsed time only, and hides when idle | plugin |
| 2 | Command names match the app's own mode vocabulary and are symmetric | plugin |
| 3 | A right-side panel with start/stop controls and status | plugin |
| 4 | Obsidian follows a recording the user started with Shorthand's own hotkey | app → core → plugin |
| 5 | Capture lifecycle has one explicit state machine with no stranding states | plugin |
| 6 | A setting to add the note scaffold without asking, on by default | plugin |

Items 1, 2, 3, 5 and 6 are plugin-only and independent of each other. Item 4
requires a protocol addition that must land and ship from `shorthand-app` and
`shorthand-core` before the plugin half can be written.

---

## 1 — Status bar

**Today.** `main.ts`'s `#renderStatus()` writes
`Shorthand: ${mode}${elapsed}${progress}`, where `progress` is
` · ${pending}/${minNewChars} chars`. The item is created in `onload()` and never
removed, so an idle vault permanently carries `Shorthand: idle`. The `mode`
token is the raw `PluginMode` union member, so a user can be shown
`Shorthand: enhancement-stopped`.

**Decision.**

- The status bar item exists only when there is something to say. Idle removes
  it entirely, reclaiming the space.
- The character counter goes. It was added so that a capture sitting below the
  enhancement gate did not look broken; that reassurance moves to the side
  panel (item 3), which has room for it, and to the item's tooltip.
- While a capture runs the item reads `Shorthand 12:34` — the elapsed clock,
  no mode token, no colon.
- Other states keep the clock and append a word, so the meeting timer never
  jumps or vanishes while the capture is still running. The full set:

  | Mode | Text |
  | --- | --- |
  | `idle` | *hidden* |
  | `starting` | `Shorthand · starting` |
  | `capturing` | `Shorthand 12:34` |
  | `enhancing` | `Shorthand 12:34 · writing` |
  | `stopping` | `Shorthand 12:34 · stopping` |
  | `enhancement-stopped` | `Shorthand 12:34 · enhancement stopped` |
  | `error` | `Shorthand · error` |

  The clock is omitted wherever there is no capture to measure — `starting`
  before the runtime exists, and an `error` that outlived its capture.
  No cell contains a `PluginMode` union member.
- The item is clickable. While a capture is running or stopping, clicking it
  stops the capture. Because the item is hidden when idle there is no start
  affordance on it — that is the ribbon icon's and the panel's job (item 3).

**Where the rule lives.** The string and the visibility decision are a pure
function in `src/`, not an expression inside `main.ts`. `node_modules/obsidian`
ships types only, so nothing in `main.ts` can be imported under `bun test`; a
string built inline there is untestable by construction. This is the same rule
`docs/settings-copy-style.md` rule 4 states for settings descriptions.

## 2 — Command naming

**Today.**

| Command | Problem |
| --- | --- |
| Start capture on this note | Does not say which mode. Its sibling does. |
| Start assisted notes capture on this note | Asymmetric with the above. |
| Stop capture | Fine. |
| Enhance now | Fine. |
| Clean up this note | Fine. |
| Toggle Shorthand recording | "recording" is not a mode name. |
| Toggle Shorthand assisted notes | Asymmetric with the above. |
| Cancel Shorthand recording | Fine. |

**The app's own vocabulary** is authoritative, and it is not what the plugin
guessed. From `shorthand-app/src/shorthand/locales/en.json`:

```
"settings.modes.tabs.meetings": "Meetings"
"settings.modes.tabs.assistedNotes": "Assisted notes"
"settings.modes.tabs.notetaking": "Notetaking"
```

Sentence case, and "notes" is lowercase. Not "Meeting Notes / Assisted Notes".
The singular adjective form for a capture of that mode is "meeting" and
"assisted notes".

**Decision.** Rename to a symmetric set built from those words:

| id (unchanged) | New name |
| --- | --- |
| `start-capture-this-note` | Start meeting capture on this note |
| `start-assisted-notes-capture-this-note` | Start assisted notes capture on this note |
| `stop-capture` | Stop capture |
| `enhance-now` | Enhance now |
| `clean-up-this-note` | Clean up this note |
| `toggle-shorthand-recording` | Toggle Shorthand meeting recording |
| `toggle-shorthand-assisted-notes` | Toggle Shorthand assisted notes recording |
| `cancel-shorthand-recording` | Cancel Shorthand recording |

**Command ids do not change.** Obsidian keys a user's custom hotkey to
`<plugin-id>:<command-id>`, so renaming an id silently discards their binding.
Only `name` moves.

The three recorder commands keep the word "Shorthand" because they drive the
external app rather than the plugin — the exception `docs/settings-copy-style.md`
already records under "Obsidian's other binding rules".

**Where the rule lives.** The command table moves to `src/commands.ts` as data,
so the names are covered by `bun test`. `main.ts` iterates it.

## 3 — Side panel

**Feasibility.** Straightforward. Every API needed is in the `obsidian@1.5.7`
typings this repo builds against and well inside `minAppVersion: 1.5.0`:
`Plugin.registerView` (`obsidian.d.ts:2989`), `ItemView` (`:1910`),
`Workspace.getRightLeaf` (`:4585`), `revealLeaf` (`:4623`),
`getLeavesOfType` (`:4614`), `detachLeavesOfType` (`:4618`).

**Decision.** One `ItemView` in the right sidebar, view type
`shorthand-controls`.

Contents, top to bottom:

- The state, as a sentence: `Not capturing`, `Capturing — 12:34`,
  `Stopping…`, `Writing the note…`, `Enhancement stopped`, `Error`.
- The note being captured, as its basename, when there is one.
- Progress toward the next enhancement pass — `140 / 180 characters` — which is
  the reassurance the status bar's counter used to give, in the place that has
  room for it.
- Buttons: **Start meeting**, **Start assisted notes**, **Stop**. Exactly the
  buttons that can act right now are enabled; the rest are disabled, never
  hidden, so the panel does not reflow as state changes.

**Opening.** Not auto-opened. A ribbon icon and a command
(`Open Shorthand panel`) reveal it. Auto-opening rearranges the sidebar of every
existing user on update, which is a cost the feature does not need to pay.

**Where the rule lives.** What the panel should show for a given state is a pure
function in `src/panel-model.ts` returning a plain description object;
`main.ts` renders it with Obsidian components. The view-model is tested; the DOM
wiring is reviewed by reading.

## 4 — Following the app's own hotkey

**The want.** A user who starts a recording with Shorthand's global hotkey
should get the Obsidian capture too, without also running a command.

**What blocks it today.** Two things.

*The plugin is not listening.* The follower process (`StreamClient`, spawning
`shorthand --follow-stream`) exists only for the duration of a capture. With no
capture running there is nothing attached to the socket, so a `begin` announced
by the app reaches nobody.

*The wire protocol does not say which mode.* From
`shorthand-core/src/stream/client.ts:14`, the `begin` record is
`{ t: "begin"; session: number; streaming: boolean }` plus timestamps. There is
no mode. `FOLLOW_STREAM.md` confirms this is the whole record.

That second gap is not cosmetic. Which captures reach the hub at all is each
mode's own `follow_stream_enabled`: Meetings and Assisted notes ship it on,
Dictation ships it off but a user may turn it on. A plugin that attached to any
`begin` it saw would, for such a user, open a capture and start writing a
dictation burst into their meeting note.

**Decision: add the mode to the protocol.**

`shorthand-app` already knows the answer at the point it emits `begin`. There is
a process-wide active-mode cell (`src-tauri/src/shorthand/mode.rs`) written by
`TranscribeAction::start` at `src-tauri/src/actions.rs:550`, and the sole
non-test `hub.begin()` call is 69 lines later at `:619`. The value is sitting
there.

So:

- `FollowEvent::Begin` gains `mode`, serialized as `"meeting"`,
  `"assisted-notes"` or `"dictation"`.
- `hello` gains a `begin-mode` capability string alongside
  `toggle-assisted-notes`. This is what lets a follower distinguish "an older
  app that never sends the field" from "a current app whose session happens to
  be unknown" — the same job the existing capability does for control flags, and
  the reason a version-number guess is not good enough.
- Additive under protocol 1, so no version bump. `FOLLOW_STREAM.md` already
  states the rule: "A bump is reserved for a removal, a rename, or a changed
  event meaning."
- `shorthand-core` parses it defensively. An unrecognized string is **dropped,
  not coerced** — the precedent is `stringArrayField`'s comment: a consumer that
  gates behaviour on a value must never see one the app did not really send.

**Then, in the plugin:**

- A new setting, **Follow Shorthand's recordings**, off by default. It spawns a
  persistent child process, which is not something to switch on for someone
  without asking.
- While it is on and no capture is running, the plugin keeps an idle follower
  attached. Eight followers may connect at once (`FOLLOW_STREAM.md`, "Delivery
  and attachment"), so one held open costs a slot the plugin would have taken
  anyway during capture.
- On a `begin` whose mode is `meeting` or `assisted-notes`, with a Markdown note
  active and no capture running, the plugin starts a capture on that note —
  **without sending a start toggle**, because the recording it would be asking
  for already exists.
- `dictation` is ignored. So is a `begin` with no mode, which means the
  connected app predates the field; the user is told once per plugin load to
  update Shorthand, and nothing is attached. Refusing to guess is the whole
  point of the capability.

**Three things this needs that a naive version does not have.**

*The idle follower has to survive Shorthand not being there yet.* `StreamClient`
treats exit code 2 before any `hello` as terminal: it deactivates and emits
`settled` (`shorthand-core/src/stream/client.ts:328-335`). It never emits
`processError` or `giveUp` for that case. A follower that only listens for those
two is silently dead after the first attempt, so "open Obsidian, start Shorthand
later" — the overwhelmingly common order — would never work. The idle follower
listens for `settled`, drops the dead client, and retries on a slow backoff for
as long as the setting is on.

*The capture has to end when the recording does.* An attached capture has no
`ShorthandRecorder` (it did not start the recording, so it must not send the
finalize toggle), and `StreamClient` only kills its child on a terminal record
if `stopAfterDrain()` was already requested (`client.ts:388-391`). So nothing
owns the ending. The capture must therefore watch for the terminal record of the
session it attached to — `final`, `no_speech`, `cancel` or a session `error` —
and run its ordinary stop path when it arrives.

*The handoff must not drop the session.* Capture setup awaits marker preflight,
possibly a confirmation modal, note reads and writes, sidecar setup and
`createEnhancer` before its own follower starts (`main.ts:338-399`, `:522`).
The app replays `begin` and the latest partials only while a session is still
active (`hub.rs:443-445`); a terminal record clears it (`hub.rs:476-491`). A
short recording that ends during that setup — a user who scaffolds through a
modal, say — would hand the freshly spawned follower nothing at all, and the
capture would sit empty forever.

So the idle follower is **handed to the capture, not replaced by it.** The
plugin owns one `StreamClient`; an attached capture adopts it, and only a capture
the *user* started spawns a new one.

This is cheap because `TranscriptStore` already tolerates the one thing that
looked like it would block it. A `partial` or `final` for a session it never saw
a `begin` for does not fail — `ingest` falls back to `#createImplicit`
(`shorthand-core/src/stream/transcript.ts:94`). The capture's store therefore
does not need the `begin` record replayed into it, which is what would otherwise
have made adoption fiddly.

**Why the plugin does not need the mode to run the capture.** The only thing
`recordingSignal` decides is which control signal the plugin sends to *start*
and *finalize* a recording, plus the Assisted Notes capability gate. A capture
that attaches to a recording the user already started sends no start signal at
all, so the two modes are the same capture from that point on. The mode is
needed to decide *whether* to attach, not *how*.

**Ordering.** `shorthand-core/AGENTS.md` § "Releasing, and why the timing
matters" governs: land and tag core, then bump the plugin's pin as the first step
of the plugin work. The app's change is independent of that build order — the
plugin spawns `shorthand.exe`, it does not compile against it — but it must ship
before the feature does anything for a user.

## 5 — The capture state machine

**Today.** `src/state.ts` reduces six events over `{ mode, captureActive,
stopping, message }`. It is careful and well commented, and it has four
reachable problems.

**Problem 1 — the start guard is asynchronous.** `startCaptureOnActiveNote()`
guards on `this.#capture !== undefined`, but `#capture` is assigned late, after
marker preflight, a possible confirmation modal, frontmatter writes, sidecar
setup and `createEnhancer()`. Two invocations inside that window — the palette
twice, or a hotkey and the new panel button — both pass the guard, both build a
full runtime, and the second assignment orphans the first. The orphan keeps a
live `StreamClient` child, a `ShorthandControl` and an `EnhanceRunner` that
nothing will ever dispose, and its Shorthand recording is left running.

**Problem 2 — enhancement is not counted.** `enhancement-started` and
`enhancement-finished` are treated as a toggle. "Enhance now" on a second note
while a capture runs on the first builds an independent `EnhanceRunner`, and both
report into the same reducer. If the standalone pass finishes first, the state
leaves `enhancing` while the capture's pass is still writing.

**Problem 2b — and one pass already reports its end twice.** Core emits a
`finished` status and *then* returns a completed outcome
(`shorthand-core/src/agent/runner.ts:503-506`). The plugin dispatches
`enhancement-finished` from both: `onEnhanceStatus`'s `"finished"` arm
(`main.ts:964-966`) and `reportOutcome`'s `"completed"` arm
(`main.ts:1016-1018`). Expiry is duplicated the same way (`main.ts:967-976` and
`1019-1022`). Under today's boolean the second dispatch is a harmless no-op.
**Under a count it is a double-decrement**, so the duplication has to be removed
in the same change that introduces the count — otherwise the fix for problem 2
ships a worse bug than problem 2.

The single owner is `onEnhanceStatus`. It sees every pass, including the
automatic live ticks that never reach `reportOutcome` at all; `reportOutcome`
sees only the four call sites that await a pass directly. `reportOutcome` keeps
its `Notice` and its error reporting and gives up its lifecycle dispatches.

**Problem 3 — there is no `starting` state.** For Assisted Notes,
`capture-started` is dispatched when the runtime is assigned, but the recording
is not confirmed for up to `START_ACKNOWLEDGEMENT_MS` (3s) afterwards, and may
never be confirmed at all — `abortAssistedNotesStart()` then walks it back. The
status bar claims "capturing" throughout.

**Problem 4 — the mode union is shown to the user.** `enhancement-stopped` is an
internal token; `#renderStatus` prints it.

**Decision.** One explicit machine, still in `src/state.ts`, still a pure
reducer, with:

- A `starting` mode and a `capture-starting` event, dispatched **synchronously**
  as the first statement of `startCaptureOnActiveNote()`. `startCaptureOnActiveNote`
  refuses when the state is already `starting`, `capturing` or `stopping`, so
  the guard closes the whole window rather than its second half.
- **Assisted Notes stays in `starting` until Shorthand acknowledges.** Today
  `capture-started` is dispatched where the runtime is assigned
  (`main.ts:447-449`), which for Assisted Notes is up to three seconds before
  anyone knows a recording exists — and it may never exist, in which case
  `recorder.start()` resolves `"not-started"` (`recorder.ts:445-466`) and
  `abortAssistedNotesStart` walks it back. Adding `starting` without moving that
  dispatch would leave problem 3 exactly as it is. So for Assisted Notes the
  `capture-started` dispatch moves into the acknowledgement callback, and the
  `"not-started"` branch dispatches `capture-start-failed`. Meeting, whose
  contract is fire-and-forget, keeps dispatching where it does now.
- **A synchronous setup error keeps its own mode.** `fail()` dispatches a sticky
  `error` (`main.ts:1113-1116`), and an unconditional `capture-start-failed →
  idle` on the way out would erase the message the user needs — the status bar
  would go blank on the one path where something went wrong. `capture-start-failed`
  therefore returns to `idle` only from `starting`; from `error` it clears the
  start without touching the mode.
- `enhancementDepth: number` instead of a boolean sense of "enhancing".
  `enhancement-started` increments, `enhancement-finished` and
  `enhancement-stopped` decrement with a floor of zero. The mode is `enhancing`
  while the depth is above zero and no stop is pending.
- A `capture-start-failed` event, so a start that never became a capture returns
  to `idle` without pretending a capture stopped.
- Display strings that are never union members — item 1's pure function owns
  that mapping.

**The diagram.** Committed to `docs/capture-states.md` as a Mermaid state
diagram, and generated from the reducer's own transition table by a test, so it
cannot drift from the code it documents.

```
                 ┌──────────────────────────────────────────┐
                 │                                          │
              idle ──capture-starting──▶ starting ──capture-start-failed──┐
                 ▲                          │                             │
                 │                     capture-started                    │
                 │                          ▼                             │
                 └──capture-stopped── capturing ──capture-stopping──▶ stopping
                                           │                             │
                                           └───────capture-stopped───────┘
```

`enhancing`, `enhancement-stopped` and `error` are overlays on that spine rather
than peers of it: each remembers where it must return to.

## 6 — Automatic scaffolding

**Today.** A note with no Shorthand marker block gets a `ScaffoldModal` asking
"Add Shorthand markers?" before every affected command. Three call sites gate on
it: `startCaptureOnActiveNote`, `prepareScaffold` (both enhancement commands),
and nothing else.

The modal exists for a good reason — the scaffold writes into a note the user
did not necessarily intend to give to Shorthand, and declining must leave every
byte untouched. But in the common case the answer is yes, and the user has
already expressed intent by running a Shorthand command on that note.

**Decision.** A setting, **Automatic note scaffolding**, default on. When on,
`preflightMarkers` returning `needs-scaffold` proceeds without the modal. When
off, today's behaviour is unchanged.

The setting governs the confirmation only. It does not touch
`preflightMarkers`'s `error` branch: a note whose markers are present but
malformed is still never repaired implicitly, whatever this setting says. That
distinction is the reason the preflight has three statuses rather than two, and
it survives.

Copy, per `docs/settings-copy-style.md`: a positive noun phrase (rule 5), one
sentence describing the consequence rather than the mechanism (rules 1 and 3),
second person and present tense (rule 9).

- Name: **Automatic note scaffolding**
- Description: "Shorthand adds its section markers to a note that has none,
  instead of asking you first."

---

## Out of scope

- Any change to which modes publish to the follow-stream hub. That is the app's
  own Modes pane and stays the single description of that behaviour.
- Mobile. The plugin is desktop-only and stays so.
- Raising `minAppVersion` above 1.5.0. Everything specified here is available at
  that floor.
- Localization of plugin strings. The plugin is English-only today; that is
  tracked separately.

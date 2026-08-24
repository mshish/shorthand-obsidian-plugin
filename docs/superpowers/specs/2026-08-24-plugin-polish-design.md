# Plugin polish: settings copy, advanced grouping, and a notes-only pass

Date: 2026-08-24
Status: approved, ready for implementation planning

## Why

The plugin works. It does not yet read as a product. Three problems block that:

1. **Settings descriptions are engineering notes.** "Control Shorthand recording"
   runs five sentences on cancel semantics and relaunch bias. "Use Shorthand
   post-processing" runs three. A user deciding whether to flip a toggle reads a
   paragraph about internal mechanism and learns nothing about what changes for
   them.
2. **Enhancement requires a transcript.** A note written by hand, or dictated
   outside a capture, cannot be run through the same formatting and cleanup.
   `enhanceActiveNote` fails at `main.ts:491` when the note has no
   `shorthand-transcript` wikilink.
3. **The prompt editor hides the default.** The editor shows core's default
   guidance as a textarea placeholder, which vanishes on the first keystroke. A
   user who has customised the prompt cannot see what they diverged from.

This spec covers those three, plus the removal of a setting that should not
exist and two pre-existing violations of Obsidian's plugin guidelines.

Publication is planned separately and is out of scope.

## Research basis

Two questions were researched against primary sources before any copy was
drafted. The findings are recorded here because several of them overturned the
design's first draft.

### Obsidian's own rules

From the [plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
and the [Settings UI guide](https://docs.obsidian.md/Plugins/User+interface/Settings):

- **Description length is a stated rule, not a preference.** "`desc` is for a
  single sentence explaining what the setting does, not for warnings or
  paragraphs of context. Long descriptions push the next row off-screen,
  disrupt scanning, and aren't guaranteed to be read."
- **Overflow has a prescribed destination.** "If the user needs background
  context to understand the setting, link to a docs page from `desc` rather than
  inlining it."
- **Sentence case everywhere**, including descriptions, headings, and button
  labels.
- **Headings must not contain the word "settings".** Prefer "Advanced" over
  "Advanced settings".
- **No top-level heading** naming the plugin. The tab title already does it.
- **Textareas are discouraged in the main tab**; multi-line input belongs in a
  form modal. `NotePromptModal` already follows this.
- **Command names must not carry the plugin name or ID.** Obsidian prefixes
  them.
- **No hardcoded styling.** Use CSS classes, never `el.style.x`.

Two explicit non-findings matter as much as the rules:

- **Obsidian states no rule about hiding advanced settings.** The `visible`
  predicate that would implement it cleanly is part of the declarative settings
  API, which requires app version 1.13.0. `manifest.json` declares 1.5.0, so it
  is unavailable, as is `SettingGroup` (1.11.0). There is no documented
  collapsible primitive in the pre-1.13 imperative API.
- **Obsidian core does not hide advanced settings.** General, Editor, and Files
  and links each place theirs in a plain, always-visible "Advanced" section at
  the bottom of the tab.

### General UI copy practice

From Nielsen Norman Group, Microsoft's Win32 UX guide, Google/Material, Apple,
and GOV.UK. The findings that changed the design:

- **A missing description is a valid outcome.** Android: "If the label is
  sufficient on its own, don't add secondary text." Microsoft: "Don't have
  supplemental explanations that merely restate the label for consistency." A
  guide mandating one description per row manufactures the filler this work
  removes.
- **For non-boolean settings, show the current value rather than describing the
  setting.** Material's example: `Sleep / After 10 minutes of inactivity`, not
  `Screen timeout / Adjust the delay before the screen turns off`.
- **Describe the consequence, not the mechanism.** Material: "Allow data
  exchange when the phone touches another device", not "Use Near Field
  Communication to read and exchange tags".
- **Advanced content belongs on a separate surface, not an inline expander.**
  Microsoft is the only source that reasons about the cost of the disclosure
  control itself, naming discoverability loss and UI instability as its risks.
  This independently supports the same choice Obsidian core made.
- **Technical users want plain language more, not less.** GOV.UK's research:
  "the more educated the person and the more specialist their knowledge, the
  greater their preference for plain English." This contradicts the instinct
  that expert users want the mechanism spelled out, and it is the single
  finding that most justifies this work.

Where sources conflicted, the guide records which was followed and why.

## Increments

Each increment is implemented by a sub-agent and reviewed by Codex before the
next begins. Increment 1 lands in `shorthand-core`; the rest land here.

### 0. Make the verification gate trustworthy

Added during planning, ahead of everything else, because every increment below
ends with "run the gate and confirm it passes" — and one part of the gate does
not currently inspect the code under test.

`test/plugin-bundle.test.ts` exists because the plugin once failed to load in
Obsidian with every check green. But its `ensureBundle()` reads
`if (existsSync(BUNDLE)) return;` — it builds **only when `main.js` is absent**.
`main.js` is gitignored yet present in any working checkout, so on an ordinary
run the test loads whatever bundle is on disk, which may have been built from
entirely different source. The test written to catch "green checks, broken
bundle" can itself pass against a bundle that does not correspond to the code
under test.

The fix throws rather than rebuilds. Rebuilding is the obvious move and the
wrong one: `esbuild.config.mjs`'s `deliver-to-vault` plugin fires on
`build.onEnd`, so a rebuild triggered from `npm test` copies into a live
Obsidian vault whenever `OBSIDIAN_PLUGIN_DIR` is set — delivering uncommitted,
mid-edit code and breaking the repo's rule that the vault holds a build from
committed code. Failing loudly keeps building an explicit act.

This also documents a hazard the repo's `AGENTS.md` states only for builds:
with that variable set, **`npm test` can write into a live vault**, because the
suite spawns a build.

### 1. Core: a notes-only enhancement pass

`runner.ts:582` returns `not-ready` when a `link` pass has an empty transcript
and the note already has sections. The gate is correct for its real job —
suppressing a redundant pass when nothing new arrived — so it stays. A caller
gains a way to override it.

`enhanceNow(tier: AgentTier = "link")` takes an optional second argument:

```ts
enhanceNow("link", { allowEmptyTranscript: true })
```

Threading the flag is four edits, not one. Planning found the spec's first
draft had this wrong: `#acceptPass` (line 400) only builds the `PassRequest`;
the gate lives downstream in `#runPass`. So the flag must be added to the
`ENHANCE` event type (line 107), carried by `#acceptPass` onto `PassRequest`,
passed explicitly at all three `#acceptPass` call sites (`acceptTick` and
`acceptLiveTick` pass `false`), and finally checked in `#runPass`. `tsc` is the
only thing that catches a missed call site — `bun test` transpiles without
typechecking.

Nothing else in the state machine changes. `buildPassPrompt` already carries
`userNotes` as a first-class field, so the prompt is untouched.

The change is additive, so every existing call site still compiles.

**Also in this commit**, per `AGENTS.md`: `docs/CONTRACT.md` gains the new
surface, and `ENHANCEMENT-LIMITS.md` gains a row for the empty-transcript
decline. Note the row does not exist to be updated — it was never written. Its
absence has left a standing error at `ENHANCEMENT-LIMITS.md:38`, which claims
"`enhanceNow()` skips the two threshold gates and honours the first three."
That is false today: `enhanceNow` does not skip the character gate, because
`runner.ts:582` declines a link pass with an empty transcript. Both the missing
row and the wrong sentence are fixed here. This is exactly the failure core's
`AGENTS.md` predicts when it says the limits table is hand-maintained and a
stale row misleads the next agent rather than failing a test.

Then the four-command gate, push, and an annotated tag on the minor slot.

### 2. Plugin: bump the pin, add "Clean up this note"

The pin bump is the first commit, verified by confirming that `resolved` in
`package-lock.json` moved. A green typecheck is not evidence; npm can report
success while leaving both the lockfile and `node_modules` on the old commit.

A new command, id `clean-up-this-note`, name "Clean up this note":

- Scaffold the note if needed, exactly as `enhanceActiveNote` does.
- Build the standalone enhancer.
- Append no transcript.
- Call `enhanceNow("link", { allowEmptyTranscript: true })`.
- Report the outcome.

If the note already carries a transcript link, the command says so and names
"Enhance now" as the right command, rather than silently doing something
different.

The two commands then differ only in whether they feed a transcript, so the
shared path is extracted. Per `AGENTS.md`, the *decision* — which mode a note
qualifies for — becomes a testable function in `src/`, and `main.ts` keeps only
the wiring. Nothing in `main.ts` can be imported under `bun test`, so a rule
left there is a rule with no test.

**`checkCallback` lands here, not in increment 6.** Both enhancement commands
require an active Markdown file, and Obsidian prescribes `checkCallback` for
commands that only run under certain conditions. Adding the new command is the
natural moment to convert its sibling. It requires splitting a side-effect-free
`activeMarkdownFileOrNull()` off `activeMarkdownFile()`, because Obsidian calls
a check with `checking: true` on every palette render and the existing accessor
fires a `Notice`.

The behaviour change is user-visible and intended. Obsidian's own typings state
it: "Returning false or undefined causes the command to be hidden from the
command palette." With no note open these commands disappear, where today they
are listed, run, and then complain.

**`start-capture-this-note` is converted too**, in increment 6. It has the
identical precondition, and leaving one of three commands inconsistent would
read as an oversight rather than a decision.

### 3. Remove Shorthand post-processing

The setting is removed entirely. It is not merely reworded: the feature is not
expected to be used, and its name overstates what it delivers.

Removal is plugin-only. Core declares `"toggle-post-process"` in the
`ControlSignal` union and never uses it. That member **stays** — removing an
exported union member is a breaking retype and a minor bump, for no gain.

Deleted:

- `useShorthandPostProcessing` from `ShorthandPluginSettings`,
  `DEFAULT_PLUGIN_SETTINGS`, and `normalizePluginSettings`.
- The settings row at `main.ts:869`.
- `recordingSignalFor()`. The recorder always sends `"toggle-transcription"`.
- The `POST_PROCESS_DRAIN_TIMEOUT_MS` branch. Stopping always uses
  `DEFAULT_CONFIG.drainTimeoutMs`.
- The snapshot-at-capture-start rule and its comment at `main.ts:527`, which
  existed only so a capture stopped with the toggle it started with.
- The drain-window comment at `main.ts:92`.

The last two are the point of this increment. It removes behaviour, not just
copy — a whole class of mid-capture inconsistency stops existing.

No migration. A `data.json` still holding the key stops being read and drops on
the next save. `test/plugin-settings.test.ts` references it in about ten places,
including tests written to pin it apart from neighbouring booleans; those are
rewritten against a remaining pair rather than deleted, since what they verify
is still worth verifying.

### 4. The style guide

`docs/settings-copy-style.md`, referenced from `AGENTS.md` § Code style, which
currently carries a single line about matching the register of existing
descriptions. That line is replaced by the pointer.

The guide states nine rules, each traceable to a primary source:

1. **One sentence.** Three is the absolute ceiling.
2. **No description is a valid outcome.** Write one only when the label leaves a
   real question unanswered.
3. **Describe the consequence, not the mechanism.**
4. **For non-boolean settings, show the current value instead of a
   description.**
5. **Name toggles as positive noun phrases.** Read the label aloud and append
   "on"; if it does not parse, rewrite it. Never phrase a toggle so that on
   means off.
6. **Banned generic verbs in labels:** set, change, edit, modify, manage, use,
   select, choose.
7. **Obsidian's terminology list is binding.** Folder, not directory. Maximum
   and minimum, not max and min. Note for Markdown files. American spelling.
8. **Sentence case throughout. Periods on descriptions, never on labels.**
9. **Second person, present tense, active voice. No "we".**

The guide also records the deviations this repo takes and why, so a later
maintainer can tell a decision from an accident.

### 5. Rewrite the copy

Every setting name and description is rewritten against the guide. Drafts pass
through the `no-ai-slop` skill before review.

Worked examples fixing the current text:

| Now | After |
| --- | --- |
| **Control Shorthand recording** — five sentences on cancel semantics | **Control Shorthand recording** — "Starting and stopping a capture also starts and stops Shorthand, so you don't need its hotkey." |
| **Transcript sidecar directory** — "Vault-relative directory used for new transcript notes." | **Transcript folder** — shows the current path as its description |
| **Debug logging** — four sentences | **Debug logging** — "Logs enhancement activity to the developer console. Turn this on if a note stops updating during capture." |

**Displaced detail is moved, not deleted.** The cancel-and-relaunch behaviour
documented in the "Control Shorthand recording" description is real, surprising,
and worth keeping: quitting Shorthand mid-capture normally relaunches it,
because the cancel is sent whenever a recording might still be running. It moves
to a README section that the description links to. Every other paragraph cut
from a description is triaged the same way — to the README if a user can hit it,
deleted only if it describes internals no user can observe.

### 6. Advanced section and the prompt editor

**Advanced section.** Advanced settings are grouped under an "Advanced"
`setHeading()` at the bottom of the tab, always visible. This matches Obsidian
core and needs no mechanism that would have to be unwound when the app-version
floor eventually reaches 1.13.0.

| Basic | Advanced |
| --- | --- |
| Enhancement backend | Shorthand executable |
| Write transcript note | Claude executable |
| Transcript folder *(conditional)* | Minimum new characters |
| Control Shorthand recording | Minimum interval |
| Note-taking prompt and sections | Live enhancement |
| | Debug logging |

"Control Shorthand recording" stays basic because turning it off changes the
daily workflow. The LLM provider block is already conditional on the backend
choice, which is its own disclosure, and it stays where it is.

**"Transcript folder" stays in Basic**, directly beneath "Write transcript note"
and still conditional on it. An earlier draft of this table put it in Advanced;
planning showed why that is wrong. The row only renders when the toggle is on,
so moving it to Advanced would place it roughly a screen below the control that
reveals it — flipping the toggle would look like it did nothing. The pairing
reads as one unit and is textbook progressive disclosure. The `this.display()`
re-render at `main.ts:849`, which exists solely to show and hide that row,
therefore stays.

Advanced holds six rows, not seven.

**Prompt editor.** `NotePromptModal` gains a two-state control per field: "Use
default" and "Customize".

- **Use default** renders the effective default read-only, so it is always
  legible.
- **Customize** reveals the editable textarea, seeded from the default the first
  time it is chosen.
- Switching back to "Use default" stores `""`.

The radio state is derived from whether the stored string is empty, so no second
key is stored. Storing `""` rather than a copy of the default is what preserves
inheritance: a user who never customises keeps receiving improvements to core's
guidance instead of being frozen at whatever the text said the day they edited
it. That property is the reason the modal is built the way it is, and this
change must not break it.

The seeding step is the risk. Seeding puts the default's text in an editable
field, and saving from that state stores a frozen copy — which is correct, since
the user explicitly chose to customise, but only if "Use default" remains a
genuine one-click route back.

**Two pre-existing violations**, fixed while in this code:

- `main.ts:1252` sets `area.style.width` directly. The plugin guidelines forbid
  hardcoded styling; this becomes a CSS class. **A stylesheet alone is not
  enough**: `esbuild.config.mjs:48` copies only `["main.js", "manifest.json"]`
  into the vault, so a new `styles.css` would pass every gate and silently never
  be applied. It must be added to that list, and a test pins the list so the
  next file to be added does not repeat the mistake.
- `start-capture-this-note` still uses a plain `callback`. The two enhancement
  commands are converted in increment 2; this is the third, converted here so
  all commands with the same precondition express it the same way.

## Verification

There is no CI in either repo, so every gate is run by hand.

**Core:** `bun test`, `bun run typecheck`, `bun run build`, `bun run test:e2e`.
All four, because `bun test` transpiles without typechecking.

**Plugin:** `npm test`, `npx tsc --noEmit`, `npm run build`. The bundle-load
smoke test in `test/plugin-bundle.test.ts` is not optional — it exists because a
build once passed every check and still failed to load.

`main.ts` cannot be imported under `bun test`. Anything expressed there is
verified only by typecheck, the smoke test, and a human clicking through
Obsidian. That is the reason increments 2 and 6 push their rules into `src/`,
and it is the reason the settings pane needs a manual pass in a real vault
before the work is called done.

`OBSIDIAN_PLUGIN_DIR` may be set, in which case every build copies into a live
vault. The vault must be left holding a build from committed code.

## Out of scope

- Publication and the community-plugin submission.
- Raising `minAppVersion` to reach the declarative settings API.
- Any change to the Shorthand app. Increment 1 was checked against it: the
  prompt already accepts user notes, so no capture-side change is needed.
- Removing `"toggle-post-process"` from core's `ControlSignal` union.

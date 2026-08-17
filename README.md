# Obsidian Shorthand

Granola-style meeting notes for Obsidian, driven by [Handy](https://github.com/cjpais/Handy)'s
`--follow-stream` CLI: Handy transcribes your microphone and system audio as separate
speaker-labelled lanes, and this plugin keeps an AI-owned summary in the note while the meeting
is still running.

Capture lands in a linked transcript sidecar note. Stateless Claude Agent SDK passes use the new
transcript plus your own notes to maintain a structured summary in the meeting note; sections may
be added, rewritten, reordered, or removed as the meeting develops.

This repository is the **Obsidian plugin only** — a thin desktop lifecycle and UI wrapper. All
capture, transcript reconciliation, enhancement and file writing live in the headless core,
[`mshish/shorthand-core`](https://github.com/mshish/shorthand-core), which this repo depends
on by package name and a pinned tag. The core repo also holds the design notes
(`docs/DESIGN.md`) and the core/consumer contract (`docs/CONTRACT.md`).

## Prerequisites

- Handy must be running with **Follow Live Transcript Output** enabled under **Advanced
  settings**. If Handy is stopped or that setting is disabled, `--follow-stream` exits with code 2
  and Shorthand reports both remedies.
- The `claude` CLI must be installed and logged in. On Windows the standard
  `C:\Users\<you>\.local\bin\claude.exe` location is detected; another location can be configured
  in the plugin's settings tab.
- A desktop, filesystem-backed vault. The plugin is `isDesktopOnly`.
- Node.js 20+ and npm, to build from source.

## Install

### From a release (no toolchain required)

Download `main.js` and `manifest.json` from the [latest release](../../releases/latest) into:

```text
<vault>/.obsidian/plugins/shorthand/
```

### With BRAT

BRAT installs from a **release**, not from the repo tree. This repository is private, so BRAT
needs a fine-grained personal access token with read-only **Contents** permission on it, added in
BRAT's settings; then add `mshish/obsidian-shorthand` as a beta plugin.

### From source — the standard Obsidian dev loop

The repository root **is** the plugin, so Obsidian's documented loop applies directly:

```sh
git clone https://github.com/mshish/obsidian-shorthand.git \
  "<vault>/.obsidian/plugins/shorthand"
cd "<vault>/.obsidian/plugins/shorthand"
npm install
npm run build   # a fresh clone has no main.js — it is gitignored
npm run dev     # esbuild watch; rebuilds main.js in place on every save
```

Enable **Shorthand** under Community plugins and configure the executable paths and budgets in
its settings tab. Install the community [Hot Reload](https://github.com/pjeby/hot-reload) plugin
in that vault and reloads become automatic — it keys off the `.git` directory a clone leaves
behind. Without it, Obsidian caches the bundle, so **toggle the plugin off and on** after each
rebuild; otherwise you are still running the previous build, which looks exactly like your change
having no effect.

**npm, not bun.** Core is a private GitHub dependency: npm resolves `git+https://…#<tag>` by
cloning through the `gh` credential helper, while bun rewrites GitHub dependencies to the API
tarball endpoint and 404s on a private repo regardless of the token supplied.

## Commands

Obsidian prefixes these with the plugin name in the palette, so they appear as
"Shorthand: Start capture on this note":

- **Start capture on this note**
- **Stop capture**
- **Enhance now**
- **Toggle Handy recording**
- **Cancel Handy recording**

Capture starts only on the active Markdown note. If it has no ownership markers, the plugin offers
to append a seeded marker scaffold. Malformed, duplicate, nested, or inverted markers are never
repaired automatically.

The last two commands work with or without an active capture and drive Handy's own recorder
directly. They do not start or stop a capture — but they are not inert either: **Cancel Handy
recording** during a capture ends the recording Handy is running, so the capture keeps only the
text Handy had already committed and the corrected `final` is discarded.

## Driving Handy's recorder

By default, **Start capture** and **Stop capture** also drive Handy's recorder, so a capture no
longer needs a separate press of Handy's global hotkey. Two settings control this:

- **Control Handy recording** (default on) — drive the recorder from start and stop.
- **Use Handy post-processing** (default off) — use `--toggle-post-process` instead of
  `--toggle-transcription` as the recording toggle.

Handy's CLI offers no `--start`/`--stop` — the transcription flags are toggles — so the plugin
makes each end deterministic instead of guessing:

- **Start capture sends `--cancel` first, then the recording toggle.** `--cancel` always drives
  Handy to idle (and is a no-op when it already is), so the toggle that follows can only start a
  recording. **Starting a capture therefore cancels any recording already in progress**, and a
  cancelled recording keeps only the partials Handy had already committed — its corrected final
  transcript is discarded. The toggle waits for the follower to attach first, so that the
  recording's own `begin` is seen; if the follower has not attached within 2s the sequence goes
  ahead anyway, since a recording nobody is following is still better than no recording.
- **Stop capture sends the recording toggle only when a recording is believed to be running**,
  which is what makes Handy finalize and emit the `final` transcript. It then holds the follower
  open until Handy's terminal record arrives (or the drain budget runs out) and sends `--cancel`
  last, as a backstop against ever leaving Handy recording. Two things suppress the toggle: no
  session believed live (a toggle would *start* a recording), and Handy already known to be gone
  — in that case the stop sends nothing at all, since the spawn would launch the app.
- **If Handy is restarted mid-capture**, the recording the capture was following died with the
  old process, and Handy's session numbering restarts at 1 — so no session id can be trusted
  across that. If the stop's toggle then lands on an idle Handy and *starts* a recording, the
  plugin sees the new session begin, says so, and cancels it instead of waiting out the whole
  drain budget with a live microphone.
- **A stop that arrives while the start sequence is still in flight** cannot un-spawn the toggle
  already on its way to Handy, so a `--cancel` is sequenced behind it instead. The capture ends
  with Handy idle either way.
- **Closing Obsidian mid-capture sends `--cancel`.** That is the only signal the shutdown path
  itself sends — but it cannot un-spawn a start sequence still in flight, so if a capture was
  started moments earlier the recording toggle may still land, and the start sequence sequences
  its own second `--cancel` behind it. Handy ends idle either way.
- **If the transcript stream dies on its own** — Handy quit, the stream was disabled — the same
  `--cancel` backstop runs, which cancels the recording that was in progress. Leaving the
  microphone hot is the worse failure. The plugin says so in a notice. It is skipped only when
  nothing the capture saw shows Handy was ever reached: no `hello`, no session record, no
  control signal Handy ever confirmed, and an exit saying "not running". A control signal
  confirmed as delivered is the strongest of those, because Handy's CLI only reports success
  after handing the flag to an already-running instance — without it, a capture whose follower
  was refused could conclude "Handy is down" seconds after its own start sequence had put that
  same Handy into recording. The exit code alone proves nothing either: the follower reports the
  same code when Handy is running and recording but live transcript streaming is switched off or
  its follower slot is taken, so anything short of the full evidence still gets the cancel.
- **The cost of that bias: quitting Handy mid-capture normally relaunches it.** The backstop
  `--cancel` is sent because a recording might still be running, and with no Handy to forward to
  the spawn *becomes* Handy starting up. That is deliberate — an unwanted app launch is the
  cheaper mistake — but it is a real, visible consequence of leaving **Control Handy recording**
  on.

**Toggle Handy recording** and **Cancel Handy recording** stay available as the manual override,
with or without an active capture.

With **Use Handy post-processing** on, Handy runs an LLM pass after the recording ends, so Stop
capture allows it a longer window (45s instead of 10s) to deliver the final transcript before the
follower is stopped. A capture keeps whichever value the setting had when it started, so it always
finalizes with the same toggle it started the recording with; changing the setting mid-capture
therefore affects only **Toggle Handy recording** and the next capture, and during that window the
manual command drives the other flag than the capture will.

Stopping is not instant: it can spend a control timeout plus the whole drain budget waiting for
Handy's `final`, so the status bar reads `Handy: stopping` for that time.

A control signal that fails is reported but never unwinds the capture — capture still works with
Handy's own hotkey. If Handy was not running at all, the signalling spawn *becomes* the Handy app
starting up; the plugin says so, and what it asks for depends on which signal failed.

## Ownership-marker contract

Shorthand owns only the bytes strictly between one well-ordered marker pair:

```markdown
<!-- handy:notes -->
- Your rough notes remain user-owned.

<!-- handy:ai:start -->
## Summary
AI-maintained sections live here.
<!-- handy:ai:end -->
```

Every AI update re-reads the file, verifies the current block hash, splices only the marker body,
writes a same-directory temporary file, and atomically renames it over the note with lock retries.
Marker anomalies fail closed. The agent has no write tools; all note writes go through the core
file writer, never through Obsidian's vault API.

## Known limitations

- Because the core writes directly to disk, Obsidian notices updates through its file watcher. If
  the note has unsaved keystrokes in Obsidian's editor buffer, that buffer can win on its next save
  and an AI update may be lost. This is the intentionally safe direction: Shorthand does not
  discard user text.
- Under Claude subscription authentication, `total_cost_usd` is commonly `0`. In that case the
  configured USD budget is inert, so the pass-count budget is the real hard cap.
- A stream disconnect cannot replay missed Handy events. Reconnects add a visible transcript-gap
  warning to the sidecar.

## Verification — run this before every push

There is **no CI in this repository yet**: a GitHub Actions default token cannot clone another
private repository, so a workflow could not install core. CI arrives when core goes public. Until
then this is the gate, and it is on you to run it:

```sh
npm run build   # tsc --noEmit, then the production esbuild bundle
npm test        # unit tests plus the bundle-load smoke
```

`npm test` runs under Bun (`bun test`); npm still owns dependency installation. The bundle-load
test is the one that matters most — nothing else ever *loads* `main.js`, and a bundle that builds
cleanly can still throw at Obsidian load. It also asserts a recorded byte baseline, which moves
whenever core's lockfile does, since esbuild resolves the Claude Agent SDK and zod out of core.

## Cutting a release

Obsidian identifies a release by a bare `x.y.z` tag that **equals** `manifest.json`'s `version` —
no `v` prefix. BRAT and the community listing both require that, and BRAT treats the tag as the
source of truth, overriding the manifest on a mismatch.

```sh
npm version 0.2.0    # runs version-bump.mjs: manifest.json + versions.json + package.json
git push origin main
git tag 0.2.0 && git push origin 0.2.0
npm run build        # attach main.js and manifest.json to the release by hand
```

`minAppVersion` is never bumped for you — raise it by hand in `manifest.json` first if a release
needs a newer Obsidian, and the bump records that value against the new version in `versions.json`.
`versions.json` lets an older Obsidian resolve the newest build it can still run; it is read from
the repo's default branch, so it does nothing while this repo is private and is maintained purely
so the history is correct if that changes.

Release assets are attached manually for the same reason there is no CI.

## Bumping core

Core is pinned by tag in `package.json`:

```json
"shorthand-core": "github:mshish/shorthand-core#0.2.0"
```

Change the tag, run `npm install`, then run the verification gate above — a core change can move
the bundle size and break the bundle-load test long before it breaks a type.

## License

MIT — see [LICENSE](LICENSE).

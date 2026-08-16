# Obsidian Handy Notes

Granola-style meeting notes for Obsidian, driven by [Handy](https://github.com/cjpais/Handy)'s
`--follow-stream` CLI: Handy transcribes your microphone and system audio as separate
speaker-labelled lanes, and this plugin keeps an AI-owned summary in the note while the meeting
is still running.

Capture lands in a linked transcript sidecar note. Stateless Claude Agent SDK passes use the new
transcript plus your own notes to maintain a structured summary in the meeting note; sections may
be added, rewritten, reordered, or removed as the meeting develops.

This repository is the **Obsidian plugin only** — a thin desktop lifecycle and UI wrapper. All
capture, transcript reconciliation, enhancement and file writing live in the headless core,
[`mshish/handy-notes-core`](https://github.com/mshish/handy-notes-core), which this repo depends
on by package name and a pinned tag. The core repo also holds the design notes
(`docs/DESIGN.md`) and the core/consumer contract (`docs/CONTRACT.md`).

## Prerequisites

- Handy must be running with **Follow Live Transcript Output** enabled under **Advanced
  settings**. If Handy is stopped or that setting is disabled, `--follow-stream` exits with code 2
  and Handy Notes reports both remedies.
- The `claude` CLI must be installed and logged in. On Windows the standard
  `C:\Users\<you>\.local\bin\claude.exe` location is detected; another location can be configured
  in the plugin's settings tab.
- A desktop, filesystem-backed vault. The plugin is `isDesktopOnly`.
- Node.js 20+ and npm, to build from source.

## Install

### From a release (no toolchain required)

Download `main.js` and `manifest.json` from the [latest release](../../releases/latest) into:

```text
<vault>/.obsidian/plugins/handy-notes/
```

### With BRAT

BRAT installs from a **release**, not from the repo tree. This repository is private, so BRAT
needs a fine-grained personal access token with read-only **Contents** permission on it, added in
BRAT's settings; then add `mshish/obsidian-handy-notes` as a beta plugin.

### From source — the standard Obsidian dev loop

The repository root **is** the plugin, so Obsidian's documented loop applies directly:

```sh
git clone https://github.com/mshish/obsidian-handy-notes.git \
  "<vault>/.obsidian/plugins/handy-notes"
cd "<vault>/.obsidian/plugins/handy-notes"
npm install
npm run build   # a fresh clone has no main.js — it is gitignored
npm run dev     # esbuild watch; rebuilds main.js in place on every save
```

Enable **Handy Notes** under Community plugins and configure the executable paths and budgets in
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
"Handy Notes: Start capture on this note":

- **Start capture on this note**
- **Stop capture**
- **Enhance now**

Capture starts only on the active Markdown note. If it has no ownership markers, the plugin offers
to append a seeded marker scaffold. Malformed, duplicate, nested, or inverted markers are never
repaired automatically.

## Ownership-marker contract

Handy Notes owns only the bytes strictly between one well-ordered marker pair:

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
  and an AI update may be lost. This is the intentionally safe direction: Handy Notes does not
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
"handy-notes-core": "git+https://github.com/mshish/handy-notes-core.git#0.1.0"
```

Change the tag, run `npm install`, then run the verification gate above — a core change can move
the bundle size and break the bundle-load test long before it breaks a type.

## License

MIT — see [LICENSE](LICENSE).

# AGENTS.md

Guidance for AI coding assistants working in this repository.

## What this is

An Obsidian plugin that drives Shorthand capture into a meeting note. Most of
the real work lives in [`shorthand-core`](https://github.com/mshish/shorthand-core);
this repo is the Obsidian surface — commands, settings, the recorder lifecycle,
and the `MarkdownNoteSink` wiring.

See [README.md](README.md) for the user-facing behaviour and the verification
gate.

## Commands

```bash
npm install
npm test              # bun:test
npx tsc --noEmit      # typecheck; tsconfig includes main.ts
npm run build         # esbuild -> main.js
```

`OBSIDIAN_PLUGIN_DIR` may be set in a developer's environment, in which case
**every build copies straight into their live vault**. Be deliberate about when
you build, and leave the vault holding a build from committed code.

## Pushing and merging your work

This repository is public. You can commit, push and merge your own work as part
of finishing the work; send work from outside the repository through a pull
request. Confirm only before force-pushing or rewriting published history.

That is permission to push *your* work. It is not permission to commit someone
else's uncommitted changes — stage explicit paths, never `git add -A`, `git add .`
or `git commit -a`, and read `git diff --cached` before committing when the
working tree has changes you did not make.

## Core is pinned by tag, so publish before you consume

`package.json` pins `"shorthand-core": "github:mshish/shorthand-core#<tag>"`.
It is not a path dependency or a workspace link, so **a local edit in the core
checkout is invisible here.** `node_modules/shorthand-core` is a fetched copy of
whatever tag is pinned.

For a feature spanning both repos: land and tag the core change first, then bump
the pin **as the first step** of the work here, so everything after it compiles
against the real dependency and `main` stays buildable from a clean checkout at
every commit. Do not reach for a junction, an `overrides` entry or a `file:`
dep — core is free to publish, and a real tag is simpler than any of them.

[README.md](README.md#bumping-core) documents the bump procedure and the three
traps in it. The one that wastes the most time: `npm install` can report success
while leaving the lockfile on the old commit and `node_modules` on the old
version. Verify the installed version rather than trusting the install.

## The settings surface

`src/settings.ts` holds every rule — defaults, normalization, validation,
resolution. `main.ts` holds Obsidian wiring only.

That split is deliberate and load-bearing: `node_modules/obsidian` has
`"main": ""` and ships only type declarations, so there is no runtime module and
nothing in `main.ts` can be imported under `bun test`. Anything expressed in
`main.ts` is verifiable only by typecheck, the bundle smoke test, and a human
clicking through Obsidian. **Put rules in `src/settings.ts` where they can be
tested; keep `main.ts` thin enough that reading it is sufficient review.**

Settings that override a core default store `""` for "use the default" rather
than copying the default's current value. A user who never touches the setting
then keeps inheriting improvements to core instead of being frozen at whatever
the text said the day they installed.

`normalizePluginSettings` is the trust boundary for `data.json`, which is
user-editable and may be malformed or hand-written. Every key validates and
falls back; nothing throws.

## Obsidian API constraints

`manifest.json` declares `minAppVersion: 1.5.0` and the repo builds against
`obsidian: 1.5.7` typings. The declarative settings API — the one with a
first-class `textarea` control — requires 1.13.0+ and is therefore unavailable.
Do not reach for it without raising the floor, which means dropping users.

For the imperative `display()` API this plugin uses, Obsidian's guidance is that
multi-line input belongs in a form modal rather than a settings-tab textarea.
`Setting.addTextArea` exists but is the undocumented path. `NotePromptModal`
follows the modal pattern; `ScaffoldModal` is the other local example.

Prefer Obsidian's own components over hand-rolled DOM: `Setting`, `Modal`,
`setHeading()`. They carry the focus behaviour, ARIA attributes and mobile
layout that custom markup silently drops.

## Code style

- Named exports; `Readonly<{...}>` for settings shapes
- Strict TypeScript, no `any`
- User-facing copy in the settings tab follows
  [docs/settings-copy-style.md](docs/settings-copy-style.md) — nine rules, each
  with the primary source it comes from. Read it before writing a `setName` or
  a `setDesc`
- Do not match the register of the neighbouring rows. That instruction is what
  this rule replaced, and it is how the descriptions grew to five sentences: a
  rule that only ever ratchets one way
- Comments explain *why* and name the failure they prevent; never restate the
  code, and never describe behaviour the code does not implement

## Commits

Conventional prefixes (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `test:`),
explaining *why* rather than what.

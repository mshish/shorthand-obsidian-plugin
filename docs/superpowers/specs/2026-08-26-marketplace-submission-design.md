# Publishing Shorthand to the Obsidian community directory

Design for getting `obsidian-shorthand` listed in Obsidian's community plugin
directory. Written 2026-08-26 against the submission process as it stands now,
which is not the process most documentation and blog posts still describe.

## What changed, and why it matters here

Submission is no longer a pull request against `obsidianmd/obsidian-releases`.
That workflow is obsolete. Authors now sign in at `community.obsidian.md` with
an Obsidian account, link a GitHub account, select a repository, and complete
the submission in a developer dashboard. An automated reviewer runs within
minutes and reports errors back to the dashboard. It re-scans **every**
release, not just the first, so a plugin can be pulled from search later by a
bad version.

Three consequences shape this work:

- **Closed source is no longer accepted.** The reviewer reads the repository at
  the HEAD of its default branch. A plugin whose source it cannot read, or
  whose dependencies it cannot resolve, cannot be listed.
- **The plugin cannot be listed alone.** It is a wrapper. Its dependency
  `shorthand-core` and the desktop app it drives both have to be reachable.
- **Policy compliance is a README obligation, not a code one.** Obsidian's
  developer policies require specific disclosures in the README for network
  use, account requirements, and file system access outside the vault. This
  plugin does all three.

## Scope

In scope: everything required to submit `obsidian-shorthand` and have the
automated review pass, plus the CI and release automation that keeps it passing
on subsequent releases.

Out of scope: building or signing installers for the Shorthand desktop app;
any change to enhancement behaviour, note writing or the marker contract; the
Google conformance path in `shorthand-config`.

## Assumptions

- `mshish/shorthand-core` and `mshish/shorthand` are public by the time this
  work starts. The plugin repository becomes public as part of it.
- `shorthand-core` stays a pinned GitHub tag dependency. It is not moving to
  npm and is not being vendored.
- The plugin remains free. It is labelled Free in the directory.

## Design

### A. Open sourcing and repository hygiene

This gates everything else; nothing downstream can be verified until the three
repositories are readable.

Going public invalidates three things currently written down as true:

- `README.md` line 3 links the driving app to `https://github.com/cjpais/Shorthand`.
  **That repository does not exist.** The app is `mshish/shorthand`, a fork of
  `cjpais/Handy`. A reader following that link today reaches a 404. This is the
  single most user-visible defect in the repository.
- `README.md` § Install describes BRAT installation requiring a fine-grained
  personal access token "because this repository is private". False once public.
- `AGENTS.md` § "This repo is private, and pushing needs no permission" states
  a working agreement premised on the repository being single-user and private.
  Both halves stop holding.

Obsidian's copyright policy requires respecting upstream licenses and giving
attribution. The bundle carries the Claude Agent SDK, `ai`, `@ai-sdk/*`,
`googleapis`, `google-auth-library`, `marked`, `xstate` and `zod`. A
third-party attribution section in the README, generated from the resolved
dependency tree rather than hand-listed, satisfies this and stays correct as
the tree moves.

`LICENSE` is already MIT and present at the root, which is a hard requirement.

### B. Manifest and identity

`id: "shorthand"` satisfies every documented constraint — lowercase and
hyphens only, does not contain `obsidian`, does not end in `plugin` — and no
entry with that id exists in the community list. `name: "Shorthand"` likewise:
Basic Latin, no punctuation, does not contain `Obsidian` or `Plugin`, does not
collide with a core feature, and is unclaimed.

`isDesktopOnly: true` is correct and is not a listing obstacle. Desktop-only
plugins that spawn child processes are already listed — Local Runner and Codex
AI Agent are both live and both spawn local processes for the same reason this
one does.

Two fields need correcting rather than adding. `author` reads
`"Shorthand contributors"` while `package.json` and `LICENSE` both say
Michael Sciscenti; the manifest is what the directory displays, so it should
match the license. `authorUrl` is absent and is the field that gives a listing
somewhere to point.

`minAppVersion` stays `1.5.0`. Raising it would buy the declarative settings
API, which `AGENTS.md` records as a deliberate non-goal because it drops users.

`versions.json` is already correct in shape and gains an entry per release
through the existing `version-bump.mjs`.

### C. Passing the automated review

The automated reviewer's ruleset is `eslint-plugin-obsidianmd`, published by
Obsidian. That makes the gate reproducible locally: install the plugin, run it,
fix what it reports, and the dashboard should agree.

The repository has no ESLint configuration at all today. It gains a flat config
extending `obsidianmd.configs.recommended` with `@typescript-eslint/parser`
pointed at `tsconfig.json`, and an `npm run lint` script wired into both the
manual gate and CI.

Already verified clean by inspection: no `innerHTML`, `outerHTML` or
`insertAdjacentHTML`; no default hotkeys; no `MyPlugin`/`SampleSettingTab`
placeholder names; no `window.app` or global `app` access.

Expected findings:

- `main.ts:346` calls `console.log` unconditionally. The guidelines are that the
  developer console shows error messages only in a default configuration. The
  repository already has the right mechanism for this — `main.ts:701` gates a
  `console.debug` behind the `debugLogging` setting. This call should use it.
- `node:` imports in `main.ts` and `src/llm-credentials-writer.ts` will trip the
  Platform rule. `isDesktopOnly: true` is a manifest declaration and does not
  satisfy a lint rule that looks for `Platform.isDesktop` guards at the call
  site. Whether to guard or to disable the rule with a comment naming
  `isDesktopOnly` as the reason is a judgement call for implementation; the rule
  exists for plugins that are *not* desktop-only.
- Sentence case on user-facing strings. The settings copy already follows a
  house style documented in `docs/settings-copy-style.md`; expect the rule to
  disagree in places and to need a brand-name allowlist for "Shorthand",
  "Obsidian", "Claude", "OpenAI", "Ollama".
- A deprecation warning steering `display()` toward `getSettingDefinitions()`.
  Ignore it. That API requires 1.13.0+, above this plugin's floor.

Findings are fixed, not suppressed, unless the suppression carries a comment
naming the specific reason the rule does not apply.

### D. Bundle size

`main.js` is 13,077,715 bytes. 9,631,462 of those — 74% — are a single inline
sourcemap line. The code is roughly 3.4 MB.

Obsidian Sync refuses files above 5 MB. A user who installs this plugin and
syncs their vault gets a partially copied plugin folder with no clear error.
That is a real defect for real users, independent of the review.

`esbuild.config.mjs` currently inlines the sourcemap in production too, and
explains why:

> Inline in production too, unlike the sample. The bundle-load test asserts a
> recorded byte baseline; dropping the sourcemap only in prod would make that
> baseline mean two different things depending on which script produced main.js.

That baseline was deleted in `3889598` ("test: drop the bundle-size drift
reporter"). `test/plugin-bundle.test.ts` contains no size assertion. The
constraint that forced the deviation is gone, and the comment now protects
nothing. Production builds drop the sourcemap; watch builds keep it. The
comment is replaced with the reason that will still be true in a year — Sync
refuses files above 5 MB — rather than a reference to a test that no longer
exists.

Second, `googleapis` is a very large dependency and this plugin has no Google
surface. Core exports Google support behind a separate `/google` entry point
precisely so consumers that do not want it do not pay for it. Whether
tree-shaking is actually dropping it needs measuring rather than assuming; if
it is not, that is a larger win than the sourcemap.

The bundle stays unminified. Obsidian's policies prohibit obfuscating code to
hide its purpose, and while minification is not obfuscation, an unminified
bundle is unambiguously reviewable and the size argument for minifying
evaporates once the sourcemap is gone.

### E. README disclosures

Obsidian's developer policies require a README to disclose, clearly, several
things this plugin does. This is a listing requirement, not documentation
polish.

Required disclosures, all of which apply:

- **Remote services and why.** Which of Anthropic, OpenAI, an
  OpenAI-compatible endpoint or a local Ollama server is contacted, under which
  backend, carrying what. A reader must be able to tell what leaves the machine.
- **An account or key is required for full access.** The Claude Agent SDK
  backend needs the `claude` CLI installed and logged in. The LLM provider
  backend needs an API key. Neither backend works without one of the two.
- **File system access outside the vault.** The plugin writes
  `llm-credentials.json` to `%APPDATA%\Shorthand`, `~/Library/Application
  Support/Shorthand` or `$XDG_CONFIG_HOME/shorthand`. The reasoning — that
  `data.json` is plaintext and syncs — is already written and good; it needs to
  appear as a disclosure and not only as a design note.
- **Local process execution.** The plugin spawns the Shorthand desktop app with
  `--follow-stream`, the `claude` CLI, and a node subprocess.
- **No telemetry.** Client-side telemetry is prohibited outright. Saying plainly
  that there is none is cheap and forecloses the question.
- **Third-party attribution**, per section A.

The README is currently a contributor document with a user-facing preamble. It
inverts: a user-facing top covering what the plugin does, what it requires, how
to install it, and the disclosures above; with the dev loop, the verification
gate, § "Cutting a release" and § "Bumping core" moving to `CONTRIBUTING.md`.
The move is a relocation, not a rewrite — that content is accurate and hard
won.

### F. First-run backend picker

Today the plugin defaults to the Claude Agent SDK backend, which needs a
separately installed CLI and a logged-in account. A user installing from the
directory has no signal that this is required until an enhancement pass fails.

Obsidian has no onboarding API, but the pattern is well established and cheap:
open a modal gated on a setting, from `workspace.onLayoutReady()` rather than
`onload()`. The distinction matters — Obsidian's own guidance is that `onload`
does only what initialization requires and nothing expensive.

The modal presents the two backends and the tradeoff that actually
distinguishes them, which is not cost but capability:

- **Claude Agent SDK** — needs the `claude` CLI installed and logged in. Can
  read elsewhere in the vault, so notes can reference people, projects and
  prior meetings found in other files.
- **LLM provider** — needs only an API key, for OpenAI, Anthropic, an
  OpenAI-compatible endpoint or a local Ollama model. Cannot use Read, Glob or
  Grep, so no pass looks outside the current note.

Both descriptions already exist in the README § "Enhancement backends" and
should be compressed from there rather than newly invented.

Structure follows `AGENTS.md`: the rule deciding whether the picker is owed
lives in `src/settings.ts` where `bun test` can reach it, along with its
`normalizePluginSettings` handling and fallback. `main.ts` gets only the
Obsidian wiring. The modal follows `NotePromptModal` and uses `Setting` and
`setHeading()` rather than hand-rolled DOM.

The gating state is a new persisted field. It stores whether the choice has been
made, not which backend was chosen — a user who picks Claude and later switches
in settings must not be asked again, and a user upgrading from an existing
install must not be interrupted by a modal for a decision they already made
implicitly. Existing installs are treated as having completed setup.

A command reopens the picker so the choice is not one-shot.

### G. CI and release automation

`README.md` § Verification currently records:

> There is **no CI in this repository yet**: a GitHub Actions default token
> cannot clone another private repository, so a workflow could not install core.
> CI arrives when core goes public.

Core goes public in section A. This is that.

Two workflows:

- **`ci.yml`** on pull requests and pushes to `main`: install, `tsc --noEmit`,
  `bun test`, `npm run lint`, `npm run build`. This is the gate `AGENTS.md`
  currently assigns to a human, mechanised. The bundle-load smoke test in
  `test/plugin-bundle.test.ts` matters most here; it exists because CI once
  built a bundle it never required, and shipped a load failure green.
- **`release.yml`** on tag push, from Obsidian's official template: build,
  `actions/attest@v4` artifact attestation over the release assets, then a
  **draft** release carrying `main.js` and `manifest.json`. No `styles.css` —
  the plugin has none, and the template's reference to it is removed rather
  than left to fail.

The tag is an annotated tag equal to the `manifest.json` version with no `v`
prefix. `version-bump.mjs` already produces a matching `manifest.json` and
`versions.json` through `npm version`.

Releases stay drafts until a human publishes them, so a bad build is caught
before the directory scans it.

### H. Submitting

1. Sign in at `community.obsidian.md` with an Obsidian account.
2. Link the GitHub account, which is how repository ownership is verified.
3. Select `mshish/obsidian-shorthand` and complete the dashboard steps,
   including the pricing label (Free) and the capability disclosures.
4. The directory reads `manifest.json` at the HEAD of the default branch, so
   `main` must already carry the submitted version.
5. Read the automated review result, which arrives in minutes.
6. For each error: fix, bump the version, cut a release, let it re-scan.

A passing plugin is searchable in-app within 24 hours. A failing one is removed
from search within the same window, which is why section G keeps releases as
drafts.

`0.1.0` is already tagged. The submission needs a fresh version. `0.2.0` is the
honest reading — this carries a user-visible behaviour change in the first-run
picker and no breaking change to the plugin's own surface.

## Sequencing

```
A (public repos, README link fix, attribution)
├─ B (manifest)          ─┐
├─ C (eslint + fixes)     │
├─ D (bundle)             ├─ independent, any order
├─ E (README disclosures) │
└─ F (first-run picker)  ─┘
                          │
                          └─ G (CI + release workflows)
                                │
                                └─ 0.2.0 release
                                      │
                                      └─ H (submit)
```

A is a hard gate: C, D and G cannot be verified against a dependency nobody can
install. G comes after B–F so its first run gates real content. H comes last
because the directory reads `main`.

## Verification

Per workstream, the evidence that it is done:

- **A** — the three repositories load anonymously; every link in `README.md`
  resolves; `AGENTS.md` no longer claims the repository is private.
- **B** — `manifest.json` validates against the manifest schema; `author`
  matches `LICENSE`.
- **C** — `npm run lint` exits zero; every remaining suppression carries a
  comment naming why the rule does not apply.
- **D** — production `main.js` is under 5 MB, measured, and the recorded number
  appears in the commit message; `test/plugin-bundle.test.ts` still loads it.
- **E** — each of the six required disclosures is findable in the README by a
  reader who has not read this spec.
- **F** — `bun test` covers the gating rule and its `normalizePluginSettings`
  fallback; a human confirms in Obsidian that a fresh install shows the modal,
  an existing install does not, and the command reopens it.
- **G** — a tag push produces a draft release with both assets attached and an
  attestation; CI is red on a deliberately broken branch.
- **H** — the dashboard reports no errors and the plugin is installable from
  within Obsidian.

## Risks

**The desktop app has no installers.** `mshish/shorthand` is a Tauri
application with no published releases. Going public makes it buildable, not
installable. A user who finds this plugin in the directory and cannot obtain the
app has a plugin that does nothing, and Obsidian removes projects that are
broken or abandoned. Building and signing Tauri installers for three platforms
is out of scope here and is its own project. Until it exists, the README must be
unambiguous that the plugin requires an application the reader has to build,
and the decision to submit anyway is taken with that understood.

**Every release is re-scanned.** A rule added to `eslint-plugin-obsidianmd`
later can fail a future release of a plugin that passed. `npm run lint` in CI
with the plugin unpinned surfaces that at pull-request time instead of at
release time.

**Core's tag pin and the directory's view of HEAD can diverge.** The reviewer
resolves dependencies from `package.json` at HEAD. `README.md` § "Bumping core"
already documents that npm can report a successful install while leaving the
lockfile and `node_modules` on the old commit. That trap now has a second
victim: a green local build proving nothing about what the reviewer resolves.
CI installing from a clean checkout is the mitigation.

## Sources

- <https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin>
- <https://obsidian.md/blog/future-of-plugins/>
- <https://docs.obsidian.md/Developer+policies>
- <https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines>
- <https://docs.obsidian.md/Reference/Manifest>
- <https://docs.obsidian.md/Plugins/Releasing/Release+your+plugin+with+GitHub+Actions>
- <https://github.com/obsidianmd/eslint-plugin>

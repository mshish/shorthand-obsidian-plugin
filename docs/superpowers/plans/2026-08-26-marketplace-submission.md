# Obsidian community directory submission — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get `obsidian-shorthand` accepted into Obsidian's community plugin directory, and keep it accepted on every subsequent release.

**Architecture:** Nine tasks. Task 1 unblocks everything by making the repository and its documentation true once public. Tasks 2–7 are independent and can run in any order or in parallel: manifest, lint, bundle size, README disclosures, and a first-run backend picker. Task 8 mechanises the verification gate that `AGENTS.md` currently assigns to a human. Task 9 cuts the release and submits.

**Tech Stack:** TypeScript 5.9 (strict, no `any`), esbuild 0.25 bundling to CommonJS for Electron, `bun test` for unit tests, npm for dependency installation, ESLint 9 flat config with `eslint-plugin-obsidianmd`, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-26-marketplace-submission-design.md`

## Global Constraints

Every task's requirements implicitly include these.

- **Obsidian API floor is `minAppVersion: 1.5.0`**, typings pinned at `obsidian: 1.5.7`. The declarative settings API (`getSettingDefinitions()`) needs 1.13.0+ and is unavailable. Use the imperative `display()` API.
- **`main.ts` cannot be imported under `bun test`.** `node_modules/obsidian` has `"main": ""` and ships only type declarations. Anything expressed in `main.ts` is verified only by `tsc --noEmit`, `test/plugin-bundle.test.ts`, and a human in Obsidian. **Put every rule in `src/settings.ts`; keep `main.ts` to Obsidian wiring.**
- **Settings that override a core default store `""`**, meaning "use the default", never a copy of the default's current value.
- **`normalizePluginSettings` is the trust boundary for `data.json`.** It is user-editable and may be hand-written or malformed. Every key validates and falls back. Nothing throws.
- **Named exports. `Readonly<{...}>` for settings shapes. Strict TypeScript, no `any`.**
- **Comments explain *why* and name the failure they prevent.** Never restate the code. Never describe behaviour the code does not implement.
- **Commits use conventional prefixes** (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `test:`) and explain *why*.
- **Never `git add -A`, `git add .`, or `git commit -a`.** Stage explicit paths. Read `git diff --cached` before committing if the tree has changes you did not make.
- **`OBSIDIAN_PLUGIN_DIR` may be set in the environment, in which case every build copies straight into a live vault.** Be deliberate about when you build; leave the vault holding a build from committed code.
- **UI copy is sentence case**, per Obsidian's guidelines and `docs/settings-copy-style.md`. "Enhancement backend", not "Enhancement Backend".
- **The three enhancement backends are exactly `["claude-agent-sdk", "llm", "codex"]`**, defined once in `ENHANCEMENT_BACKENDS` in `src/settings.ts` and narrowed through `isEnhancementBackend`. Never restate these literals anywhere else.
- **Release tags are lightweight** and equal `manifest.json`'s `version` with no `v` prefix. This differs from `shorthand-core`'s annotated tags on purpose — do not harmonise them.
- **The plugin has no `styles.css`.** Do not add one and do not reference one.

---

## File Structure

**Created:**

| Path | Responsibility |
| --- | --- |
| `eslint.config.js` | The flat ESLint config extending `obsidianmd.configs.recommended`. This *is* the automated reviewer's ruleset; the file exists so the gate is reproducible locally. |
| `CONTRIBUTING.md` | Everything a contributor needs and a user does not: dev loop, verification gate, cutting a release, bumping core. Relocated from `README.md`. |
| `.github/workflows/ci.yml` | Typecheck, test, lint and build on pull requests and pushes to `main`. |
| `.github/workflows/release.yml` | Tag-triggered build, attestation, and draft release with `main.js` and `manifest.json`. |
| `test/plugin-setup.test.ts` | Tests for the first-run picker's gating rule and its `normalizePluginSettings` handling. |

**Modified:**

| Path | Change |
| --- | --- |
| `manifest.json` | `author`, `authorUrl`. |
| `README.md` | Fix the dead app link; add the six policy disclosures; move contributor content out. |
| `AGENTS.md` | The "this repo is private" working agreement stops being true. |
| `esbuild.config.mjs` | Drop the production sourcemap; replace the stale justification comment. |
| `package.json` | `lint` script, ESLint devDependencies. |
| `src/settings.ts` | `setupCompleted` field, its normalization, and `isSetupPickerOwed`. |
| `main.ts` | Gate the chatty `console.log`; open the picker from `onLayoutReady`; add the reopen command. |

---

## Task 1: Make the repository true once public

Nothing downstream can be verified while `shorthand-core` cannot be installed by anyone but its owner. This task assumes `mshish/shorthand-core` and `mshish/shorthand` are already public, and fixes the three places this repository asserts otherwise — plus the one link that is simply wrong.

**Files:**
- Modify: `README.md` (line 3; the `### With BRAT` block under `## Install`)
- Modify: `AGENTS.md` (§ "This repo is private, and pushing needs no permission")

**Interfaces:**
- Consumes: nothing.
- Produces: a repository a stranger can clone, install and build. Tasks 3, 4 and 8 depend on that.

- [ ] **Step 1: Confirm the three repositories are readable anonymously**

```bash
for r in mshish/obsidian-shorthand mshish/shorthand-core mshish/shorthand; do
  printf '%s ' "$r"
  curl -s -o /dev/null -w '%{http_code}\n' "https://api.github.com/repos/$r"
done
```

Expected: `200` on all three. A `404` means the repository is still private (the GitHub API returns 404, not 403, for private repositories to unauthenticated callers). **Stop and report** if any is not 200 — every later task in this plan assumes all three are public.

- [ ] **Step 2: Verify a clean-checkout install actually resolves core**

This is the thing the automated reviewer will do, and the one `README.md` § "Bumping core" warns can silently succeed against a stale cache.

```bash
tmp=$(mktemp -d)
git -C "$tmp" clone --depth 1 https://github.com/mshish/obsidian-shorthand.git plugin
cd "$tmp/plugin" && npm install --no-audit --fund=false
node -p "require('./node_modules/shorthand-core/package.json').version"
```

Expected: `0.10.0`, matching the tag pinned in `package.json`. A different version means npm resolved from cache — the trap that section documents.

- [ ] **Step 3: Fix the dead application link in `README.md`**

Line 3 currently reads:

```markdown
Granola-style meeting notes for Obsidian, driven by [Shorthand](https://github.com/cjpais/Shorthand)'s
```

`https://github.com/cjpais/Shorthand` **does not exist** — it returns 404. The application this plugin drives is `mshish/shorthand`, a fork of `cjpais/Handy`. Replace with:

```markdown
Granola-style meeting notes for Obsidian, driven by [Shorthand](https://github.com/mshish/shorthand)'s
```

Then check every other link in the file resolves:

```bash
grep -o 'https://[^)"[:space:]]*' README.md | sort -u | while read -r u; do
  printf '%s %s\n' "$(curl -s -o /dev/null -w '%{http_code}' -L "$u")" "$u"
done
```

Expected: no `404` lines.

- [ ] **Step 4: Replace the BRAT paragraph, which now describes a private repository**

Under `## Install`, `### With BRAT` currently says BRAT needs a fine-grained personal access token "because this repository is private". Replace that paragraph with:

```markdown
BRAT installs from a **release**, not from the repository tree. Add
`mshish/obsidian-shorthand` as a beta plugin in BRAT's settings.
```

- [ ] **Step 5: Rewrite the `AGENTS.md` working agreement**

The section is headed "This repo is private, and pushing needs no permission" and premises a single-user private repository. Both halves stop holding: the repository is public and may take contributions. Replace the heading and its first paragraph with a statement that the repository is public, that the maintainer's own work may be pushed without asking, and that anything arriving from outside goes through a pull request and CI. **Keep verbatim** the paragraph beginning "That is permission to push *your* work" — the staging discipline it describes is unrelated to visibility and still applies.

- [ ] **Step 6: Verify no stale privacy claim survives**

```bash
grep -rni "private repo\|is private\|repository is private\|while this repo is private" README.md AGENTS.md CLAUDE.md
```

Expected: one surviving hit in `README.md` § "Cutting a release" — "it does nothing while this repo is private" about `versions.json`. Fix that sentence too; `versions.json` is now read from the default branch and does real work.

- [ ] **Step 7: Commit**

```bash
git add README.md AGENTS.md
git commit -m "docs: correct what going public makes false

The app link pointed at cjpais/Shorthand, which does not exist -- the app
is mshish/shorthand, a fork of cjpais/Handy. BRAT no longer needs a token,
versions.json is now actually read, and the private-repo working agreement
in AGENTS.md no longer describes this repository."
```

---

## Task 2: Manifest and identity

**Files:**
- Modify: `manifest.json`

**Interfaces:**
- Consumes: nothing.
- Produces: the manifest the directory displays. Task 9 submits it.

- [ ] **Step 1: Re-confirm the id and name are still unclaimed**

Both were free when this plan was written. They are first-come, so check again immediately before submitting.

```bash
curl -sL https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json \
  | grep -in '"id": "shorthand"\|"name": "Shorthand"'
```

Expected: no output. If either is taken, **stop and report** — the id is not changeable after listing and the choice needs a human.

- [ ] **Step 2: Correct `author` and add `authorUrl`**

`manifest.json` says `"author": "Shorthand contributors"`, while `LICENSE` and `package.json` both say Michael Sciscenti. The manifest is what the directory displays to users, so it should agree with the license.

```json
{
  "id": "shorthand",
  "name": "Shorthand",
  "version": "0.1.0",
  "minAppVersion": "1.5.0",
  "description": "Capture Shorthand transcripts and maintain an AI-owned meeting-note summary.",
  "author": "Michael Sciscenti",
  "authorUrl": "https://github.com/mshish",
  "isDesktopOnly": true
}
```

Leave `version` at `0.1.0`; Task 9 bumps it through `npm version`, which is what keeps `manifest.json`, `versions.json` and `package.json` in agreement.

Do **not** add `fundingUrl` unless the maintainer asks — an absent field is cleaner than an empty one.

- [ ] **Step 3: Verify the manifest against every documented constraint**

Check by hand, and record the result in the commit message:

| Field | Constraint | This manifest |
| --- | --- | --- |
| `id` | lowercase and hyphens only; no `obsidian`; must not end in `plugin` | `shorthand` — passes |
| `name` | Basic Latin; no punctuation beyond `- + ( )`; not a core feature; no `Obsidian` or `Plugin` | `Shorthand` — passes |
| `version` | semver `x.y.z` | `0.1.0` — passes |
| `minAppVersion` | present | `1.5.0` — passes |
| `description` | present, sentence case | passes |
| `author` | present | passes |
| `isDesktopOnly` | present; true when the plugin needs Node or Electron | `true`, and it spawns child processes — correct |

- [ ] **Step 4: Confirm it still parses and the build still runs**

```bash
node -e "const m=require('./manifest.json'); if(m.version!==require('./package.json').version) throw new Error('version drift'); console.log('ok', m.id, m.version)"
```

Expected: `ok shorthand 0.1.0`

- [ ] **Step 5: Commit**

```bash
git add manifest.json
git commit -m "chore: name the actual author in the manifest

The manifest said 'Shorthand contributors' while LICENSE and package.json
both say Michael Sciscenti, and the manifest is what the directory shows.
authorUrl gives the listing somewhere to point."
```

---

## Task 3: ESLint, which is the automated reviewer's ruleset

The directory's automated review runs `eslint-plugin-obsidianmd`. Installing it locally turns an opaque remote gate into a command. Do this before the cosmetic work in Tasks 4–7, because its findings may change what those tasks touch.

**Files:**
- Create: `eslint.config.js`
- Modify: `package.json`
- Modify: `main.ts`, `src/*.ts` as findings require

**Interfaces:**
- Consumes: nothing.
- Produces: `npm run lint`, which Task 8 wires into CI.

- [ ] **Step 1: Install ESLint and the Obsidian plugin**

```bash
npm install --save-dev eslint eslint-plugin-obsidianmd @typescript-eslint/parser @typescript-eslint/eslint-plugin
```

- [ ] **Step 2: Create `eslint.config.js`**

```javascript
// The Obsidian community directory's automated review runs this exact plugin. Keeping the
// config here — and unpinned in package.json — is what makes a rule added upstream fail a
// pull request rather than a release the directory has already scanned.
import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  {
    ignores: ["main.js", "node_modules/**", ".worktrees/**"],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
    },
  },
]);
```

`main.js` is in `ignores` because it is a 3 MB generated bundle; linting it is meaningless and slow.

- [ ] **Step 3: Add the `lint` script to `package.json`**

In the `scripts` block, alongside the existing entries:

```json
"lint": "eslint .",
```

- [ ] **Step 4: Run it and capture the full finding list**

```bash
npm run lint 2>&1 | tee /tmp/lint-findings.txt; tail -5 /tmp/lint-findings.txt
```

Expected: failures. Read every one before fixing any. Findings are **fixed, not suppressed**, unless the suppression carries a comment naming the specific reason the rule does not apply to this plugin.

- [ ] **Step 5: Fix the unconditional `console.log`**

This one is known in advance. `main.ts:376` logs once per transcript delta:

```typescript
        if (enhancer !== undefined && this.settings.enableLiveEnhancement) {
          enhancer.requestTick();
          console.log(
            `[shorthand] transcript +${delta.length} chars; pending ${enhancer.state.pendingCharacters}/${this.settings.minNewChars} toward next pass`,
          );
        }
```

Obsidian's guidelines are that the developer console shows error messages only in a default configuration. This is the chattiest possible violation — every utterance of every meeting. The repository already has the mechanism: `main.ts:701` gates a `console.debug` behind the `debugLogging` setting. Use it, matching that line's shape:

```typescript
        if (enhancer !== undefined && this.settings.enableLiveEnhancement) {
          enhancer.requestTick();
          // Gated like the status trace below it: this fires once per transcript delta, and
          // the guidelines are that a default configuration shows errors in the console and
          // nothing else.
          if (this.settings.debugLogging) {
            console.debug(
              `[shorthand] transcript +${delta.length} chars; pending ${enhancer.state.pendingCharacters}/${this.settings.minNewChars} toward next pass`,
            );
          }
        }
```

Note `debugLogging` is documented as snapshotted per capture; reading `this.settings` live here matches the existing `main.ts:701` call, so the two stay consistent.

- [ ] **Step 6: Decide the `node:` import findings deliberately**

The Platform rule flags `node:` imports not guarded by `Platform.isDesktop`. `main.ts` imports `node:fs`, `node:fs/promises` and `node:path`; `src/llm-credentials-writer.ts` imports `node:fs/promises`, `node:crypto` and `node:path`.

The rule exists for plugins that are **not** desktop-only. This one declares `isDesktopOnly: true`, which Obsidian honours by refusing to load it on mobile at all — so the guard can never be false. Do not add dead guards. Disable the rule for these files in `eslint.config.js` with a comment naming the reason:

```javascript
  {
    // manifest.json declares isDesktopOnly, so Obsidian never loads this plugin where a
    // Platform.isDesktop guard could be false. Adding the guards the rule wants would add
    // branches no runtime can take. The rule is for plugins that ship to mobile.
    files: ["main.ts", "src/llm-credentials-writer.ts"],
    rules: { "obsidianmd/platform": "off" },
  },
```

Confirm the rule's actual name from the finding output before writing it — the id above must match what the linter reported.

- [ ] **Step 7: Configure the sentence-case rule's brand allowlist**

The rule lowercases words it does not recognise as proper nouns. This plugin's copy legitimately contains `Shorthand`, `Obsidian`, `Claude`, `Codex`, `OpenAI`, `Anthropic` and `Ollama`. Add them to the rule's configured brand names rather than rewriting correct copy. Take the option name from the rule's own documentation in the finding output.

Where the rule is right — a genuinely title-cased UI string — fix the copy, matching `docs/settings-copy-style.md`.

- [ ] **Step 8: Ignore the `getSettingDefinitions()` deprecation**

Expect a finding steering `display()` toward `getSettingDefinitions()`. That API needs Obsidian 1.13.0+; this plugin's floor is 1.5.0 and `AGENTS.md` records raising it as a deliberate non-goal because it drops users. Disable that single rule globally with a comment naming the version floor as the reason.

- [ ] **Step 9: Run the full gate**

```bash
npm run lint && npx tsc --noEmit && npm test
```

Expected: all three pass. `npm test` is `bun test`; it includes the bundle-load smoke, which will rebuild `main.js` if missing.

- [ ] **Step 10: Commit**

```bash
git add eslint.config.js package.json package-lock.json main.ts
git commit -m "chore: lint against the directory's own ruleset

eslint-plugin-obsidianmd is what the community directory's automated review
runs, so running it here turns a remote gate into a command. The one
behaviour change is the per-delta console.log, which fired on every
utterance of every meeting against a guideline that a default configuration
logs errors only."
```

---

## Task 4: Bring the bundle under Obsidian Sync's 5 MB cap

**Files:**
- Modify: `esbuild.config.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: a `main.js` Task 9 can ship.

- [ ] **Step 1: Record the current size and the sourcemap's share of it**

```bash
npm run build
wc -c < main.js
awk '/sourceMappingURL=data:application\/json/{print "sourcemap bytes:", length($0)}' main.js
```

Expected at the time of writing: 13,077,715 total, 9,631,462 of it sourcemap — 74%. Record the actual numbers; they go in the commit message.

Obsidian Sync refuses files above 5 MB. A user who installs this plugin and syncs gets a partially copied plugin folder and no clear error.

- [ ] **Step 2: Confirm the comment's stated reason is genuinely stale before removing it**

`esbuild.config.mjs` justifies the production sourcemap by "the bundle-load test asserts a recorded byte baseline". Verify that baseline is gone rather than trusting the claim:

```bash
grep -n "baseline\|byteLength\|statSync\|size" test/plugin-bundle.test.ts || echo "no size assertion present"
git log --oneline -1 3889598
```

Expected: `no size assertion present`, and a commit titled `test: drop the bundle-size drift reporter`. The constraint that forced the deviation was deleted; the comment now protects nothing.

- [ ] **Step 3: Drop the production sourcemap**

Change:

```javascript
  // Inline in production too, unlike the sample. The bundle-load test asserts a recorded
  // byte baseline; dropping the sourcemap only in prod would make that baseline mean two
  // different things depending on which script produced main.js.
  sourcemap: "inline",
```

to:

```javascript
  // Watch builds only. Obsidian Sync refuses any file over 5MB, and an inlined sourcemap is
  // three quarters of this bundle -- shipping it leaves a synced vault with a half-copied
  // plugin folder and no error anywhere. Production releases are unminified instead, which
  // keeps the shipped code readable without paying for the map.
  sourcemap: prod ? false : "inline",
```

`prod` is already defined above as `process.argv[2] === "production"`.

- [ ] **Step 4: Rebuild and confirm the size**

```bash
npm run build
wc -c < main.js
```

Expected: roughly 3.4 MB, comfortably under 5,242,880. If it is still over, **stop** — Step 5 becomes required rather than exploratory.

- [ ] **Step 5: Check whether `googleapis` is reaching the bundle**

`googleapis` is very large and this plugin has no Google surface. Core exports Google support behind a separate `/google` entry point precisely so consumers that do not want it do not pay for it.

```bash
grep -c "googleapis" main.js
grep -rn "shorthand-core/google" main.ts src/ || echo "plugin does not import core/google"
```

If the plugin does not import `/google` but `googleapis` strings appear in the bundle, tree-shaking is not dropping it and there is a larger win available than the sourcemap. Report the finding; **do not** restructure core's exports as part of this task — that is a change in another repository with its own gates.

- [ ] **Step 6: Confirm the bundle still loads**

This is the test that matters. Nothing else in this repository ever *loads* `main.js`, and a bundle that builds cleanly can still throw at Obsidian load — which is how the `import.meta.url` banner came to exist.

```bash
npm test
```

Expected: pass, including `test/plugin-bundle.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add esbuild.config.mjs
git commit -m "fix: stop shipping a 9.6MB sourcemap inside main.js

Obsidian Sync refuses files over 5MB, so the 13MB bundle left synced
vaults with a half-copied plugin folder and no error. Production now
builds without the map: 13,077,715 bytes to <ACTUAL>.

The comment defending the production sourcemap cited a byte baseline in
the bundle-load test. That baseline was deleted in 3889598, so the
constraint that forced the deviation no longer exists."
```

Replace `<ACTUAL>` with the number from Step 4.

---

## Task 5: The six required README disclosures

Obsidian's developer policies require a README to disclose specific things this plugin does. This is a listing requirement, not documentation polish.

**Files:**
- Modify: `README.md`
- Create: `CONTRIBUTING.md`

**Interfaces:**
- Consumes: Task 1's link fix (do not undo it).
- Produces: the README the automated review and every prospective user reads.

- [ ] **Step 1: Move contributor content to `CONTRIBUTING.md`**

Create `CONTRIBUTING.md` and move these four `README.md` sections into it **verbatim**, adjusting only their heading levels and any cross-references that break:

- `### From source — the standard Obsidian dev loop` (including the `OBSIDIAN_PLUGIN_DIR` guidance)
- `## Verification — run this before every push`
- `## Cutting a release`
- `## Bumping core`

This is a relocation, not a rewrite. That content is accurate and hard-won — particularly the npm-cache trap in § "Bumping core" and the reasoning about lightweight tags in § "Cutting a release". Do not paraphrase it.

Add a line near the top of `README.md`: `Contributing, the dev loop and the release process: [CONTRIBUTING.md](CONTRIBUTING.md).`

- [ ] **Step 2: Correct two claims that move with § "Cutting a release"**

Inside the relocated section:

- It instructs attaching `styles.css` to the release. **The plugin has no `styles.css`.** Remove that reference. Confirm first: `ls styles.css 2>/dev/null || echo "no styles.css"`.
- The sentence about `versions.json` doing "nothing while this repo is private" is false after Task 1. `versions.json` is read from the default branch and now lets an older Obsidian resolve the newest build it can still run.

Leave the paragraph explaining why these tags are lightweight exactly as it is. It is a deliberate divergence from Obsidian's official workflow docs, correctly reasoned, and Task 8 depends on it staying true.

- [ ] **Step 3: Write the disclosures section in `README.md`**

Add a section — heading `## What this plugin accesses`, placed directly after the intro and before `## Prerequisites`, so a reader meets it before deciding to install. It must cover all six. Obsidian's policies require the first three explicitly; the last three are cheap and foreclose the question.

1. **Remote services, and why.** Name each: Anthropic, OpenAI, an OpenAI-compatible endpoint, or a local Ollama server. Say which backend contacts which, and that what leaves the machine is the meeting transcript and the note's current contents, sent to produce the summary. A reader must be able to tell what leaves their machine. Note that with a local Ollama endpoint, nothing does.
2. **An account or key is required.** The Claude Agent SDK backend needs the `claude` CLI installed and logged in. The Codex backend needs the `codex` CLI on PATH and a completed `codex login`. The LLM provider backend needs an API key. There is no configuration in which the plugin works without one of the three.
3. **File system access outside the vault.** The plugin writes `llm-credentials.json` to `%APPDATA%\Shorthand`, `~/Library/Application Support/Shorthand`, or `$XDG_CONFIG_HOME/shorthand`. The existing § "Enhancement backends" already explains *why* — `data.json` is plaintext and syncs with the vault — and that reasoning is good. Cross-reference it rather than duplicating it; what this section adds is that it is disclosed up front.
4. **Local process execution.** The plugin spawns the Shorthand desktop application with `--follow-stream`, the `claude` or `codex` CLI depending on backend, and a Node subprocess. This is why the plugin is desktop-only.
5. **No telemetry.** State plainly that the plugin collects nothing and reports nothing anywhere. Client-side telemetry is prohibited outright by policy.
6. **Third-party attribution.** A list of the bundled dependencies and their licenses, generated rather than hand-maintained so it stays true as the tree moves:

```bash
npx license-checker@25 --production --summary
```

Record the output as a short "Bundled dependencies" subsection naming at minimum `@anthropic-ai/claude-agent-sdk`, `ai`, `@ai-sdk/*`, `googleapis`, `google-auth-library`, `marked`, `xstate` and `zod`, and stating that this plugin is MIT and each dependency remains under its own license.

- [ ] **Step 4: Make the app requirement impossible to miss**

`README.md` § Prerequisites mentions Shorthand must be running. It does not say the reader has to obtain and build a separate Tauri desktop application that has no published installers. Add that plainly to § Prerequisites — a user who installs from the directory and cannot get the app has a plugin that does nothing, and Obsidian removes projects that are broken.

- [ ] **Step 5: Verify each disclosure is findable by someone who has not read the spec**

Re-read `README.md` top to bottom and confirm all six are locatable without prior knowledge. Then re-run the link check from Task 1 Step 3 across both files:

```bash
grep -oh 'https://[^)"[:space:]]*' README.md CONTRIBUTING.md | sort -u | while read -r u; do
  printf '%s %s\n' "$(curl -s -o /dev/null -w '%{http_code}' -L "$u")" "$u"
done
```

Expected: no `404` lines.

- [ ] **Step 6: Commit**

```bash
git add README.md CONTRIBUTING.md
git commit -m "docs: disclose network, credentials and process use up front

Obsidian's developer policies require a README to disclose remote service
use, an account requirement, and file system access outside the vault.
This plugin does all three and said so only in passing, halfway down a
document written for contributors. The contributor half moves to
CONTRIBUTING.md so the README answers a prospective user's questions."
```

---

## Task 6: Persist whether first-run setup has happened

The gating rule, in `src/settings.ts` where `bun test` can reach it. Task 7 adds the UI.

**Files:**
- Modify: `src/settings.ts`
- Test: `test/plugin-setup.test.ts`

**Interfaces:**
- Consumes: `ShorthandPluginSettings`, `DEFAULT_PLUGIN_SETTINGS`, `normalizePluginSettings` from `src/settings.ts`.
- Produces:
  - `ShorthandPluginSettings.setupCompleted: boolean` — a new required field on the settings shape.
  - `isSetupPickerOwed(settings: ShorthandPluginSettings): boolean`
  - `completedSetup(settings: ShorthandPluginSettings, backend: EnhancementBackend): ShorthandPluginSettings`

  Task 7 calls all three from `main.ts`.

- [ ] **Step 1: Write the failing tests**

Create `test/plugin-setup.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PLUGIN_SETTINGS,
  completedSetup,
  isSetupPickerOwed,
  normalizePluginSettings,
} from "../src/settings.js";

describe("first-run setup gating", () => {
  test("a vault with no data.json is owed the picker", () => {
    expect(isSetupPickerOwed(normalizePluginSettings(undefined))).toBe(true);
    expect(isSetupPickerOwed(normalizePluginSettings({}))).toBe(true);
  });

  test("an existing install is not interrupted for a choice it already made", () => {
    // An upgrade from a version predating this field has a populated data.json with no
    // setupCompleted key. Treating that as "never set up" would open a modal in front of a
    // user who has been running the plugin for months, over a decision their stored backend
    // already records.
    const upgraded = normalizePluginSettings({ backend: "llm", minNewChars: 250 });
    expect(isSetupPickerOwed(upgraded)).toBe(false);
  });

  test("setupCompleted survives a round trip and is not re-asked", () => {
    const chosen = completedSetup(normalizePluginSettings({}), "codex");
    expect(chosen.backend).toBe("codex");
    expect(chosen.setupCompleted).toBe(true);
    expect(isSetupPickerOwed(normalizePluginSettings(chosen))).toBe(false);
  });

  test("a malformed setupCompleted falls back rather than throwing", () => {
    // data.json is user-editable, so every key has to survive a hand-written value.
    expect(normalizePluginSettings({ setupCompleted: "yes" }).setupCompleted).toBe(false);
    expect(normalizePluginSettings({ setupCompleted: null }).setupCompleted).toBe(false);
    expect(normalizePluginSettings({ setupCompleted: true }).setupCompleted).toBe(true);
  });

  test("completing setup leaves every neighbouring setting untouched", () => {
    // Asserting only the two keys this writes cannot catch a spread that drops a field.
    const before = normalizePluginSettings({ minNewChars: 250, debugLogging: true });
    const after = completedSetup(before, "llm");
    expect(after.minNewChars).toBe(250);
    expect(after.debugLogging).toBe(true);
    expect(after.writeTranscriptNote).toBe(DEFAULT_PLUGIN_SETTINGS.writeTranscriptNote);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx bun test test/plugin-setup.test.ts
```

Expected: FAIL — `isSetupPickerOwed` and `completedSetup` are not exported from `src/settings.ts`.

- [ ] **Step 3: Add the field to the settings shape**

In `ShorthandPluginSettings`, after `debugLogging`:

```typescript
  /**
   * Whether the user has been shown the backend picker. Stores *that* a choice was made,
   * never which one — a user who picks Claude here and later switches to Codex in settings
   * has still been set up, and must not be asked twice.
   *
   * Defaults false, so a vault with no data.json is offered the picker. An existing install
   * is a populated record with this key absent, which normalization treats as completed:
   * that user chose a backend implicitly by running the plugin, and a modal in front of them
   * on upgrade would be asking about a decision already made.
   */
  setupCompleted: boolean;
```

In `DEFAULT_PLUGIN_SETTINGS`, after `debugLogging: false,`:

```typescript
  setupCompleted: false,
```

- [ ] **Step 4: Normalize the field**

In `normalizePluginSettings`, after the `debugLogging` entry:

```typescript
    setupCompleted: typeof value.setupCompleted === "boolean"
      ? value.setupCompleted
      : DEFAULT_PLUGIN_SETTINGS.setupCompleted,
```

This makes a malformed value fall back to `false`. The upgrade case — a populated record with the key absent — is handled in `isSetupPickerOwed`, not here, because `normalizePluginSettings` sees each key in isolation and cannot tell an empty record from a populated one.

- [ ] **Step 5: Add the two exported functions**

Place them near `validatePromptSettings`, which is the existing precedent for a rule that exists here rather than in `main.ts`:

```typescript
/**
 * Whether the first-run backend picker is owed. Lives here rather than in `main.ts` for the
 * same reason `validatePromptSettings` does: nothing in this repository can import `main.ts`
 * under `bun test`, so a rule left in the modal is a rule with no test at all.
 */
export function isSetupPickerOwed(settings: ShorthandPluginSettings): boolean {
  return !settings.setupCompleted;
}

/** Records the picker's outcome: the chosen backend, and that the choice was made. */
export function completedSetup(
  settings: ShorthandPluginSettings,
  backend: EnhancementBackend,
): ShorthandPluginSettings {
  return { ...settings, backend, setupCompleted: true };
}
```

- [ ] **Step 6: Handle the upgrade case**

Step 5's `isSetupPickerOwed` fails the "existing install" test — `normalizePluginSettings({ backend: "llm", minNewChars: 250 })` yields `setupCompleted: false`.

Distinguish an empty record from a populated one inside `normalizePluginSettings`, where the raw input is still visible:

```typescript
    // A populated data.json with no setupCompleted key is an install that predates this
    // field, not a fresh vault. Its user chose a backend implicitly by running the plugin;
    // opening a modal at them on upgrade would ask about a decision already made.
    setupCompleted: typeof value.setupCompleted === "boolean"
      ? value.setupCompleted
      : Object.keys(value).length > 0,
```

This makes `normalizePluginSettings({ setupCompleted: "yes" })` return `true` — a populated record — which contradicts the Step 1 test asserting `false`. Reconcile by testing the upgrade case with a record whose *other* keys are populated and the malformed case against `DEFAULT_PLUGIN_SETTINGS` semantics. Update `test/plugin-setup.test.ts` so both express what they mean:

```typescript
  test("a malformed setupCompleted falls back to the record's own shape, not to a throw", () => {
    // data.json is user-editable. A hand-written non-boolean must not throw, and must not
    // re-open the picker at a user whose file is otherwise populated.
    expect(normalizePluginSettings({ setupCompleted: "yes" }).setupCompleted).toBe(true);
    expect(normalizePluginSettings({ setupCompleted: null }).setupCompleted).toBe(true);
    expect(normalizePluginSettings({ setupCompleted: true }).setupCompleted).toBe(true);
    expect(normalizePluginSettings({}).setupCompleted).toBe(false);
    expect(normalizePluginSettings(undefined).setupCompleted).toBe(false);
  });
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npx bun test test/plugin-setup.test.ts
```

Expected: PASS, all five.

- [ ] **Step 8: Run the full suite — the new field crosses an existing trust boundary**

```bash
npm test && npx tsc --noEmit && npm run lint
```

Expected: all pass. `test/plugin-settings.test.ts` exercises `normalizePluginSettings` heavily; a new required field on a `Readonly<{...}>` shape can break its expectations. Fix any breakage there rather than loosening the type.

- [ ] **Step 9: Commit**

```bash
git add src/settings.ts test/plugin-setup.test.ts
git commit -m "feat: record whether first-run setup has happened

A user installing from the directory has no signal that the default
backend needs a separately installed CLI until an enhancement pass fails
mid-meeting. This is the gating state for a picker that says so up front.

It stores that a choice was made, not which one, so switching backend in
settings later does not re-open it -- and a populated data.json with the
key absent counts as complete, so an upgrade does not interrupt a user
over a decision they already made."
```

---

## Task 7: The first-run backend picker

**Files:**
- Modify: `main.ts` (`onload`, a new `BackendPickerModal` beside `NotePromptModal` at line 1380)

**Interfaces:**
- Consumes: `isSetupPickerOwed`, `completedSetup`, `type EnhancementBackend` from `src/settings.ts` (Task 6). `ShorthandPlugin.saveSettings(candidate: unknown): Promise<void>` and `ShorthandPlugin.settings`, both existing.
- Produces: nothing later tasks consume.

- [ ] **Step 1: Open the picker from `onLayoutReady`, not `onload`**

Obsidian's guidance is that `onload` does only what initialization requires and nothing expensive. Add at the end of `onload`, after the two existing `registerDomEvent`/`registerEvent` lines:

```typescript
    // onLayoutReady, not onload: Obsidian's guidance is that onload does only what
    // initialization requires, and a modal opened from it races the workspace it draws over.
    this.app.workspace.onLayoutReady(() => {
      if (!isSetupPickerOwed(this.settings)) return;
      new BackendPickerModal(this.app, this).open();
    });
```

Add `isSetupPickerOwed` and `completedSetup` to the existing import from `./src/settings.js`.

- [ ] **Step 2: Add the reopen command**

Alongside the existing commands in `onload`. A plain `callback`, not `checkCallback` — it needs no open note:

```typescript
    this.addCommand({
      id: "choose-enhancement-backend",
      name: "Choose enhancement backend",
      callback: () => { new BackendPickerModal(this.app, this).open(); },
    });
```

Command names carry no plugin prefix and are sentence case — the palette already renders "Shorthand: Choose enhancement backend", and spelling the prefix out here produces "Shorthand: Shorthand: …".

- [ ] **Step 3: Add `BackendPickerModal`**

Place it beside `NotePromptModal` (line 1380), following its constructor shape. Use `Setting` and `setHeading()` rather than hand-rolled DOM — they carry the focus behaviour, ARIA attributes and mobile layout that custom markup silently drops.

```typescript
/**
 * Shown once, when the plugin has never recorded a backend choice. It exists because the
 * default backend needs a separately installed CLI and a logged-in account, and nothing
 * anywhere said so until an enhancement pass failed mid-meeting.
 *
 * The three descriptions are compressed from README "Enhancement backends" and the settings
 * tab's own copy; the axis that actually distinguishes them is what has to be installed and
 * whether a pass can look outside the current note.
 */
class BackendPickerModal extends Modal {
  constructor(app: App, private readonly plugin: ShorthandPlugin) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Choose an enhancement backend");
    this.contentEl.createEl("p", {
      text: "Shorthand needs one of these to write your notes. Each has a different"
        + " prerequisite, and you can change this later in settings.",
    });

    this.choice(
      "Claude Agent SDK",
      "Needs the claude CLI installed and logged in. The only backend that can look things"
        + " up elsewhere in your vault, so notes can reference people, projects and prior"
        + " meetings from other files.",
      "claude-agent-sdk",
    );
    this.choice(
      "Codex",
      "Needs the codex CLI on your PATH and a completed codex login.",
      "codex",
    );
    this.choice(
      "LLM provider",
      "Needs only an API key, for OpenAI, Anthropic, an OpenAI-compatible endpoint or a"
        + " local Ollama model. Cannot look outside the note being written.",
      "llm",
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private choice(name: string, description: string, backend: EnhancementBackend): void {
    new Setting(this.contentEl)
      .setName(name)
      .setDesc(description)
      .addButton((button) => button
        .setButtonText("Use this")
        .onClick(() => {
          // Closed before the await, not after: leaving the modal up across a saveData()
          // invites a second click that writes the choice twice.
          this.close();
          void this.plugin.saveSettings(completedSetup(this.plugin.settings, backend));
        }));
  }
}
```

`completedSetup` returns a full `ShorthandPluginSettings`, and `saveSettings` re-normalizes whatever it is given, so the value is validated on the way to disk exactly like every other settings write.

- [ ] **Step 4: Verify the imports and types resolve**

```bash
npx tsc --noEmit
```

Expected: PASS. If `App` or `EnhancementBackend` is unimported, add it to the existing import blocks at the top of `main.ts` rather than creating new ones.

- [ ] **Step 5: Verify the bundle still loads**

This is the check that catches what `tsc` cannot. A new class in `main.ts` extends the module graph, which is the exact class of failure `test/plugin-bundle.test.ts` exists to catch.

```bash
npm run build && npm test
```

Expected: PASS, including the bundle-load smoke. If it fails on a missing `obsidian` export, `OBSIDIAN_STUB` in `test/plugin-bundle.test.ts` needs the class this modal uses — check it already exports `Modal` and `Setting`; both are present today.

- [ ] **Step 6: Confirm in Obsidian by hand**

Nothing automated can verify this — `main.ts` cannot be imported under `bun test`, so the modal's behaviour is reachable only by a human. Build into a vault and check four things:

1. A plugin folder with no `data.json` shows the modal after the workspace draws.
2. Choosing a backend closes it, and `data.json` contains that backend and `"setupCompleted": true`.
3. Reloading the plugin does **not** show it again.
4. A `data.json` with settings but no `setupCompleted` key does not show it.
5. The "Choose enhancement backend" command reopens it.

```bash
# with OBSIDIAN_PLUGIN_DIR set to the vault plugin folder
npm run build
```

Leave the vault holding a build from committed code when finished.

- [ ] **Step 7: Run the full gate and commit**

```bash
npm run lint && npx tsc --noEmit && npm test
```

```bash
git add main.ts
git commit -m "feat: ask which enhancement backend to use on first run

The default backend needs the claude CLI installed and logged in, and a
user installing from the community directory had no way to learn that
except a failed enhancement pass mid-meeting.

Opened from onLayoutReady rather than onload, per Obsidian's guidance that
onload does only what initialization requires; the gating rule is in
src/settings.ts where bun test can reach it."
```

---

## Task 8: CI and the release workflow

`README.md` § Verification records that there is no CI because "a GitHub Actions default token cannot clone another private repository, so a workflow could not install core. CI arrives when core goes public." Task 1 made core public. This is that.

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`
- Modify: `CONTRIBUTING.md` (§ Verification, § Cutting a release)

**Interfaces:**
- Consumes: `npm run lint` (Task 3), `CONTRIBUTING.md` (Task 5).
- Produces: the release assets Task 9 submits.

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
# The gate AGENTS.md assigns to a human, mechanised now that core is public and a default
# GITHUB_TOKEN can resolve the github: dependency in package.json.
name: CI
on:
  pull_request:
  push:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22.x"
      - uses: oven-sh/setup-bun@v2
      # npm install, not npm ci: package.json pins core as a github: tag dependency, and a
      # clean install from the lockfile is what proves the reviewer can resolve it too.
      - run: npm install
      - run: npx tsc --noEmit
      - run: npm run lint
      # Builds main.js as a side effect, which test/plugin-bundle.test.ts then loads. That
      # load is the point: nothing else here ever requires the bundle, and a bundle that
      # builds cleanly can still throw at Obsidian load.
      - run: npm run build
      - run: npm test
```

Node 22 matches core's `engines: { "node": ">=22" }`; the esbuild target is `node18`, which is the Electron floor and unrelated to the build host.

- [ ] **Step 2: Create `.github/workflows/release.yml`**

Obsidian's official template, with `styles.css` removed — this plugin has none, and leaving the reference makes `gh release create` fail on a missing file.

```yaml
name: Release Obsidian plugin
on:
  push:
    tags:
      - "*"

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      id-token: write
      attestations: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22.x"
      - run: npm install
      - run: npm run build
      - name: Generate artifact attestation
        uses: actions/attest@v4
        with:
          subject-path: |
            main.js
            manifest.json
      - name: Create release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          tag="${GITHUB_REF#refs/tags/}"
          gh release create "$tag" \
            --title="$tag" \
            --draft \
            main.js manifest.json
```

Two deliberate points:

- **`--draft`.** The directory re-scans every release, and a failing one is dropped from search within 24 hours. A draft is not visible to it until a human publishes.
- **`on: push: tags: "*"`** fires for lightweight tags, which is what this repository uses. Obsidian's own docs create an annotated tag; `CONTRIBUTING.md` § "Cutting a release" explains why this repository deliberately does not, and instructs against harmonising with `shorthand-core`. Do not change it.

- [ ] **Step 3: Enable workflow write permissions**

In the repository's Settings → Actions → General → Workflow permissions, select **Read and write permissions**. Without it, `gh release create` fails with a 403.

- [ ] **Step 4: Prove CI actually fails on a broken tree**

A green CI that cannot go red is worse than none — which is the failure `test/plugin-bundle.test.ts`'s own comment records.

```bash
git checkout -b ci/prove-red
printf '\nconst deliberateBreakage: number = "not a number";\n' >> src/elapsed.ts
git add src/elapsed.ts && git commit -m "test: prove CI goes red"
git push origin ci/prove-red
gh pr create --fill --title "Prove CI goes red" --body "Do not merge."
gh pr checks --watch
```

Expected: the `verify` job fails at `npx tsc --noEmit`. Then:

```bash
gh pr close ci/prove-red --delete-branch
git checkout - && git branch -D ci/prove-red
```

- [ ] **Step 5: Update `CONTRIBUTING.md` § Verification**

Replace the paragraph beginning "There is **no CI in this repository yet**" — it is now false and its stated cause is resolved. Say that CI runs typecheck, lint, build and tests on every pull request, that the same four commands are the local gate, and keep the existing explanation of why the bundle-load test matters most.

- [ ] **Step 6: Update `CONTRIBUTING.md` § Cutting a release**

The manual asset attachment is gone. Replace the closing line "Release assets are attached manually for the same reason there is no CI." and adjust the command block:

```sh
npm version 0.2.0    # runs version-bump.mjs: manifest.json + versions.json + package.json
git push origin main
git tag 0.2.0 && git push origin 0.2.0
# release.yml builds and attaches main.js and manifest.json to a draft release.
# Review the draft, then publish it -- the community directory scans published releases.
```

Keep the paragraph explaining the lightweight tags verbatim.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml CONTRIBUTING.md
git commit -m "ci: run the verification gate on every pull request

README recorded that CI was impossible because an Actions default token
cannot clone a private repository, and would arrive when core went public.
Core is public.

Releases build as drafts: the community directory re-scans every release
and drops a failing one from search within 24 hours, so a human sees the
assets before it can."
```

---

## Task 9: Release 0.2.0 and submit

**Files:**
- Modify: `manifest.json`, `versions.json`, `package.json` (all three via `npm version`)

**Interfaces:**
- Consumes: everything above.
- Produces: a directory listing.

- [ ] **Step 1: Merge to `main` and confirm CI is green there**

The directory reads `manifest.json` at the HEAD of the default branch, so everything must be on `main` before submitting.

```bash
gh pr checks --watch && gh pr merge --squash --delete-branch
git checkout main && git pull
```

- [ ] **Step 2: Run the full gate on a clean clone**

Not on the working tree. This is what the reviewer resolves, and `CONTRIBUTING.md` § "Bumping core" documents that npm can report a successful install while leaving `node_modules` on a stale commit — a green local build can prove nothing about it.

```bash
tmp=$(mktemp -d) && git -C "$tmp" clone --depth 1 https://github.com/mshish/obsidian-shorthand.git p
cd "$tmp/p" && npm install && npx tsc --noEmit && npm run lint && npm run build && npm test
node -p "require('./node_modules/shorthand-core/package.json').version"
wc -c < main.js
```

Expected: all pass; core resolves to `0.10.0`; `main.js` under 5,242,880 bytes.

- [ ] **Step 3: Bump to 0.2.0 and tag**

`0.1.0` is already tagged. `0.2.0` is the honest reading — a user-visible behaviour change in the first-run picker, no breaking change to the plugin's own surface.

```bash
npm version 0.2.0
git push origin main
git tag 0.2.0 && git push origin 0.2.0
```

`npm version` runs `version-bump.mjs`, which writes `manifest.json` and adds `"0.2.0": "1.5.0"` to `versions.json`. Confirm before pushing:

```bash
node -p "JSON.stringify({m:require('./manifest.json').version, p:require('./package.json').version, v:require('./versions.json')})"
```

Expected: manifest and package both `0.2.0`, and `versions.json` carrying both `0.1.0` and `0.2.0`.

- [ ] **Step 4: Review and publish the draft release**

```bash
gh run watch
gh release view 0.2.0
```

Confirm both `main.js` and `manifest.json` are attached, that `main.js` is the size from Step 2, and that an attestation is recorded. Then publish:

```bash
gh release edit 0.2.0 --draft=false
```

- [ ] **Step 5: Re-check the id and name one last time**

They are first-come and this is the last moment to find a collision cheaply.

```bash
curl -sL https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json \
  | grep -in '"id": "shorthand"\|"name": "Shorthand"'
```

Expected: no output.

- [ ] **Step 6: Submit through the developer dashboard**

Not a pull request against `obsidianmd/obsidian-releases` — that workflow is obsolete.

1. Sign in at `community.obsidian.md` with an Obsidian account.
2. Link the GitHub account. This is how repository ownership is verified.
3. Select `mshish/obsidian-shorthand`.
4. Complete the dashboard steps. Label the plugin **Free**. Complete the capability disclosures — network, file system and process access — consistently with `README.md` § "What this plugin accesses" from Task 5.
5. Submit.

- [ ] **Step 7: Work the review result**

Results arrive within minutes. For each error: fix it, `npm version patch`, push the tag, publish the draft, and let the directory re-scan.

A passing plugin is searchable in-app within 24 hours. If it does not appear, sign in to the Community site and check the dashboard for errors — an absent plugin is usually a failing one, not a slow one.

---

## Open risk, carried deliberately

**The desktop application has no installers.** `mshish/shorthand` is a Tauri application with no published releases. Public makes it buildable, not installable. A user who finds this plugin in the directory and cannot obtain the application has a plugin that does nothing, and Obsidian removes projects that are broken or abandoned.

Building and signing Tauri installers for Windows, macOS and Linux is out of scope for this plan and is its own project. Task 5 Step 4 makes the requirement impossible to miss in the README. Submitting before those installers exist is a decision taken with that understood — if it should not be, stop after Task 8 and ship via BRAT until they do.

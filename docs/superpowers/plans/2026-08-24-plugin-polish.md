# Plugin Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Obsidian plugin read as a product before publication — settings copy a user can act on, an enhancement command that works without a transcript, and a prompt editor that shows what it is replacing.

**Architecture:** Six increments across two repositories. `shorthand-core` gains one additive option on `EnhanceRunner.enhanceNow` so a caller can force a pass with no new transcript; everything else lands in `obsidian-shorthand`. Rules go in `src/` where `bun test` can reach them, because `main.ts` cannot be imported under test; `main.ts` keeps only Obsidian wiring.

**Tech Stack:** TypeScript (strict, no `any`), Obsidian plugin API 1.5.7 typings against `minAppVersion` 1.5.0, `bun:test`, esbuild, xstate 5 (core's enhancement runner).

**Spec:** `docs/superpowers/specs/2026-08-24-plugin-polish-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

### Which shell to run the commands in

**Run every `sh` block in this plan under Git Bash, not PowerShell or cmd.** The blocks use
POSIX syntax throughout — `&&` chaining, `grep`, `tail`, `touch`, `rm -f`, and `$VAR` — and
several will fail or, worse, half-succeed under PowerShell.

Paths appear in two forms and both are correct under Git Bash: `/d/tools/obsidian-shorthand`
and `D:/tools/obsidian-shorthand`. Do not "normalize" them to backslashes.

### Repositories and ordering

- `shorthand-core` lives at `D:/tools/shorthand-repos/shorthand-core`. `obsidian-shorthand` lives at `D:/tools/obsidian-shorthand`. They are separate git repositories.
- The plugin pins core as `"shorthand-core": "github:mshish/shorthand-core#<tag>"` — a pinned GitHub tag, **not** a path dependency or workspace link. A local edit in the core checkout is invisible to the plugin.
- Therefore: land the core change, push, tag, then bump the plugin's pin as the **first** commit of the plugin work. Never reach for a junction, an `overrides` entry, or a `file:` dependency.
- Core tags are annotated and named bare with no `v` prefix. Version on the `0.x` line: minor is the breaking slot. Current core version is `0.10.0`; this work tags `0.11.0`.
- `npm install` can report success while leaving the lockfile and `node_modules` on the old commit. Verify that `resolved` in `package-lock.json` actually moved. A green typecheck proves nothing.

### Verification gates — there is no CI in either repo

- **Core:** all four of `bun test`, `bun run typecheck`, `bun run build`, `bun run test:e2e`. All four, because `bun test` transpiles without typechecking, so a green suite is not evidence that `tsc` is happy.
- **Plugin — and after Task 0 the order matters:** `npx tsc --noEmit && npm run build && npm test`. **Build before test, always.** Task 0 makes the bundle test fail when `main.js` is absent or older than its sources, so a full `npm test` against an unbuilt tree fails on staleness rather than on anything you did. Every full gate in this plan uses that order. Red/green TDD steps are the exception: name the file (`npm test -- test/plugin-settings.test.ts`), which skips the bundle test and needs no build. Targeted while iterating, full gate before committing.
- `tsconfig.json` includes `test/**/*.ts`, so `npx tsc --noEmit` typechecks the tests. A change to a settings type and the test rewrite that follows it **cannot be split across commits** without a red typecheck between them.
- `main.ts` cannot be imported under `bun test` — `node_modules/obsidian` has `"main": ""` and ships only type declarations. Anything expressed in `main.ts` is verified only by typecheck, the bundle smoke test, and a human clicking through Obsidian.

### The vault-delivery hazard

`OBSIDIAN_PLUGIN_DIR` may be set in the environment. `esbuild.config.mjs`'s `deliver-to-vault` plugin fires on `build.onEnd`, so **any** esbuild run copies `main.js` and `manifest.json` into a live Obsidian vault. Be deliberate about when you build, and leave the vault holding a build from committed code.

Before Task 0, `npm test` could trigger that delivery too, because `ensureBundle()` built a missing bundle. **Task 0 removes the build from the test path entirely**, so after it lands only an explicit `npm run build` writes to the vault. Passages later in this plan that describe `npm test` spawning a build are describing the state Task 0 fixes — Task 0 corrects them in `README.md` and in `esbuild.config.mjs`'s comment as part of its own work.

`esbuild.config.mjs:48` copies only `["main.js", "manifest.json"]`. **Any new file that must reach the vault — a stylesheet, for instance — has to be added to that list, or it will pass every gate and silently never be applied.**

### Copy rules

All user-facing text obeys `docs/settings-copy-style.md`, created in Task 40. Until it exists, the nine rules are:

1. One sentence. Three is the absolute ceiling.
2. No description is a valid outcome. Write one only when the label leaves a real question unanswered.
3. Describe the consequence, not the mechanism.
4. For non-boolean settings, show the current value instead of a description — but only when the raw value is not already self-describing in its own control.
5. Name toggles as positive noun phrases. Read the label aloud and append "on"; if it does not parse, rewrite. Never phrase a toggle so that on means off.
6. Banned generic verbs in labels: set, change, edit, modify, manage, use, select, choose.
7. Obsidian's terminology list is binding. Folder, not directory. Maximum and minimum, not max and min. Note for Markdown files. American spelling.
8. Sentence case throughout. Periods on descriptions, never on labels.
9. Second person, present tense, active voice. No "we".

### Obsidian API constraints

- The declarative settings API — with `visible`/`disabled` predicates and a first-class `textarea` control — requires app version 1.13.0. `SettingGroup` requires 1.11.0. `manifest.json` declares 1.5.0, so **none of these are available**. Do not reach for them without raising the floor, which means dropping users.
- No top-level heading naming the plugin in the settings tab. Obsidian already titles the pane.
- Headings must not contain the word "settings": prefer "Advanced" over "Advanced settings".
- No hardcoded styling. Use CSS classes and Obsidian's CSS variables, never `el.style.x = …`.
- No `innerHTML`, `outerHTML`, or `insertAdjacentHTML`. Use `createEl()`, `createDiv()`, `createSpan()`, and `el.empty()`.
- Prefer Obsidian's own components (`Setting`, `Modal`, `setHeading()`) over hand-rolled DOM. They carry focus behaviour, ARIA attributes, and mobile layout that custom markup silently drops.
- Multi-line input belongs in a form modal, not a settings-tab textarea. `NotePromptModal` already follows this; do not move its fields into the tab.
- Command names carry no plugin prefix and are sentence case. Obsidian adds the prefix.

### Git

- Single-user private repos. Commit, push, and tag as part of finishing the work; do not stop to ask. Confirm only before force-pushing, rewriting published history, or deleting a tag.
- **Stage explicit paths. Never `git add -A`, `git add .`, or `git commit -a`.** Read `git diff --cached` before committing when the working tree holds changes you did not make.
- Conventional commit prefixes (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `test:`), explaining *why* rather than what.

### Code style

- Named exports. `Readonly<{...}>` for settings shapes. Strict TypeScript, no `any`.
- Settings that override a core default store `""` for "use the default" rather than copying the default's current value. **This is load-bearing.** A user who never touches the setting keeps inheriting improvements to core instead of freezing at whatever the text said the day they installed. Do not break it.
- `normalizePluginSettings` is the trust boundary for `data.json`, which is user-editable and may be malformed or hand-written. Every key validates and falls back; nothing throws.
- Comments explain *why* and name the failure they prevent. Never restate the code, and **never describe behaviour the code does not implement** — when you delete behaviour, delete the comment that explained it.

### Decisions already made — do not relitigate

- **Advanced settings are a visible section, not a toggle.** Obsidian core does it this way, and the predicate that would hide them needs 1.13.0.
- **"Transcript folder" stays in Basic, directly under "Write transcript note", and stays conditional.** The pairing reads as a unit; separating them would make flipping the toggle look like it did nothing. The `this.display()` re-render at `main.ts:849` therefore **stays**.
- **`"toggle-post-process"` stays in core's `ControlSignal` union.** Removing an exported union member is a breaking retype for no gain. The plugin simply stops selecting it.
- **Doc links ship pointing at README sections** even though the repo is private and they 404 for others until publication. Recorded as a known deviation in the style guide.

---

## Section 0 — Increment 0: make the verification gate trustworthy

Every later task in this plan ends with "run the gate and confirm it passes." That claim is
only worth anything if the gate actually inspects the code you just wrote. Right now one part
of it does not, so this increment comes first.

### Task 0: Fail the bundle test when `main.js` is stale

`test/plugin-bundle.test.ts` exists because the plugin once failed to load in Obsidian with
every check green. But `ensureBundle()` (line 29) reads:

```ts
function ensureBundle(): void {
  if (existsSync(BUNDLE)) return;
  ...
}
```

It builds **only when `main.js` is absent**. `main.js` is gitignored but present in any working
checkout, so on every ordinary run the test loads whatever bundle happens to be on disk — which
may have been built from entirely different source. The test written to catch "green checks,
broken bundle" can itself pass against a bundle that does not correspond to the code under test.

**Why throw rather than rebuild.** Rebuilding here would be the obvious fix and is the wrong
one. `esbuild.config.mjs`'s `deliver-to-vault` plugin fires on `build.onEnd`, so a rebuild
triggered by `npm test` copies into a live Obsidian vault when `OBSIDIAN_PLUGIN_DIR` is set —
delivering uncommitted, mid-edit code and violating the repo's rule that the vault is left
holding a build from committed code. Failing loudly keeps the build an explicit act.

**This removes the build from the test path entirely, including the missing-bundle case.**
The old code built when `main.js` was absent, which is the one branch that ever ran — and it
carried exactly the same vault-write hazard. Leaving it in place would fix the staleness hole
while keeping the delivery hole, so both go.

**The consequence, stated plainly:** on a fresh clone, `npm test` now fails until you run
`npm run build` once. That is the intended trade. A test suite that silently writes into a
live vault is worse than one that asks you to build first, and every task in this plan runs
the build anyway.

**Files:**
- Modify: `D:/tools/obsidian-shorthand/test/plugin-bundle.test.ts:2` (delete the `spawnSync` import), `:5` (widen the `node:fs` import), `:29-33` (`ensureBundle`)
- Modify: `D:/tools/obsidian-shorthand/esbuild.config.mjs:31-33` — a comment that claims the bundle test rebuilds a missing `main.js`
- Modify: `D:/tools/obsidian-shorthand/README.md:351-352` — a bullet documenting the manual delete-and-rebuild workaround this task automates

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. `ensureBundle()` keeps its name and signature.

- [ ] **Step 1: Confirm the hole is real before changing anything**

Run:

```sh
cd /d/tools/obsidian-shorthand && npm run build && touch main.ts && npm test 2>&1 | tail -20
```

Expected: the suite PASSES. `main.ts` is now newer than `main.js`, so the bundle under test is
stale, and nothing complains. That passing run is the bug.

- [ ] **Step 2: Replace `ensureBundle` with a staleness check**

Replace lines 29-33 of `test/plugin-bundle.test.ts` with:

```ts
/**
 * Inputs that can change what the bundle contains: the entry point and its module graph, the
 * build configuration itself, and the resolved dependency set. This is deliberately broader
 * than esbuild's import graph — package-lock.json catches a core-pin bump, which changes the
 * bundled code without touching a single file in src/.
 *
 * It is not exhaustive and cannot be: a dependency rebuilt in place under node_modules moves
 * no file listed here. It covers every way this repo's own workflow changes the bundle.
 */
const BUNDLE_SOURCES = ["main.ts", "src", "package.json", "package-lock.json", "esbuild.config.mjs"];

function newestSourceMtimeMs(target: string): number {
  const stats = statSync(target);
  if (!stats.isDirectory()) return stats.mtimeMs;
  // Seed with the directory's own mtime, not 0. Deleting or renaming a file touches the
  // directory but leaves every surviving child older than the bundle — so a reduction over
  // children alone would call a bundle fresh when a module had just been removed from it.
  return readdirSync(target)
    .map((entry) => newestSourceMtimeMs(join(target, entry)))
    .reduce((newest, candidate) => Math.max(newest, candidate), stats.mtimeMs);
}

/**
 * A bundle that is absent, or older than its sources, is not the code under test.
 *
 * This throws in both cases rather than building, and that is the whole point: esbuild's
 * deliver-to-vault plugin runs on build.onEnd, so any build this file triggers copies into a
 * live Obsidian vault whenever OBSIDIAN_PLUGIN_DIR is set. A test suite must never deliver
 * mid-edit code to a vault, so building stays an explicit act the developer performs.
 */
function ensureBundle(): void {
  if (!existsSync(BUNDLE)) {
    throw new Error("main.js does not exist. Run `npm run build` before `npm test`.");
  }
  const bundleMtimeMs = statSync(BUNDLE).mtimeMs;
  const newestSource = BUNDLE_SOURCES
    .map((source) => newestSourceMtimeMs(resolve(process.cwd(), source)))
    .reduce((newest, candidate) => Math.max(newest, candidate), 0);
  if (newestSource > bundleMtimeMs) {
    throw new Error("main.js is older than its sources. Run `npm run build` before `npm test`.");
  }
}
```

- [ ] **Step 3: Fix the imports**

Two edits at the top of the file.

Line 5 currently reads `import { existsSync } from "node:fs";`. Replace it with:

```ts
import { existsSync, readdirSync, statSync } from "node:fs";
```

Line 2 currently reads `import { spawnSync } from "node:child_process";`. **Delete it.**
`spawnSync` was only used by the build branch you just removed, and it is now the sole
remaining reference to `node:child_process` in this file. Confirm before deleting:

```sh
cd /d/tools/obsidian-shorthand && grep -n "spawnSync\|child_process" test/plugin-bundle.test.ts
```

Expected after the delete: no output.

`join` and `resolve` are already imported from `node:path` on line 7. Do not add them again.

- [ ] **Step 4: Run the test and verify it now FAILS on the stale bundle**

Run:

```sh
cd /d/tools/obsidian-shorthand && npm test 2>&1 | tail -20
```

Expected: FAIL with "main.js is older than its sources. Run `npm run build` before `npm test`."
`main.ts` is still newer from Step 1. This is the assertion that was missing.

- [ ] **Step 5: Rebuild and verify the suite goes green**

Run:

```sh
cd /d/tools/obsidian-shorthand && npm run build && npm test 2>&1 | tail -20
```

Expected: PASS.

**If `OBSIDIAN_PLUGIN_DIR` is set in your environment, this build just copied into your live
vault.** That is expected and fine here — you are building from committed code plus this one
test change. Do not leave the vault holding a build from a mid-edit tree later in this plan.

- [ ] **Step 6: Correct the two places that document the old behaviour**

Both currently describe a test that builds a missing bundle. After Step 2 it does not, and a
comment describing behaviour the code no longer has is the thing `AGENTS.md` forbids outright.

**`esbuild.config.mjs`, lines 31–33.** The clause "the bundle-load test resolves it from the
root and rebuilds it there when missing" is now false. Replace that clause so the sentence
reads:

```js
 * The build still writes `main.js` at the repository root and copies from there rather than
 * pointing `outfile` at the vault: the bundle-load test resolves it from the root and fails if
 * it is missing or stale, releases attach that same file, and the recorded byte baseline has to
 * keep meaning one file. Unset, nothing is copied and the build behaves as it always has.
```

**`README.md`, lines 351–352.** The bullet currently reads "`test/plugin-bundle.test.ts` only
builds `main.js` when it is absent, so delete it and rebuild first. Otherwise the load test
exercises a bundle built against the old core." That manual workaround is exactly what Step 2
automates. Replace the bullet with:

```md
- `test/plugin-bundle.test.ts` fails when `main.js` is missing or older than its sources, so
  run `npm run build` after bumping the pin. It will not silently exercise a bundle built
  against the old core.
```

Verify nothing else still makes the old claim:

```sh
cd /d/tools/obsidian-shorthand && grep -rn "when it is absent\|rebuilds it there\|when missing" README.md esbuild.config.mjs AGENTS.md
```

Expected: no output.

- [ ] **Step 7: Run the rest of the gate**

Run:

```sh
cd /d/tools/obsidian-shorthand && npx tsc --noEmit
```

Expected: no output, exit 0.

- [ ] **Step 8: Commit**

```bash
cd /d/tools/obsidian-shorthand
git add test/plugin-bundle.test.ts esbuild.config.mjs README.md
git commit -m "test: fail the bundle test when main.js is older than its sources

ensureBundle() only built when main.js was absent, so an ordinary run
loaded whatever bundle was on disk. The test that exists to catch a
green-checks-broken-bundle failure could itself pass against a bundle
built from different source.

Throws rather than rebuilds: esbuild's deliver-to-vault plugin runs on
every build, so rebuilding from npm test would copy mid-edit code into a
live vault whenever OBSIDIAN_PLUGIN_DIR is set."
```

---

## Section A — Increments 1 and 2: the notes-only enhancement pass

Covers spec §1 (core: `allowEmptyTranscript`) and spec §2 (plugin: bump the pin,
add "Clean up this note"). Tasks 1–2 are in
`D:/tools/shorthand-repos/shorthand-core`; tasks 3–5 are in
`D:/tools/obsidian-shorthand`. **The order across the two repos is not
negotiable** — core must be pushed and tagged before the plugin's pin can move,
and the pin bump must be the plugin's first commit so every commit after it
builds from a clean checkout.

### Things the reader must not do

- **Do not run `git add -A`, `git add .`, or `git commit -a` in either repo.**
  Both working trees carry an untracked `.serena/` directory that is not yours.
  Every `git add` below names explicit paths; use them verbatim.
- **Do not create a junction, an `overrides` entry, or a `file:` dependency** to
  see core's change from the plugin before the tag exists. Both repos' AGENTS.md
  forbid it by name. Publish and pin instead — it costs one push.
- **Do not "fix" the empty-transcript gate by deleting it.** It is what stops a
  capture paying for a closing model call with nothing new to say. This work adds
  an opt-out, per call, nothing more.
- **Do not trust a green `npx tsc --noEmit` as evidence the pin moved.** npm
  reuses cached git resolutions. Task 3 checks the `resolved` commit in
  `package-lock.json` because that is the only thing that actually proves it.
- **Do not put any decision logic in `main.ts`.** `node_modules/obsidian` has
  `"main": ""` and ships types only, so `main.ts` cannot be imported under
  `bun test`. A rule written there is a rule with no test.

### Two corrections to the spec, verified in the code

1. The spec says the flag "threads through the `ENHANCE` event into
   `#acceptPass` and is checked alongside the existing condition at
   `src/agent/runner.ts:582`". `#acceptPass` (line 400) does not check anything —
   it builds the `PassRequest`. The check at line 582 is inside `#runPass`, and it
   reads `request.requestedTier`, `request.input.transcript` and the freshly-read
   `observed.sections`. So the flag is *carried* by `#acceptPass` onto
   `PassRequest` and *checked* in `#runPass`. Both edits are required; neither
   alone works.
2. The spec says to update "the `ENHANCEMENT-LIMITS.md` row for the
   empty-transcript decline". **There is no such row.** The gate is undocumented
   today, and the sentence at `docs/ENHANCEMENT-LIMITS.md:38` ("`enhanceNow()`
   skips the two threshold gates and honours the first three") is already wrong
   because of it. Task 1 adds the row and corrects that sentence.

---

### Task 1: Core — carry `allowEmptyTranscript` from `enhanceNow` to the `#runPass` gate

**Files:**
- Modify: `D:/tools/shorthand-repos/shorthand-core/src/agent/runner.ts` — event type at line 107, `acceptTick`/`acceptEnhance`/`acceptLiveTick` actions at lines 182–188, `PassRequest` type at lines 68–76, `enhanceNow` at lines 363–367, `#acceptPass` signature/body at lines 400–422, the gate at lines 582–584
- Test: `D:/tools/shorthand-repos/shorthand-core/test/enhance-runner.test.ts` — insert after line 661
- Modify: `D:/tools/shorthand-repos/shorthand-core/docs/CONTRACT.md` — insert after line 67
- Modify: `D:/tools/shorthand-repos/shorthand-core/docs/ENHANCEMENT-LIMITS.md` — table row after line 36, prose at lines 38–39
- Modify: `D:/tools/shorthand-repos/shorthand-core/package.json:3` — `"version": "0.10.0"` → `"version": "0.11.0"`

**The version bump is not optional and is easy to miss.** Task 2 tags `0.11.0`
and Task 3 verifies that the installed package *reports* `0.11.0`. A git tag
does not change what `package.json` says, so skipping this makes Task 3's
verification fail against a perfectly good release — and the natural
misdiagnosis is "the install is broken", which sends you round the
`npm cache clean` loop for a problem that is not there.

**Interfaces:**
- Consumes: nothing from an earlier task.
- Produces:
  - `EnhanceRunner.enhanceNow(tier?: AgentTier, options?: Readonly<{ allowEmptyTranscript?: boolean }>): Promise<PassOutcome>`
  - internal `RunnerEvent` member `Readonly<{ type: "ENHANCE"; tier: AgentTier; allowEmptyTranscript: boolean; resolve: (outcome: PassOutcome) => void }>`
  - internal `PassRequest` field `readonly allowEmptyTranscript: boolean`
  - internal `EnhanceRunner.#acceptPass(context: RunnerContext, requestedTier: AgentTier, allowEmptyTranscript: boolean, resolve: (outcome: PassOutcome) => void): Partial<RunnerContext>`

- [ ] **Step 1: Write the failing test**

Insert both tests into `test/enhance-runner.test.ts` immediately after line 661
(the closing `});` of `"a requested link pass keeps the empty-transcript guard
when the backend downgrades it"`), still inside the
`describe("EnhanceRunner wall-clock window and failure isolation", ...)` block
that ends at line 816.

```ts
  /**
   * The gate at the top of #runPass exists to suppress a redundant paid pass when nothing
   * new arrived, and a capture's closing pass is exactly that case. A note written by hand
   * is the case it gets wrong: there is no transcript and there never will be one, so the
   * caller states that rather than leaving the runner to infer it from an empty string.
   */
  test("a link pass that declares its empty transcript deliberate runs on the note's own text", async () => {
    const agent = new FakeAgent([Promise.resolve(response())]);
    const runner = makeRunner({ agent });
    expect(await runner.enhanceNow("link", { allowEmptyTranscript: true }))
      .toMatchObject({ status: "completed", tier: "link" });
    expect(agent.requests).toHaveLength(1);
    expect(tag(agent.requests[0]!.prompt, "new_committed_transcript")).toBe("");
    expect(tag(agent.requests[0]!.prompt, "user_notes")).toBe(USER_NOTES);
  });

  /**
   * The override is per call, not per runner. If it ever latched onto context, a capture
   * that used it once would pay for every subsequent no-op closing pass for the rest of
   * the session, and nothing else in this suite would notice.
   */
  test("the empty-transcript gate holds for calls that do not ask for the override", async () => {
    const agent = new FakeAgent([Promise.resolve(response())]);
    const runner = makeRunner({ agent });
    expect(await runner.enhanceNow("link", { allowEmptyTranscript: true }))
      .toMatchObject({ status: "completed" });
    expect(await runner.enhanceNow("link", { allowEmptyTranscript: false }))
      .toEqual({ status: "not-ready", reason: "characters" });
    expect(await runner.enhanceNow("link")).toEqual({ status: "not-ready", reason: "characters" });
    expect(agent.requests).toHaveLength(1);
  });
```

`makeRunner`'s default `FakeSink` already reads back `SECTIONS` (non-empty) and
`USER_NOTES`, and carries `agentContext: { cwd: process.cwd() }`, so the link
tier is genuinely earned and the gate genuinely fires. Do not pass a bare
`new FakeSink()` — that one has no `agentContext`, the tier downgrades to
`"tick"`, and the first assertion would fail for the wrong reason.

- [ ] **Step 2: Run test to verify it fails**

```sh
cd D:/tools/shorthand-repos/shorthand-core && bun test test/enhance-runner.test.ts
```

Expected: both new tests fail at compile/parse of the call, because `enhanceNow`
currently takes one parameter. Under `bun test` (which transpiles without
typechecking) the second argument is silently dropped instead, so the observed
failure is:

```
error: expect(received).toMatchObject(expected)
- Expected  - 2
+ Received  + 2
- "status": "completed",
- "tier": "link",
+ "status": "not-ready",
+ "reason": "characters",
```

If instead you see `expect(agent.requests).toHaveLength(1)` receiving `0`, that
is the same failure reported one line later. Either is the correct red.

- [ ] **Step 3: Write minimal implementation**

Five edits in `src/agent/runner.ts`.

(a) Line 107, the `ENHANCE` member of `RunnerEvent`. The field is a required
`boolean` on the internal event even though the public argument is optional —
`enhanceNow` resolves the default once, so no action has to re-derive it:

```ts
  | Readonly<{ type: "ENHANCE"; tier: AgentTier; allowEmptyTranscript: boolean; resolve: (outcome: PassOutcome) => void }>
```

(b) Lines 68–76, `PassRequest`, gains one field:

```ts
type PassRequest = Readonly<{
  requestedTier: AgentTier;
  tier: AgentTier;
  allowEmptyTranscript: boolean;
  input: PassInput;
  resolve: (outcome: PassOutcome) => void;
  metrics: PassMetrics;
  sessionId: string | undefined;
  passCountAtStart: number;
}>;
```

(c) Lines 182–188, the three accepting actions. `acceptTick` and `acceptLiveTick`
pass `false` because the gate only ever applies to a requested `link` tier;
spelling it out keeps `#acceptPass` free of a default that would hide which
caller opted in:

```ts
        acceptTick: assign(({ context, event }) => event.type === "TICK"
          ? this.#acceptPass(context, "tick", false, event.resolve)
          : {}),
        acceptEnhance: assign(({ context, event }) => event.type === "ENHANCE"
          ? this.#acceptPass(context, event.tier, event.allowEmptyTranscript, event.resolve)
          : {}),
        acceptLiveTick: assign(({ context }) => this.#acceptPass(context, "tick", false, () => {})),
```

(d) Lines 363–367, `enhanceNow`:

```ts
  /**
   * `allowEmptyTranscript` waives the empty-transcript gate in `#runPass` for this call only.
   * It exists for a note that has no transcript and never will — written by hand, or dictated
   * outside a capture — where the gate would otherwise decline forever. A capture must not
   * pass it: the gate is what stops the closing pass paying for a call with nothing new to say.
   */
  enhanceNow(
    tier: AgentTier = "link",
    options?: Readonly<{ allowEmptyTranscript?: boolean }>,
  ): Promise<PassOutcome> {
    if (this.#stopped) return Promise.resolve(stoppedOutcome());
    this.#syncExpiry();
    const allowEmptyTranscript = options?.allowEmptyTranscript ?? false;
    return new Promise((resolve) => this.#actor.send({ type: "ENHANCE", tier, allowEmptyTranscript, resolve }));
  }
```

(e) Line 400, `#acceptPass`, takes the flag and copies it onto the request. Only
the signature and the one new property change; leave the transcript-cutoff
comment and every other field exactly as they are:

```ts
  #acceptPass(
    context: RunnerContext,
    requestedTier: AgentTier,
    allowEmptyTranscript: boolean,
    resolve: (outcome: PassOutcome) => void,
  ): Partial<RunnerContext> {
    const toolsUsable = this.#options.agent.supportsVaultTools !== false;
    const tier: AgentTier = requestedTier === "link" && this.#options.sink.agentContext !== undefined && toolsUsable ? "link" : "tick";
    // The cutoff is taken in the accepting transition, before the invoked read begins, so
    // transcript arriving during any awaited part of the pass belongs to the next request.
    return {
      pendingTranscript: "",
      requeuedTranscript: "",
      requeueCount: 0,
      current: {
        requestedTier,
        tier,
        allowEmptyTranscript,
        input: {
          transcript: joinTranscript(context.requeuedTranscript, context.pendingTranscript),
          requeueCount: context.requeueCount,
        },
        resolve,
        metrics: { modelStartedAt: undefined, modelDurationMs: 0, attempts: 0, sessionId: undefined },
        sessionId: context.sessionId,
        passCountAtStart: context.passCount,
      },
    };
  }
```

(f) Lines 582–584, the gate itself, inside `#runPass`:

```ts
    // Declining here rather than in a machine guard is deliberate: the decision needs the
    // note's current sections, which are only known after sink.read(). A caller that knows
    // no transcript is coming waives it per call; a capture never does, because for a capture
    // an empty transcript means the closing pass would be paid for and change nothing.
    if (!request.allowEmptyTranscript
      && request.requestedTier === "link"
      && request.input.transcript.length === 0
      && observed.sections.length > 0) {
      return { kind: "not-ready", tier, reason: "characters", attempts: 0 };
    }
```

- [ ] **Step 4: Run test to verify it passes**

```sh
cd D:/tools/shorthand-repos/shorthand-core && bun test test/enhance-runner.test.ts
```

Every test in the file must pass, including the two pre-existing guards at lines
646 and 656 — they are what prove the default did not change.

- [ ] **Step 5: Document the new surface in `docs/CONTRACT.md`**

Insert after line 67 (the end of the "A second hole the `exports` map cannot
see" paragraph) and before the `---` on line 69:

```md
### `enhanceNow` can be told the empty transcript is deliberate

```ts
enhanceNow(tier: AgentTier = "link", options?: Readonly<{ allowEmptyTranscript?: boolean }>): Promise<PassOutcome>
```

A `link` pass with no new transcript, against a note that already has sections, is declined
with `{ status: "not-ready", reason: "characters" }` and never reaches the model. That is
right for a capture: the closing pass would be paid for and change nothing.

It is wrong for a note that has no transcript and never will — one written by hand, or
dictated outside a capture. `allowEmptyTranscript: true` says so, and the pass runs against
the note's own prose, which `buildPassPrompt` already sends as `<user_notes>`.

The waiver is per call, not per runner: the same runner declines the next empty `link` pass
unless that call asks too. The default is `false`, which is what leaves every existing call
site — the capture-stop pass, the CLI's `enhance` command — behaving exactly as before.
```

- [ ] **Step 6: Record the gate in `docs/ENHANCEMENT-LIMITS.md`**

Add this row to the gates table, immediately after the `minIntervalMs` row at
line 36:

```md
| empty `link` transcript | declines unless waived | same | — | A paid `link` pass that re-sends a note core has already summarised. Checked in `#runPass` after `sink.read()`, not by a machine guard, because it needs the note's current sections |
```

Then replace lines 38–39 in full. The existing sentence undercounts the gates
because this row was never written down:

```md
`enhanceNow()` skips the two threshold gates and honours the other four. That is what the
capture-stop pass and the standalone `enhance` command use. The empty-`link`-transcript gate
is the only one a caller may waive, and only for one call:
`enhanceNow("link", { allowEmptyTranscript: true })`. The Obsidian plugin's "Clean up this
note" command is the reason it exists.
```

- [ ] **Step 7: Commit**

```sh
cd D:/tools/shorthand-repos/shorthand-core && git add src/agent/runner.ts test/enhance-runner.test.ts docs/CONTRACT.md docs/ENHANCEMENT-LIMITS.md package.json && git commit -m "feat: let a caller waive the empty-transcript gate on a link pass

A note written by hand has no transcript and never will, so the gate declines it
forever. The gate itself is right and stays: it is what stops a capture paying for
a closing pass with nothing new to say. Callers that know better opt out per call.

The gate was never in ENHANCEMENT-LIMITS.md, which made the 'honours the first
three' line beside the table wrong before this change. Both are fixed here.

Obsidian's 'Clean up this note' is the first consumer."
```

All four files go in one commit because core's `AGENTS.md` requires the limits
table and the contract to move with the behaviour they describe. Do not split
them.

---

### Task 2: Core — run the four-command gate, push, and tag 0.11.0

**Files:**
- No file changes. This task publishes Task 1.

**Interfaces:**
- Consumes: the commit from Task 1.
- Produces: annotated tag `0.11.0` on `mshish/shorthand-core`, which Task 3 pins.

**Why 0.11.0 and not 0.10.1:** `AGENTS.md` § Releasing states that on the `0.x`
line, minor is the breaking slot, and that *retyping* an exported symbol is a
minor bump. Adding a parameter to `EnhanceRunner.enhanceNow` retypes an exported
method. The change happens to be source-compatible, but the version scheme is
about the shape of the export, not about whether this particular widening broke
anyone. The current tag is `0.10.0`; the next is `0.11.0`.

- [ ] **Step 1: Run the full gate**

```sh
cd D:/tools/shorthand-repos/shorthand-core && bun test && bun run typecheck && bun run build && bun run test:e2e
```

All four, in that order. `bun test` transpiles without typechecking, so a green
suite is not evidence `tsc` is happy — and step 3(a)/3(b) of Task 1 are precisely
the kind of edit that passes tests and fails `tsc` if one call site was missed.
If `bun run typecheck` reports `Expected 4 arguments, but got 3` in
`src/agent/runner.ts`, an `#acceptPass` caller was not updated; there are exactly
three, at lines 182, 185 and 188.

- [ ] **Step 2: Confirm the working tree holds nothing but Task 1's commit**

```sh
cd D:/tools/shorthand-repos/shorthand-core && git status --porcelain && git log --oneline -1
```

Expected: `?? .serena/` and nothing else. `.serena/` is untracked tooling state
that is not yours to commit — leave it. If any tracked file shows as modified,
`bun run build` wrote into `dist/`; check whether `dist/` is ignored before doing
anything about it.

- [ ] **Step 3: Push `main`**

```sh
cd D:/tools/shorthand-repos/shorthand-core && git push origin main
```

- [ ] **Step 4: Create and push the annotated tag**

Bare name, no `v` prefix, annotated (`-a`):

```sh
cd D:/tools/shorthand-repos/shorthand-core && git tag -a 0.11.0 -m "0.11.0 — enhanceNow can waive the empty-transcript gate for a notes-only pass" && git push origin 0.11.0
```

- [ ] **Step 5: Verify the tag points at the commit you think it does**

```sh
cd D:/tools/shorthand-repos/shorthand-core && git rev-parse HEAD && git ls-remote --tags origin "0.11.0^{}"
```

The two hashes must match. Compare `0.11.0^{}`, not `0.11.0` — the tag is
annotated, so `git ls-remote --tags origin 0.11.0` returns the *tag object's*
hash, which will never equal the commit and will make a correct tag look wrong.

---

### Task 3: Plugin — bump the core pin to 0.11.0, as the first commit

**Files:**
- Modify: `D:/tools/obsidian-shorthand/package.json` line 18
- Modify: `D:/tools/obsidian-shorthand/package-lock.json` lines 12 and 2584–2586 (regenerated by npm, never hand-edited)

**Interfaces:**
- Consumes: tag `0.11.0` from Task 2.
- Produces: `enhanceNow(tier?: AgentTier, options?: Readonly<{ allowEmptyTranscript?: boolean }>)` visible to `main.ts` through the `shorthand-core` package name.

This task has no failing unit test to write first, and that is not an oversight:
a dependency bump has no behaviour of its own. Its evidence is the `resolved`
commit in the lockfile, which Step 1 records before and Step 4 checks after.
Follow `README.md` § "Bumping core" — the three traps below are its three traps.

- [ ] **Step 1: Record the currently-installed core, so the move is provable**

```sh
cd D:/tools/obsidian-shorthand && node -p "require('./package-lock.json').packages['node_modules/shorthand-core'].resolved" && node -p "require('./node_modules/shorthand-core/package.json').version"
```

Expected today:
`git+ssh://git@github.com/mshish/shorthand-core.git#1110af34936646f90fbf83774b7834381410e066`
and `0.10.0`. Write both down. They are the "before" half of Step 4.

- [ ] **Step 2: Change the pin in `package.json`**

Line 18, inside `"dependencies"`:

```json
    "shorthand-core": "github:mshish/shorthand-core#0.11.0"
```

- [ ] **Step 3: Install, naming the tag explicitly**

```sh
cd D:/tools/obsidian-shorthand && npm install "shorthand-core@github:mshish/shorthand-core#0.11.0"
```

Naming the tag on the command line rather than running a bare `npm install` is
the documented way around npm's cached git resolution, which can otherwise leave
both the lockfile and `node_modules` on the old commit while reporting success.

- [ ] **Step 4: Verify the lockfile and `node_modules` actually moved**

```sh
cd D:/tools/obsidian-shorthand && node -p "require('./package-lock.json').packages['node_modules/shorthand-core'].resolved" && node -p "require('./node_modules/shorthand-core/package.json').version" && grep -n "allowEmptyTranscript" node_modules/shorthand-core/src/agent/runner.ts
```

Three checks, and all three must pass:

1. The `resolved` commit **must differ** from the one recorded in Step 1. If it
   still ends in `1110af34…`, the install did nothing: delete
   `node_modules/shorthand-core`, run `npm cache clean --force`, and repeat
   Step 3.
2. The version must read `0.11.0`. This only works because Task 1 bumped
   `package.json` in core; a tag alone does not change the version a package
   reports.
3. The `grep` must find `allowEmptyTranscript` in the installed copy. **This is
   the check that actually proves the new code arrived** — the other two can
   both pass against a mis-tagged commit.

Do **not** verify by requiring a built artifact. Core has no `dist/index.js`:
its `exports` map points `"."` straight at `./src/index.ts`, and `npm run build`
emits only `dist/shorthand-notes.mjs` for the CLI bin. A `require` of any other
`dist/` path always throws, whether or not the install worked.

**Do not proceed on a green typecheck alone** — `main.ts` does not yet call the
new overload, so `tsc` would be green against the old version too.

- [ ] **Step 5: Rebuild from scratch and run the gate**

```sh
cd D:/tools/obsidian-shorthand && npx tsc --noEmit && rm -f main.js && npm run build && npm test
```

`main.js` is deleted first because `test/plugin-bundle.test.ts` only builds the
bundle when it is absent — otherwise the load test would exercise a bundle built
against core 0.10.0 and prove nothing about the bump. A core change can break the
bundle *load* long before it breaks a type, which is why `npm test` is not
optional here.

- [ ] **Step 6: Commit**

```sh
cd D:/tools/obsidian-shorthand && git add package.json package-lock.json && git commit -m "chore: pin shorthand-core 0.11.0

Brings in enhanceNow's allowEmptyTranscript option. Landed on its own, before any
code that uses it, so every later commit here builds from a clean checkout."
```

`main.js` is a build artifact — do not stage it. Check `git status --porcelain`
shows only `?? .serena/` (and `main.js`, if it is not ignored) left over.

---

### Task 4: Plugin — decide the enhancement mode in `src/`, where it can be tested

**Files:**
- Create: `D:/tools/obsidian-shorthand/src/enhance-mode.ts`
- Create: `D:/tools/obsidian-shorthand/test/plugin-enhance-mode.test.ts`

**Interfaces:**
- Consumes: nothing from Task 3 at runtime. It deliberately imports nothing —
  not `obsidian`, not `shorthand-core` — so it stays a pure function under
  `bun test`.
- Produces:
  - `type EnhanceCommandId = "enhance-now" | "clean-up-this-note"`
  - `type EnhanceRequest = Readonly<{ command: EnhanceCommandId; captureOnThisNote: boolean; transcriptLink: string | undefined; writeTranscriptNote: boolean }>`
  - `type EnhanceMode = Readonly<{ kind: "live-capture" }> | Readonly<{ kind: "transcript"; transcriptLink: string }> | Readonly<{ kind: "notes-only" }> | Readonly<{ kind: "unavailable"; message: string }>`
  - `function resolveEnhanceMode(request: EnhanceRequest): EnhanceMode`

The two commands differ only in whether they feed a transcript, so the branch
that picks between them is the whole interesting part. It goes here, not in
`main.ts`, for the reason `AGENTS.md` § "The settings surface" gives:
`node_modules/obsidian` has `"main": ""` and ships only type declarations, so
`main.ts` has no runtime module and cannot be imported under `bun test`.

- [ ] **Step 1: Write the failing test**

Create `test/plugin-enhance-mode.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { resolveEnhanceMode } from "../src/enhance-mode.js";

describe("enhancement mode selection", () => {
  test("a live capture on this note outranks the sidecar that capture is writing", () => {
    expect(resolveEnhanceMode({
      command: "enhance-now",
      captureOnThisNote: true,
      transcriptLink: "Transcripts/2026-08-24-1200",
      writeTranscriptNote: true,
    })).toEqual({ kind: "live-capture" });
  });

  test("without a capture, a linked transcript is the source", () => {
    expect(resolveEnhanceMode({
      command: "enhance-now",
      captureOnThisNote: false,
      transcriptLink: "Transcripts/2026-08-24-1200",
      writeTranscriptNote: true,
    })).toEqual({ kind: "transcript", transcriptLink: "Transcripts/2026-08-24-1200" });
  });

  test("Enhance now on a note with no transcript names the command that does work", () => {
    const mode = resolveEnhanceMode({
      command: "enhance-now",
      captureOnThisNote: false,
      transcriptLink: undefined,
      writeTranscriptNote: true,
    });
    expect(mode.kind).toBe("unavailable");
    expect(mode).toHaveProperty("message", expect.stringContaining("Clean up this note"));
  });

  // The setting is off, so "start capture once" alone would send the user in a circle:
  // no sidecar would be written and the same message would come back.
  test("Enhance now says which setting is off when transcript notes are disabled", () => {
    const mode = resolveEnhanceMode({
      command: "enhance-now",
      captureOnThisNote: false,
      transcriptLink: undefined,
      writeTranscriptNote: false,
    });
    expect(mode.kind).toBe("unavailable");
    expect(mode).toHaveProperty("message", expect.stringContaining("Write transcript note"));
    expect(mode).toHaveProperty("message", expect.stringContaining("Clean up this note"));
  });

  test("Clean up this note enhances a hand-written note with no transcript", () => {
    expect(resolveEnhanceMode({
      command: "clean-up-this-note",
      captureOnThisNote: false,
      transcriptLink: undefined,
      writeTranscriptNote: true,
    })).toEqual({ kind: "notes-only" });
  });

  // "Write transcript note" governs what a future capture writes. It says nothing about
  // whether this note can be cleaned up right now, so it must not reach this decision.
  test("Clean up this note ignores the transcript-note setting entirely", () => {
    expect(resolveEnhanceMode({
      command: "clean-up-this-note",
      captureOnThisNote: false,
      transcriptLink: undefined,
      writeTranscriptNote: false,
    })).toEqual({ kind: "notes-only" });
  });

  // Silently discarding a transcript the user already has is the failure this prevents.
  test("Clean up this note refuses a note that has a transcript, and names Enhance now", () => {
    const mode = resolveEnhanceMode({
      command: "clean-up-this-note",
      captureOnThisNote: false,
      transcriptLink: "Transcripts/2026-08-24-1200",
      writeTranscriptNote: true,
    });
    expect(mode.kind).toBe("unavailable");
    expect(mode).toHaveProperty("message", expect.stringContaining("Enhance now"));
  });

  test("Clean up this note refuses a note that is being captured, and names Enhance now", () => {
    const mode = resolveEnhanceMode({
      command: "clean-up-this-note",
      captureOnThisNote: true,
      transcriptLink: undefined,
      writeTranscriptNote: true,
    });
    expect(mode.kind).toBe("unavailable");
    expect(mode).toHaveProperty("message", expect.stringContaining("Enhance now"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd D:/tools/obsidian-shorthand && npm test -- test/plugin-enhance-mode.test.ts
```

Expected failure: `error: Cannot find module '../src/enhance-mode.js' from
'D:\tools\obsidian-shorthand\test\plugin-enhance-mode.test.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/enhance-mode.ts`:

```ts
/**
 * Which enhancement a command should run on the active note.
 *
 * This lives here rather than in `main.ts` because `node_modules/obsidian` has `"main": ""`
 * and ships only type declarations: nothing in `main.ts` can be imported under `bun test`,
 * so a rule written there is a rule with no test. `main.ts` keeps the wiring; the choice
 * between the three sources of text lives here.
 */

export type EnhanceCommandId = "enhance-now" | "clean-up-this-note";

export type EnhanceRequest = Readonly<{
  command: EnhanceCommandId;
  /** A capture is running on *this* note and built an enhancer for it. */
  captureOnThisNote: boolean;
  /** The vault-relative `shorthand-transcript` target, or undefined when the note has none. */
  transcriptLink: string | undefined;
  writeTranscriptNote: boolean;
}>;

export type EnhanceMode =
  /** Reuse the capture's own runner: its buffered transcript is newer than any sidecar on disk. */
  | Readonly<{ kind: "live-capture" }>
  | Readonly<{ kind: "transcript"; transcriptLink: string }>
  /** No transcript, on purpose: enhance the note's own prose. */
  | Readonly<{ kind: "notes-only" }>
  | Readonly<{ kind: "unavailable"; message: string }>;

export function resolveEnhanceMode(request: EnhanceRequest): EnhanceMode {
  if (request.command === "clean-up-this-note") {
    // Both refusals name the other command instead of quietly doing something else: a
    // notes-only pass over a note that has a transcript would drop text the user recorded.
    if (request.captureOnThisNote) {
      return {
        kind: "unavailable",
        message: "Shorthand is capturing this note. Run \"Enhance now\" to fold in the transcript so far.",
      };
    }
    if (request.transcriptLink !== undefined) {
      return {
        kind: "unavailable",
        message: "This note has a transcript. Run \"Enhance now\" so the transcript is used.",
      };
    }
    return { kind: "notes-only" };
  }
  if (request.captureOnThisNote) return { kind: "live-capture" };
  if (request.transcriptLink !== undefined) {
    return { kind: "transcript", transcriptLink: request.transcriptLink };
  }
  return {
    kind: "unavailable",
    message: request.writeTranscriptNote
      ? "This note has no shorthand-transcript wikilink. Start capture once to create and link a sidecar, or run \"Clean up this note\" to enhance the note as written."
      : "This note has no shorthand-transcript wikilink, and \"Write transcript note\" is off. Turn it on in Shorthand settings and start capture once, or run \"Clean up this note\" to enhance the note as written.",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```sh
cd D:/tools/obsidian-shorthand && npm test -- test/plugin-enhance-mode.test.ts && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```sh
cd D:/tools/obsidian-shorthand && git add src/enhance-mode.ts test/plugin-enhance-mode.test.ts && git commit -m "feat: decide the enhancement mode in src, where bun test can reach it

Two enhancement commands now differ only in whether they feed a transcript, so the
branch between them is the part worth testing. main.ts cannot be imported under
bun test, so it gets the wiring and this gets the rule."
```

---

### Task 5: Plugin — add "Clean up this note" and give both enhancement commands a `checkCallback`

**Files:**
- Modify: `D:/tools/obsidian-shorthand/main.ts` — import after line 48; the `enhance-now` command at lines 187–191; `enhanceActiveNote` at lines 476–515; a new predicate beside `activeMarkdownFile` at lines 765–770
- Modify: `D:/tools/obsidian-shorthand/README.md` — command list at lines 138–142

**Interfaces:**
- Consumes: `resolveEnhanceMode(request: EnhanceRequest): EnhanceMode` and `type EnhanceCommandId` from Task 4; `enhanceNow(tier?: AgentTier, options?: Readonly<{ allowEmptyTranscript?: boolean }>)` from Task 3's pin.
- Produces (all on `ShorthandPlugin`, none exported):
  - `enhanceActiveNote(): Promise<void>` (unchanged signature, body delegates)
  - `cleanUpActiveNote(): Promise<void>`
  - `private runEnhancement(command: EnhanceCommandId): Promise<void>`
  - `private hasActiveMarkdownFile(): boolean`

**Scope note the reviewer needs.** The spec files the `callback` →
`checkCallback` conversion under increment 6. It is done here instead, for both
enhancement commands, because increment 2 adds a command and adding it with the
wrong callback shape only to rewrite it two increments later is churn. Increment
6 therefore inherits only the `main.ts:1252` inline-style fix. **Do not convert
`start-capture-this-note`, `stop-capture`, `toggle-shorthand-recording` or
`cancel-shorthand-recording`** — the spec scopes this to "both enhancement
commands", and the recorder commands are documented in the README as working with
or without an active note.

- [ ] **Step 1: Write the failing test**

There is no unit test to write: everything in this task is `main.ts`, which
cannot be imported under `bun test`. The failing check is the bundle-load smoke
test running against a bundle that must compile the new call. Establish the red
by deleting the built bundle and building:

```sh
cd D:/tools/obsidian-shorthand && rm -f main.js && npx tsc --noEmit
```

This is green right now. Add the *use* first — change only the `enhance-now`
command registration at lines 187–191 to the shape the rest of the task needs,
so the compiler is red before the implementation lands:

```ts
    this.addCommand({
      id: "enhance-now",
      name: "Enhance now",
      checkCallback: (checking: boolean) => {
        if (!this.hasActiveMarkdownFile()) return false;
        if (!checking) void this.enhanceActiveNote();
        return true;
      },
    });
    this.addCommand({
      id: "clean-up-this-note",
      name: "Clean up this note",
      checkCallback: (checking: boolean) => {
        if (!this.hasActiveMarkdownFile()) return false;
        if (!checking) void this.cleanUpActiveNote();
        return true;
      },
    });
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd D:/tools/obsidian-shorthand && npx tsc --noEmit
```

Expected:

```
main.ts(191,26): error TS2339: Property 'hasActiveMarkdownFile' does not exist on type 'ShorthandPlugin'.
main.ts(200,26): error TS2339: Property 'cleanUpActiveNote' does not exist on type 'ShorthandPlugin'.
```

- [ ] **Step 3: Write minimal implementation**

Three edits in `main.ts`.

(a) Insert after line 48 (`} from "shorthand-core/markdown";`), before the
`./src/settings.js` import:

```ts
import {
  resolveEnhanceMode,
  type EnhanceCommandId,
} from "./src/enhance-mode.js";
```

(b) Replace `enhanceActiveNote` in full — lines 476 through 515, from
`async enhanceActiveNote(): Promise<void> {` through its closing brace:

```ts
  async enhanceActiveNote(): Promise<void> {
    await this.runEnhancement("enhance-now");
  }

  async cleanUpActiveNote(): Promise<void> {
    await this.runEnhancement("clean-up-this-note");
  }

  /**
   * Both enhancement commands, which differ only in where the text comes from. The choice
   * itself is `resolveEnhanceMode` in src/, because nothing here can be imported under
   * bun test; what is left here is the file and vault plumbing that has to touch Obsidian.
   */
  private async runEnhancement(command: EnhanceCommandId): Promise<void> {
    const file = this.activeMarkdownFile();
    if (file === undefined) return;
    const vaultRoot = this.vaultRoot();
    if (vaultRoot === undefined) return;
    const notePath = resolve(vaultRoot, file.path);
    try {
      if (!await this.ensureScaffold(notePath)) return;
      const liveEnhancer = this.#capture?.notePath === notePath ? this.#capture.enhancer : undefined;
      const mode = resolveEnhanceMode({
        command,
        captureOnThisNote: liveEnhancer !== undefined,
        transcriptLink: transcriptWikilink(await readFile(notePath, "utf8")),
        writeTranscriptNote: this.settings.writeTranscriptNote,
      });
      switch (mode.kind) {
        case "unavailable":
          this.fail(mode.message);
          return;
        case "live-capture":
          // `liveEnhancer` is what made this mode reachable; re-checking is for the compiler.
          if (liveEnhancer === undefined) return;
          this.reportOutcome(await liveEnhancer.enhanceNow("link"));
          return;
        case "transcript": {
          const sidecarPath = resolve(vaultRoot, addMarkdownExtension(mode.transcriptLink));
          if (!isInside(vaultRoot, sidecarPath)) {
            this.fail("The note's shorthand-transcript link resolves outside the vault.");
            return;
          }
          const enhancer = await this.createEnhancer(
            notePath,
            vaultRoot,
            DEFAULT_CONFIG.enhancement.standaloneTimeoutMs,
          );
          enhancer.appendTranscript(await readFile(sidecarPath, "utf8"));
          this.reportOutcome(await enhancer.enhanceNow("link"));
          return;
        }
        case "notes-only": {
          const enhancer = await this.createEnhancer(
            notePath,
            vaultRoot,
            DEFAULT_CONFIG.enhancement.standaloneTimeoutMs,
          );
          // No appendTranscript, and core's empty-transcript gate would decline forever
          // without the waiver. The note's own prose reaches the model as `user_notes`.
          this.reportOutcome(await enhancer.enhanceNow("link", { allowEmptyTranscript: true }));
          return;
        }
        default: {
          const unhandled: never = mode;
          throw new Error(`Unhandled enhancement mode: ${JSON.stringify(unhandled)}`);
        }
      }
    } catch (error) {
      this.fail(`Enhancement failed: ${errorMessage(error)}`);
    }
  }
```

(c) Insert immediately after `activeMarkdownFile` (which ends at line 770):

```ts
  /**
   * The `checkCallback` predicate for both enhancement commands. Silent, unlike
   * `activeMarkdownFile`: Obsidian calls this while merely rendering the command palette,
   * so a Notice here would fire at a user who never chose the command.
   */
  private hasActiveMarkdownFile(): boolean {
    const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
    return file !== null && file !== undefined;
  }
```

Leave `activeMarkdownFile()` and its Notice exactly as they are. It is still
reached by `startCaptureOnActiveNote`, and it still runs inside
`runEnhancement` — harmlessly, since `checkCallback` has already established
there is a file, and defensively, since the view can change between the check and
the run.

- [ ] **Step 4: Run test to verify it passes**

```sh
cd D:/tools/obsidian-shorthand && npx tsc --noEmit && rm -f main.js && npm run build && npm test
```

All three. `test/plugin-bundle.test.ts` is the one that matters: it loads the
built `main.js` under a stub `obsidian`, and it exists because a bundle once
built cleanly and still threw at Obsidian load. Deleting `main.js` first is
mandatory — the test only builds the bundle when it is absent.

- [ ] **Step 5: Update the README command list**

Replace lines 138–142 so the new command is listed between "Enhance now" and the
two recorder commands (the paragraph at line 148 says "the last two commands",
so the new entry must not go at the end):

```md
- **Start capture on this note**
- **Stop capture**
- **Enhance now**
- **Clean up this note**
- **Toggle Shorthand recording**
- **Cancel Shorthand recording**
```

Then insert this paragraph after line 146 (the end of the "Capture starts only on
the active Markdown note" paragraph) and before the "The last two commands"
paragraph:

```md
**Enhance now** and **Clean up this note** are the same pass over two different inputs, and
each is offered only while a Markdown note is open. **Enhance now** needs a transcript — the
running capture's, or the sidecar the note links to. **Clean up this note** deliberately
supplies none, so it works on a note written or dictated by hand; it refuses a note that
already has a transcript rather than silently ignoring it.
```

- [ ] **Step 6: Commit**

```sh
cd D:/tools/obsidian-shorthand && git add main.ts README.md && git commit -m "feat: add \"Clean up this note\" for a note with no transcript

A note written by hand could not be run through the same formatting pass, because
enhancement required a transcript link. The new command supplies none and waives
core's empty-transcript gate; the two commands now share one path and differ only
in their input.

Both are registered with checkCallback rather than callback, which is what Obsidian
prescribes for a command that only applies under a condition — here, an open
Markdown note. The palette now hides them instead of offering a command whose only
effect is a Notice telling the user to open a note."
```

`main.js` is a build artifact — do not stage it.

- [ ] **Step 7: Click through it in a real vault**

Nothing above proves the command works, only that it loads. If
`OBSIDIAN_PLUGIN_DIR` is set, Step 4's build already copied into the live vault
and that vault is now holding a build from committed code. Reload Obsidian and
check four things by hand:

1. With no note open, neither "Shorthand: Enhance now" nor "Shorthand: Clean up
   this note" appears in the palette, and no Notice fires from opening it.
2. On a hand-written note with markers, "Clean up this note" rewrites the AI
   block.
3. On a note with a `shorthand-transcript` link, "Clean up this note" refuses and
   names "Enhance now".
4. On that same note, "Enhance now" still folds the sidecar in as before.

Item 4 is the regression that matters: `runEnhancement` replaced the whole of the
old `enhanceActiveNote`, and no automated test in this repo covers that path.

## Section B — Increment 3: remove "Use Shorthand post-processing"

Covers Increment 3 of `docs/superpowers/specs/2026-08-24-plugin-polish-design.md` only.
Tasks are numbered 20–25 so they do not collide with other sections.

Repository: `D:/tools/obsidian-shorthand` (the Obsidian plugin). Default branch `main`.
All line numbers below are **as of commit `42eae9e`**, the state of the tree when this plan
was written. Earlier tasks delete lines, so numbers shift as you go — **anchor every edit on
the quoted text, not on the number.** Each task re-states the text it expects to find.

### Read this before you start

**1. `OBSIDIAN_PLUGIN_DIR` may be set in your environment.** `esbuild.config.mjs` has a
`deliver-to-vault` plugin: when that variable is set, **every** build copies `main.js` and
`manifest.json` straight into a live Obsidian vault's plugin folder. Check with
`echo "$OBSIDIAN_PLUGIN_DIR"` before you begin. AGENTS.md requires you leave the vault holding a
build from **committed** code; Task 25 does that as its last step.

Task 0 has already removed the build from the test path, so `npm test` no longer writes to the
vault. Only an explicit `npm run build` does.

**2. `main.js` is gitignored.** Never `git add main.js`. It is a ~6.9MB bundle shipped via GitHub
releases.

**3. Build before you run the full suite.** Task 0 made `test/plugin-bundle.test.ts` fail when
`main.js` is missing or older than its sources, so `npm test` on an unbuilt tree fails on
staleness rather than on your change. Full gate is `npx tsc --noEmit && npm run build &&
npm test`. While iterating red/green, name the file instead — `npm test --
test/plugin-settings.test.ts` — which skips the bundle test and needs no build.

**4. Nothing in `main.ts` can be imported under `bun test`.** `node_modules/obsidian` has
`"main": ""` and ships only type declarations, so there is no runtime module to stub at import
time. AGENTS.md § "The settings surface" states this: anything expressed in `main.ts` is verified
only by `npx tsc --noEmit`, the bundle smoke test, and a human clicking through Obsidian. Tasks 20,
21 and 22 touch only `main.ts`, so they cannot open with a failing unit test. Their steps say so
plainly rather than inventing one.

**5. Do not touch `shorthand-core`.** Core declares `"toggle-post-process"` in its exported
`ControlSignal` union and never uses it. That member **stays** — removing an exported union member
is a breaking retype for no gain, and the spec puts it out of scope. The plugin simply stops
selecting it. Core is pinned at `github:mshish/shorthand-core#0.10.0` and a local edit in the core
checkout is invisible here anyway.

**6. No data migration.** A `data.json` that still holds `useShorthandPostProcessing` simply stops
being read, and drops the next time settings are saved. Task 23 adds the test that proves the
stale key cannot break `normalizePluginSettings`, which AGENTS.md names as the trust boundary for
that untrusted file.

**7. Staging.** AGENTS.md forbids `git add -A`, `git add .` and `git commit -a`. Every commit below
names its paths. The working tree currently has an untracked `.serena/` directory — leave it alone.

### Gate commands

```bash
npm test              # bun test
npx tsc --noEmit      # tsconfig includes main.ts, src/**/*.ts AND test/**/*.ts
npm run build         # runs `tsc --noEmit` then `node esbuild.config.mjs production`
```

Tasks 20–24 gate on `npm test` and `npx tsc --noEmit`. Task 25 runs all three.

---

### Task 20: Always drive Shorthand's plain transcription toggle

Deletes the signal *selection*: `recordingSignalFor()`, the private `recordingSignal()` method and
its nine-line comment, and the per-capture snapshot. After this task the recorder is always built
with `"toggle-transcription"` and `"toggle-post-process"` appears nowhere in the plugin.

**Files:**
- Modify: `main.ts:107-112` (the `CaptureRuntime.recorder` doc comment)
- Modify: `main.ts:197` (the `toggle-shorthand-recording` command callback)
- Modify: `main.ts:297-299` (the `recordingSignal` argument to `ShorthandRecorder` and its comment)
- Modify: `main.ts:527-541` (the `recordingSignal()` method and its comment, plus the blank line after)
- Modify: `main.ts:1305-1309` (the `recordingSignalFor()` function and its doc comment)

**Interfaces:**
- Consumes: nothing from an earlier task; this is the first task in the section.
- Produces: `main.ts` no longer references `recordingSignalFor`, `recordingSignal()` or
  `"toggle-post-process"`. `this.settings.useShorthandPostProcessing` survives at exactly two
  sites — `main.ts:279` (Task 21) and the settings row at `main.ts:869-873` (Task 22).
  `ShorthandRecorderOptions.recordingSignal: ControlSignal` in `src/recorder.ts:75` is **unchanged**
  and still required; `main.ts` now passes the literal `"toggle-transcription"`.
  The `type ControlSignal` import at `main.ts:37` **stays** — `fireControl(signal: ControlSignal)`
  still uses it.

- [ ] **Step 1: Write the failing test** — *not possible here, and that is a finding, not an
  omission.* Every line this task touches lives in `main.ts`, which cannot be imported under
  `bun test` (see "Read this before you start", point 4). There is no unit test to turn red. The
  standing verification is `npx tsc --noEmit` plus `test/plugin-bundle.test.ts`. So the action for
  this step is to record the exact call sites you are about to remove, and confirm there are no
  others:

  ```bash
  cd /d/tools/obsidian-shorthand && grep -n "recordingSignalFor\|recordingSignal()\|toggle-post-process" main.ts
  ```

  Expect exactly five hits: lines 197, 299, 538, 539, 1307, 1308 (`recordingSignal()` at 538 is the
  declaration, 539 its body). If you see a sixth, stop and read it before deleting anything.

- [ ] **Step 2: Run test to verify it fails** — *inverted for a deletion.* Establish that the
  before-state is clean, because the only signal this task can produce is "the deletion introduced
  no error", which is meaningless unless there was no error to begin with:

  ```bash
  cd /d/tools/obsidian-shorthand && npx tsc --noEmit
  ```

  Expect **no output and exit 0**. If it reports anything, that error is pre-existing and belongs
  to another section — resolve or record it before continuing.

- [ ] **Step 3: Write minimal implementation** — apply all five edits to `main.ts`.

  a) `main.ts:107-112`. The parenthetical describes the post-processing snapshot rule, which stops
  existing in this commit; the rest of the comment still applies to `controlShorthandRecording`.
  AGENTS.md § Code style forbids leaving a comment describing behaviour the code no longer has.

  Replace:

  ```ts
  /**
   * Present exactly when this capture drives Shorthand's recorder. Built once, at start, from
   * the settings as they were then: reading them live at each call site let a setting
   * flipped mid-capture send a stop signal that had no matching start (or the stop toggle
   * for a different signal than the one that started the recording).
   */
  ```

  with:

  ```ts
  /**
   * Present exactly when this capture drives Shorthand's recorder. Built once, at start, from
   * the settings as they were then: reading them live at each call site let a setting
   * flipped mid-capture send a stop signal that had no matching start.
   */
  ```

  b) `main.ts:197`. Replace:

  ```ts
      callback: () => { this.fireControl(this.recordingSignal()); },
  ```

  with:

  ```ts
      callback: () => { this.fireControl("toggle-transcription"); },
  ```

  c) `main.ts:297-299`. Replace:

  ```ts
          // Captured from `postProcessing`, not read live: the recorder must stop the
          // recording with the same toggle it started it with, even if the setting flips.
          recordingSignal: recordingSignalFor(postProcessing),
  ```

  with:

  ```ts
          recordingSignal: "toggle-transcription",
  ```

  d) `main.ts:527-541`. Delete the whole method, its comment, and the blank line that follows it:

  ```ts
    /**
     * The live setting, deliberately: this is the manual override, which belongs to the user
     * and not to any capture, so it must obey the switch as it is set right now.
     *
     * A capture snapshots its own copy at start instead of calling this, because it has to
     * finalize with the same toggle it started the recording with. The split is intentional
     * and has one visible consequence: flipping **Use Shorthand post-processing** mid-capture makes
     * "Toggle Shorthand recording" drive the *other* flag than the one the capture will finalize
     * with. Reconciling them would mean either a capture that stops with a toggle that has no
     * matching start, or a manual command that silently ignores the setting — both worse.
     */
    private recordingSignal(): ControlSignal {
      return recordingSignalFor(this.settings.useShorthandPostProcessing);
    }

  ```

  The `shorthandCommand()` method above it and the `fireControl()` comment below it both stay.

  e) `main.ts:1305-1309`. Delete the function, its doc comment, and one adjoining blank line:

  ```ts

  /** Which of Shorthand's two recording toggles a capture drives. */
  function recordingSignalFor(postProcessing: boolean): ControlSignal {
    return postProcessing ? "toggle-post-process" : "toggle-transcription";
  }
  ```

  `samePath()` above and `streamExitMessage()` below stay, separated by a single blank line.

- [ ] **Step 4: Run test to verify it passes**

  ```bash
  cd /d/tools/obsidian-shorthand && npx tsc --noEmit && npm run build && npm test
  ```

  Expect `tsc` silent and `bun test` green. Then confirm the deletion is total:

  ```bash
  cd /d/tools/obsidian-shorthand && grep -n "recordingSignalFor\|toggle-post-process" main.ts src/*.ts; echo "exit $?"
  ```

  Expect no matches (`exit 1` from grep). `postProcessing` still appears at `main.ts:279-280`; that
  is Task 21's job.

- [ ] **Step 5: Commit**

  ```bash
  cd /d/tools/obsidian-shorthand && git add main.ts && git commit -m "refactor: always drive Shorthand's plain transcription toggle

The post-process toggle was selectable but not expected to be used, and the
snapshot-at-capture-start rule existed only to keep a capture finalizing with
the toggle it started. With one toggle there is no mid-capture inconsistency
left to reconcile, so the rule and its comment go with it.

Core keeps \"toggle-post-process\" in its ControlSignal union; removing an
exported union member is a breaking retype for no gain."
  ```

---

### Task 21: Always use core's drain budget when stopping

Deletes `POST_PROCESS_DRAIN_TIMEOUT_MS`, the branch that chose it, and the two comments that
explained the longer window. Stopping now always spends `DEFAULT_CONFIG.drainTimeoutMs` (10s).

**Files:**
- Modify: `main.ts:91-100` (the `POST_PROCESS_DRAIN_TIMEOUT_MS` doc comment, the constant, the blank line after)
- Modify: `main.ts:279-280` (the `postProcessing` and `drainTimeoutMs` locals)
- Modify: `main.ts:286` (`drainTimeoutMs` shorthand property on `StreamClient`)
- Modify: `main.ts:303` (`finalizeTimeoutMs` on `ShorthandRecorder`)
- Modify: `main.ts:422-423` (the stop comment naming the post-processing drain)

**Interfaces:**
- Consumes: Task 20's output — `postProcessing` is by now referenced only at `main.ts:280`, so
  deleting both locals leaves nothing dangling. Run Task 20 first or this step will not compile.
- Produces: `POST_PROCESS_DRAIN_TIMEOUT_MS` no longer exists. `StreamClient` receives
  `drainTimeoutMs: DEFAULT_CONFIG.drainTimeoutMs` and `ShorthandRecorder` receives
  `finalizeTimeoutMs: DEFAULT_CONFIG.drainTimeoutMs`. `src/recorder.ts` is untouched:
  `finalizeTimeoutMs: number` at line 81 stays a required option.
  `this.settings.useShorthandPostProcessing` now has exactly one reader left, the settings row.

- [ ] **Step 1: Write the failing test** — *not possible; same reason as Task 20.* `main.ts` cannot
  be imported under `bun test`, and a timeout constant has no observable behaviour a unit test
  could reach. Instead, confirm the constant has exactly the readers this task expects:

  ```bash
  cd /d/tools/obsidian-shorthand && grep -n "POST_PROCESS_DRAIN_TIMEOUT_MS\|postProcessing\|drainTimeoutMs\|finalizeTimeoutMs" main.ts
  ```

  Expect: 99 (declaration), 279, 280, 286, 303. Nothing else.

- [ ] **Step 2: Run test to verify it fails** — again inverted; confirm the before-state is clean:

  ```bash
  cd /d/tools/obsidian-shorthand && npx tsc --noEmit
  ```

  Expect no output, exit 0.

- [ ] **Step 3: Write minimal implementation** — apply four edits to `main.ts`.

  a) `main.ts:91-100`. Delete the comment, the constant, and the blank line after it:

  ```ts
  /**
   * Shorthand's post-processing runs an LLM pass between the recording ending and the `final`
   * event, and that pass now happens entirely inside the drain window — before this plugin
   * drove the recorder, the toggle was pressed by hand and most of that time had already
   * elapsed by the time Stop capture ran. A post-processed `final` that misses the window
   * is force-killed and lost, so the budget is raised rather than documented as a limit:
   * the timeout only ever costs time on a capture that already failed to finalize.
   */
  const POST_PROCESS_DRAIN_TIMEOUT_MS = 45_000;

  ```

  `const BEGIN_GRACE_MS = 1_500;` above and `type CaptureRuntime = {` below now sit one blank line
  apart.

  b) `main.ts:279-280`. Delete both lines:

  ```ts
        const postProcessing = this.settings.useShorthandPostProcessing;
        const drainTimeoutMs = postProcessing ? POST_PROCESS_DRAIN_TIMEOUT_MS : DEFAULT_CONFIG.drainTimeoutMs;
  ```

  `const command = this.shorthandCommand();` above stays; `const client = new StreamClient({` below
  stays.

  c) `main.ts:286`. The shorthand property loses its local, so name the value. Replace:

  ```ts
          drainTimeoutMs,
  ```

  with:

  ```ts
          drainTimeoutMs: DEFAULT_CONFIG.drainTimeoutMs,
  ```

  d) `main.ts:303`. The comment above it still holds — the recorder really does replace the
  follower's drain rather than precede it — so keep it and only change the value. Replace:

  ```ts
            finalizeTimeoutMs: drainTimeoutMs,
  ```

  with:

  ```ts
            finalizeTimeoutMs: DEFAULT_CONFIG.drainTimeoutMs,
  ```

  e) `main.ts:422-423`. The stop really can still spend a control timeout plus a drain; only the
  word "post-processing" is now wrong. Replace:

  ```ts
      // Stopping can spend a control timeout plus a whole post-processing drain. Without
      // this the status bar read "capturing" for all of it.
  ```

  with:

  ```ts
      // Stopping can spend a control timeout plus the whole drain budget. Without this the
      // status bar read "capturing" for all of it.
  ```

- [ ] **Step 4: Run test to verify it passes**

  ```bash
  cd /d/tools/obsidian-shorthand && npx tsc --noEmit && npm run build && npm test
  ```

  Expect `tsc` silent and `bun test` green. `tsc` is the real gate here: it is what catches an
  orphaned `drainTimeoutMs` reference if you missed edit (c) or (d).

- [ ] **Step 5: Commit**

  ```bash
  cd /d/tools/obsidian-shorthand && git add main.ts && git commit -m "refactor: always use core's drain budget when stopping a capture

The 45s budget existed only to let Shorthand's post-processing LLM pass finish
inside the drain window. With post-processing gone there is nothing to wait for
beyond the plain final transcript, so stopping uses DEFAULT_CONFIG.drainTimeoutMs
unconditionally."
  ```

---

### Task 22: Delete the settings row

The toggle has been inert since Task 21. Removing it now is the point at which the feature stops
being offered to the user.

**Files:**
- Modify: `main.ts:868-873` (the "Use Shorthand post-processing" `Setting`)

**Interfaces:**
- Consumes: Tasks 20 and 21 — nothing but this row still reads the setting, so removing it makes
  `useShorthandPostProcessing` unreferenced everywhere outside `src/settings.ts`.
- Produces: `useShorthandPostProcessing` appears in exactly two files afterwards,
  `src/settings.ts` and `test/plugin-settings.test.ts`, which is precisely Task 23's scope.

- [ ] **Step 1: Write the failing test** — *not possible; `main.ts` again.* The settings pane is
  Obsidian wiring and has no test in this repo; AGENTS.md accepts that on condition that `main.ts`
  stays thin enough to review by reading. Confirm the row's exact boundaries instead:

  ```bash
  cd /d/tools/obsidian-shorthand && grep -n "Use Shorthand post-processing\|useShorthandPostProcessing" main.ts
  ```

  Expect exactly four hits: 869, 870, 872, 873 — all inside one `new Setting(containerEl)` chain
  starting at line 868.

- [ ] **Step 2: Run test to verify it fails** — inverted; confirm clean before-state:

  ```bash
  cd /d/tools/obsidian-shorthand && npx tsc --noEmit
  ```

  Expect no output, exit 0.

- [ ] **Step 3: Write minimal implementation** — delete `main.ts:868-873` in full:

  ```ts
      new Setting(containerEl)
        .setName("Use Shorthand post-processing")
        .setDesc("Drive Shorthand's post-processed transcription instead of plain transcription. Post-processing runs an LLM pass after the recording ends, so stopping a capture waits longer for the final transcript (45s instead of 10s). A capture keeps the value this setting had when it started, so that it stops the recording with the same toggle it started; changing it mid-capture affects only the \"Toggle Shorthand recording\" command and the next capture.")
        .addToggle((toggle) => toggle
          .setValue(this.plugin.settings.useShorthandPostProcessing)
          .onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, useShorthandPostProcessing: value })));
  ```

  The "Control Shorthand recording" row ends immediately above it and the "Debug logging" row
  begins immediately below; after the deletion they are adjacent with no blank line, matching the
  rest of the block. Do not reword either — their copy is Increment 5's job, not this section's.

- [ ] **Step 4: Run test to verify it passes**

  ```bash
  cd /d/tools/obsidian-shorthand && npx tsc --noEmit && npm run build && npm test
  ```

  Expect `tsc` silent, `bun test` green. Then confirm `main.ts` is finished:

  ```bash
  cd /d/tools/obsidian-shorthand && grep -in "postprocess\|post-process\|post processing" main.ts; echo "exit $?"
  ```

  Expect no matches (`exit 1`).

- [ ] **Step 5: Commit**

  ```bash
  cd /d/tools/obsidian-shorthand && git add main.ts && git commit -m "feat: remove the Use Shorthand post-processing toggle

The setting is not expected to be used and its name overstated what it
delivered. Nothing has read it since the drain branch went, so the row was
offering a choice that changed nothing."
  ```

---

### Task 23: Drop the key from the settings contract, and prove a stale `data.json` is harmless

The only task in this section with a genuine red-first test. Two of the existing tests were written
specifically to pin `useShorthandPostProcessing` apart from a neighbouring boolean; what they
verify — that normalization never reads one boolean's value under another key — is still worth
verifying, so they are **rewritten against `controlShorthandRecording` and `debugLogging`, not
deleted**. That pair is a good replacement precisely because their defaults differ (`true` and
`false`), so a cross-wired guard shows up even when one side is left at its default.

**Files:**
- Modify: `src/settings.ts:12` (the field in `ShorthandPluginSettings`)
- Modify: `src/settings.ts:48` (the entry in `DEFAULT_PLUGIN_SETTINGS`)
- Modify: `src/settings.ts:70-72` (the branch in `normalizePluginSettings`)
- Test: `test/plugin-settings.test.ts:12-19`, `:36-66`, `:84-91`, `:93-101`, `:103-117`

**Interfaces:**
- Consumes: Tasks 20–22 — no `main.ts` reader remains, so removing the field cannot break the
  typecheck. `tsconfig.json` includes `test/**/*.ts`, so a leftover reference in a test file is a
  typecheck error too; that is why the test rewrite and the field deletion land in one commit.
- Produces:
  - `ShorthandPluginSettings` without `useShorthandPostProcessing` — 12 keys, was 13.
  - `DEFAULT_PLUGIN_SETTINGS: ShorthandPluginSettings` unchanged in every other value.
  - `normalizePluginSettings(input: unknown): ShorthandPluginSettings` — same signature; it now
    ignores the key entirely, so it never reaches the returned object and is dropped on the next
    `saveSettings`.

- [ ] **Step 1: Write the failing test** — apply five edits to `test/plugin-settings.test.ts`.
  Edits (a) and (e) are the rewrites of the pinning tests; (b), (c), (d) drop the removed key from
  fixtures; the new test at the end is the trust-boundary proof.

  a) Replace the test at lines 12-19:

  ```ts
    test("debugLogging defaults to false when absent or malformed, independently of the other toggles", () => {
      // Asserting only debugLogging's own key cannot catch a guard that reads a neighbouring
      // boolean's value. controlShorthandRecording is the useful neighbour because it defaults
      // the other way, so a cross-wire to it surfaces even when it is left at its default.
      expect(normalizePluginSettings({}).debugLogging).toBe(false);
      expect(normalizePluginSettings({ debugLogging: "yes" }).debugLogging).toBe(false);
      expect(normalizePluginSettings({ controlShorthandRecording: true }).debugLogging).toBe(false);
      expect(normalizePluginSettings({ debugLogging: false }).controlShorthandRecording).toBe(true);
    });
  ```

  b) In "normalizes valid persisted values" (lines 36-66), delete line 46 from the input object:

  ```ts
        useShorthandPostProcessing: true,
  ```

  and delete line 60 from the `toEqual` expectation:

  ```ts
        useShorthandPostProcessing: true,
  ```

  Both lines sit between `controlShorthandRecording: false,` and `writeTranscriptNote: true,`. The
  assertion is `toEqual`, so it is exhaustive: leaving the key in the expectation fails, and leaving
  it in the input fails once the normalizer stops returning it.

  c) Replace the test at lines 84-91:

  ```ts
    test("defaults the Shorthand control toggle", () => {
      expect(normalizePluginSettings({})).toMatchObject({ controlShorthandRecording: true });
      expect(DEFAULT_PLUGIN_SETTINGS.controlShorthandRecording).toBe(true);
    });
  ```

  d) Replace the test at lines 93-101:

  ```ts
    test("falls back for non-boolean Shorthand toggles", () => {
      for (const garbage of ["true", 1, null, {}, []]) {
        expect(normalizePluginSettings({ controlShorthandRecording: garbage, debugLogging: garbage }))
          .toMatchObject({
            controlShorthandRecording: DEFAULT_PLUGIN_SETTINGS.controlShorthandRecording,
            debugLogging: DEFAULT_PLUGIN_SETTINGS.debugLogging,
          });
      }
    });
  ```

  e) Replace the comment and test at lines 103-117 — this is the second pinning test, rewritten
  against the surviving pair and followed by the new trust-boundary test:

  ```ts
    // Every value here is non-default AND differs from the other key's value, which is what
    // makes a cross-wired guard die in both directions. Asserting a key's *default* proves
    // nothing: reading the wrong key and falling through to the default are indistinguishable
    // in that case, which is exactly how an earlier version of this test survived
    // `controlShorthandRecording` reading a neighbouring key's value.
    test("keeps each boolean toggle on its own key", () => {
      expect(normalizePluginSettings({ controlShorthandRecording: false, debugLogging: true }))
        .toMatchObject({ controlShorthandRecording: false, debugLogging: true });
      // And with garbage on one side, so a guard that reads the *other* key's type test is
      // caught too: here the surviving value is non-default on both sides in turn.
      expect(normalizePluginSettings({ controlShorthandRecording: false, debugLogging: "yes" }))
        .toMatchObject({ controlShorthandRecording: false, debugLogging: false });
      expect(normalizePluginSettings({ controlShorthandRecording: 0, debugLogging: true }))
        .toMatchObject({ controlShorthandRecording: true, debugLogging: true });
    });

    // normalizePluginSettings is the trust boundary for data.json, and every install that
    // predates this removal still has useShorthandPostProcessing on disk. The key must be
    // ignored rather than carried through: a stale key that survived normalization would be
    // written straight back out on the next save and never drop. There is no migration —
    // this test is what stands in for one.
    test("a data.json still holding the removed post-processing key normalizes without it", () => {
      const stored = { controlShorthandRecording: false, useShorthandPostProcessing: true, debugLogging: true };
      const normalized = normalizePluginSettings(stored);
      expect(normalized).not.toHaveProperty("useShorthandPostProcessing");
      expect(normalized).toMatchObject({ controlShorthandRecording: false, debugLogging: true });
      expect(normalized).toEqual(normalizePluginSettings({ controlShorthandRecording: false, debugLogging: true }));
    });
  ```

  `normalizePluginSettings` takes `unknown`, so the extra property in `stored` is not an excess
  property error.

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  cd /d/tools/obsidian-shorthand && npm test -- test/plugin-settings.test.ts
  ```

  Expect **two failing tests** in `test/plugin-settings.test.ts`:
  - `a data.json still holding the removed post-processing key normalizes without it` — fails at
    `expect(normalized).not.toHaveProperty("useShorthandPostProcessing")`, because the field is
    still on the returned object.
  - `normalizes valid persisted values` — `toEqual` fails with an unexpected
    `useShorthandPostProcessing: false` on the received object.

  Every other test in the file passes: the rewritten pinning tests describe behaviour that is
  already correct, which is the honest shape for a rewrite.

- [ ] **Step 3: Write minimal implementation** — apply three deletions to `src/settings.ts`.

  a) `src/settings.ts:12`, from the `ShorthandPluginSettings` type. Delete:

  ```ts
    useShorthandPostProcessing: boolean;
  ```

  It sits between `controlShorthandRecording: boolean;` and the `writeTranscriptNote` doc comment.

  b) `src/settings.ts:48`, from `DEFAULT_PLUGIN_SETTINGS`. Delete:

  ```ts
    useShorthandPostProcessing: false,
  ```

  c) `src/settings.ts:70-72`, from `normalizePluginSettings`. Delete:

  ```ts
      useShorthandPostProcessing: typeof value.useShorthandPostProcessing === "boolean"
        ? value.useShorthandPostProcessing
        : DEFAULT_PLUGIN_SETTINGS.useShorthandPostProcessing,
  ```

  Nothing replaces it. An unread key on an untrusted `data.json` needs no guard: `value` is a
  `Record<string, unknown>` and the returned object is built key by key, so an unknown key simply
  never appears in the result.

- [ ] **Step 4: Run test to verify it passes**

  ```bash
  cd /d/tools/obsidian-shorthand && npx tsc --noEmit && npm run build && npm test
  ```

  Expect `bun test` fully green and `tsc` silent. `tsc` matters as much as the tests here:
  `tsconfig.json` includes `test/**/*.ts`, so any reference to the removed key you missed in the
  test file is a compile error, not a silent `undefined`.

  Then confirm the key is gone from the source tree:

  ```bash
  cd /d/tools/obsidian-shorthand && grep -rn "useShorthandPostProcessing" main.ts src test; echo "exit $?"
  ```

  Expect exactly one hit — the fixture inside the new trust-boundary test in
  `test/plugin-settings.test.ts`, which is deliberate. Nothing in `main.ts` or `src/`.

- [ ] **Step 5: Commit**

  ```bash
  cd /d/tools/obsidian-shorthand && git add src/settings.ts test/plugin-settings.test.ts && git commit -m "refactor: drop useShorthandPostProcessing from the settings contract

No migration: a data.json still holding the key stops being read and drops on
the next save. The new normalization test is what stands in for a migration —
normalizePluginSettings is the trust boundary for that file, so a stale key
must be provably harmless.

The two tests that pinned this key apart from a neighbour are rewritten against
controlShorthandRecording and debugLogging rather than deleted; what they verify
- that no guard reads one boolean's value under another key - still holds."
  ```

---

### Task 24: Fix the two comments that still name a post-processing drain

`src/state.ts` and `test/plugin-state.test.ts` both explain the `stopping` flag by naming a drain
that no longer has anything to do with post-processing. The *reason* they give is still true — the
stop window is long and used to look like a hang — so the comments are corrected, not deleted.
This is separate from Tasks 20–22 because it is the only comment work outside `main.ts`.

**Files:**
- Modify: `src/state.ts:7-9` (the `stopping` field doc in `PluginUiState`)
- Test: `test/plugin-state.test.ts:33-35` (the comment above "a stop request is visible before the
  capture has finished stopping")

**Interfaces:**
- Consumes: Task 21 — the drain is now unconditionally `DEFAULT_CONFIG.drainTimeoutMs`, which is
  what makes "the full drain budget" the accurate phrasing.
- Produces: no code change at all. `PluginUiState`, `PluginUiEvent` and `reducePluginState` are
  untouched; only comment text moves.

- [ ] **Step 1: Write the failing test** — *not applicable: this task changes no behaviour.* Both
  edits are comments. Writing a test that asserts on comment text would be a test of the source
  file's bytes, which this repo does not do anywhere and which would rot immediately. The gate is
  that the existing suite stays green and the stale phrasing is gone. Action for this step: list
  every remaining occurrence outside the spec, so you know the exact scope:

  ```bash
  cd /d/tools/obsidian-shorthand && grep -rn "post-processing\|post processing" src test README.md
  ```

  Expect exactly three hits: `src/state.ts:8`, `test/plugin-state.test.ts:33`, and README lines 159
  and 210 (Task 25). Nothing in `src/settings.ts` or `src/recorder.ts`.

- [ ] **Step 2: Run test to verify it fails** — inverted; confirm the suite is green before you
  touch a test file, so a later failure can only be yours:

  ```bash
  cd /d/tools/obsidian-shorthand && npm test -- test/plugin-settings.test.ts
  ```

  Expect green.

- [ ] **Step 3: Write minimal implementation** — two comment edits.

  a) `src/state.ts:7-9`. Replace:

  ```ts
     * Set between the stop request and the capture actually finishing. Stopping is not
     * instant — it can spend a control timeout plus a full post-processing drain waiting for
     * Shorthand's `final` — and without this the status bar still read "capturing" for the whole
  ```

  with:

  ```ts
     * Set between the stop request and the capture actually finishing. Stopping is not
     * instant — it can spend a control timeout plus the full drain budget waiting for
     * Shorthand's `final` — and without this the status bar still read "capturing" for the whole
  ```

  Leave the remaining three lines of that comment (`of it, which looks like a hang. …`) untouched.

  b) `test/plugin-state.test.ts:33-35`. Replace:

  ```ts
    // Stopping is not instant: it can spend a control timeout plus a whole post-processing
    // drain waiting for Shorthand's `final`, and the status bar used to read "capturing"
    // throughout, which looks like a hang.
  ```

  with:

  ```ts
    // Stopping is not instant: it can spend a control timeout plus the whole drain budget
    // waiting for Shorthand's `final`, and the status bar used to read "capturing"
    // throughout, which looks like a hang.
  ```

- [ ] **Step 4: Run test to verify it passes**

  ```bash
  cd /d/tools/obsidian-shorthand && npx tsc --noEmit && npm run build && npm test
  ```

  Expect green and silent. Then:

  ```bash
  cd /d/tools/obsidian-shorthand && grep -rn "post-processing\|post processing" main.ts src test; echo "exit $?"
  ```

  Expect no matches (`exit 1`). The whole TypeScript tree is now clean of the feature.

- [ ] **Step 5: Commit**

  ```bash
  cd /d/tools/obsidian-shorthand && git add src/state.ts test/plugin-state.test.ts && git commit -m "docs: stop naming post-processing in the stopping-window comments

The stop window is still long enough to look like a hang, which is why the
stopping flag exists — but the drain is now unconditionally core's budget, so
the comments named a branch the code no longer has."
  ```

---

### Task 25: Remove the setting from the README, then run the full gate

The README documents the setting in two places. Neither is listed in the spec's "Deleted" list,
but AGENTS.md § Code style forbids describing behaviour the code does not implement, and README.md
is the user-facing document the settings pane's copy is derived from. Leaving it would ship
documentation for a toggle that no longer exists.

This task also carries the full three-command gate and the vault hand-back, because it is the last
commit in the section.

**Files:**
- Modify: `README.md:156` ("Two settings control this:")
- Modify: `README.md:159-160` (the bullet for the setting)
- Modify: `README.md:210-215` (the paragraph on the 45s window and the mid-capture split)

**Interfaces:**
- Consumes: Tasks 20–24. Nothing in the code implements what these paragraphs describe.
- Produces: the section "Driving Shorthand's recorder" documents one setting,
  **Control Shorthand recording**. `README.md:217` ("Stopping is not instant: it can spend a control
  timeout plus the whole drain budget…") is already phrased generically and **stays as is** — it is
  now the only statement about the stop window, which is correct.

- [ ] **Step 1: Write the failing test** — *not applicable: documentation.* There is no docs test in
  this repo. Action for this step: confirm the two regions and that nothing else in the README
  mentions the feature or the 45s figure:

  ```bash
  cd /d/tools/obsidian-shorthand && grep -n "post-process\|postProcessing\|45s\|Two settings" README.md
  ```

  Expect: 156 (`Two settings control this:`), 159, 160, 210, 211. Nothing else.

- [ ] **Step 2: Run test to verify it fails** — inverted; confirm the tree is green before the last
  commit of the section:

  ```bash
  cd /d/tools/obsidian-shorthand && npx tsc --noEmit && npm run build && npm test
  ```

  Expect green and silent.

- [ ] **Step 3: Write minimal implementation** — two README edits.

  a) Replace lines 155-160:

  ```markdown
  By default, **Start capture** and **Stop capture** also drive Shorthand's recorder, so a capture no
  longer needs a separate press of Shorthand's global hotkey. Two settings control this:

  - **Control Shorthand recording** (default on) — drive the recorder from start and stop.
  - **Use Shorthand post-processing** (default off) — use `--toggle-post-process` instead of
    `--toggle-transcription` as the recording toggle.
  ```

  with:

  ```markdown
  By default, **Start capture** and **Stop capture** also drive Shorthand's recorder, so a capture no
  longer needs a separate press of Shorthand's global hotkey. One setting controls this:

  - **Control Shorthand recording** (default on) — drive the recorder from start and stop. The
    recording toggle is always `--toggle-transcription`.
  ```

  b) Delete lines 210-215 in full, together with the blank line that follows them:

  ```markdown
  With **Use Shorthand post-processing** on, Shorthand runs an LLM pass after the recording ends, so Stop
  capture allows it a longer window (45s instead of 10s) to deliver the final transcript before the
  follower is stopped. A capture keeps whichever value the setting had when it started, so it always
  finalizes with the same toggle it started the recording with; changing the setting mid-capture
  therefore affects only **Toggle Shorthand recording** and the next capture, and during that window the
  manual command drives the other flag than the capture will.

  ```

  The paragraph beginning "**Toggle Shorthand recording** and **Cancel Shorthand recording** stay
  available…" (line 207) and the one beginning "Stopping is not instant:" (line 217) become adjacent,
  separated by one blank line. Do not edit either.

- [ ] **Step 4: Run test to verify it passes** — the full gate, in this order. **Delete the stale
  bundle first**, or `test/plugin-bundle.test.ts` will load a `main.js` built before any of this
  work and prove nothing:

  ```bash
  cd /d/tools/obsidian-shorthand && npx tsc --noEmit && rm -f main.js && npm run build && npm test
  ```

  Expect: `npm run build` runs `tsc --noEmit` then esbuild and writes `main.js`; `npm test` green
  including `the built plugin bundle > loads under a stub obsidian and exports a Plugin class with
  onload/onunload`; `tsc` silent.

  **If `OBSIDIAN_PLUGIN_DIR` is set, that build just wrote `main.js` and `manifest.json` into a live
  Obsidian vault** — you will see `delivered main.js and manifest.json to <path>` in the output.
  That is expected and required: it is how the vault ends up holding a build of the committed code,
  as AGENTS.md demands. Do not run another build after Step 5 unless you change source again.

  Final sweep across the whole repository, excluding the spec (which is a historical record and must
  not be edited):

  ```bash
  cd /d/tools/obsidian-shorthand && grep -rn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=docs --exclude=main.js -i "postprocess\|post-process\|post processing" . ; echo "exit $?"
  ```

  Expect exactly one hit — the `useShorthandPostProcessing` fixture inside the trust-boundary test
  in `test/plugin-settings.test.ts`.

- [ ] **Step 5: Commit**

  ```bash
  cd /d/tools/obsidian-shorthand && git add README.md && git commit -m "docs: remove Use Shorthand post-processing from the README

The setting no longer exists, so both the settings bullet and the paragraph on
the 45s window and the mid-capture toggle split described behaviour the plugin
does not have. The generic sentence about the stop window stays: it is still
true, and it is now the only claim made about that window."
  ```

  Then push, per AGENTS.md § "This repo is private, and pushing needs no permission":

  ```bash
  cd /d/tools/obsidian-shorthand && git push
  ```

---

### Done when

- `grep -rn "useShorthandPostProcessing" main.ts src` returns nothing.
- `grep -rn "toggle-post-process" main.ts src test README.md` returns nothing.
- `npm test`, `npx tsc --noEmit` and `npm run build` all pass, with `main.js` rebuilt from the
  committed tree.
- `test/plugin-settings.test.ts` contains the trust-boundary test proving a stored
  `useShorthandPostProcessing` is ignored, and two cross-wiring tests written against
  `controlShorthandRecording` and `debugLogging`.
- `shorthand-core` is untouched **by this section**. Its pin is already at
  `github:mshish/shorthand-core#0.11.0`, moved there by Task 3 — do not move it
  again, and do not move it back. (An earlier draft of this section was written
  to stand alone and asserted the pin was still `0.10.0`. That was true only
  before Section A was ordered ahead of it.)
- A manual pass in a real vault: open the plugin's settings tab and confirm the row between
  **Control Shorthand recording** and **Debug logging** is gone; run a capture and confirm Stop
  still finalizes. The settings pane is `main.ts`, so no automated check covers it.

## Section C — Increments 4 and 5: the copy style guide and the copy rewrite

Covers spec increments **4** (`docs/settings-copy-style.md` + the `AGENTS.md` pointer) and
**5** (rewrite every setting name and description in `main.ts`, move displaced detail to
`README.md`).

Tasks **40–49**.

### Read this before you start

**Line numbers below are as of the current `main.ts` (1287 lines).** Increment 3 runs before
this section and deletes `main.ts:868–873` (the "Use Shorthand post-processing" row), so
everything after line 873 shifts up by six. Increment 2 adds a command earlier in the file and
shifts everything after it down. **Anchor every edit on the quoted string, not the line
number.** The line numbers are here so you can find the region, not so you can `sed` by index.

**The setting "Use Shorthand post-processing" does not exist by the time you start.** Increment
3 removed it, the `useShorthandPostProcessing` key, and the drain-timeout branch. If you find
it in `main.ts`, increment 3 has not landed and you are in the wrong place. It appears in this
plan only in Task 48, where its leftover `README.md` prose is cleaned up.

**Nothing in `main.ts` can be imported under `bun test`.** `node_modules/obsidian` has
`"main": ""` and ships type declarations only, so there is no runtime module to stub at import
time. Copy that lives in `main.ts` is verified by exactly three things:

1. `npx tsc --noEmit` — proves the strings compile and the helper signatures line up.
2. `npm test` — includes `test/plugin-bundle.test.ts`, which loads the built `main.js` under a
   stub `obsidian`. It proves the module still *loads*; it never calls `display()`, so it sees
   none of these strings.
3. A human opening the settings tab in a real vault. Task 49 lists exactly what to look at.

That is why Task 43 pushes every computed description string into `src/settings-display.ts`,
where `bun test` reaches it, and leaves `main.ts` holding only the wiring. This mirrors what
`src/settings.ts` and `src/elapsed.ts` already do, and it is the rule `AGENTS.md` § "The
settings surface" states.

**The plugin gate is `npm test`, `npx tsc --noEmit`, `npm run build`.** All three, every time
a task says "run the gate". `OBSIDIAN_PLUGIN_DIR` may be set in this environment, in which case
every build copies into a live vault — leave the vault holding a build from committed code.

### What this section does not do

- The **Advanced** `setHeading()` grouping and the row reordering in the spec's increment-6
  table. A different section owns that. Write the copy where the row lives today; the grouping
  section moves the rows afterwards.
- The `NotePromptModal` "Default / Custom" rebuild, the `area.style.width` CSS fix, and
  the `checkCallback` conversion. All increment 6, all a different section.
- Command names and the palette. `README.md` § Commands already lists them and they already
  comply (no plugin name, sentence case).
- The status-bar text and its `title` attribute (`main.ts:1094–1107`). Not settings copy.
  Left alone deliberately; note it in the commit message so the next reader knows it was seen
  and skipped, not missed.

---

### Task 40: Write `docs/settings-copy-style.md`

**Files:**
- Create: `D:/tools/obsidian-shorthand/docs/settings-copy-style.md`
- Read for examples: `D:/tools/obsidian-shorthand/main.ts:820–911` (the settings tab),
  `main.ts:925–1000` (the LLM provider block)

**Interfaces:**
- Consumes: nothing.
- Produces: `docs/settings-copy-style.md`, with stable section anchors `#rule-1` … `#rule-9`
  used by the `AGENTS.md` pointer in Task 41 and cited by Tasks 44–47 in their commit messages.

The guide states the nine rules from the spec. Each rule gets: the rule in one line, the
primary source it comes from with its URL, and a do/don't pair **taken from this plugin's own
copy** — never an invented example. The "don't" side is the current string; the "do" side is
the string this section actually ships, so the guide and the code agree from day one.

- [ ] **Step 1: Create the file with its frontmatter and the "why this exists" opener.** Two
  paragraphs, no more. First: the descriptions in this plugin grew to five sentences because
  the old `AGENTS.md` rule said "match the register of the existing settings descriptions",
  which is a rule that ratchets in one direction only. Second: the GOV.UK finding, because it
  is the one that justifies the work against the obvious objection —
  "the more educated the person and the more specialist their knowledge, the greater their
  preference for plain English" (<https://www.gov.uk/guidance/content-design/writing-for-gov-uk>).
  A user of this plugin is a technical user, and that is an argument for plainer copy, not
  more mechanism.

- [ ] **Step 2: Write rules 1 and 2 (length, and the empty description).**

  ```markdown
  ## Rule 1 — One sentence. Three is the absolute ceiling.

  Obsidian's [Settings guide](https://docs.obsidian.md/Plugins/User+interface/Settings):
  "`desc` is for a single sentence explaining what the setting does, not for warnings or
  paragraphs of context. Long descriptions push the next row off-screen, disrupt scanning, and
  aren't guaranteed to be read."

  Overflow has a prescribed destination, from the same page: "If the user needs background
  context to understand the setting, link to a docs page from `desc` rather than inlining it."
  In this repo the docs page is `README.md`, linked by URL from a `DocumentFragment`.

  - **Don't** — the old **Control Shorthand recording**, five sentences ending "The consequence
    of that bias: quitting Shorthand in the middle of a capture normally does relaunch it,
    because the cancel is sent whenever there is any chance a recording is still running."
  - **Do** — "Starting and stopping a capture also starts and stops Shorthand, so you don't
    need its hotkey. Quitting Shorthand mid-capture normally relaunches it — see
    [Driving Shorthand's recorder]." Two sentences and a link; the paragraph the link replaces
    is still in `README.md`, word for word.

  ## Rule 2 — No description is a valid outcome.

  Write one only when the label leaves a real question unanswered.

  Android/Material settings: "If the label is sufficient on its own, don't add secondary text."
  Microsoft's [Win32 UX guide](https://learn.microsoft.com/en-us/windows/win32/uxguide/text-ui):
  "Don't have supplemental explanations that merely restate the label for consistency."

  - **Don't** — **Provider**, "Select the API family used for enhancement requests." The label
    says Provider; the dropdown shows which one. The sentence adds nothing.
  - **Do** — **Provider**, no `setDesc` call at all.
  ```

- [ ] **Step 3: Write rules 3 and 4 (consequence over mechanism, and current value).** Rule 4
  is the one that changes behaviour, so it carries the refinement this repo actually
  implements. Write it out in full:

  ```markdown
  ## Rule 3 — Describe the consequence, not the mechanism.

  Material's worked pair: DO `Enable NFC / Allow data exchange when the phone touches another
  device`; DON'T `NFC / Use Near Field Communication to read and exchange tags`.

  - **Don't** — **Enhancement backend**, "Choose whether note enhancement uses the Claude Agent
    SDK or a directly configured LLM provider." That is the dropdown read back as a sentence.
  - **Do** — "The Claude Agent SDK backend can look things up elsewhere in your vault; an LLM
    provider cannot." That is the difference the choice actually makes, and it is the reason a
    user would pick one.

  Second pair, because "mechanism" here often means core's vocabulary leaking into the pane:

  - **Don't** — **Enable live enhancement**, "Run tick passes while capture is active. Stop and
    Enhance now still use a link-tier pass." "Tick pass" and "link tier" are names from
    `shorthand-core`'s state machine. No user has ever seen either word.
  - **Do** — "The note is rewritten while the meeting runs, instead of only when you stop or
    run Enhance now."

  ## Rule 4 — For non-boolean settings, show the current value instead of a description.

  Material: secondary text "should show the current status of a setting only". Its pair is
  `Sleep / After 10 minutes of inactivity`, not `Screen timeout / Adjust the delay before the
  screen automatically turns off`.

  **The refinement this repo applies, and why.** Material's example is a row that opens a
  dialog: the value is not on screen, so the description is the only place it can appear. A
  text field or a dropdown already renders its value. Restating it there would violate rule 2
  and Microsoft's "don't restate the label" in the same breath. So rule 4 fires here in exactly
  two situations:

  1. **The raw value is not self-describing.** `25000` in a number field is not "25 seconds",
     and nothing on screen says which unit it is.
  2. **The stored value is not what the field shows.** `normalizePluginSettings` is the trust
     boundary for `data.json` and rewrites what it is given — a rejected folder path falls back
     to the default, an empty executable becomes `shorthand`. The field shows what was typed;
     the description shows what is in force.

  When neither applies, rule 2 wins and the row gets no description.

  - **Don't** — **Minimum interval (ms)**, "Minimum time between completed live passes."
  - **Do** — **Minimum interval**, "Live passes run no more often than once every 25 seconds.
    The value is in milliseconds." The number is the stored one, re-rendered on every edit.
  - **Don't** — **Transcript sidecar directory**, "Vault-relative directory used for new
    transcript notes."
  - **Do** — **Transcript folder**, "New transcript notes go in Meetings/Transcripts."

  Every string of this shape is built by a pure function in
  [`src/settings-display.ts`](../src/settings-display.ts), never inline in `main.ts`, because
  `main.ts` cannot be imported under `bun test`.
  ```

- [ ] **Step 4: Write rules 5 and 6 (toggle names, banned verbs).**

  ```markdown
  ## Rule 5 — Name toggles as positive noun phrases.

  Nielsen Norman Group's test: "say the label aloud and append 'on/off' to the end, and if it
  doesn't make sense, then rewrite the label." Never phrase a toggle so that on means off.

  - **Don't** — **Write transcript note**. "Write transcript note: on" reads as an instruction
    with a state stapled to it.
  - **Do** — **Transcript notes**. "Transcript notes: on" parses.
  - **Don't** — **Enable live enhancement**. "Enable live enhancement: on" is "enable: on".
  - **Do** — **Live enhancement**.

  **The aloud test is the operative one; the noun-phrase preference yields to it.**
  **Control Shorthand recording** stays a verb phrase, because "Shorthand recorder control"
  loses the fact that it is *this plugin* doing the controlling, and "Control Shorthand
  recording: on" passes the aloud test cleanly. Prefer the noun phrase; keep the verb phrase
  when the noun form drops the object.

  ## Rule 6 — Banned generic verbs in naming labels.

  Android's settings guidance: labels must not "Use generic terms, such as: Set, Change, Edit,
  Modify, Manage, Use, Select, or Choose."

  The ban applies to **naming labels** — anything that names a thing rather than invokes an
  action: setting names, headings, and the option text of a dropdown or radio. In those
  positions a generic verb displaces the noun that would have carried the meaning.

  It does **not** apply to **action buttons**. A button's job is to invoke, so an imperative
  verb is the correct part of speech there, and Obsidian's own UI is built from "Edit", "Save",
  "Cancel". Forcing a noun onto a button produces worse copy, not better.

  A description may use any of these words when it is the accurate verb.

  - **Don't** — the provider dropdown's placeholder option, "Select a provider". It is option
    text, so it names a state and must not issue an order.
  - **Do** — "No provider chosen".
  - **Don't** — a mode option reading "Use default". Same position, same problem: the verb adds
    nothing and "Default" alone is unambiguous next to "Custom".
  - **Do** — the prompt modal's two mode options, **Default** and **Custom**.
  - **Allowed** — the prompt row's **Edit…** button. An action button, not a naming label. The
    ellipsis follows the platform convention for an action that opens a further window.
  ```

- [ ] **Step 5: Write rules 7, 8 and 9 (terminology, case and punctuation, person).**

  ```markdown
  ## Rule 7 — Obsidian's terminology list is binding.

  From Obsidian's help style guide: prefer "folder" over "directory"; "Prefer 'maximum' over
  'max' and 'minimum' over 'min'". "Note" for a Markdown file. American spelling.

  - **Don't** — **Transcript sidecar directory**.
  - **Do** — **Transcript folder**. "Sidecar" is core's word for the file; a user sees a note in
    a folder.
  - **Do** — **Minimum interval**, **Minimum new characters**. Already correct; do not
    abbreviate them back.

  ## Rule 8 — Sentence case throughout. Periods on descriptions, never on labels.

  Obsidian's [plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines):
  "Any text in UI elements should be using Sentence case instead of Title Case". Microsoft:
  "Don't place [periods] at the end of control labels... Place at the end of supplemental
  instructions... that form a complete sentence."

  Headings follow the same rule and must not contain the word "settings" — Obsidian's guidance
  is to prefer "Advanced" over "Advanced settings".

  - **Do** — **LLM provider profile** (heading, no period), "The API key is stored outside your
    vault, so it never syncs." (description, period).
  - **Don't** — a fragment with a period bolted on. If it is not a sentence, it gets no period;
    if that feels wrong, it should have been a sentence.

  ## Rule 9 — Second person, present tense, active voice. No "we".

  - **Do** — "Turn this on if a note stops updating during capture."
  - **Don't** — "It will be created only after a valid edit is committed." Passive, future, and
    it hides who does the committing.
  - **Do** — "The profile is written once every required field has a value."
  ```

- [ ] **Step 6: Write the "Deviations this repo takes" section.** This is what lets a later
  maintainer tell a decision from an accident. Four entries, each naming the rule, the
  deviation, and the reason:
  1. **Rule 4 does not fire for text fields and dropdowns that already show their value.**
     Reason and reasoning as written in rule 4 above; the two triggering situations are listed
     there.
  2. **Rule 5 keeps "Control Shorthand recording" as a verb phrase.** The aloud test passes and
     the noun form drops the object.
  3. **Rule 1's "link to a docs page" target is `README.md` on GitHub, by absolute URL.** There
     is no hosted docs site. While this repository is private that link 404s for anyone without
     access; it becomes correct at publication, which is tracked separately and is out of scope
     for this spec. The alternative — inlining the paragraph — is the thing rule 1 exists to
     prevent, so the link stays.
  4. **Error and status strings are out of scope for the nine rules.** `The profile could not
     be saved: ${message}` is failure text, not a setting description; it is governed by
     "name the thing that failed and the reason", and Task 46 leaves those strings alone
     except where they were plainly over-long.

- [ ] **Step 7: Run the `no-ai-slop` skill over the whole guide.** Invoke it by name on
  `docs/settings-copy-style.md`. Expect it to flag the opener hardest — a "why this exists"
  section is where hedging and tricolons collect. Apply what it returns; do not argue with it
  on rhythm, do argue with it if it wants to soften a citation.

- [ ] **Step 8: Check every URL in the guide resolves and every quoted sentence matches its
  source.** The four Obsidian URLs are the ones that matter most, because they are the only
  sources that are *binding* rather than advisory. If a quote no longer appears on the page,
  fix the quote rather than the rule — and say so in the commit message.

- [ ] **Step 9: Commit.** `docs: add settings copy style guide`. Body names the nine rules'
  sources and states that increment 5 is the first application of them.

---

### Task 41: Replace the copy rule in `AGENTS.md` § Code style with a pointer

**Files:**
- Modify: `D:/tools/obsidian-shorthand/AGENTS.md:94–102` (§ Code style), specifically the third
  bullet at lines 98–100

**Interfaces:**
- Consumes: `docs/settings-copy-style.md` from Task 40.
- Produces: nothing later tasks import.

- [ ] **Step 1: Read `AGENTS.md:94–102` and confirm the bullet is still exactly this.** The
  current third bullet is:

  ```markdown
  - User-facing copy in `setDesc` is direct and specific about consequences —
    match the register of the existing settings descriptions rather than writing
    generic help text
  ```

- [ ] **Step 2: Replace that bullet with the pointer.** Match the file's style: bullets in this
  section have no terminal period.

  ```markdown
  - User-facing copy in the settings tab follows
    [docs/settings-copy-style.md](docs/settings-copy-style.md) — nine rules, each with the
    primary source it comes from. Read it before writing a `setName` or a `setDesc`
  - Do not match the register of the neighbouring rows. That instruction is what this rule
    replaced, and it is how the descriptions grew to five sentences: a rule that only ever
    ratchets one way
  ```

  The second bullet is not padding. The old rule's failure mode is the specific thing a future
  agent will otherwise re-derive, and naming it is cheaper than letting it happen twice.

- [ ] **Step 3: Confirm the relative link resolves from the repository root.** `AGENTS.md` is at
  the root, `docs/settings-copy-style.md` is one level down, so `docs/settings-copy-style.md`
  is correct on GitHub and in an editor preview. Open the preview and click it.

- [ ] **Step 4: Commit.** `docs: point AGENTS.md at the settings copy style guide`.

---

### Task 42: Slop-check the whole copy set before any of it lands

**Files:**
- Create then delete: a scratch file outside the repository, e.g.
  `D:/tools/obsidian-shorthand/.copy-draft.md` (add nothing to `.gitignore`; delete it in
  Step 4)

**Interfaces:**
- Consumes: every final string written out in Tasks 44–48 of this plan.
- Produces: the vetted strings that Tasks 44–48 paste. If this task changes a string, change it
  **in this plan file too**, so the plan and the code do not diverge.

Running `no-ai-slop` once over the full set beats running it per-string: the patterns it catches
best — the same sentence shape repeated across ten rows, a tricolon in every third description,
"seamlessly" appearing twice — are only visible when the set is read together.

- [ ] **Step 1: Copy every final string from Tasks 44, 45, 46, 47 and 48 into the scratch file**,
  one per line, grouped by row, with the label above each description. Include the README prose
  additions from Task 48. Do not include the code around them.

- [ ] **Step 2: Run the `no-ai-slop` skill on the scratch file.** Invoke it by name. Watch
  specifically for: em-dash overuse across the set (this plan's drafts use one in
  **Control Shorthand recording** and one in **Base URL** — two in twenty rows is fine, ten
  would not be), the "X, so Y" construction repeating, and any description that opens with the
  setting's own name.

- [ ] **Step 3: Apply every accepted change back into this plan file**, so Tasks 44–48 paste the
  vetted text rather than the draft. This is the step that keeps the plan honest; skipping it
  means the code and the plan disagree and the next reader trusts the wrong one.

- [ ] **Step 4: Delete the scratch file.** No commit — nothing in the repository changed.

---

### Task 43: `src/settings-display.ts` — every computed description string, with tests

**Files:**
- Create: `D:/tools/obsidian-shorthand/src/settings-display.ts`
- Create: `D:/tools/obsidian-shorthand/test/settings-display.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, all named exports from `./src/settings-display.js`:
  - `shorthandExecutableDescription(stored: string): string`
  - `claudeExecutableDescription(stored: string): string`
  - `transcriptFolderDescription(folder: string): string`
  - `newCharacterThresholdDescription(characters: number): string`
  - `passIntervalDescription(milliseconds: number): string`
  - `baseUrlDescription(provider: string): string`
  - `type StoredKeyState = "stored" | "absent" | "unknown"`
  - `apiKeyDescription(state: StoredKeyState): string`

  Tasks 44 and 46 import these. Note the `.js` extension in the import specifier — that is the
  convention already used by `./src/settings.js` and `./src/elapsed.js` in `main.ts`.

- [ ] **Step 1: Write the failing test file.** Model it on `test/elapsed.test.ts`: `bun:test`,
  `describe`/`test`/`expect`, relative import with `.js`.

  ```ts
  import { describe, expect, test } from "bun:test";
  import {
    apiKeyDescription,
    baseUrlDescription,
    claudeExecutableDescription,
    newCharacterThresholdDescription,
    passIntervalDescription,
    shorthandExecutableDescription,
    transcriptFolderDescription,
  } from "../src/settings-display.js";
  import { DEFAULT_PLUGIN_SETTINGS } from "../src/settings.js";

  describe("shorthandExecutableDescription", () => {
    test("a bare command name says where it is looked up", () => {
      expect(shorthandExecutableDescription("shorthand")).toBe("shorthand is looked up on your PATH.");
    });

    test("a path describes nothing: the field already shows it", () => {
      expect(shorthandExecutableDescription("C:\\Tools\\shorthand.exe")).toBe("");
      expect(shorthandExecutableDescription("/usr/local/bin/shorthand")).toBe("");
    });

    test("the shipped default is a bare name, so the row is never silent out of the box", () => {
      expect(shorthandExecutableDescription(DEFAULT_PLUGIN_SETTINGS.shorthandExecutable))
        .toBe("shorthand is looked up on your PATH.");
    });
  });

  describe("claudeExecutableDescription", () => {
    test("empty means core detects the CLI, which is shown nowhere else", () => {
      expect(claudeExecutableDescription("")).toBe("Claude is found automatically.");
      expect(claudeExecutableDescription("   ")).toBe("Claude is found automatically.");
    });

    test("a configured path describes nothing", () => {
      expect(claudeExecutableDescription("C:\\Users\\me\\.local\\bin\\claude.exe")).toBe("");
    });
  });

  describe("transcriptFolderDescription", () => {
    test("names the folder in force", () => {
      expect(transcriptFolderDescription("Meetings/Transcripts"))
        .toBe("New transcript notes go in Meetings/Transcripts.");
    });

    test("tracks the shipped default", () => {
      expect(transcriptFolderDescription(DEFAULT_PLUGIN_SETTINGS.sidecarDirectory))
        .toBe("New transcript notes go in Meetings/Transcripts.");
    });
  });

  describe("newCharacterThresholdDescription", () => {
    test("plural for the shipped default", () => {
      expect(newCharacterThresholdDescription(180))
        .toBe("A live pass waits until 180 new characters of transcript have arrived.");
    });

    test("singular at one", () => {
      expect(newCharacterThresholdDescription(1))
        .toBe("A live pass waits until 1 new character of transcript has arrived.");
    });

    test("a nonsensical stored value still reads as a sentence", () => {
      // normalizePluginSettings floors this at 1, but data.json is user-editable and this
      // function must never render "0 new characters ... have arrived".
      expect(newCharacterThresholdDescription(0))
        .toBe("A live pass waits until 1 new character of transcript has arrived.");
      expect(newCharacterThresholdDescription(Number.NaN))
        .toBe("A live pass waits until 1 new character of transcript has arrived.");
    });
  });

  describe("passIntervalDescription", () => {
    test("the shipped default reads in seconds and names the unit of the field", () => {
      expect(passIntervalDescription(25_000))
        .toBe("Live passes run no more often than once every 25 seconds. The value is in milliseconds.");
    });

    test("one second is singular", () => {
      expect(passIntervalDescription(1_000))
        .toBe("Live passes run no more often than once every 1 second. The value is in milliseconds.");
    });

    test("one millisecond is singular", () => {
      expect(passIntervalDescription(1))
        .toBe("Live passes run no more often than once every 1 millisecond. The value is in milliseconds.");
    });

    test("under a second stays in milliseconds rather than rounding to zero", () => {
      expect(passIntervalDescription(250))
        .toBe("Live passes run no more often than once every 250 milliseconds. The value is in milliseconds.");
    });

    test("a minute and over reads in minutes", () => {
      expect(passIntervalDescription(120_000))
        .toBe("Live passes run no more often than once every 2 minutes. The value is in milliseconds.");
      expect(passIntervalDescription(90_000))
        .toBe("Live passes run no more often than once every 1 minute 30 seconds. The value is in milliseconds.");
    });

    test("zero is a legal stored value and gets its own sentence", () => {
      // minIntervalMs normalizes with a floor of 0, so this is reachable from the UI.
      expect(passIntervalDescription(0))
        .toBe("Live passes run with no minimum gap between them. The value is in milliseconds.");
    });
  });

  describe("baseUrlDescription", () => {
    test("required for openai-compatible, because the name identifies no endpoint", () => {
      expect(baseUrlDescription("openai-compatible"))
        .toBe("Required: the provider name alone does not identify an endpoint.");
    });

    test("optional for the named providers, and while none is chosen", () => {
      const optional = "Optional. Leave it blank unless you route through a gateway or proxy.";
      expect(baseUrlDescription("openai")).toBe(optional);
      expect(baseUrlDescription("anthropic")).toBe(optional);
      expect(baseUrlDescription("")).toBe(optional);
    });
  });

  describe("apiKeyDescription", () => {
    const semantics = "Blank keeps the stored key, a new value replaces it, and Clear key removes it.";

    test("reports which of the three states the file is in", () => {
      expect(apiKeyDescription("stored")).toBe(`A key is stored. ${semantics}`);
      expect(apiKeyDescription("absent")).toBe(`No key is stored. ${semantics}`);
      expect(apiKeyDescription("unknown")).toBe(`The stored key cannot be read. ${semantics}`);
    });
  });
  ```

- [ ] **Step 2: Run `npm test` and watch it fail on the missing module.** The failure must be
  `Cannot find module '../src/settings-display.js'`, not an assertion failure. Anything else
  means the test file itself is wrong.

- [ ] **Step 3: Write `src/settings-display.ts`.**

  ```ts
  /**
   * Every settings-tab string computed from a stored value, and nothing else.
   *
   * These live here rather than beside their `Setting` in `main.ts` because
   * `node_modules/obsidian` has `"main": ""` and ships only type declarations, so nothing in
   * `main.ts` can be imported under `bun test`. A string built there is a string with no test.
   *
   * See `docs/settings-copy-style.md` § rule 4 for when a row shows its value instead of
   * describing itself, and § rule 2 for why several of these return `""`.
   */

  /**
   * Empty normalizes to the bare command `shorthand`, which resolves only through PATH — the
   * one thing the text field cannot show. A full path needs no description: it is already on
   * screen in the field.
   */
  export function shorthandExecutableDescription(stored: string): string {
    const trimmed = stored.trim();
    if (trimmed.length === 0) return "";
    if (trimmed.includes("/") || trimmed.includes("\\")) return "";
    return `${trimmed} is looked up on your PATH.`;
  }

  /** Empty means core detects the CLI itself, and the path it finds is shown nowhere. */
  export function claudeExecutableDescription(stored: string): string {
    return stored.trim().length === 0 ? "Claude is found automatically." : "";
  }

  /**
   * Rendered from the stored folder, not the typed one: `normalizePluginSettings` rejects
   * absolute, drive-letter and traversing paths back to the default, so the field and the
   * folder in force can legitimately disagree.
   */
  export function transcriptFolderDescription(folder: string): string {
    return `New transcript notes go in ${folder}.`;
  }

  export function newCharacterThresholdDescription(characters: number): string {
    const safe = Number.isFinite(characters) && characters >= 1 ? Math.floor(characters) : 1;
    return safe === 1
      ? "A live pass waits until 1 new character of transcript has arrived."
      : `A live pass waits until ${safe} new characters of transcript have arrived.`;
  }

  /**
   * The field holds milliseconds, so the sentence has to say so; `25000` on its own is not a
   * duration anyone reads. Zero is a legal stored value and gets its own sentence rather than
   * "once every 0 seconds".
   */
  export function passIntervalDescription(milliseconds: number): string {
    const unit = "The value is in milliseconds.";
    const safe = Number.isFinite(milliseconds) && milliseconds >= 1 ? Math.floor(milliseconds) : 0;
    return safe === 0
      ? `Live passes run with no minimum gap between them. ${unit}`
      : `Live passes run no more often than once every ${formatDuration(safe)}. ${unit}`;
  }

  export function baseUrlDescription(provider: string): string {
    return provider === "openai-compatible"
      ? "Required: the provider name alone does not identify an endpoint."
      : "Optional. Leave it blank unless you route through a gateway or proxy.";
  }

  export type StoredKeyState = "stored" | "absent" | "unknown";

  export function apiKeyDescription(state: StoredKeyState): string {
    const stored = state === "stored"
      ? "A key is stored."
      : state === "absent"
        ? "No key is stored."
        : "The stored key cannot be read.";
    return `${stored} Blank keeps the stored key, a new value replaces it, and Clear key removes it.`;
  }

  /** Callers clamp to >= 1 first, so this never has to render a zero duration. */
  function formatDuration(milliseconds: number): string {
    // countOf, not a bare template. 1 is reachable — the field's floor is 1ms, not 1000 — and
    // "1 milliseconds" is the sort of thing a user reads as sloppiness in the whole plugin.
    if (milliseconds < 1000) return countOf(milliseconds, "millisecond");
    const totalSeconds = Math.round(milliseconds / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes === 0) return countOf(seconds, "second");
    if (seconds === 0) return countOf(minutes, "minute");
    return `${countOf(minutes, "minute")} ${countOf(seconds, "second")}`;
  }

  function countOf(count: number, unit: string): string {
    return count === 1 ? `1 ${unit}` : `${count} ${unit}s`;
  }
  ```

- [ ] **Step 4: Run `npm test` and confirm the new suite is green**, then `npx tsc --noEmit`.
  `tsconfig` includes `src/`, so the typecheck covers the new file without any config change.

- [ ] **Step 5: Commit.** `feat: add settings-display, the tested home for computed setting
  descriptions`. Body explains that rule 4 in the new style guide makes descriptions a function
  of state, and state-dependent copy left in `main.ts` would be untestable.

---

### Task 44: Change `textSetting` and `numberSetting` to take a formatter, and rewire the five value-showing rows

**Files:**
- Modify: `D:/tools/obsidian-shorthand/main.ts:1130–1140` (`textSetting`)
- Modify: `D:/tools/obsidian-shorthand/main.ts:1142–1156` (`numberSetting`)
- Modify: `D:/tools/obsidian-shorthand/main.ts:824` (Shorthand executable), `:838` (Claude
  executable), `:852` (Transcript sidecar directory), `:854` (Minimum new characters), `:855`
  (Minimum interval)
- Modify: `D:/tools/obsidian-shorthand/main.ts:53` (the `./src/settings.js` import block — add a
  sibling import below it)

**Interfaces:**
- Consumes: all seven exports from Task 43.
- Produces the new helper signatures, used by nothing else in the file:
  ```ts
  function textSetting(
    container: HTMLElement,
    plugin: ShorthandPlugin,
    name: string,
    describe: (value: string) => string,
    key: "shorthandExecutable" | "claudeExecutable" | "sidecarDirectory",
  ): void;

  function numberSetting(
    container: HTMLElement,
    plugin: ShorthandPlugin,
    name: string,
    describe: (value: number) => string,
    key: "minNewChars" | "minIntervalMs",
  ): void;
  ```

The parameter is replaced, not added: there is no remaining caller that wants a static string,
and keeping an overload for none would be a branch nobody exercises.

- [ ] **Step 1: Add the import.** Insert immediately after the `./src/settings.js` import block
  that ends at `main.ts:53`, keeping the file's alphabetical-by-specifier ordering of the local
  imports:

  ```ts
  import {
    apiKeyDescription,
    baseUrlDescription,
    claudeExecutableDescription,
    newCharacterThresholdDescription,
    passIntervalDescription,
    shorthandExecutableDescription,
    transcriptFolderDescription,
  } from "./src/settings-display.js";
  ```

  `apiKeyDescription` and `baseUrlDescription` are unused until Task 46. Add them now anyway —
  `npx tsc --noEmit` does not error on unused imports under this `tsconfig`, and splitting one
  import statement across two commits is worse than a one-commit gap. If the typecheck *does*
  flag them, add only the five this task uses and extend the list in Task 46.

- [ ] **Step 2: Replace `textSetting` (`main.ts:1130–1140`) in full.**

  ```ts
  function textSetting(
    container: HTMLElement,
    plugin: ShorthandPlugin,
    name: string,
    describe: (value: string) => string,
    key: "shorthandExecutable" | "claudeExecutable" | "sidecarDirectory",
  ): void {
    const setting = new Setting(container).setName(name).setDesc(describe(plugin.settings[key]));
    setting.addText((text) => text
      .setValue(plugin.settings[key])
      .onChange(async (value) => {
        await plugin.saveSettings({ ...plugin.settings, [key]: value });
        // Described from the stored value, never the typed one. normalizePluginSettings is the
        // trust boundary for data.json and rewrites what it rejects, so a description built
        // from the raw input would name a folder the plugin is not using.
        setting.setDesc(describe(plugin.settings[key]));
      }));
  }
  ```

- [ ] **Step 3: Replace `numberSetting` (`main.ts:1142–1156`) in full.**

  ```ts
  function numberSetting(
    container: HTMLElement,
    plugin: ShorthandPlugin,
    name: string,
    describe: (value: number) => string,
    key: "minNewChars" | "minIntervalMs",
  ): void {
    const setting = new Setting(container).setName(name).setDesc(describe(plugin.settings[key]));
    setting.addText((text) => {
      text.inputEl.type = "number";
      text.setValue(String(plugin.settings[key])).onChange(async (value) => {
        const parsed = Number(value);
        // Unchanged: a half-typed or non-numeric field keeps the previous value. The
        // description keeps the previous value with it, rather than flickering to a default.
        if (!Number.isFinite(parsed)) return;
        await plugin.saveSettings({ ...plugin.settings, [key]: parsed });
        setting.setDesc(describe(plugin.settings[key]));
      });
    });
  }
  ```

- [ ] **Step 4: Run `npx tsc --noEmit` and watch it fail on all five call sites**, each with
  "Argument of type 'string' is not assignable to parameter of type '(value: string) => string'".
  Five errors is the expected count. Fewer means a call site was missed by the search; more
  means something else calls these helpers.

- [ ] **Step 5: Rewrite the five call sites.** Exact replacements, in file order:

  ```ts
  // main.ts:824
  textSetting(containerEl, this.plugin, "Shorthand executable", shorthandExecutableDescription, "shorthandExecutable");
  ```
  ```ts
  // main.ts:838
  textSetting(containerEl, this.plugin, "Claude executable", claudeExecutableDescription, "claudeExecutable");
  ```
  ```ts
  // main.ts:852
  textSetting(containerEl, this.plugin, "Transcript folder", transcriptFolderDescription, "sidecarDirectory");
  ```
  ```ts
  // main.ts:854-855
  numberSetting(containerEl, this.plugin, "Minimum new characters", newCharacterThresholdDescription, "minNewChars");
  numberSetting(containerEl, this.plugin, "Minimum interval", passIntervalDescription, "minIntervalMs");
  ```

  Before/after, for the record:

  | Row | Name before | Name after | Description before | Description after |
  | --- | --- | --- | --- | --- |
  | `shorthandExecutable` | Shorthand executable | *unchanged* | "Path to shorthand.exe, or a command available on PATH." | "shorthand is looked up on your PATH." (bare name) / none (path) |
  | `claudeExecutable` | Claude executable | *unchanged* | "Optional path to claude.exe. Leave blank for automatic detection." | "Claude is found automatically." (empty) / none (set) |
  | `sidecarDirectory` | Transcript sidecar directory | **Transcript folder** | "Vault-relative directory used for new transcript notes." | "New transcript notes go in Meetings/Transcripts." |
  | `minNewChars` | Minimum new characters | *unchanged* | "Live-pass transcript threshold." | "A live pass waits until 180 new characters of transcript have arrived." |
  | `minIntervalMs` | Minimum interval (ms) | **Minimum interval** | "Minimum time between completed live passes." | "Live passes run no more often than once every 25 seconds. The value is in milliseconds." |

- [ ] **Step 6: Run the full gate** — `npm test`, `npx tsc --noEmit`, `npm run build`. The
  bundle-load test is the one that matters here: a signature change that compiles can still
  break the module's top level.

- [ ] **Step 7: Commit.** `refactor: describe text and number settings from their stored value`.
  Body: names rule 4, and states the deliberate consequence that the description tracks the
  normalized value rather than the field contents.

---

### Task 45: Rewrite the toggle and dropdown copy in the main tab

**Files:**
- Modify: `D:/tools/obsidian-shorthand/main.ts:825–836` (Enhancement backend)
- Modify: `D:/tools/obsidian-shorthand/main.ts:842–850` (Write transcript note)
- Modify: `D:/tools/obsidian-shorthand/src/enhance-mode.ts` and its test — the renamed label appears in a user-facing error string Task 4 wrote and pinned
- Modify: `D:/tools/obsidian-shorthand/main.ts:856–861` (Enable live enhancement)
- Modify: `D:/tools/obsidian-shorthand/main.ts:862–867` (Control Shorthand recording)
- Modify: `D:/tools/obsidian-shorthand/main.ts:874–879` (Debug logging)

Line numbers are pre-increment-3. Match on the `setName` string.

**Interfaces:**
- Consumes: nothing from earlier tasks except the guide.
- Produces: the label strings **Transcript notes** and **Live enhancement**, which Task 48 must
  use when it updates `README.md`. A rename that lands in one file and not the other is the
  failure this pairing exists to prevent.

- [ ] **Step 1: Rewrite Enhancement backend.** Only the `setDesc` line changes.

  ```ts
    new Setting(containerEl)
      .setName("Enhancement backend")
      .setDesc("The Claude Agent SDK backend can look things up elsewhere in your vault; an LLM provider cannot.")
  ```

  Rule 3: the old string ("Choose whether note enhancement uses the Claude Agent SDK or a
  directly configured LLM provider.") read the dropdown back as a sentence. The vault-access
  difference is the thing that decides the choice, and `README.md` § Enhancement backends
  already documents it in full — so nothing is displaced here, only summarised.

- [ ] **Step 2: Rewrite Write transcript note.** Name and description both change.

  ```ts
    new Setting(containerEl)
      .setName("Transcript notes")
      .setDesc("Each capture also saves the raw transcript in its own linked note.")
  ```

  Rule 5: "Write transcript note: on" fails the aloud test; "Transcript notes: on" passes. The
  new name also pairs with **Transcript folder** directly below it, which is the row it
  reveals.

  **This rename reaches outside `main.ts`, and missing that is the defect this note exists to
  prevent.** Task 4 put the old label inside a user-facing error string in `src/`, and pinned
  it with a test. Renaming the row without following through leaves an error message telling
  users to find a setting that no longer exists under that name.

  Fix both now, in this step. First find them:

  ```sh
  cd /d/tools/obsidian-shorthand && grep -rn "Write transcript note" src/ test/ main.ts
  ```

  Expected: the error string built by `resolveEnhanceMode` in `src/`, and the
  `expect.stringContaining("Write transcript note")` assertion in its test. Change the string
  to read `"Transcript notes"`, change the assertion to match, and re-run:

  ```sh
  cd /d/tools/obsidian-shorthand && npm test && grep -rn "Write transcript note" src/ test/ main.ts
  ```

  Expected: tests pass, and the `grep` returns nothing. Any remaining hit is a stale reference.

  **Displaced detail, triaged.** The old description carried three facts:
  - "capture and live enhancement never require it — enhancement is always fed from the
    transcript in memory" — user-observable (it explains why the default is off). → `README.md`,
    Task 48 Step 6.
  - "a note that already has a transcript link keeps working with Enhance active note either
    way" — user-observable and genuinely surprising. → `README.md`, Task 48 Step 6. Note that
    the command is called **Enhance now**, not "Enhance active note"; the old description named
    a command that does not exist, and the README version fixes that.
  - "(location set by \"Transcript sidecar directory\" below)" — deleted. The row it points at
    is directly below and now reads **Transcript folder**; a pointer to the next line is the
    kind of filler rule 2 exists to remove.

- [ ] **Step 3: Rewrite Enable live enhancement.**

  ```ts
    new Setting(containerEl)
      .setName("Live enhancement")
      .setDesc("The note is rewritten while the meeting runs, instead of only when you stop or run Enhance now.")
  ```

  Rules 3 and 5. Nothing is displaced: the old second sentence ("Stop and Enhance now still use
  a link-tier pass") said that stop and Enhance now keep working, which the new sentence says
  in the words a user recognises.

- [ ] **Step 4: Rewrite Control Shorthand recording.** This one takes a `DocumentFragment`,
  because rule 1's prescribed destination for overflow is a link.

  ```ts
    new Setting(containerEl)
      .setName("Control Shorthand recording")
      .setDesc(createFragment((desc) => {
        desc.appendText(
          "Starting and stopping a capture also starts and stops Shorthand, so you don't need its hotkey. "
          + "Quitting Shorthand mid-capture normally relaunches it — see ",
        );
        desc.createEl("a", {
          text: "Driving Shorthand's recorder",
          href: "https://github.com/mshish/obsidian-shorthand#driving-shorthands-recorder",
        });
        desc.appendText(".");
      }))
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.controlShorthandRecording)
        .onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, controlShorthandRecording: value })));
  ```

  `createFragment` is a global declared in `obsidian.d.ts`'s `declare global` block, so it needs
  no import. `Setting.setDesc` accepts `string | DocumentFragment`. `appendText` and `createEl`
  are both on the augmented `Node` interface, which `DocumentFragment` extends.

  **This is the increment's headline cut**: five sentences to two. The relaunch behaviour is
  the one fact in the old paragraph a user can actually hit, and it survives — the link points
  at `README.md` § "Driving Shorthand's recorder", whose final bullet already states it word
  for word ("The cost of that bias: quitting Shorthand mid-capture normally relaunches it."). No
  README work is needed to create the target; Task 48 only repairs the section's opening after
  increment 3.

  The four sentences that go: the cancel-then-toggle start sequence, the "toggle only when a
  recording is believed to be running" stop rule, the shutdown and stream-death cancels, and the
  "nothing this capture saw shows Shorthand was ever reached" exception. Every one of them is
  already in `README.md` § "Driving Shorthand's recorder" in more detail than the description
  had. Deleted from the pane, not from the repository.

- [ ] **Step 5: Rewrite Debug logging.**

  ```ts
    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc("Logs enhancement activity to the developer console. Turn this on if a note stops updating during capture.")
  ```

  Two sentences, exactly as the approved spec's worked-example table specifies. Do not add a
  third even though rule 1 permits it.

  **Displaced detail, triaged.**
  - "(Ctrl+Shift+I)" — deleted. Platform-specific, and it is Obsidian's shortcut, not this
    plugin's.
  - "Off by default because it is noisy" — deleted. The toggle's position shows the default.
  - "a re-queue and a timeout both put the transcript back and retry, so they are deliberately
    silent in the UI and look identical to an idle capture from outside" — this is the *reason*
    the setting exists, and it is already recorded in the `debugLogging` doc comment in
    `src/settings.ts`, which is where a maintainer looks. The user-facing half of it is
    sentence 2 of the new description. Deleted from the pane.
  - "Applies to the next capture, not one already running" — user-observable, and a real trap:
    turning it on mid-capture appears to do nothing. → `README.md` § Known limitations, Task 48
    Step 5.

- [ ] **Step 6: Run the full gate** and commit. `feat: rewrite the settings tab's toggle and
  dropdown copy`. Body cites `docs/settings-copy-style.md` and names the two renames, because
  a rename is the change most likely to surprise a user reading a release note.

---

### Task 46: Rewrite the LLM provider block copy

**Files:**
- Modify: `D:/tools/obsidian-shorthand/main.ts:925–928` (LLM provider profile heading)
- Modify: `D:/tools/obsidian-shorthand/main.ts:942–959` (Provider) — includes the dropdown's
  placeholder option at `:946`
- Modify: `D:/tools/obsidian-shorthand/main.ts:962–973` (Model)
- Modify: `D:/tools/obsidian-shorthand/main.ts:975–986` (Base URL)
- Modify: `D:/tools/obsidian-shorthand/main.ts:1034–1040` (`setKeyDescription`)
- Modify: `D:/tools/obsidian-shorthand/main.ts:1042–1049` (`showDraftStatus`)
- Modify: `D:/tools/obsidian-shorthand/main.ts:1119–1124` (the post-load status branch)
- Modify: `D:/tools/obsidian-shorthand/main.ts:1095` (the saving status)
- Modify: `D:/tools/obsidian-shorthand/main.ts:1126` (the load-failure message)

**Interfaces:**
- Consumes: `apiKeyDescription`, `StoredKeyState`, `baseUrlDescription` from Task 43; the import
  added in Task 44 Step 1.
- Produces: nothing later tasks rely on.

This block renders only when **Enhancement backend** is set to LLM provider, so a human
verifying it must switch the backend first. Task 49 says so.

- [ ] **Step 1: Rewrite the block heading.**

  ```ts
    new Setting(containerEl)
      .setName("LLM provider profile")
      .setHeading()
      .setDesc("The API key is stored outside your vault, so it never syncs.");
  ```

  The old description — "Provider requests use this profile only when the LLM backend is
  selected." — is a tautology at the only moment it is visible: the block does not render on the
  other backend. Rule 2 and Microsoft's "don't restate". The replacement is the fact a user
  would otherwise have to open `README.md` to learn, and it is one sentence. The full
  explanation, including the per-platform paths, stays in `README.md` § Enhancement backends.

- [ ] **Step 2: Delete the Provider description and rename the placeholder option.**

  ```ts
      const providerSetting = new Setting(containerEl)
        .setName("Provider")
        .addDropdown((dropdown) => {
          providerInput = dropdown
            .addOption("", "No provider chosen")
            .addOption("openai", "OpenAI")
            .addOption("anthropic", "Anthropic")
            .addOption("openai-compatible", "OpenAI-compatible")
  ```

  The `.setDesc("Select the API family used for enhancement requests.")` line is removed
  entirely — rule 2, and the verb was banned by rule 6 anyway. "Select a provider" becomes "No
  provider chosen" for the same rule: a dropdown option is a label, and it should name a state
  rather than issue an order.

- [ ] **Step 3: Rewrite Model.**

  ```ts
      const modelSetting = new Setting(containerEl)
        .setName("Model")
        .setDesc("Model IDs are exact strings, not display names.")
  ```

  Rule 3 and rule 6: "Enter the provider's exact model ID." described the mechanism of typing.
  The new sentence names the mistake it prevents.

- [ ] **Step 4: Make Base URL track the chosen provider.** Two edits. First the initial render:

  ```ts
      const baseUrlSetting = new Setting(containerEl)
        .setName("Base URL")
        .setDesc(baseUrlDescription(draft.provider))
  ```

  Then, inside `showDraftStatus` (`main.ts:1042–1049`), which already runs on every provider
  change, add the re-render as its first statement:

  ```ts
      const showDraftStatus = (): void => {
        if (!ready) return;
        baseUrlSetting.setDesc(baseUrlDescription(draft.provider));
        const missing = missingLlmProfileFields(draft);
        statusSetting.setDesc(missing.length > 0
          ? `Not saved yet. Still needed: ${missing.join(", ")}.`
          : "Saved when you leave the field you are editing.");
      };
  ```

  Rule 4: whether this field is required is a fact about the *current* provider, and the old
  string made the reader work it out ("Required for OpenAI-compatible providers; optional
  endpoint override for OpenAI and Anthropic."). Rule 9 for the two status strings: "Complete.
  Changes stay in memory until the edited field loses focus." was mechanism in the passive; the
  replacement says what happens and when, in the second person.

  Note the ordering constraint: `showDraftStatus` is declared after `baseUrlSetting` in the
  current file, so the closure reference is already valid. Confirm that before editing — if
  increment 6 has moved anything, fix the declaration order rather than duplicating the call.

  **Third edit, and without it the feature is half-broken on the path users actually hit.**
  Hanging the description off `showDraftStatus` alone covers the case where the user *changes*
  the provider, but not the case where a profile is *loaded* with one already set. The async
  load path assigns `draft = state.draft` (`main.ts:1088`), pushes each value into its control
  (`main.ts:1114–1117`), and sets `ready = true` (`main.ts:1118`) — and never calls
  `showDraftStatus`. Obsidian's `setValue()` does not fire `onChange`, so nothing recomputes
  the description.

  The visible bug: open settings with a saved OpenAI-compatible profile, and Base URL reads the
  generic description until you touch the provider dropdown — telling the user a required field
  is optional.

  Add the call immediately after `ready = true`:

  ```ts
        ready = true;
        // setValue() does not fire onChange, so nothing above recomputed the provider-dependent
        // copy. Without this, a loaded openai-compatible profile shows Base URL as optional.
        showDraftStatus();
  ```

  Verify by hand: save an OpenAI-compatible profile, close settings, reopen, and read Base URL
  before touching anything. It must already say the field is required.

- [ ] **Step 5: Rewrite `setKeyDescription` to use the tested helper.**

  ```ts
      const setKeyDescription = (keyStatus: "known" | "unknown" = "known"): void => {
        const state: StoredKeyState = keyStatus === "unknown"
          ? "unknown"
          : storedKey.length > 0 ? "stored" : "absent";
        apiKeySetting.setDesc(apiKeyDescription(state));
      };
  ```

  Add `type StoredKeyState` to the `./src/settings-display.js` import from Task 44 Step 1, as a
  `type` member so it is erased at build time:

  ```ts
  import {
    apiKeyDescription,
    baseUrlDescription,
    claudeExecutableDescription,
    newCharacterThresholdDescription,
    passIntervalDescription,
    shorthandExecutableDescription,
    transcriptFolderDescription,
    type StoredKeyState,
  } from "./src/settings-display.js";
  ```

  Before: "A key is stored. Leave this field blank to preserve the existing key, enter a value
  to rotate it, or use Clear key to remove it. The key is stored at
  `%APPDATA%\\Shorthand\\llm-credentials.json`, deliberately outside the vault."
  After: "A key is stored. Blank keeps the stored key, a new value replaces it, and Clear key
  removes it."

  **Displaced detail, triaged.** The credentials path and the "deliberately outside the vault"
  rationale are already in `README.md` § Enhancement backends, including all three platform
  paths and the reason (`data.json` is plaintext and syncs). One sentence of it now lives on the
  block heading, from Step 1. Nothing new is needed in the README.

- [ ] **Step 6: Rewrite the three remaining status strings.** Exact replacements:

  ```ts
  // main.ts:1095 — was: `Saving the complete profile to ${credentialsPath}…`
            statusSetting.setDesc(`Saving to ${credentialsPath}…`);
  ```
  ```ts
  // main.ts:1121-1123 — was: "Complete the profile. It will be created only after a valid edit is committed."
        statusSetting.setDesc(state.status === "missing"
          ? "The profile is written once every required field has a value."
          : `Profile loaded from ${credentialsPath}.`);
  ```
  ```ts
  // main.ts:1126 — was: `The LLM profile could not be loaded: ${errorMessage(error)}`
        if (isCurrentDisplay()) renderMalformed(`The provider profile could not be loaded: ${errorMessage(error)}`);
  ```

  Rule 9 for the middle one: passive, future tense, and "committed" is a word from the
  commit-on-blur implementation, not from anything a user did. The third is a consistency fix —
  its two siblings already say "The profile could not be saved / discarded".

- [ ] **Step 7: Leave these strings alone, deliberately.** List them in the commit body so the
  next reader knows they were considered:
  - `Loading the provider profile…` (`main.ts:933`) — already one short sentence.
  - `Profile loaded from ${credentialsPath}.` / `Profile saved to ${credentialsPath}.` — rule 4
    in its purest form; they show the state.
  - `Discarding the malformed profile at ${credentialsPath}…` (`main.ts:1060`).
  - `${message} Discard file deletes the existing profile, including any key that could still be
    recovered from it by hand.` (`main.ts:1074`) — a destructive-action warning, precise about
    what is lost. Guide § Deviations item 4 puts warning and error text outside the nine rules.
  - `The profile could not be saved: …` / `The profile could not be discarded: …` — error text.
  - Button labels **Discard file**, **Clear key**, **Edit…** — sentence case, no periods,
    already compliant.

- [ ] **Step 8: Run the full gate** and commit. `feat: rewrite the LLM provider block's copy`.

---

### Task 47: Rewrite the headings and the prompt row, and delete the write-limitation row

**Files:**
- Modify: `D:/tools/obsidian-shorthand/main.ts:881–886` (Note writing heading)
- Modify: `D:/tools/obsidian-shorthand/main.ts:887–901` (the overridden-labels block and the
  prompt row)
- Delete: `D:/tools/obsidian-shorthand/main.ts:903–910` (the "Direct-file write limitation"
  heading, its comment, and its description)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Rewrite the Note writing heading's description.**

  ```ts
      new Setting(containerEl)
        .setName("Note writing")
        .setHeading()
        .setDesc("Left empty, both follow Shorthand's own defaults and keep improving with each release.");
  ```

  Rule 8: the heading is already sentence case and contains no "settings", so it stands. The
  description drops from three sentences to one.

  **Displaced detail, triaged.** "A custom prompt cannot break note writing — the output schema
  and Shorthand's safety rules are enforced regardless of what you write" is user-observable and
  reassuring, and `README.md` § Note writing already states it at length, including the sharp
  edge (a prompt that emits markers fails validation on every pass and the only sign is
  `[enhance] OUTPUT REJECTED` in the console). Deleted from the pane, nothing to add.

- [ ] **Step 2: Rewrite the prompt row's two descriptions.** The surrounding comment and the
  `overridden` computation stay exactly as they are — they implement rule 4 already, and this
  task only shortens what they render.

  ```ts
      new Setting(containerEl)
        .setName("Note-taking prompt and starting sections")
        .setDesc(overridden.length === 0
          ? "Both follow Shorthand's defaults."
          : `Custom ${overridden.join(" and ")} in use.`)
        .addButton((button) => button
          .setButtonText("Edit…")
          .onClick(() => new NotePromptModal(this.app, this.plugin, () => this.display()).open()));
  ```

  The four strings this produces, in full, because they are what a reader sees:

  ```text
  Both follow Shorthand's defaults.
  Custom prompt in use.
  Custom starting sections in use.
  Custom prompt and starting sections in use.
  ```

  **Displaced detail, triaged.** "Opens in its own window: Obsidian's settings rows hold
  single-line fields, and both of these are multi-line" is mechanism, and it explains an
  Obsidian API constraint to someone who does not have it — rule 3. The `Edit…` ellipsis already
  signals that a window opens, which is the convention Microsoft's guide relies on. `README.md`
  § Note writing keeps the explanation for anyone who wonders. Deleted from the pane, nothing to
  add.

- [ ] **Step 3: Delete the "Direct-file write limitation" row entirely** — the comment at
  `main.ts:903–904`, and the `new Setting(...)` through its closing `);` at `main.ts:905–910`.

  Obsidian's Settings guide is explicit that `desc` is "not for warnings", and this row is a
  four-sentence warning parked at the bottom of the pane where nothing can act on it. Every word
  of it is already the first bullet of `README.md` § Known limitations, in the same detail and
  with the same "this is the safe direction" framing. Verify that before deleting — read
  `README.md:280–284` and confirm it covers the file-watcher race, the unsaved-buffer conflict,
  and the safe-direction rationale. It does today; confirm rather than assume.

  The `setHeading()` rationale comment above it ("setHeading() rather than a raw `<h3>`: the
  guidelines call for it...") is about the pattern, not this row. The **Note writing** heading
  above still uses `setHeading()`, so move that comment up to sit above the **Note writing**
  block rather than deleting it with the row.

- [ ] **Step 4: Run the full gate** and commit. `feat: shorten the settings tab's headings and
  drop the write-limitation warning`. Body states that the deleted warning is `README.md` §
  Known limitations bullet 1, so the deletion is not read as a loss.

---

### Task 48: Move the displaced detail into `README.md`

**Files:**
- Modify: `D:/tools/obsidian-shorthand/README.md:10` (intro, the setting rename)
- Modify: `D:/tools/obsidian-shorthand/README.md:12` (intro, add the displaced sidecar facts)
- Modify: `D:/tools/obsidian-shorthand/README.md:20–30` (Prerequisites, the PATH fallback)
- Modify: `D:/tools/obsidian-shorthand/README.md:155–161` (Driving Shorthand's recorder, opening)
- Delete: `D:/tools/obsidian-shorthand/README.md:210–216` (the post-processing paragraph)
- Modify: `D:/tools/obsidian-shorthand/README.md:284–291` (Known limitations)

**Interfaces:**
- Consumes: the label strings **Transcript notes** and **Live enhancement** from Task 45; the
  anchor `#driving-shorthands-recorder`, which the `DocumentFragment` in Task 45 Step 4 links to.
- Produces: the link target that description depends on. If this task renames the
  `## Driving Shorthand's recorder` heading, the description's link breaks silently. Do not
  rename it.

Two of these edits are cleanup that increment 3 should have done and did not: its plan lists
`main.ts` and `test/plugin-settings.test.ts` and never mentions `README.md`, which is left
documenting a setting that no longer exists. **Check first whether increment 3 caught it after
all** — if `README.md:159` and `:210` no longer mention post-processing, skip Steps 3 and 4 and
say so in the commit body.

- [ ] **Step 1: Rename the setting in the intro (line 10) and in Known limitations (line 290).**
  Both currently read `**Write transcript note**`; both become `**Transcript notes**`. Verify
  with `grep -n "Write transcript note" README.md` afterwards — the expected result is no
  matches.

- [ ] **Step 2: Add the displaced sidecar facts to the intro**, as a new sentence at the end of
  the second paragraph (after "off by default, since the meeting note's summary is usually all
  that's needed."):

  ```markdown
  Enhancement never needs the sidecar — every pass is fed from the transcript held in memory —
  and the setting governs only whether *new* captures create one. A note that already links a
  transcript keeps working with **Enhance now** either way.
  ```

  This is the "Write transcript note" description's overflow from Task 45 Step 2. The old
  description called the command "Enhance active note"; there is no such command. `README.md`
  § Commands lists **Enhance now**. The rewrite fixes the name.

- [ ] **Step 3: Repair the opening of § Driving Shorthand's recorder (lines 155–161).** It
  currently announces two settings and lists a deleted one. Replace the paragraph and the
  two-item list with:

  ```markdown
  By default, **Start capture** and **Stop capture** also drive Shorthand's recorder, so a capture no
  longer needs a separate press of Shorthand's global hotkey. **Control Shorthand recording**
  (default on) is the setting that turns that off.
  ```

  Leave everything from "Shorthand's CLI offers no `--start`/`--stop`" onward untouched. That
  block is the link target for the **Control Shorthand recording** description, and its final
  bullet — "The cost of that bias: quitting Shorthand mid-capture normally relaunches it" — is
  the exact paragraph Task 45 Step 4 displaced. It is already here, which is why that step
  needed no README work of its own.

- [ ] **Step 4: Delete the post-processing paragraph (lines 210–216)**, the one beginning "With
  **Use Shorthand post-processing** on, Shorthand runs an LLM pass...". Increment 3 removed both
  the setting and the 45-second drain branch it describes, so every sentence in it is now false.
  Keep the paragraph after it ("Stopping is not instant..."), which is still true.

  Verify with `grep -n "post-process" README.md` — the expected result is no matches.

- [ ] **Step 5: Add two bullets to § Known limitations**, after the existing wall-clock bullet:

  ```markdown
  - **Debug logging** is snapshotted when a capture starts, so turning it on part-way through a
    capture affects the next one rather than the one already running.
  ```

  This is the Debug logging description's overflow from Task 45 Step 5. It is the trap a user
  actually hits: the setting appears to do nothing at the exact moment they reach for it.

  In the same section, update the wall-clock bullet's last sentence (line 288–289) to name the
  UI label as well as the key, since the label changed in Task 44:

  ```markdown
    **Minimum interval** (`minIntervalMs`) is what actually bounds pass rate.
  ```

- [ ] **Step 6: Add the executable fallback to § Prerequisites**, as a sentence on the existing
  Shorthand bullet:

  ```markdown
    The plugin's **Shorthand executable** setting holds the bare command `shorthand` by default,
    which resolves through your PATH; clearing the field restores that default rather than
    leaving it empty.
  ```

  This is the only fact from the old copy set with no other home. It is user-observable — clear
  the field, reopen the tab, and the default is back — and `shorthandExecutableDescription`
  covers only the half of it that is visible while a bare name is stored.

- [ ] **Step 7: Read the whole of § Driving Shorthand's recorder and § Known limitations
  through once, end to end.** Two paragraphs were deleted from the middle of a long section, and
  the failure mode is a dangling "the other flag" or a "two settings" count somewhere the grep
  did not reach. Fix any reference the deletions orphaned.

- [ ] **Step 8: Commit.** `docs: move displaced settings copy into the README`. Body lists the
  three moved facts by name — the sidecar-is-optional pair, the debug-logging snapshot, the
  executable PATH fallback — and states that the post-processing cleanup belonged to increment 3.

---

### Task 49: Gate, then read the settings pane in a real vault

**Files:**
- No edits. This task produces a verification record, not a change.

**Interfaces:**
- Consumes: everything from Tasks 40–48.
- Produces: nothing.

`npx tsc --noEmit` proves the strings compile. `test/plugin-bundle.test.ts` proves `main.js`
still loads under a stub `obsidian` — it never calls `display()`, so it has seen none of this
copy. `bun test` cannot import `main.ts` at all. **A human reading the pane is the only thing
that has actually looked at nineteen of these strings.** Do not report this section complete
before Step 3.

- [ ] **Step 1: Run the full gate from a clean state.** Delete `main.js` first, because
  `test/plugin-bundle.test.ts` only builds it when it is absent and would otherwise load a
  stale bundle:

  ```sh
  rm -f main.js
  npm run build
  npx tsc --noEmit
  npm test
  ```

  All three green. Paste the output into the task record rather than summarising it.

- [ ] **Step 2: Load the build in a vault.** If `OBSIDIAN_PLUGIN_DIR` is set, `npm run build`
  already copied it; otherwise copy `main.js` and `manifest.json` into
  `<vault>/.obsidian/plugins/shorthand/`. Toggle the plugin off and on — Obsidian caches the
  bundle, and skipping this looks exactly like the change having had no effect.

- [ ] **Step 3: Open Settings → Community plugins → Shorthand and check each item.** This is the
  list; work down it.

  1. **No plugin-name heading at the top.** The first thing in the pane is the Shorthand
     executable row.
  2. **Shorthand executable** shows "shorthand is looked up on your PATH." Type a full path into
     the field; the description disappears. Clear the field; reopen the tab; the default is back
     and so is the sentence.
  3. **Enhancement backend** shows the vault-access sentence, not the old "Choose whether...".
  4. **Claude executable** shows "Claude is found automatically." while empty, and nothing once
     a path is typed.
  5. Switch **Enhancement backend** to LLM provider. The provider block appears; its heading
     description reads "The API key is stored outside your vault, so it never syncs."
     **Provider** has no description at all and its unset option reads "No provider chosen".
     **Model** reads "Model IDs are exact strings, not display names."
  6. **Base URL** — choose OpenAI-compatible and confirm the description switches to
     "Required: the provider name alone does not identify an endpoint."; choose Anthropic and
     confirm it switches back to the optional sentence. This is the only cross-field dynamic
     description in the pane and the one most likely to be wired wrong.
  7. **API key** — confirm the two-sentence description, and that the first sentence tracks
     whether a key is stored.
  8. Switch **Enhancement backend** back to Claude Agent SDK.
  9. **Transcript notes** — the label, not "Write transcript note". Turn it on; **Transcript
     folder** appears below it reading "New transcript notes go in Meetings/Transcripts."
  10. **Transcript folder** — type `../escape` into it. The field holds what you typed; the
      description must still name `Meetings/Transcripts`, because normalization rejected the
      path. This is rule 4's second trigger and the one thing here that a typecheck can never
      catch. Clear the field back to `Meetings/Transcripts` afterwards.
  11. **Minimum new characters** — reads "A live pass waits until 180 new characters of
      transcript have arrived." Change it to `1`; the sentence goes singular.
  12. **Minimum interval** — the label has no "(ms)". Reads "Live passes run no more often than
      once every 25 seconds. The value is in milliseconds." Type `90000`; it reads "1 minute
      30 seconds". Type `250`; it reads "250 milliseconds". Restore `25000`.
  13. **Live enhancement** — the label, not "Enable live enhancement".
  14. **Control Shorthand recording** — two sentences, and "Driving Shorthand's recorder" renders
      as a link. **Click it.** It must open GitHub at the right section. If the repository is
      still private you will see a 404 while signed out — signed in as the repository owner it
      resolves, and that is what this check is for.
  15. **No "Use Shorthand post-processing" row anywhere.** If one is present, increment 3 did not
      land and everything above is built on the wrong base.
  16. **Debug logging** — two sentences.
  17. **Note writing** heading — one sentence under it.
  18. **Note-taking prompt and starting sections** — reads "Both follow Shorthand's defaults."
      Open **Edit…**, set a custom prompt, save. The row must re-render to "Custom prompt in
      use." Set custom sections too; it must read "Custom prompt and starting sections in use."
      Clear both back to empty.
  19. **No "Direct-file write limitation" row at the bottom.** The pane ends with the prompt row.
  20. **Scan the whole pane for periods on labels and Title Case anywhere.** There should be
      neither. This is the check that catches what the per-row checks miss.

- [ ] **Step 4: Read every string in the pane against
  `docs/settings-copy-style.md` once more, as a set.** The rule most likely to have been broken
  across the set rather than in one row is rule 1's ceiling combined with rule 2 — nineteen rows
  each with a defensible one-sentence description is still a wall of text. If more than a couple
  of rows would read better with no description at all, cut them and amend Tasks 45–47's commits.

- [ ] **Step 5: Leave the vault holding a build from committed code.** `AGENTS.md` requires it.
  If anything was fixed in Step 3 or 4, commit it and rebuild before stopping.

- [ ] **Step 6: Record the verification.** In the task record, not a new file: the three gate
  commands and their results, the twenty pane checks and which ones failed first time, and the
  Obsidian version the pane was read in.

## Section D — Increment 6: Advanced section, prompt editor, guideline fixes

Covers spec § "6. Advanced section and the prompt editor" only. Tasks 60–65.

### Before you start

You have never seen this codebase. Read these first, in this order:

- `D:/tools/obsidian-shorthand/AGENTS.md` § "The settings surface" and § "Obsidian API constraints".
- `D:/tools/obsidian-shorthand/src/settings.ts` — every rule lives here. The comment on
  `noteTakingGuidance` (lines 19–26) explains why `""` is stored instead of a copy of the
  default. That property is what Task 60 and Task 61 exist to protect.
- `D:/tools/obsidian-shorthand/main.ts` — `ShorthandSettingTab.display()` (lines 818–911),
  `NotePromptModal` (lines 1200–1282), `ScaffoldModal` (lines 1158–1188) as the other modal
  example, and `textSetting` / `numberSetting` (lines 1130–1156).

Three facts that decide most of what follows:

1. **`main.ts` cannot be imported under `bun test`.** `node_modules/obsidian` has `"main": ""`
   and ships only type declarations, so there is no runtime module to stub at import time.
   Anything expressed in `main.ts` is verified by `npx tsc --noEmit`, by
   `test/plugin-bundle.test.ts`, and by a human in a real vault — nothing else. Tasks 63, 64
   and 65 land in `main.ts` and therefore carry manual verification steps instead of unit
   tests. This is stated in AGENTS.md and is not negotiable by writing a cleverer test.
2. **`OBSIDIAN_PLUGIN_DIR` may be set in your environment.** If it is, *every* `npm run build`
   and every `npm run dev` watch rebuild copies `main.js` and `manifest.json` straight into a
   live Obsidian vault. Check with `echo $OBSIDIAN_PLUGIN_DIR` before your first build. Leave
   the vault holding a build from committed code when you finish.
3. **Increments 3 and 5 land before this one.** Increment 3 deletes the
   "Use Shorthand post-processing" setting; Increment 5 rewrites every setting name and
   description. Every `main.ts` line number in this document was read from the file **as it
   stands today, before those increments**. They will have shifted. Locate rows by setting
   name, and treat the line numbers as a cross-check that you are looking at the right code.

### The gate

Run all four, every time, before every commit:

```sh
npx tsc --noEmit
npm test
npm run build
```

`npm run build` runs `tsc --noEmit` again and then esbuild. `npm test` runs `bun test`, which
includes `test/plugin-bundle.test.ts`. That test is not optional: it loads the built `main.js`
under a stub `obsidian` module and it exists because a build once passed every other check and
still threw at Obsidian load.

### Decisions this section makes, and the ones it defers

Read these before Task 64. The spec's Basic/Advanced table does not address what happens to
the rows that render **conditionally**, and moving a conditional row into a later section
changes when it appears relative to the control that reveals it.

**Decided — the `if/else` becomes two independent `if`s.** Today lines 837–841 are a single
either/or: `if (backend === "claude-agent-sdk") { Claude executable } else { LLM block }`.
"Claude executable" goes to Advanced and the LLM block stays in Basic, so the pair must split.
Because `backend` is a two-member union (`"claude-agent-sdk" | "llm"`, `src/settings.ts:4`),
`if (backend === "llm")` in Basic plus `if (backend === "claude-agent-sdk")` in Advanced is
exactly equivalent to today's `if/else`. It stops being equivalent the day a third backend is
added — Task 64 puts a comment on both halves saying so.

**Decided — "Claude executable" stays conditional, and is now far from its dropdown.** Today it
appears directly under "Enhancement backend"; after the move it appears in Advanced, roughly a
screen below. Accepted, because the setting is optional (blank means automatic detection,
`main.ts:524`) — a user who picks the Claude Agent SDK backend never has to reach it. The
alternative, rendering it unconditionally in Advanced, is a one-line change and is noted in
Task 64 Step 5.

**Decided by the human — "Transcript folder" does NOT move to Advanced.** It stays in Basic,
directly beneath "Write transcript note", and stays conditional. This overrides the spec's
Basic/Advanced table, which listed it under Advanced.

The reasoning: the toggle and the folder read as one unit. Separating them would put the
revealed row roughly a screen below the control that reveals it, so flipping the toggle on
would look like it did nothing. Keeping the pair together is textbook progressive disclosure,
and it is what the pane already does correctly.

Consequences for Task 64:

- `this.display()` at line 849 **stays**. Do not delete it. It exists to show and hide this
  row, and that behaviour is being kept deliberately.
- The folder row is pasted into `displayBasic`, immediately after the "Write transcript note"
  toggle, with its `if (this.plugin.settings.writeTranscriptNote)` guard preserved verbatim.
- Advanced therefore holds **six** rows, not seven: Shorthand executable, Claude executable,
  minimum new characters, minimum interval, live enhancement, debug logging.

Task 64 Step 5's "render it unconditionally" alternative is **not** to be applied to this row.
It stays in the document only so a later reader can see the option was weighed and rejected.

**Not a regression — the LLM block's heading swallows fewer rows than it does today.** The LLM
block opens with its own `setHeading()` ("LLM provider profile", line 926). An Obsidian heading
runs until the next heading, so with the LLM backend selected, every row after it currently
falls under it: Write transcript note, Minimum new characters, Minimum interval, Live
enhancement, Control Shorthand recording, Debug logging. After this reorder, only "Write
transcript note" and "Control Shorthand recording" do, and the "Note writing" heading closes
it. The pre-existing mis-grouping shrinks. Fixing it outright would mean moving the LLM block
to the end of Basic, which the spec explicitly rules out ("it stays where it is"), so leave it.

**Decided by the human — `start-capture-this-note` is converted too.** It has the same
precondition as the two enhancement commands (it calls `activeMarkdownFile()` at line 225).
The spec chartered `checkCallback` for the enhancement commands only, which would have left
one of the three commands inconsistent — and a later reader would have read that as an
oversight rather than a decision. All three now use `checkCallback`.

**Scope note — Task 65 no longer converts the enhancement commands.** Task 5 already does,
including introducing `hasActiveMarkdownFile()`. Task 65 covers `start-capture-this-note`
alone and consumes the accessor Task 5 produced. If you are executing Task 65 and
`hasActiveMarkdownFile` does not exist, Task 5 has not landed — stop and say so.

---

### Task 60: Derive the prompt field's mode from the stored string

The two-state control's state must be **derived** from whether the stored string is empty. No
second key is stored. This task builds the derivation and the read-back, and pins the property
the whole design exists to protect: choosing "Default" stores `""`, never a copy of the
default's text.

**Files:**
- Modify: `D:/tools/obsidian-shorthand/src/settings.ts` — append after
  `defaultTemplateSectionText` (ends line 129), before the private helpers that start at
  line 131
- Test: `D:/tools/obsidian-shorthand/test/plugin-settings.test.ts` — append a new `describe`
  at the end of the file (currently ends line 302 with the `prompt modal validation` block's
  closing `});`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type PromptFieldMode = "default" | "custom"`
  - `type PromptFieldState = Readonly<{ mode: PromptFieldMode; editorText: string; seeded: boolean }>`
  - `initialPromptFieldState(stored: string): PromptFieldState`
  - `storedPromptFieldValue(state: PromptFieldState): string`

- [ ] **Step 1: Write the failing test**

Append to `test/plugin-settings.test.ts`:

```ts
describe("prompt field mode derivation", () => {
  test("an empty stored value derives the default mode, unseeded", () => {
    expect(initialPromptFieldState("")).toEqual({ mode: "default", editorText: "", seeded: false });
    expect(initialPromptFieldState("   \n  ")).toEqual({ mode: "default", editorText: "", seeded: false });
  });

  test("a stored value derives the custom mode, counts as seeded, and round-trips its text", () => {
    expect(initialPromptFieldState("Be terse.")).toEqual({ mode: "custom", editorText: "Be terse.", seeded: true });
    expect(storedPromptFieldValue(initialPromptFieldState("Be terse."))).toBe("Be terse.");
  });

  // The load-bearing property. Storing "" rather than a copy of the default is what keeps a
  // user inheriting improvements to core's guidance; storing the default's text freezes them
  // at whatever it said the day they opened the modal. A control that looks correct on screen
  // and stores the text anyway is the exact failure this test exists to catch.
  test("the default mode stores an empty string, never the default's text", () => {
    const defaultText = "You maintain the AI-owned section block of a meeting note.";
    const state: PromptFieldState = { mode: "default", editorText: defaultText, seeded: true };
    expect(storedPromptFieldValue(state)).toBe("");
    expect(storedPromptFieldValue(state)).not.toBe(defaultText);
  });
});
```

Extend the existing import block at the top of the file (lines 2–8) to add the three new
names:

```ts
import {
  DEFAULT_PLUGIN_SETTINGS,
  defaultTemplateSectionText,
  initialPromptFieldState,
  normalizePluginSettings,
  resolveTemplateSections,
  storedPromptFieldValue,
  validatePromptSettings,
  type PromptFieldState,
} from "../src/settings.js";
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd /d/tools/obsidian-shorthand && npm test -- test/plugin-settings.test.ts
```

Expected: bun fails to resolve the import — `SyntaxError: Export named 'initialPromptFieldState'
not found in module '.../src/settings.ts'`. The whole file fails, not just the new block. That
is the correct failure for a missing export.

- [ ] **Step 3: Write minimal implementation**

Insert into `src/settings.ts` after `defaultTemplateSectionText` (after line 129):

```ts
export type PromptFieldMode = "default" | "custom";

/**
 * What one field of the prompt modal is showing right now. `mode` is never stored: it is
 * derived from the stored string, because a second stored key could disagree with the text
 * and there would be no way to tell which one was right.
 *
 * `seeded` is modal-session state and is likewise never stored. It records that this field has
 * already been filled from the default once, so a later switch to Custom leaves the editor
 * alone. Without it, "has the user cleared this box on purpose?" and "has this box never been
 * filled?" are the same observation, and the second reading silently overwrites the first.
 */
export type PromptFieldState = Readonly<{
  mode: PromptFieldMode;
  editorText: string;
  seeded: boolean;
}>;

/**
 * Empty stored value means "use the default", so it derives the default mode.
 *
 * A stored custom value counts as already seeded: the box holds the user's own text, and
 * nothing should ever overwrite it.
 */
export function initialPromptFieldState(stored: string): PromptFieldState {
  const trimmed = stored.trim();
  return trimmed.length === 0
    ? { mode: "default", editorText: "", seeded: false }
    : { mode: "custom", editorText: stored, seeded: true };
}

/**
 * What gets written to `data.json`. The default mode always stores "", never a copy of the
 * default's text — even though `editorText` may still hold that text from a seeded edit the
 * user then backed out of. Storing the copy would freeze the user at whatever core's guidance
 * said that day instead of letting them keep inheriting improvements to it.
 */
export function storedPromptFieldValue(state: PromptFieldState): string {
  return state.mode === "default" ? "" : state.editorText;
}
```

- [ ] **Step 4: Run test to verify it passes**

```sh
cd /d/tools/obsidian-shorthand && npx tsc --noEmit && npm run build && npm test
```

- [ ] **Step 5: Commit**

```sh
cd /d/tools/obsidian-shorthand && git add src/settings.ts test/plugin-settings.test.ts && git commit -m "feat: derive the prompt field's mode from the stored string

The modal is about to gain a Default / Custom control. Its state has to
come from the stored string rather than a second key, so that empty can keep
meaning \"inherit core's guidance\" with nothing able to contradict it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 61: Seed the editor from the default on the first switch to Custom

"Custom" reveals the editable textarea **seeded from the default the first time it is
chosen**, so the user edits the real guidance rather than an empty box. Switching back to "Use
default" must remain a genuine one-click route out, which means it must not discard the text
the user typed — only refuse to store it.

**Files:**
- Modify: `D:/tools/obsidian-shorthand/src/settings.ts` — insert after
  `storedPromptFieldValue` (added by Task 60)
- Test: `D:/tools/obsidian-shorthand/test/plugin-settings.test.ts` — extend the
  `prompt field mode derivation` describe block added by Task 60

**Interfaces:**
- Consumes: `PromptFieldState`, `PromptFieldMode`, `initialPromptFieldState`,
  `storedPromptFieldValue` from Task 60.
- Produces:
  `choosePromptFieldMode(state: PromptFieldState, mode: PromptFieldMode, effectiveDefault: string): PromptFieldState`

- [ ] **Step 1: Write the failing test**

Append these three tests inside the `prompt field mode derivation` describe block:

```ts
  test("the first switch to custom seeds the editor from the effective default", () => {
    const seeded = choosePromptFieldMode(initialPromptFieldState(""), "custom", "Write plainly.");
    expect(seeded).toEqual({ mode: "custom", editorText: "Write plainly.", seeded: true });
  });

  // The case an "is the box empty" guard gets wrong. Clearing the box is a deliberate act;
  // flipping to the default to re-read it and back must not undo that.
  test("a deliberately cleared editor is not re-seeded on a later switch to custom", () => {
    const seeded = choosePromptFieldMode(initialPromptFieldState(""), "custom", "Write plainly.");
    const cleared: PromptFieldState = { ...seeded, editorText: "" };
    const backedOut = choosePromptFieldMode(cleared, "default", "Write plainly.");
    const returned = choosePromptFieldMode(backedOut, "custom", "Write plainly.");
    expect(returned.editorText).toBe("");
    expect(storedPromptFieldValue(returned)).toBe("");
  });

  test("switching back to custom keeps the user's edit instead of re-seeding over it", () => {
    const seeded = choosePromptFieldMode(initialPromptFieldState(""), "custom", "Write plainly.");
    const edited: PromptFieldState = { ...seeded, editorText: "Write plainly. Name owners." };
    const backedOut = choosePromptFieldMode(edited, "default", "Write plainly.");
    const returned = choosePromptFieldMode(backedOut, "custom", "Write plainly.");
    expect(returned.editorText).toBe("Write plainly. Name owners.");
  });

  // Seeding is the risk in this design: it puts the default's text in an editable field, and
  // saving from there stores a frozen copy. That is correct once the user has chosen to
  // customise — but only while "Default" is still a one-click route back to "".
  test("choosing the default after a seeded edit stores an empty string", () => {
    const seeded = choosePromptFieldMode(initialPromptFieldState(""), "custom", "Write plainly.");
    const backedOut = choosePromptFieldMode(seeded, "default", "Write plainly.");
    expect(storedPromptFieldValue(backedOut)).toBe("");
    expect(storedPromptFieldValue(backedOut)).not.toBe("Write plainly.");
  });
```

Add `choosePromptFieldMode` to the import block at the top of the file, alphabetically after
`defaultTemplateSectionText`.

- [ ] **Step 2: Run test to verify it fails**

```sh
cd /d/tools/obsidian-shorthand && npm test -- test/plugin-settings.test.ts
```

Expected: `SyntaxError: Export named 'choosePromptFieldMode' not found in module
'.../src/settings.ts'`.

- [ ] **Step 3: Write minimal implementation**

Insert into `src/settings.ts` after `storedPromptFieldValue`:

```ts
/**
 * Seeds on the first switch to custom and never again.
 *
 * The guard is `seeded`, not "is the box empty". Those differ in exactly one case, and it is a
 * case users hit: clear the box to write from scratch, flip to "Default" to re-read the
 * original, flip back — and an emptiness test would refill the box with the default, throwing
 * away the blank canvas the user deliberately made. Flipping across to compare is the one thing
 * this control exists for, so it must be free.
 */
export function choosePromptFieldMode(
  state: PromptFieldState,
  mode: PromptFieldMode,
  effectiveDefault: string,
): PromptFieldState {
  if (mode === "default") return { ...state, mode: "default" };
  if (state.seeded) return { ...state, mode: "custom" };
  return { mode: "custom", editorText: effectiveDefault, seeded: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

```sh
cd /d/tools/obsidian-shorthand && npx tsc --noEmit && npm run build && npm test
```

- [ ] **Step 5: Commit**

```sh
cd /d/tools/obsidian-shorthand && git add src/settings.ts test/plugin-settings.test.ts && git commit -m "feat: seed the prompt editor from the default on the first switch to Custom

Editing an empty box is guesswork. Seeding is safe only while Default is a
one-click route back to \"\", so that route is what the tests pin.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 62: Add styles.css and deliver it to the vault

`main.ts:1251` sets `area.style.width = "100%"` directly. Obsidian's plugin guidelines forbid
hardcoded styling and prescribe CSS classes plus Obsidian's own CSS variables. This repo has
**no `styles.css`** — verified: `find . -name styles.css -not -path './node_modules/*'` returns
nothing, and no file references the name.

Obsidian loads `styles.css` from the plugin folder automatically — that is the documented
standard path and needs no manifest entry and no esbuild entry point. But this repository is
cloned *outside* the vault, so `esbuild.config.mjs` copies the delivered files across, and its
copy list (line 48) names only `main.js` and `manifest.json`. A stylesheet added to the repo
without that line exists, passes every check, and silently never reaches Obsidian.

Do this task **before** Task 63, which uses the class.

**Files:**
- Create: `D:/tools/obsidian-shorthand/styles.css`
- Create: `D:/tools/obsidian-shorthand/test/plugin-assets.test.ts`
- Modify: `D:/tools/obsidian-shorthand/esbuild.config.mjs` lines 28, 48, 51
- Modify: `D:/tools/obsidian-shorthand/README.md` lines 70, 100, 318

**Interfaces:**
- Consumes: nothing.
- Produces: CSS class `.shorthand-prompt-textarea`, consumed by Task 63.

- [ ] **Step 1: Write the failing test**

Create `test/plugin-assets.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Obsidian loads `styles.css` from the plugin folder automatically — but only if the file is
 * in that folder. This repository is cloned outside the vault, so esbuild.config.mjs copies
 * the delivered files across. A stylesheet left out of that copy list exists in the repo,
 * typechecks, builds, loads, and is simply never applied. Nothing else would catch it.
 *
 * Asserting on the config's source text rather than running a build keeps `npm test` fast;
 * the trade-off is that reformatting that line breaks this test, which is acceptable for a
 * one-line list that should not change.
 */
describe("the plugin stylesheet", () => {
  test("defines the prompt-editor field class", () => {
    const css = readFileSync(resolve(process.cwd(), "styles.css"), "utf8");
    expect(css).toContain(".shorthand-prompt-textarea");
  });

  test("is delivered to the vault alongside main.js and manifest.json", () => {
    const config = readFileSync(resolve(process.cwd(), "esbuild.config.mjs"), "utf8");
    expect(config).toContain(`["main.js", "manifest.json", "styles.css"]`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd /d/tools/obsidian-shorthand && npm test -- test/plugin-assets.test.ts
```

Expected: the first test throws `ENOENT: no such file or directory, open '.../styles.css'`; the
second fails with `expect(received).toContain(expected)` because the copy list currently reads
`["main.js", "manifest.json"]`.

- [ ] **Step 3: Write minimal implementation**

Create `styles.css`:

```css
/* Obsidian's plugin guidelines forbid hardcoded styling — `el.style.width = "100%"` in a
   plugin overrides whatever the user's theme and font-size settings decided. Values that need
   a number come from Obsidian's own CSS variables so they track the active theme. */

/* Both states of a prompt field: the editable textarea and the read-only view of the
   effective default. They share the class so the field does not change width when the user
   switches between them. */
.shorthand-prompt-textarea {
  width: 100%;
  margin-bottom: var(--size-4-2);
  resize: vertical;
}
```

Then three edits to `esbuild.config.mjs`:

Line 28:
```js
 * obsidian-sample-plugin's README documents — copy `main.js`, `manifest.json` and
 * `styles.css` across — automated here so a watch rebuild lands in the vault without a
 * second command.
```

Line 48:
```js
      for (const file of ["main.js", "manifest.json", "styles.css"]) {
```

Line 51:
```js
      console.log(`delivered main.js, manifest.json and styles.css to ${target}`);
```

Then three edits to `README.md`, so the file is not lost at install or release time:

- Line 70: `Download `main.js`, `manifest.json` and `styles.css` from the [latest release](../../releases/latest) into:`
- Line 100: `build — including each watch rebuild — copies `main.js`, `manifest.json` and `styles.css` there. This keeps`
- Line 318: `npm run build        # attach main.js, manifest.json and styles.css to the release by hand`

- [ ] **Step 4: Run test to verify it passes**

```sh
cd /d/tools/obsidian-shorthand && npx tsc --noEmit && npm run build && npm test
```

If `OBSIDIAN_PLUGIN_DIR` is set, this build is the first one that copies `styles.css` into the
vault. Confirm it landed: `ls "$OBSIDIAN_PLUGIN_DIR"` should now list three files.

- [ ] **Step 5: Commit**

```sh
cd /d/tools/obsidian-shorthand && git add styles.css test/plugin-assets.test.ts esbuild.config.mjs README.md && git commit -m "feat: add styles.css and deliver it to the vault

Obsidian's guidelines forbid hardcoded styling, so the prompt modal needs a
class to move its inline width onto. A stylesheet the delivery step does not
copy is a stylesheet Obsidian never sees, so the copy list is tested.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 63: Give NotePromptModal a Default / Custom control

**This task lands entirely in `main.ts` and cannot be unit-tested.** `main.ts` is not importable
under `bun test`, so its verification is `npx tsc --noEmit`, the bundle-load smoke test, and the
manual pass in Step 4. Every rule the control follows was already tested in Tasks 60 and 61 —
`main.ts` holds only the DOM wiring, which is exactly the split AGENTS.md § "The settings
surface" requires.

What changes in `NotePromptModal.field()` (lines 1240–1256):

- The default stops being a placeholder that vanishes on the first keystroke and becomes a
  read-only textarea that is always legible.
- The "Reset to default" button (lines 1253–1254) is replaced by the two-state control, which
  does the same job in both directions.
- `area.style.width = "100%"` (line 1251) becomes `cls: "shorthand-prompt-textarea"`.
- `field()` stops returning `HTMLTextAreaElement` and returns a handle, because `save()` needs
  both the value to store and something to focus on a validation failure.

Use `Setting.addDropdown` for the control. Obsidian's imperative API has no radio-group
primitive, and a hand-rolled `<input type="radio">` pair would mean building the label
association, the ARIA grouping and the mobile layout ourselves — the exact thing AGENTS.md
§ "Obsidian API constraints" says Obsidian's own components carry for free. `DropdownComponent`
is already imported as a type at `main.ts:12`.

Do not use `innerHTML`, `outerHTML` or `insertAdjacentHTML` anywhere. Switching between the two
states is `body.empty()` followed by a re-render, not a hidden element.

Verified, so seeding is safe: `DEFAULT_EDITORIAL_GUIDANCE` is 271 characters and
`MAX_GUIDANCE_CHARACTERS` is 10,000, so seeding the guidance field with the default and saving
straight away cannot trip `validatePromptSettings`.

**Files:**
- Modify: `D:/tools/obsidian-shorthand/main.ts` — imports (lines 49–56), `NotePromptModal.onOpen`
  (lines 1211–1234), `NotePromptModal.field` (lines 1240–1256), `NotePromptModal.save`
  (lines 1258–1281)
- Modify: `D:/tools/obsidian-shorthand/README.md` lines 235–239 — that paragraph documents the
  placeholder and the "Reset to default" button, both of which this task removes

**Interfaces:**
- Consumes: `initialPromptFieldState(stored: string): PromptFieldState`,
  `choosePromptFieldMode(state: PromptFieldState, mode: PromptFieldMode, effectiveDefault: string): PromptFieldState`,
  `storedPromptFieldValue(state: PromptFieldState): string`,
  `.shorthand-prompt-textarea`
- Produces: `type PromptFieldHandle = Readonly<{ value: () => string; focus: () => void }>`,
  `NotePromptModal.field(name: string, description: string, effectiveDefault: string, stored: string): PromptFieldHandle`

- [ ] **Step 1: Extend the settings import**

Replace the import block at `main.ts:49–56` with:

```ts
import {
  DEFAULT_PLUGIN_SETTINGS,
  choosePromptFieldMode,
  defaultTemplateSectionText,
  initialPromptFieldState,
  normalizePluginSettings,
  resolveTemplateSections,
  storedPromptFieldValue,
  validatePromptSettings,
  type PromptFieldState,
  type ShorthandPluginSettings,
} from "./src/settings.js";
```

- [ ] **Step 2: Replace `field()` and its return type**

Add above the `NotePromptModal` class (above the doc comment at line 1190):

```ts
/**
 * What the modal needs back from one field: the value to store, and a way to put the cursor
 * in it when validation rejects it. A bare textarea element cannot answer the first, because
 * "Default" stores "" no matter what text the textarea is holding.
 */
type PromptFieldHandle = Readonly<{ value: () => string; focus: () => void }>;
```

Replace the whole of `field()` (lines 1240–1256) with:

```ts
  /**
   * One field: label, explanation, a Default / Custom control, and the body that
   * control switches between. The mode is derived from the stored string by
   * `initialPromptFieldState`, so there is no second key that could disagree with the text.
   */
  private field(
    name: string,
    description: string,
    effectiveDefault: string,
    stored: string,
  ): PromptFieldHandle {
    let state = initialPromptFieldState(stored);
    let editor: HTMLTextAreaElement | undefined;
    const setting = new Setting(this.contentEl).setName(name).setDesc(description);
    const body = this.contentEl.createDiv();

    const render = (): void => {
      body.empty();
      editor = undefined;
      if (state.mode === "default") {
        // Read-only rather than hidden: the point of this control is that the text a user is
        // inheriting is legible without first agreeing to replace it. A placeholder was not,
        // because it vanished on the first keystroke.
        body.createEl("textarea", {
          text: effectiveDefault,
          cls: "shorthand-prompt-textarea",
          // aria-label because these textareas are siblings of the Setting rather than children
          // of a <label>, so a screen reader has nothing to announce them by. Obsidian's own
          // components carry this for you; hand-rolled elements do not, which is the trade this
          // modal accepts to get a multi-line field at all.
          attr: { readonly: "true", rows: 10, spellcheck: "false", "aria-label": `${name} (Shorthand's default, read-only)` },
        });
        return;
      }
      const area = body.createEl("textarea", {
        cls: "shorthand-prompt-textarea",
        attr: { rows: 10, spellcheck: "false", "aria-label": name },
      });
      area.value = state.editorText;
      // Mirrored into the state on every keystroke so `storedPromptFieldValue` stays the only
      // thing that decides what is written. Reading `area.value` at save time instead would
      // route around it and could store the seeded default after a switch back to Default.
      area.addEventListener("input", () => { state = { ...state, editorText: area.value }; });
      editor = area;
      area.focus();
    };

    setting.addDropdown((dropdown) => dropdown
      .addOption("default", "Default")
      .addOption("custom", "Custom")
      .setValue(state.mode)
      .onChange((value) => {
        state = choosePromptFieldMode(state, value === "custom" ? "custom" : "default", effectiveDefault);
        render();
      }));
    render();

    return {
      value: () => storedPromptFieldValue(state),
      focus: () => { editor?.focus(); },
    };
  }
```

Note `state` is declared `let` and reassigned; `PromptFieldState` is `Readonly<{...}>`, so every
transition builds a new object rather than mutating one. The `type PromptFieldState` import
added in Step 1 is used by the `{ ...state, editorText: area.value }` assignment's inferred
type — if `tsc` reports it unused after your edit, delete it from the import rather than
leaving it.

- [ ] **Step 3: Update `onOpen()` and `save()` to the handle**

In `onOpen()` (lines 1213–1224) the two `this.field(...)` calls are unchanged in shape — the
third argument is already the effective default and the fourth is already the stored value. Only
the inferred type of `guidance` and `sections` changes, from `HTMLTextAreaElement` to
`PromptFieldHandle`. The `Leave empty to use the default shown below.` sentence at the end of
both descriptions is now wrong and is Increment 5's copy to own; if Increment 5 already removed
it, leave it removed.

Replace `save()`'s signature and the two places it reads a value (lines 1258–1276):

```ts
  private async save(
    guidance: PromptFieldHandle,
    sections: PromptFieldHandle,
    error: HTMLElement,
  ): Promise<void> {
    // Guards a second click landing while the first save is still awaiting saveData(), the
    // same job #settled does in ScaffoldModal.
    if (this.#settled) return;
    const validated = validatePromptSettings({
      noteTakingGuidance: guidance.value(),
      templateSectionText: sections.value(),
    });
    if (!validated.ok) {
      // Invalid input is never saved and the window stays open, focused on the field that
      // failed, so the text being complained about is still on screen next to the complaint.
      error.setText(validated.error);
      (validated.field === "noteTakingGuidance" ? guidance : sections).focus();
      return;
    }
    this.#settled = true;
    await this.plugin.saveSettings({ ...this.plugin.settings, ...validated.settings });
    this.onSaved();
    this.close();
  }
```

Update the class doc comment at lines 1190–1199: its last sentence says "the fields here are raw
textareas built the way ScaffoldModal builds its own buttons". Still true, but add that the
mode control is a `Setting` dropdown because Obsidian's imperative API has no radio group.

Update `README.md` lines 235–239, replacing the sentence "The defaults are shown as placeholder
text in each field, and **Reset to default** clears a field back to empty." with a description
of the two-state control. Keep the paragraph's first two sentences — they state the inheritance
property and are still exactly right.

- [ ] **Step 4: Verify — typecheck, build, then click through Obsidian**

```sh
cd /d/tools/obsidian-shorthand && npx tsc --noEmit && npm run build && npm test
```

Then, in a real vault (if `OBSIDIAN_PLUGIN_DIR` is set the build above already delivered it;
otherwise copy `main.js`, `manifest.json` and `styles.css` into
`<vault>/.obsidian/plugins/shorthand/`). Reload Obsidian with Ctrl+R, then:

1. Settings → Shorthand → **Edit…** on the note-taking prompt row. The modal opens.
2. Both fields show a dropdown reading **Default**, and below it a textarea containing
   readable text that you cannot type into. Confirm the guidance field shows text beginning
   "You maintain the AI-owned section block of a meeting note." and the sections field shows
   one heading per line.
3. Confirm both textareas span the full width of the modal. That is `styles.css` working — if
   they are narrow, the stylesheet did not reach the vault.
4. Switch the first dropdown to **Custom**. The read-only text is replaced by an editable
   textarea **already containing that same text**, with the cursor in it.
5. Type ` Name owners.` at the end. Switch to **Default**, then back to **Custom**.
   Your edit is still there — it was not re-seeded over.
6. Switch to **Default** and click **Save**. The settings row now reads that both follow
   Shorthand's defaults.
7. Open `<vault>/.obsidian/plugins/shorthand/data.json`. Confirm `"noteTakingGuidance": ""` —
   an empty string, **not** a copy of the default's text. This is the property the whole
   design exists to protect.
8. Reopen the modal. The dropdown reads **Default** again, derived from that empty string.
9. Switch to **Custom**, replace the whole guidance with `x` repeated past 10,000
   characters (paste it), and click **Save**. The modal stays open, an inline red message names
   the character count and the limit, and the cursor lands in the guidance field.

- [ ] **Step 5: Commit**

```sh
cd /d/tools/obsidian-shorthand && git add main.ts README.md && git commit -m "feat: show the prompt default read-only behind a Default control

A placeholder vanished on the first keystroke, so a user who had customised the
prompt could not see what they diverged from. The default is now always legible
and Default is a one-click route back to inheriting it.

Also drops the inline width the plugin guidelines forbid, onto styles.css.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 64: Group the advanced settings under an "Advanced" heading

**This task lands entirely in `main.ts` and cannot be unit-tested.** Verification is
`npx tsc --noEmit`, the bundle-load smoke test, and Step 4's manual pass.

Read the "Decisions" section above before starting. In particular, confirm with the human
whether "Transcript folder" stays conditional.

The reorder is expressed as a **move**, not a rewrite. Increment 5 has already replaced every
name and description in these rows; retyping them from this document would revert that work.
Cut each statement and paste it, unchanged, into its new position.

**Files:**
- Modify: `D:/tools/obsidian-shorthand/main.ts` — `ShorthandSettingTab.display()`, lines
  818–911 as read today. Increments 3 and 5 will have shifted these; locate by setting name.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `ShorthandSettingTab.displayBasic(containerEl: HTMLElement, displayGeneration: number): void`
  - `ShorthandSettingTab.displayAdvanced(containerEl: HTMLElement): void`

- [ ] **Step 1: Replace the body of `display()` with three calls**

Replace lines 818–911 — that is, the entire `display()` method — with:

```ts
  display(): void {
    const displayGeneration = ++this.#displayGeneration;
    const { containerEl } = this;
    containerEl.empty();
    // No plugin-name heading at the top: Obsidian already titles this pane "Shorthand", and
    // the guidelines reserve headings for separating multiple sections.
    this.displayBasic(containerEl, displayGeneration);
    this.displayAdvanced(containerEl);

  }
```

Keep everything you cut on the clipboard, or work from `git diff` — Steps 2 and 3 paste it back.

- [ ] **Step 2: Create `displayBasic` and paste the basic rows into it**

Add immediately after `display()`:

```ts
  private displayBasic(containerEl: HTMLElement, displayGeneration: number): void {
  }
```

Paste these statements into it, in this order, **verbatim from what you cut**:

| Order | Setting | Cut from lines (today) |
| --- | --- | --- |
| 1 | Enhancement backend (the `new Setting(...)` dropdown) | 825–836 |
| 2 | the `else` branch's `this.displayLlmProfileControls(containerEl, displayGeneration);` | 840 |
| 3 | Write transcript note (the `new Setting(...)` toggle) | 842–850 |
| 4 | Transcript folder (`textSetting(...)` for `sidecarDirectory`), **with its `if` guard** | 851–853 |
| 5 | Control Shorthand recording (the `new Setting(...)` toggle) | 862–867 |
| 6 | "Note writing" heading, the `overridden` const and its comment, and the "Note-taking prompt and starting sections" row | 881–901 |

Item 4 stays in Basic by explicit decision — see "Decisions this section makes". It is pasted
directly beneath item 3, keeping its guard exactly as it is today:

```ts
    if (this.plugin.settings.writeTranscriptNote) {
      // <the textSetting call cut from line 852>
    }
```

The `this.display()` re-render inside item 3's `onChange` (line 849) **stays**. It exists to
show and hide item 4, the two rows are staying adjacent, and that disclosure is being kept.

Item 2 is not a bare paste: it was the `else` half of the `if/else` at lines 837–841, whose
`if` half moves to Advanced. Wrap it in its own positive condition:

```ts
    // The if/else this came from was split when "Claude executable" moved to Advanced. With
    // `backend` a two-member union this pair is exactly equivalent to that if/else; add a
    // third backend and it stops being — the LLM block would then render for it too.
    if (this.plugin.settings.backend === "llm") {
      this.displayLlmProfileControls(containerEl, displayGeneration);
    }
```

Do **not** move the LLM block anywhere else. It is already conditional on the backend choice,
which is its own disclosure, and the spec keeps it where it is.

- [ ] **Step 3: Create `displayAdvanced` and paste the rest**

Add after `displayBasic`:

```ts
  /**
   * Always visible, at the bottom, no expander. This is what Obsidian core's own General,
   * Editor, and Files and links tabs do.
   *
   * It is not a fallback for something better: the `visible` predicate that would hide these
   * rows behind a condition belongs to the declarative settings API, which requires app
   * version 1.13.0, and `manifest.json` declares `minAppVersion: 1.5.0`. `SettingGroup`
   * (1.11.0) is out for the same reason, and the pre-1.13 imperative API has no documented
   * collapsible primitive. Raising the floor to reach any of them means dropping users.
   */
  private displayAdvanced(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Advanced").setHeading();
  }
```

**Two methods, not three.** An earlier draft of this task also created a `displayFooter` to
hold the "Direct-file write limitation" heading. **Task 47 deletes that row**, so by the time
you get here there is nothing for a footer to contain. Do not create one, and do not go
looking for the row — if it is still in the file, Increment 5 has not landed and you are on
the wrong branch.

Paste into `displayAdvanced`, after the heading, in this order, verbatim from what you cut:

| Order | Setting | Cut from lines (today) |
| --- | --- | --- |
| 1 | Shorthand executable (`textSetting(...)`) | 824 |
| 2 | Claude executable (`textSetting(...)`) | 838 |
| 3 | Minimum new characters (`numberSetting(...)`) | 854 |
| 4 | Minimum interval (`numberSetting(...)`) | 855 |
| 5 | Live enhancement (the `new Setting(...)` toggle) | 856–861 |
| 6 | Debug logging (the `new Setting(...)` toggle) | 874–879 |

Six rows, not seven. "Transcript folder" is **not** here — it stays in Basic beside the toggle
that reveals it. If you find yourself pasting it into `displayAdvanced`, re-read "Decisions
this section makes".

Item 2 keeps its condition, which moves with it:

```ts
    // The other half of the split if/else in displayBasic. Optional — blank means automatic
    // detection — which is why it can sit this far from the dropdown that reveals it.
    if (this.plugin.settings.backend === "claude-agent-sdk") {
      // <the textSetting call cut from line 838>
    }
```

There should now be nothing left over. Two rows that the original `display()` contained are
absent by design, and finding either one means an earlier increment has not landed:

- **"Use Shorthand post-processing"** (lines 868–873 today) — deleted by Increment 3.
- **"Direct-file write limitation"** (lines 903–910 today) — deleted by Increment 5, Task 47,
  which moved its content to `README.md`. Advanced is therefore the last group in the pane.

If either is still in the file, stop; you are on the wrong branch.

- [ ] **Step 4: Verify — typecheck, build, then click through Obsidian**

```sh
cd /d/tools/obsidian-shorthand && npx tsc --noEmit && npm run build && npm test
```

Then in a real vault, after Ctrl+R:

**Use the post-Increment-5 labels below.** Increment 5 renamed several rows before this task
ran, so the pane no longer reads the way the original source did. In particular "Write
transcript note" is now **Transcript notes**.

1. Settings → Shorthand. Read the pane top to bottom. Confirm the order is: Enhancement
   backend, **Transcript notes**, Control Shorthand recording, the **Note writing** heading and
   its Edit… row, the **Advanced** heading, then Shorthand executable, Claude executable,
   Minimum new characters, Minimum interval, Live enhancement, Debug logging. **Advanced is the
   last group** — the pane ends with Debug logging.
2. Confirm there is no heading above "Enhancement backend" and no expander, twisty or
   "Show advanced" toggle anywhere. Advanced is a plain heading with rows under it.
3. Confirm the Advanced group holds exactly six rows: Shorthand executable, Claude executable,
   Minimum new characters, Minimum interval, Live enhancement, Debug logging. Exact wording is
   Increment 5's; this check is about which rows are in the group and how many.
4. Switch **Enhancement backend** to "LLM provider". The Claude executable row disappears from
   Advanced and the LLM provider profile block appears immediately below the dropdown. Switch
   back; Claude executable returns.
5. Turn **Transcript notes** on. The **Transcript folder** row appears immediately beneath it,
   in Basic, above the Advanced heading — not down in Advanced. Turn it off; it goes. If it
   appears anywhere below the Advanced heading, the paste went into the wrong method.
6. Type a path into Transcript folder, close settings, reopen. The value persisted.
7. Confirm no **Direct-file write limitation** row exists. Task 47 deleted it and moved its
   content to `README.md`. If it is present, Increment 5 did not fully land.

- [ ] **Step 5: Confirm you did NOT apply the unconditional variant**

An earlier draft of this plan offered to render "Transcript folder" unconditionally in Advanced
and delete the `this.display()` re-render at line 849. **That was considered and rejected.**
Verify you left both alone:

```sh
cd /d/tools/obsidian-shorthand && grep -n "writeTranscriptNote" main.ts
```

Expected: the toggle's `setValue`, its `onChange` (which still calls `this.display()`), and the
`if` guard around the folder row — all three inside `displayBasic`.

The one place the unconditional treatment *is* still open is "Claude executable": deleting its
`backend === "claude-agent-sdk"` wrapper would leave it always visible in Advanced. That is not
part of this task. Do **not** drop `this.display()` from the backend dropdown either — the LLM
provider block still needs it.

- [ ] **Step 6: Commit**

```sh
cd /d/tools/obsidian-shorthand && git add main.ts && git commit -m "refactor: group the advanced settings under an Advanced heading

Always visible at the bottom, matching Obsidian core's General, Editor and
Files and links tabs. The predicate that would hide them needs app version
1.13.0 and the manifest floor is 1.5.0, so there is nothing to unwind later.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 65: Use checkCallback for `start-capture-this-note` too

**This task lands entirely in `main.ts` and cannot be unit-tested.** Verification is
`npx tsc --noEmit`, the bundle-load smoke test, and Step 4's manual pass.

**Scope.** Task 5 already converted `enhance-now` and `clean-up-this-note` to `checkCallback`
and introduced the side-effect-free `hasActiveMarkdownFile()`. This task converts the one
remaining command with the same precondition, so all three are consistent.

If `hasActiveMarkdownFile` does not exist in `main.ts`, Task 5 has not landed. **Stop and
say so** rather than reimplementing it here — two copies of that accessor would diverge.

**This is a user-visible change and it is the desired behaviour.** Obsidian's own typings state
it plainly (`node_modules/obsidian/obsidian.d.ts:670`): *"Returning false or undefined causes
the command to be hidden from the command palette."* With no Markdown note open, "Start capture
on this note" will no longer be listed — where today it is listed, runs, and then shows the
Notice "Open a Markdown note before running Shorthand." A bound hotkey is likewise inert. That
is Obsidian's prescribed way to express a precondition.

`activeMarkdownFile()` and its Notice stay. `startCaptureOnActiveNote()` still calls it at line
225, and that call is still reachable — a note can be closed between the palette rendering and
the command running.

**Files:**
- Modify: `D:/tools/obsidian-shorthand/main.ts` — the `start-capture-this-note` command in
  `onload()` (lines 177–181 as read today; Increments 2 and 3 will have shifted them, so locate
  by command id)

**Interfaces:**
- Consumes: `ShorthandPlugin.hasActiveMarkdownFile(): boolean` (produced by Task 5)
- Produces: nothing.

- [ ] **Step 1: Confirm Task 5's accessor exists**

Run:

```sh
cd /d/tools/obsidian-shorthand && grep -n "hasActiveMarkdownFile" main.ts
```

Expected: at least three hits — the method definition, and its use in the `enhance-now` and
`clean-up-this-note` checks. If there are zero hits, Task 5 has not landed. Stop.

- [ ] **Step 2: Locate the command**

Run:

```sh
cd /d/tools/obsidian-shorthand && grep -n "start-capture-this-note" -A 4 main.ts
```

Expected: one `id:` line, a `name:` line reading `"Start capture on this note"`, and a
`callback:` whose body calls `this.startCaptureOnActiveNote()`.

- [ ] **Step 3: Convert it to `checkCallback`**

Replace that `addCommand` block with:

```ts
    // checkCallback, not callback: Obsidian hides a command whose check returns false, which
    // is its prescribed way to express "needs an open Markdown note". Matches the two
    // enhancement commands. The check runs on every palette render, so it must not fire a
    // Notice — hence hasActiveMarkdownFile rather than activeMarkdownFile.
    this.addCommand({
      id: "start-capture-this-note",
      name: "Start capture on this note",
      checkCallback: (checking: boolean) => {
        if (!this.hasActiveMarkdownFile()) return false;
        if (checking) return true;
        void this.startCaptureOnActiveNote();
        return true;
      },
    });
```

Leave the comment above the command group about sentence case and plugin prefixes exactly
where it is — it explains the `name` field and is still accurate.

- [ ] **Step 4: Typecheck**

Run:

```sh
cd /d/tools/obsidian-shorthand && npx tsc --noEmit
```

Expected: no output, exit 0. A `checkCallback` that falls off the end without returning trips
`noImplicitReturns`, so a red here most likely means a missing `return true`.

- [ ] **Step 5: Build and run the suite**

Run:

```sh
cd /d/tools/obsidian-shorthand && npm run build && npm test
```

Expected: PASS, including `test/plugin-bundle.test.ts`.

**If `OBSIDIAN_PLUGIN_DIR` is set, that build just went into your live vault.**

- [ ] **Step 6: Manual pass in Obsidian**

There is no automated coverage for command registration. Reload the plugin, then check all four:

1. With a Markdown note open, press Ctrl+P and type "Shorthand". All three commands appear:
   "Start capture on this note", "Enhance now", "Clean up this note".
2. Close every note so no Markdown file is active. Press Ctrl+P and type "Shorthand". None of
   those three appear. "Toggle Shorthand recording" and "Cancel Shorthand recording" still do —
   they have no note precondition and keep their plain `callback`.
3. Open a note again and run "Start capture on this note". It starts capture as before.
4. Open the developer console (Ctrl+Shift+I) and confirm no errors were logged while the
   palette was open. The check runs on every render; an exception there would repeat.

- [ ] **Step 7: Commit**

```bash
cd /d/tools/obsidian-shorthand
git add main.ts
git commit -m "fix: hide start capture from the palette without a Markdown note

The two enhancement commands moved to checkCallback in the previous
increment; this one has the identical precondition and was left on a
plain callback, which would have read as an oversight rather than a
decision. All three commands now express the precondition the way
Obsidian prescribes.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### When Section D's tasks are done

Run the full gate once more from a clean tree:

```sh
cd /d/tools/obsidian-shorthand && git status --porcelain && npx tsc --noEmit && npm run build && npm test
```

If `OBSIDIAN_PLUGIN_DIR` is set, that final build is what the vault keeps — and it must be a
build from committed code, so run it *after* the last commit, not before. Confirm
`<vault>/.obsidian/plugins/shorthand/` holds `main.js`, `manifest.json` and `styles.css`.

---

## When the whole plan is done

All 28 tasks across seven increments. Both repositories must be green
independently, and the plugin must be green against the **published** core tag,
not a local checkout.

- [ ] **Core is released.** `git ls-remote --tags origin 0.11.0` returns the tag
  object; `0.11.0^{}` points at the commit you tagged. Core's four-command gate
  passed on that commit.
- [ ] **The plugin consumes the real tag.** `package.json` pins
  `github:mshish/shorthand-core#0.11.0` and `package-lock.json`'s `resolved`
  moved off `1110af34…`. Verify the installed version rather than trusting the
  install — npm can report success while leaving both on the old commit.
- [ ] **The plugin's gate passes from a clean tree:**

```sh
cd /d/tools/obsidian-shorthand && git status --porcelain && npx tsc --noEmit && npm run build && npm test
```

  `git status --porcelain` should print nothing but the untracked `.serena/`
  that is not yours. Build before test: Task 0 makes the bundle test fail on a
  stale `main.js`.

- [ ] **A human has read the settings pane in a real vault.** `main.ts` cannot
  be imported under `bun test`, so every change to the pane, the modal, and the
  command registrations is verified only by typecheck, the bundle smoke test,
  and a person clicking. Task 49's twenty-item pane check and Task 65's palette
  check are that person's script.
- [ ] **The vault holds a build from committed code.** If
  `OBSIDIAN_PLUGIN_DIR` is set, the last build you ran is what Obsidian is
  running. Make it a build of `main`.
- [ ] **No setting description exceeds three sentences**, and none names a
  command that does not exist. The current copy fails both: `main.ts:844` points
  users at "Enhance active note", and the actual command is "Enhance now".
- [ ] **The plugin work is pushed.** Section B pushes after Task 25, and then
  nothing does — Tasks 40 through 65 would sit committed on a local `main`.
  Both repos are private and single-user, and their `AGENTS.md` files make
  pushing part of finishing the work, not something to ask about:

```sh
cd /d/tools/obsidian-shorthand && git push origin main
```

  Push **after** the clean-tree gate above, not before. A push is the point at
  which the work stops being yours to quietly amend.

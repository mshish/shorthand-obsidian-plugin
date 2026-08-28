# Phase A: Publish core and the plugin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `shorthand-core` and the Obsidian plugin publicly readable, with documentation that is true once they are, and a published plugin release a friend can install by hand.

**Architecture:** Seven tasks across two repositories. Task 1 is a read-only secret scan whose findings a human clears before anything is published. Tasks 2 and 3 correct documentation that asserts privacy, and both land while the repositories are still private. Tasks 4–6 are the irreversible publication steps, executed by Claude after explicit confirmation, never by an agent. Task 7 builds and verifies the release payload. Task 8 renames the local working copy and the workspace map, last, so nothing is renamed out from under work in progress.

**Tech Stack:** gitleaks 8.30.1 (via winget), `gh` CLI, git bare clones, npm (plugin dependency resolution — **not** bun, see Global Constraints), bun (test runner in both repos), esbuild, TypeScript 5.9.

**Spec:** `D:/tools/shorthand-repos/shorthand-app/docs/superpowers/specs/2026-08-28-public-release-design.md`

**Phase gate (the whole plan is done when this passes):** an anonymous clean clone of the plugin runs `npm install && npm run build && npm test` green, with `shorthand-core` resolving to `0.13.0`.

## Global Constraints

Every task's requirements implicitly include these.

- **This plan spans two repositories.** `shorthand-core` is at `D:/tools/shorthand-repos/shorthand-core`; the plugin is at `D:/tools/obsidian-shorthand` (outside the workspace tree). **Every task below names its repository. Reset the Codex session on every repository change.**
- **Codex's writable root is the shell's working directory at dispatch time, not the path in the brief.** Observed 2026-08-28: a Task 2 dispatch made while the shell sat in `D:/tools/obsidian-shorthand` came back "Blocked by workspace permissions… this session can only write under `D:\tools\obsidian-shorthand`", having changed nothing. It refuses rather than editing the wrong tree, which is the good failure — but it costs a round trip. **`cd` to the repository's parent before dispatching**, and confirm with `pwd`. For `shorthand-core` that means the workspace root `D:/tools/shorthand-repos`; for the plugin it means the plugin directory itself.
- **Publication is irreversible.** No agent runs `gh repo edit --visibility`, `gh repo rename`, or `gh release edit --draft=false`. Those are Tasks 4, 5 and 6, executed by Claude after the user confirms each one individually.
- **The secret scan is advisory to a human.** An agent may run the scanner and format its output. An agent may not decide a finding is a false positive.
- **The plugin resolves core with npm, not bun.** `README.md:53-56` in core records why. Do not "fix" a plugin install by switching to bun.
- **Documentation corrections land before publication, not after.** Once a repository is public there is no private window in which to fix a wrong claim before anyone can read it.
- **Shorthand's voice is not Handy's, and it applies to prose as well as UI.** `docs/settings-copy-style.md` is the source; it is scoped to the settings tab, so apply the rules that generalise and not the ones about controls. Binding on every edit in this plan: **rule 3** — describe the consequence, not the mechanism, and never let `shorthand-core`'s internal vocabulary ("tick pass", "link tier", "sidecar") reach a reader; **rule 7** — Obsidian's terminology is binding, so "folder" not "directory", "note" for a Markdown file, American spelling; **rule 8** — sentence case headings; **rule 9** — second person, present tense, active voice, no "we". Rule 1's ethos carries too: say it once, plainly, and link rather than inline the background. Rules 2, 4, 5 and 6 govern settings controls and do not apply here. When correcting an inherited sentence, rewrite it into this register rather than patching the wrong fact and leaving Handy's voice behind.
- **Plugin id and name are `shorthand` and `Shorthand`.** Both are already correct and are not touched by the repository rename.
- **Core's tags exist only as dependency pins.** There is no release workflow in core and there must not be one; the plugin's releases are cut from the plugin repository.

---

## File Structure

| File | Repository | Responsibility |
| --- | --- | --- |
| `AGENTS.md:28-32` | plugin | working agreement — currently premises a private single-user repo |
| `README.md:3` | plugin | product line — currently links a repository that does not exist |
| `README.md:96-100` | plugin | BRAT install — currently claims a token is required |
| `AGENTS.md:36-40` | core | working agreement — same false premise |
| `README.md:48` | core | "The package is private and unpublished" |
| `README.md:53-56` | core | the npm-not-bun rule, justified by a reason that expires on publication |
| `D:/tools/shorthand-repos/CLAUDE.md` | workspace (not versioned) | the repo map, which names the old plugin path |

---

## Task 1: Scan both repositories' full history for secrets

**Repository:** both, from bare clones. Read-only — mutates nothing.

**Reviewed alone.** Not batched with any other task.

**Files:**
- Create: `C:/Users/<user>/AppData/Local/Temp/claude/D--tools-shorthand-repos/scan/` (scratch; not committed)

**Interfaces:**
- Consumes: nothing.
- Produces: a findings report a human reads before Task 4. No code artifact.

- [ ] **Step 1: Install gitleaks**

Neither gitleaks nor trufflehog is present on this machine. Verified available via winget as `Gitleaks.Gitleaks` 8.30.1.

```bash
winget install --id Gitleaks.Gitleaks --accept-source-agreements --accept-package-agreements
```

winget reports "Path environment variable modified; restart your shell." **In practice a fresh Git Bash from this harness does not pick it up** (observed 2026-08-28), so expect to use the absolute path rather than fighting PATH:

```bash
GL="/c/Users/<user>/AppData/Local/Microsoft/WinGet/Packages/Gitleaks.Gitleaks_Microsoft.Winget.Source_8wekyb3d8bbwe/gitleaks.exe"
"$GL" version
```

Expected: `8.30.1` or later. If that path does not exist, locate the binary with `find /c/Users/<user>/AppData/Local/Microsoft/WinGet -iname 'gitleaks*' -maxdepth 4` — the package directory name encodes the source and may differ.

- [ ] **Step 2: Take bare clones of both repositories**

The bare clone is the source of truth, not the working copy. A working copy cannot see branch history that exists only on the server, and that is exactly the history a scan must cover.

```bash
scan=/c/Users/<user>/AppData/Local/Temp/claude/D--tools-shorthand-repos/scan
mkdir -p "$scan"
git clone --bare https://github.com/mshish/shorthand-core.git "$scan/core.git"
git clone --bare https://github.com/mshish/obsidian-shorthand.git "$scan/plugin.git"
```

Confirm the clones carry the refs the server has. **Compare ref names, not counts.** `git ls-remote` emits a second `refs/tags/X^{}` line for every annotated tag, so a count-versus-count check reports a false gap — core shows 34 remote lines against 19 real refs purely because 15 of its tags are annotated.

```bash
for r in core:shorthand-core plugin:obsidian-shorthand; do
  n=${r%%:*}; repo=${r##*:}
  git ls-remote --heads --tags "https://github.com/mshish/$repo.git" \
    | awk '{print $2}' | grep -v '\^{}' | sort > "$scan/$n-server.txt"
  git -C "$scan/$n.git" for-each-ref --format='%(refname)' | sort > "$scan/$n-local.txt"
  echo "=== $n ==="; diff "$scan/$n-server.txt" "$scan/$n-local.txt" && echo "complete"
done
```

Expected: `complete` for both. Any line present on the server but missing locally is history the scan would not see.

Also confirm the clone has no remote-tracking refs — a bare clone of a single-remote source has none, and anything here means the clone is not what it appears to be:

```bash
git -C "$scan/core.git" for-each-ref refs/remotes
git -C "$scan/plugin.git" for-each-ref refs/remotes
```

Expected: no output from either.

- [ ] **Step 3: Scan the full history of each**

`--no-banner` keeps the report parseable. `--report-format json` gives a file a human can work through; the console summary alone is not a record.

```bash
gitleaks detect --source "$scan/core.git" --no-banner \
  --report-format json --report-path "$scan/core-findings.json"
echo "core exit: $?"

gitleaks detect --source "$scan/plugin.git" --no-banner \
  --report-format json --report-path "$scan/plugin-findings.json"
echo "plugin exit: $?"
```

gitleaks exits `1` when it finds leaks and `0` when it finds none. **A non-zero exit is the expected outcome to investigate, not a tool failure.** An exit of `126`/`127` is a tool failure.

- [ ] **Step 4: Summarise the findings for human review**

```bash
for f in core plugin; do
  echo "=== $f ==="
  node -e "
    const r = require('$scan/'+'$f'+'-findings.json');
    console.log(r.length + ' findings');
    for (const x of r) console.log([x.RuleID, x.File, x.StartLine, x.Commit.slice(0,8)].join('  '));
  " 2>/dev/null || echo "(no findings file — gitleaks found nothing)"
done
```

- [ ] **Step 5: STOP. Human reviews every finding**

Do not proceed. Do not classify anything as a false positive. Present the summary and the paths to the two JSON reports, and wait.

The user decides, per finding, whether it is a real secret. If any is real, publication does not proceed — history rewriting or credential rotation is a separate piece of work that must complete first, and rotating the credential is mandatory even if the history is rewritten, because a private repository is not proof the value was never exposed.

Nothing is committed by this task.

---

## Task 2: Correct core's documentation before it is public

**Repository:** `D:/tools/shorthand-repos/shorthand-core`. Reset the Codex session — this is a repository change from Task 1's scratch directory.

**Files:**
- Modify: `AGENTS.md:36-40`
- Modify: `README.md:48`
- Modify: `README.md:53-56`

**Interfaces:**
- Consumes: nothing.
- Produces: documentation that is true after Task 4. Task 4 must not run before this lands.

- [ ] **Step 1: Rewrite the `AGENTS.md` working agreement**

`AGENTS.md:36` is headed "This repo is private, and pushing needs no permission" and `:38` opens "It is a single-user private repo." Both halves stop holding — it becomes public and may take contributions.

Replace the heading and that first paragraph with a statement that the repository is public, that the maintainer's own work may be committed, pushed and tagged without stopping to ask, and that anything arriving from outside goes through a pull request.

**Keep verbatim** the paragraph beginning "Still confirm before force-pushing" (`:40-41`). Force-push discipline is unrelated to visibility and still applies.

- [ ] **Step 2: Correct the "Consuming core" claim**

`README.md:48` reads:

```markdown
The package is private and unpublished, so consumers install it from git, pinned to a tag:
```

It stays unpublished (not on npm) but stops being private. Replace with:

```markdown
The package is unpublished — it is not on npm — so consumers install it from git, pinned to a tag:
```

- [ ] **Step 3: Fix the stale pin example in the same block**

The example immediately below `:48` shows:

```json
"shorthand-core": "git+https://github.com/mshish/shorthand-core.git#0.1.0"
```

The plugin actually uses `"shorthand-core": "github:mshish/shorthand-core#0.13.0"` — a different URL form and a tag 12 releases stale. Documentation that disagrees with the only consumer is worse than none. Change the example to the `github:` form and drop the specific version from the example so it cannot go stale again:

```json
"shorthand-core": "github:mshish/shorthand-core#<tag>"
```

- [ ] **Step 4: Establish whether the npm-not-bun rule survives publication**

This is the step that matters. `README.md:53-56` says:

> Use **npm**, not bun: npm resolves that URL by cloning through the `gh` credential helper, while bun rewrites GitHub dependencies to the API tarball endpoint and 404s on a private repository regardless of the token supplied.

The stated reason — "404s on a **private** repository" — expires the moment core is public. The rule may still be right for a different reason, or may now be pointless. Deleting a load-bearing rule and keeping a pointless one are both failures, and the global working agreement is explicit that the recorded reason must be the actual one.

**This step cannot be completed before Task 4.** Do the edits above now, leave `:53-56` untouched, and return here after core is public. Then, in a scratch directory:

```bash
tmp=$(mktemp -d) && cd "$tmp" && npm init -y >/dev/null
bun add github:mshish/shorthand-core#0.13.0 2>&1 | tail -20
node -p "require('./node_modules/shorthand-core/package.json').version" 2>&1
```

- If bun now resolves it and the version prints `0.13.0`: the constraint is gone. Delete the npm-not-bun rule and say in the commit message that publication removed the reason for it.
- If bun still fails: keep the rule and **rewrite the reason to the one actually observed**, quoting bun's real error. Do not leave "404s on a private repository" standing — it will be deleted by the next reader who notices core is public.

- [ ] **Step 5: Verify no stale privacy claim survives**

```bash
cd /d/tools/shorthand-repos/shorthand-core
grep -rni "private repo\|is private\|repository is private\|package is private" AGENTS.md README.md CLAUDE.md
```

Expected after Step 4 resolves: no output. If `:53-56` is still pending Step 4, expect exactly that one hit and no other.

- [ ] **Step 6: Confirm nothing else broke**

Documentation-only changes, but the repository has gates and they are cheap:

```bash
bun run typecheck && bun test
```

Expected: both pass. They were passing before; this task touches no code, so a failure here means something unrelated is already broken and must be reported, not worked around.

- [ ] **Step 7: Commit**

```bash
git add AGENTS.md README.md
git commit -m "docs: correct what going public makes false

The working agreement premised a single-user private repo, and the
consuming instructions called the package private. The pin example also
showed a git+https URL at 0.1.0 while the only consumer uses the github:
form at 0.13.0."
```

---

## Task 3: Correct the plugin's documentation before it is public

**Repository:** `D:/tools/obsidian-shorthand`. **Reset the Codex session** — repository change.

This is Task 1 of the existing marketplace-submission plan (`docs/superpowers/plans/2026-08-26-marketplace-submission.md`), and only that task. Nothing else from that plan is in scope for this phase.

**Files:**
- Modify: `README.md:3`
- Modify: `README.md:96-100`
- Modify: `AGENTS.md:28-32`

**Interfaces:**
- Consumes: nothing.
- Produces: documentation naming the post-rename repository. Task 5 must not run before this lands.

- [ ] **Step 1: Fix the dead application link**

`README.md:3` currently reads:

```markdown
Granola-style meeting notes for Obsidian, driven by [Shorthand](https://github.com/cjpais/Shorthand)'s
```

`https://github.com/cjpais/Shorthand` **does not exist** — it 404s. The application is `mshish/shorthand`, a fork of `cjpais/Handy`. Replace with:

```markdown
Granola-style meeting notes for Obsidian, driven by [Shorthand](https://github.com/mshish/shorthand)'s
```

- [ ] **Step 2: Replace the BRAT paragraph**

`README.md:98-100` currently reads:

```markdown
BRAT installs from a **release**, not from the repo tree. This repository is private, so BRAT
needs a fine-grained personal access token with read-only **Contents** permission on it, added in
BRAT's settings; then add `mshish/obsidian-shorthand` as a beta plugin.
```

Both claims die: the token is unnecessary, and the repository name changes in Task 5. Replace with:

```markdown
BRAT installs from a **release**, not from the repo tree. Add
`mshish/shorthand-obsidian-plugin` as a beta plugin in BRAT's settings.
```

- [ ] **Step 3: Rewrite the `AGENTS.md` working agreement**

`AGENTS.md:28` is headed "This repo is private, and pushing needs no permission" and `:30` opens "Single-user private repo."

Replace the heading and that first paragraph with a statement that the repository is public, that the maintainer's own work may be pushed and merged without asking, and that anything arriving from outside goes through a pull request.

**Keep verbatim** the paragraph at `:34` beginning "That is permission to push *your* work". The staging discipline it describes is unrelated to visibility and still applies.

- [ ] **Step 4: Update every other reference to the old repository name**

The rename in Task 5 makes `mshish/obsidian-shorthand` a redirect, not an error — but documentation should name the real thing.

```bash
grep -rn "obsidian-shorthand" README.md AGENTS.md CLAUDE.md package.json 2>/dev/null
```

Update each hit to `shorthand-obsidian-plugin`, **except** `package.json`'s `"name"` field. That is the npm package name, is not the repository name, appears in build output, and changing it is a separate decision nobody has taken. Leave it.

`.serena/project.yml` also carries `project_name: "obsidian-shorthand"`, but `.serena/` is gitignored (`.gitignore:30`) — edit it if you like, and do **not** stage it. `git add` on an ignored path errors rather than succeeding quietly.

- [ ] **Step 5: Verify no stale privacy claim survives**

```bash
grep -rni "private repo\|is private\|repository is private\|while this repo is private" README.md AGENTS.md CLAUDE.md
```

Expected: one surviving hit, in `README.md` § "Cutting a release" — "it does nothing while this repo is private", about `versions.json`. Fix that sentence too: `versions.json` is read from the default branch by the community directory and will do real work once the plugin is listed, which is a later phase but no longer a hypothetical.

Re-run the grep. Expected: no output.

- [ ] **Step 6: Confirm every link in the README resolves**

```bash
grep -o 'https://[^)"[:space:]]*' README.md | sort -u | while read -r u; do
  printf '%s %s\n' "$(curl -s -o /dev/null -w '%{http_code}' -L "$u")" "$u"
done
```

Expected: no `404` lines. `https://github.com/mshish/shorthand` and `https://github.com/mshish/shorthand-core` will still 404 at this point because they are private — that is correct and expected now, and Task 4 and Phase B fix it. Every **other** 404 is a real defect to fix here.

- [ ] **Step 7: Confirm the build and tests still pass**

```bash
npm run build && npm test
```

Expected: both pass.

- [ ] **Step 8: Commit**

```bash
git add README.md AGENTS.md CLAUDE.md
git commit -m "docs: correct what going public makes false

The app link pointed at cjpais/Shorthand, which does not exist -- the app
is mshish/shorthand, a fork of cjpais/Handy. BRAT no longer needs a token,
versions.json will do real work, and the private-repo working agreement no
longer describes this repository. Names the post-rename repository."
```

---

## Review batch 1

Tasks 2 and 3 are one review batch: two documentation truth passes, same class of change, ~2 files each. Task 1 was reviewed alone.

Dispatch a **Sonnet 5 reviewer** with read-only tools over both repositories' `HEAD~1..HEAD`, with Tasks 2 and 3 as the rubric. Specifically ask it to check that no *other* claim in either README or AGENTS.md silently depends on the repository being private — the greps above catch the phrasings we predicted, not the ones we did not.

Claude adjudicates. `superpowers:receiving-code-review` applies.

---

## Task 4: Publish `shorthand-core`

**Executed by Claude, not an agent. Requires explicit user confirmation.**

**Precondition:** Task 1's findings cleared by the user, and Task 2 committed.

- [ ] **Step 1: Confirm with the user, naming what is about to happen**

State: `mshish/shorthand-core` becomes readable by anyone, its full history included, and the 31 tags with it. Wait for a yes.

- [ ] **Step 2: Flip visibility**

```bash
gh repo edit mshish/shorthand-core --visibility public --accept-visibility-change-consequences
```

- [ ] **Step 3: Verify anonymously**

The GitHub API returns 404, not 403, for private repositories to unauthenticated callers, so this is a real check and not a formality:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://api.github.com/repos/mshish/shorthand-core
```

Expected: `200`.

- [ ] **Step 4: Return to Task 2 Step 4**

The bun-versus-npm question is now answerable. Go back and settle it.

---

## Task 5: Rename and publish the plugin repository

**Executed by Claude, not an agent. Requires explicit user confirmation.**

**Precondition:** Task 3 committed and pushed, and Task 4 complete.

- [ ] **Step 1: Confirm with the user**

State both actions: the repository is renamed `obsidian-shorthand` → `shorthand-obsidian-plugin`, and then made public. Note that GitHub auto-redirects the old URL until some other repository claims the vacated name, and that nothing external currently points at it. Wait for a yes.

- [ ] **Step 2: Push the Task 3 commit first**

Documentation must be correct at the moment of publication, not shortly after.

```bash
cd /d/tools/obsidian-shorthand && git push origin main
```

- [ ] **Step 3: Rename**

```bash
gh repo rename shorthand-obsidian-plugin -R mshish/obsidian-shorthand -y
```

- [ ] **Step 4: Update the local remote**

The redirect makes the old URL keep working, which is exactly why this is easy to forget.

```bash
git remote set-url origin https://github.com/mshish/shorthand-obsidian-plugin.git
git remote -v
```

Expected: both fetch and push lines show `shorthand-obsidian-plugin`.

- [ ] **Step 5: Publish**

```bash
gh repo edit mshish/shorthand-obsidian-plugin --visibility public --accept-visibility-change-consequences
```

- [ ] **Step 6: Verify anonymously**

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://api.github.com/repos/mshish/shorthand-obsidian-plugin
```

Expected: `200`.

---

## Task 6: Build and verify the release payload, then publish the draft

**Repository:** `D:/tools/obsidian-shorthand`. Codex builds and verifies; **Claude publishes** after user confirmation.

A draft release `0.1.0` already exists, created 2026-08-16. It is not created by this task — it is verified and published.

**Files:**
- Modify: none (build outputs only)

**Interfaces:**
- Consumes: a public plugin repository from Task 5.
- Produces: a published release carrying `main.js`, `manifest.json`, `styles.css` — the three files Obsidian needs in `<vault>/<config>/plugins/shorthand/`.

- [ ] **Step 1: Build from a clean tree**

```bash
cd /d/tools/obsidian-shorthand
git status --short
```

Expected: empty. A dirty tree means the release would carry unreviewed work; stop and resolve it.

```bash
npm run build
```

- [ ] **Step 2: Confirm the three assets exist and the manifest agrees**

```bash
ls -l main.js manifest.json styles.css
node -p "JSON.stringify({m:require('./manifest.json').version, p:require('./package.json').version, id:require('./manifest.json').id})"
```

Expected: all three files present; manifest and package versions both `0.1.0`; id `shorthand`.

- [ ] **Step 3: Inspect the existing draft**

```bash
gh release view 0.1.0 -R mshish/shorthand-obsidian-plugin
```

The draft was cut on 2026-08-16 and `main.js` has changed since. Whatever assets it carries are stale.

- [ ] **Step 4: Replace the draft's assets with the freshly built ones**

```bash
gh release upload 0.1.0 main.js manifest.json styles.css \
  -R mshish/shorthand-obsidian-plugin --clobber
```

- [ ] **Step 5: Verify the uploaded assets are the built ones**

Not that assets exist — that they are the bytes just built. A stale asset is the failure mode this whole task exists to prevent.

```bash
tmp=$(mktemp -d)
gh release download 0.1.0 -R mshish/shorthand-obsidian-plugin -D "$tmp" --clobber
for f in main.js manifest.json styles.css; do
  a=$(sha256sum "$f" | cut -d' ' -f1)
  b=$(sha256sum "$tmp/$f" | cut -d' ' -f1)
  [ "$a" = "$b" ] && echo "OK   $f" || echo "DIFF $f"
done
```

Expected: three `OK` lines.

- [ ] **Step 6: STOP. Claude publishes after user confirmation**

```bash
gh release edit 0.1.0 -R mshish/shorthand-obsidian-plugin --draft=false
```

---

## Task 7: Rename the local working copy and the workspace map

**Repository:** the plugin's local checkout, plus the workspace `CLAUDE.md`, which is **not** versioned.

Last task in the phase, deliberately: renaming a directory that other work is running in breaks that work.

**Files:**
- Move: `D:/tools/obsidian-shorthand` → `D:/tools/shorthand-obsidian-plugin`
- Modify: `D:/tools/shorthand-repos/CLAUDE.md` (the map table and the routing-trigger section)

**Interfaces:**
- Consumes: the completed rename from Task 5.
- Produces: a local path matching the repository name.

- [ ] **Step 1: Confirm nothing is running against the old path**

No agent session, no dev server, no editor holding a file open. On Windows a directory cannot be renamed while a handle is open in it, so this fails loudly rather than silently — but the failure is confusing if unexpected.

- [ ] **Step 2: Rename**

```bash
mv /d/tools/obsidian-shorthand /d/tools/shorthand-obsidian-plugin
```

- [ ] **Step 3: Update the workspace map**

In `D:/tools/shorthand-repos/CLAUDE.md`, the map table's fourth row reads `../obsidian-shorthand/` and describes it as "a sibling at `D:/tools/obsidian-shorthand`". Update both the path and the repository name. The routing-trigger section below the table also names the plugin; update it if it uses the path rather than the concept.

This file is deliberately not versioned, so there is no commit for this edit.

- [ ] **Step 4: Verify the checkout still works from its new location**

```bash
cd /d/tools/shorthand-obsidian-plugin
git remote -v && git status --short && npm test
```

Expected: remote shows `shorthand-obsidian-plugin`, status clean, tests pass.

---

## Phase gate: anonymous clean-clone verification

**Executed by Claude.** This is what an outside contributor — and, in a later phase, Obsidian's automated reviewer — actually does.

- [ ] **Step 1: Clone and install as an anonymous user would**

Not against the working tree. Core's own README documents that npm can report a successful install while resolving from a stale cache, so the version assertion below is the real check.

```bash
tmp=$(mktemp -d)
git -C "$tmp" clone --depth 1 https://github.com/mshish/shorthand-obsidian-plugin.git p
cd "$tmp/p"
npm install --no-audit --fund=false
node -p "require('./node_modules/shorthand-core/package.json').version"
```

Expected: `0.13.0`. A different version means npm resolved from cache — clear it and retry before believing the result.

- [ ] **Step 2: Build and test the clean clone**

**`OBSIDIAN_PLUGIN_DIR` must be unset for this.** It is set in the user's shell profile, and `esbuild.config.mjs:37` reads it from the environment, so `npm run build` in *any* directory — a throwaway clone included — copies `main.js`, `manifest.json` and `styles.css` straight into the live vault. Observed 2026-08-28: a verification build from a temp clone silently overwrote the vault's plugin. Nothing was lost that time because the clone was of committed `HEAD`, but a verification step must not write to a real vault at all, and a clone of a *branch* would have installed unreviewed code into it.

```bash
env -u OBSIDIAN_PLUGIN_DIR npm run build && env -u OBSIDIAN_PLUGIN_DIR npm test
```

Expected: all pass, and **no** "delivered main.js, manifest.json and styles.css to …" line in the output. If that line appears, the guard did not take — stop, and check the vault against `git -C <vault-plugin-dir> status` or a rebuild from committed `main`.

Do not substitute `npx tsc --noEmit` for the typecheck here. `npm run build` already runs `tsc --noEmit` as its first step, and bare `npx tsc` fails outright against a bun-installed tree — bun writes `.exe`/`.bunx` shims into `node_modules/.bin` where npx expects scripts.

- [ ] **Step 3: Confirm all three repositories' public status**

Phase B has not run yet, so the app is still expected to be private here.

```bash
for r in mshish/shorthand-core mshish/shorthand-obsidian-plugin mshish/shorthand; do
  printf '%s ' "$r"
  curl -s -o /dev/null -w '%{http_code}\n' "https://api.github.com/repos/$r"
done
```

Expected: `200`, `200`, `404`. The third becomes `200` at the end of Phase B.

- [ ] **Step 4: Install the release into a real vault by hand**

The gate this phase exists to satisfy is a friend installing the plugin, and no automated check substitutes for doing it.

Download the three assets from the published `0.1.0` release into `<vault>/.obsidian/plugins/shorthand/`, enable the plugin in Obsidian's Community plugins pane, and confirm it loads without console errors.

Note for the tester: the plugin needs the Shorthand application, which has no installer until Phase D. Until then this confirms the plugin loads, not that capture works end to end.

---

## Known consequences, carried deliberately

**Publishing is irreversible.** Making a repository private again does not un-publish what was read, forked or cached while it was public. Task 1's scan is the only real control, which is why its findings are cleared by a human.

**The plugin does nothing useful yet.** The application it drives has no installer until Phase D. Anyone who finds the plugin between now and then has a plugin that cannot capture. Acceptable while distribution is manual and to named friends; it stops being acceptable at directory submission, which is a later phase and out of scope here.

**`versions.json` starts doing real work.** It is inert while unlisted, and read from the default branch once listed. Task 3 Step 5 corrects the claim that it does nothing, but nothing in this phase exercises it.

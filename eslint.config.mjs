// Local reproduction of the Obsidian marketplace review's lint gate. The
// marketplace runs eslint-plugin-obsidianmd's recommended config against
// submitted plugins; this file exists so findings can be checked here before
// resubmission, not to define a different policy. `npm run lint` is the
// entry point, and CI runs it as a gate.
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "main.js",
      // Maintainer build tooling: plain Node scripts that never import
      // "obsidian" and never ship in main.js, so the marketplace review this
      // gate reproduces never sees them either. They also sit outside
      // tsconfig.json's "include" (main.ts, src/**/*.ts, test/**/*.ts), so
      // linting them would mean a second, non-type-checked config block for
      // no benefit — ignoring keeps the gate scoped to what the marketplace
      // actually reviews.
      "esbuild.config.mjs",
      "third-party-licenses.mjs",
      "version-bump.mjs",
      // Machine-local / scratch tooling state, already gitignored. ESLint's
      // flat config does not read .gitignore on its own, and none of these
      // currently hold files our globs match — listed explicitly so that
      // stays true on purpose rather than by accident.
      ".worktrees/**",
      ".superpowers/**",
      ".serena/**",
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    // Type-aware linting only for the files tsconfig.json actually includes
    // (main.ts, src/**/*.ts, test/**/*.ts). Scoped here with `files` rather
    // than set globally, because eslint-plugin-obsidianmd's own recommended
    // config gives *.mjs files a non-type-checked block instead (files:
    // ['**/*.{js,cjs,mjs,jsx}'], extends: tseslint.configs.recommended) —
    // an unscoped `parserOptions.projectService` would still merge into that
    // block's languageOptions and force @typescript-eslint/parser to demand
    // a tsconfig membership those files don't have. That's a parse error, not
    // a lint finding, and it would hit this config file itself (also outside
    // tsconfig's "include") every time `npm run lint` runs.
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    // obsidianmd/ui/sentence-case flags proper nouns this project must
    // capitalise ("Open shorthand panel", "Claude Code", "Shorthand") per
    // docs/settings-copy-style.md. The marketplace review this gate
    // reproduces did not include a single sentence-case finding, so the
    // reviewing bot filters it too — disabling it here only affects this
    // local gate; the marketplace still runs its own config independently.
    rules: {
      "obsidianmd/ui/sentence-case": "off",
    },
  },
  {
    // Two rules defend against Obsidian *runtime* hazards that cannot arise in
    // a bun:test file, because these files never load inside Obsidian at all.
    // Applying them there does not make the plugin safer; it forces changes
    // that make the tests worse, which is why they are off here and nowhere
    // else. Both were confirmed against the real alternative, not assumed:
    //
    //   prefer-window-timers guards popout windows, where a bare setTimeout
    //   resolves against the wrong window. Under `bun test` there is no
    //   `window` at all, so the "fix" is a ReferenceError on the first call.
    //   src/recorder.ts uses window.setTimeout and stays covered by the rule;
    //   its tests reach that path through an injected fake delay instead.
    //
    //   no-tfile-tfolder-cast wants `instanceof TFile` in place of a cast, but
    //   node_modules/obsidian sets "main": "" and ships types only — TFile has
    //   no runtime class to be an instance of. Satisfying the rule would mean
    //   fabricating unused fields so a test double impersonates a real TFile,
    //   when every consumer of these doubles reads only `.path` and reference
    //   identity.
    files: ["test/**/*.ts"],
    rules: {
      "obsidianmd/prefer-window-timers": "off",
      "obsidianmd/no-tfile-tfolder-cast": "off",
    },
  },
);

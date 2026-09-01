// Local reproduction of the Obsidian marketplace review's lint gate. The
// marketplace runs eslint-plugin-obsidianmd's recommended config against
// submitted plugins; this file exists so findings can be checked here before
// resubmission, not to define a different policy. `npm run lint` is the
// entry point; nothing here is wired into CI yet.
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
);

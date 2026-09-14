import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Obsidian's declarative settings renderer (1.13.7) builds a group's rows from its `items`,
 * runs each row's `render`, and then calls `listEl.setChildrenInPlace(...)` with exactly those
 * rows' elements — which removes every other child of the list, including any row a `render`
 * callback appended through its `group` argument's `addSetting`. Such a row is created, wired
 * up, and gone before the user sees it, with no error anywhere. That is how the Claude/Codex
 * effort row and all four LLM provider profile fields shipped invisible in 0.6.x with every
 * check green: `main.ts` cannot be exercised under `bun test` (see AGENTS.md § "The settings
 * surface"), so the only automated guard available is the source text.
 *
 * Every row must therefore be its own definition. Rows that share imperative state do so
 * through the tab instance (`#effortRows`, `#llmProfile`), not through `group.addSetting`.
 */
describe("the settings tab", () => {
  test("declares every row rather than appending rows from a render callback", () => {
    const source = readFileSync(resolve(process.cwd(), "main.ts"), "utf8");
    expect(source).not.toMatch(/\.addSetting\(/);
  });

  test("declares ACP backend options and controls", () => {
    const source = readFileSync(resolve(process.cwd(), "main.ts"), "utf8");
    expect(source).toContain('acp: "Agent Client Protocol (ACP)"');
    expect(source).toContain('"ACP model"');
    expect(source).toContain('"ACP transport"');
    expect(source).toContain('"ACP executable"');
    expect(source).toContain('"ACP arguments"');
    expect(source).toContain('"ACP network URL"');
    expect(source).toContain('"acpTransport"');
    expect(source).toContain('"acpExecutable"');
  });

  test("declares Cursor CLI backend options and controls", () => {
    const source = readFileSync(resolve(process.cwd(), "main.ts"), "utf8");
    expect(source).toContain('cursor: "Cursor CLI"');
    expect(source).toContain('"Cursor CLI model"');
    expect(source).toContain('"Cursor CLI executable"');
    expect(source).toContain('"cursorExecutable"');
  });

  /**
   * Every provider secret now lives in the Shorthand app's keyring, not `data.json` (see
   * `src/app-credentials.ts`). `writeLlmCredentials` and `LlmProfileEditor` are the
   * writer-based UI that used to own that file directly; their presence here would mean a
   * credential path core no longer supports is still reachable from the settings tab.
   */
  test("does not write credentials directly, and the old writer-based profile editor is gone", () => {
    const source = readFileSync(resolve(process.cwd(), "main.ts"), "utf8");
    expect(source).not.toContain("writeLlmCredentials");
    expect(source).not.toContain("LlmProfileEditor");
  });

  /**
   * `acpAuthToken` survives in `ShorthandPluginSettings` only so `normalizePluginSettings` can
   * keep validating an older `data.json` long enough for the one-time migration to read it —
   * see the field's own doc comment in `src/settings.ts`. A second reference anywhere else in
   * `main.ts` would mean some other code path still treats it as live, rather than as a value
   * on its way to being cleared and forgotten.
   */
  test("acpAuthToken is read only by the one-time credential migration", () => {
    const source = readFileSync(resolve(process.cwd(), "main.ts"), "utf8");
    const occurrences = source.split("acpAuthToken").length - 1;
    expect(occurrences).toBe(1);
  });

  test('declares one write-only "API key" row, shared by the LLM profile and the ACP network transport', () => {
    const source = readFileSync(resolve(process.cwd(), "main.ts"), "utf8");
    expect(source).toContain('"API key"');
    expect(source).not.toContain('"ACP authentication token"');
  });

  test("declares provider, model and base URL as plain controls bound to their settings keys", () => {
    const source = readFileSync(resolve(process.cwd(), "main.ts"), "utf8");
    expect(source).toContain('key: "llmProvider"');
    expect(source).toContain('key: "llmModel"');
    expect(source).toContain('key: "llmBaseUrl"');
  });
});

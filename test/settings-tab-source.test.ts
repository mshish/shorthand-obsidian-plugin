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
    expect(source).toContain('"ACP authentication token"');
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
});

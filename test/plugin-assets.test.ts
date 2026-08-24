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

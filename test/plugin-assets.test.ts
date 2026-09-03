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
    expect(css).toContain(".shorthand-panel-buttons");
  });

  test("lets the panel's `hidden` attribute win over its own display rules", () => {
    // `#patch` hides Stop, the note link and the activity dots with `el.hidden`, which only
    // works through the UA stylesheet's `[hidden] { display: none }`. Any author rule that
    // sets `display` on those elements outranks it, and `.shorthand-panel-note`,
    // `.shorthand-panel-activity` and `button.shorthand-panel-button` all do — so without a
    // scoped `[hidden]` rule, an idle panel shows a Stop button that does nothing.
    const css = readFileSync(resolve(process.cwd(), "styles.css"), "utf8");
    expect(css).toMatch(/\.shorthand-panel \[hidden\]\s*\{\s*display: none;\s*\}/);
  });

  test("keeps the panel's semantic accents stable across Obsidian themes", () => {
    const css = readFileSync(resolve(process.cwd(), "styles.css"), "utf8");
    expect(css).toContain("--shorthand-panel-green: #4d8b74");
    expect(css).toContain("--shorthand-panel-orange: #bc7049");
    expect(css).toContain("--shorthand-panel-purple: #8169ae");
    expect(css).toContain("--shorthand-panel-blue: #5f82bd");
    expect(css).toContain("--shorthand-panel-red: #b55757");
  });

  test("keeps the idle header visually distinct from live-status cards", () => {
    const css = readFileSync(resolve(process.cwd(), "styles.css"), "utf8");
    expect(css).toContain(".shorthand-panel-status.is-idle");
    expect(css).toMatch(/\.shorthand-panel-status\.is-idle\s*\{[\s\S]*?box-shadow: none;/);
  });

  test("is delivered to the vault alongside main.js and manifest.json", () => {
    const config = readFileSync(resolve(process.cwd(), "esbuild.config.mjs"), "utf8");
    expect(config).toContain(`["main.js", "manifest.json", "styles.css"]`);
  });
});

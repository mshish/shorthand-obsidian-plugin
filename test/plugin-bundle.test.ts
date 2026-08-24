import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Nothing else in CI ever LOADS the plugin bundle — it is built and then never
 * required. That is how the `import.meta.url` banner in esbuild.config.mjs
 * came to exist: the plugin failed at Obsidian load once, with every check green.
 * A barrel that drags a new module into the bundle graph reproduces exactly that
 * class of failure, so the entry point must be executed here.
 */
const BUNDLE = resolve(process.cwd(), "main.js");

const OBSIDIAN_STUB = `
class Plugin { constructor(app, manifest) { this.app = app; this.manifest = manifest; } }
class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }
class Modal { constructor(app) { this.app = app; } }
class Notice { constructor(message) { this.message = message; } }
class Setting { constructor(container) { this.container = container; } }
class MarkdownView {}
class FileSystemAdapter {}
module.exports = { Plugin, PluginSettingTab, Modal, Notice, Setting, MarkdownView, FileSystemAdapter };
`;

/**
 * Inputs that can change what the bundle contains: the entry point and its module graph, the
 * build configuration itself, and the resolved dependency set. This is deliberately broader
 * than esbuild's import graph — package-lock.json catches a core-pin bump, which changes the
 * bundled code without touching a single file in src/.
 *
 * tsconfig.json is here for the same reason as esbuild.config.mjs, not because of what it
 * includes: esbuild reads its compiler options — target among them — and those change the
 * emitted bundle. Its own `include` also matches files under test/, but the entry point is
 * main.ts, so those files never reach the bundle — watching tsconfig.json tracks esbuild's
 * config input, not its module graph.
 *
 * It is not exhaustive and cannot be: a dependency rebuilt in place under node_modules moves
 * no file listed here. It covers every way this repo's own workflow changes the bundle.
 */
const BUNDLE_SOURCES = [
  "main.ts",
  "src",
  "package.json",
  "package-lock.json",
  "esbuild.config.mjs",
  "tsconfig.json",
];

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

describe("the built plugin bundle", () => {
  test("loads under a stub obsidian and exports a Plugin class with onload/onunload", async () => {
    ensureBundle();
    const directory = await mkdtemp(join(tmpdir(), "shorthand-plugin-load-"));
    try {
      await mkdir(join(directory, "node_modules", "obsidian"), { recursive: true });
      await writeFile(
        join(directory, "node_modules", "obsidian", "package.json"),
        JSON.stringify({ name: "obsidian", version: "0.0.0", main: "index.js" }),
        "utf8",
      );
      await writeFile(join(directory, "node_modules", "obsidian", "index.js"), OBSIDIAN_STUB, "utf8");
      const copied = join(directory, "main.js");
      await copyFile(BUNDLE, copied);
      const loaded: Record<string, unknown> = createRequire(join(directory, "loader.cjs"))(copied);
      const exported = loaded.default;
      expect(typeof exported).toBe("function");
      const prototype = (exported as new () => unknown).prototype as Record<string, unknown>;
      expect(typeof prototype.onload).toBe("function");
      expect(typeof prototype.onunload).toBe("function");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});

import { afterEach, describe, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { llmCredentialsPath } from "shorthand-core";
import { describeLlmCredentialsConformance } from "shorthand-core/testing";
import type {
  LlmCredentialsFixture,
  LlmCredentialsWriterHarness,
} from "shorthand-core/testing";
import { writeLlmCredentials } from "../src/llm-credentials-writer.js";

const scratchDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function withScratchConfigDirectory(): Promise<Readonly<{
  root: string;
  restore(): void;
}>> {
  const root = await mkdtemp(join(tmpdir(), "llm-credentials-conformance-"));
  scratchDirectories.push(root);

  const keys = ["APPDATA", "XDG_CONFIG_HOME", "HOME", "USERPROFILE"] as const;
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) process.env[key] = root;

  return {
    root,
    restore: () => {
      for (const key of keys) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

async function createHarness(): Promise<LlmCredentialsWriterHarness> {
  const scope = await withScratchConfigDirectory();
  const target = resolve(llmCredentialsPath());
  const fromScratchRoot = relative(resolve(scope.root), target);

  // Refuse to run if core's platform resolution escapes scratch space; this turns a
  // future environment-variable change into a test failure instead of a real key overwrite.
  if (fromScratchRoot === "" || fromScratchRoot === ".." ||
      fromScratchRoot.startsWith(`..${sep}`) || isAbsolute(fromScratchRoot)) {
    scope.restore();
    throw new Error(`Refusing to test outside scratch directory: ${target}`);
  }

  return {
    write: (credentials: LlmCredentialsFixture) => writeLlmCredentials(credentials),
    dispose: async () => { scope.restore(); },
  };
}

describeLlmCredentialsConformance(
  { describe, test },
  "the Obsidian plugin writer",
  createHarness,
  { posixPermissions: process.platform !== "win32" },
);

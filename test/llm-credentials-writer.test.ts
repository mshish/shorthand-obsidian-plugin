import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { llmCredentialsPath } from "shorthand-core";
import { deleteLlmCredentials } from "../src/llm-credentials-writer.js";

describe("LLM credentials deletion", () => {
  test("deletes a malformed file and tolerates an already-absent file", async () => {
    const root = await mkdtemp(join(tmpdir(), "llm-credentials-delete-"));
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      APPDATA: root,
      XDG_CONFIG_HOME: root,
      HOME: root,
      USERPROFILE: root,
    };
    const target = resolve(llmCredentialsPath(environment));
    const fromScratchRoot = relative(resolve(root), target);

    // Refuse to run if core's platform resolution escapes scratch space; this turns a
    // future environment-variable change into a test failure instead of deleting a real key.
    if (fromScratchRoot === "" || fromScratchRoot === ".." ||
        fromScratchRoot.startsWith(`..${sep}`) || isAbsolute(fromScratchRoot)) {
      await rm(root, { recursive: true, force: true });
      throw new Error(`Refusing to test outside scratch directory: ${target}`);
    }

    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, "{ malformed", "utf8");

      await expect(deleteLlmCredentials(environment)).resolves.toBe(target);
      expect(existsSync(target)).toBeFalse();
      await expect(deleteLlmCredentials(environment)).resolves.toBe(target);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

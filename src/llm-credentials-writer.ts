import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { llmCredentialsPath } from "shorthand-core";
import type { LlmCredentials } from "shorthand-core";

function serializeLlmCredentials(credentials: LlmCredentials): string {
  const profile: LlmCredentials = {
    provider: credentials.provider,
    model: credentials.model,
    ...(credentials.api_key === undefined ? {} : { api_key: credentials.api_key }),
    ...(credentials.base_url === undefined ? {} : { base_url: credentials.base_url }),
  };
  return `${JSON.stringify(profile, null, 2)}\n`;
}

export async function writeLlmCredentials(
  credentials: LlmCredentials,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const target = llmCredentialsPath(environment);
  const directory = dirname(target);
  const temporary = join(directory, `.${basename(target)}.${randomUUID()}.tmp`);
  const body = serializeLlmCredentials(credentials);

  await mkdir(directory, { recursive: true });

  let temporaryCreated = false;
  let renamed = false;
  try {
    // Creating the temp file with its final mode prevents a billable key from briefly
    // inheriting a permissive umask before the explicit chmod tightens it.
    const handle = process.platform === "win32"
      ? await open(temporary, "wx")
      : await open(temporary, "wx", 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(body, "utf8");
    } finally {
      await handle.close();
    }

    if (process.platform !== "win32") await chmod(temporary, 0o600);
    await rename(temporary, target);
    renamed = true;
    return target;
  } finally {
    // A failed write must not poison the config directory with a stale secret-bearing
    // temp file that the next successful whole-file replacement cannot account for.
    if (temporaryCreated && !renamed) await rm(temporary, { force: true });
  }
}

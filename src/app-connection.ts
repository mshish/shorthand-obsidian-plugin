import { AppUnavailableError, type AppClientLike } from "shorthand-core";
import { planCredentialMigration } from "./app-credentials.js";
import type { ShorthandPluginSettings } from "./settings.js";
import type { LlmCredentials } from "shorthand-core";

/**
 * Owns the one `AppClientLike` this plugin talks to the Shorthand app through, so every
 * caller — the migration, an LLM enhancer, an ACP network transport — shares a single
 * request-socket connection instead of dialing a fresh one per call. `connect` is injected
 * (`ShorthandAppClient.connect` in production) so tests never open a real socket.
 */
export class AppConnection {
  #client: AppClientLike | undefined;
  #pending: Promise<AppClientLike> | undefined;

  constructor(private readonly connect: () => Promise<AppClientLike>) {}

  /**
   * Returns the live client, connecting only when there isn't one. Concurrent callers during
   * a connection attempt share the same in-flight promise rather than each dialing their own
   * socket. A client that closes — the app quit, or the socket dropped — is discarded via its
   * own `onClose`, so the next `ensure()` reconnects instead of handing back a dead client.
   * A failed connect (typically `AppUnavailableError`) is not cached and reaches the caller
   * unchanged, so the caller's own retry policy decides what happens next.
   */
  ensure(): Promise<AppClientLike> {
    if (this.#client !== undefined) return Promise.resolve(this.#client);
    if (this.#pending !== undefined) return this.#pending;

    const pending = this.connect().then(
      (client) => {
        this.#pending = undefined;
        this.#client = client;
        client.onClose(() => {
          // Only clear the slot if this is still the client that closed: dispose() may
          // already have replaced it with nothing by the time a stale onClose fires.
          if (this.#client === client) this.#client = undefined;
        });
        return client;
      },
      (error: unknown) => {
        this.#pending = undefined;
        throw error;
      },
    );
    this.#pending = pending;
    return pending;
  }

  /** Closes a live client and forgets it, so the next `ensure()` dials a fresh connection. */
  dispose(): void {
    this.#client?.close();
    this.#client = undefined;
    this.#pending = undefined;
  }
}

export type CredentialMigrationDeps = Readonly<{
  settings: ShorthandPluginSettings;
  vaultId: string;
  readLegacy: () => Promise<LlmCredentials | undefined>;
  deleteLegacy: () => Promise<void>;
  connection: AppConnection;
  save: (patch: Partial<ShorthandPluginSettings>) => Promise<void>;
}>;

/**
 * Performs the one-time move `planCredentialMigration` plans: every secret into the app's
 * keyring, then the legacy file gone and `appCredentialsMigrated` set, in that order — so a
 * crash or a rejected `setCredential` between the two never reports a move `data.json` did
 * not actually receive.
 *
 * `"skipped"` short-circuits before any dependency runs, `appCredentialsMigrated` being sticky
 * (see `planCredentialMigration`'s own doc comment) means there is nothing here worth reading,
 * let alone acting on. `"deferred"` is returned instead of thrown for `AppUnavailableError`
 * specifically: the app being closed is an ordinary, expected reason a capture hasn't happened
 * yet, not a bug — the caller retries next load. A plan with no secrets to set never has to
 * reach the app at all, since there is nothing there for it to do.
 */
export async function runCredentialMigration(deps: CredentialMigrationDeps): Promise<"done" | "skipped" | "deferred"> {
  if (deps.settings.appCredentialsMigrated) return "skipped";

  const legacy = await deps.readLegacy();
  const plan = planCredentialMigration(deps.settings, deps.vaultId, legacy);

  if (plan.sets.length > 0) {
    let client: AppClientLike;
    try {
      client = await deps.connection.ensure();
    } catch (error) {
      if (error instanceof AppUnavailableError) return "deferred";
      throw error;
    }
    for (const { slot, secret } of plan.sets) {
      await client.setCredential(slot, secret);
    }
  }

  await deps.deleteLegacy();
  await deps.save(plan.patch);
  return "done";
}

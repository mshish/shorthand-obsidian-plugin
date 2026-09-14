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
  /**
   * Bumped by `dispose()`. A connect attempt started before the bump checks it again once it
   * resolves, so a client that only finishes connecting after `dispose()` ran is closed
   * instead of adopted — see `ensure()`'s success handler. Not a boolean "disposed forever"
   * flag: `dispose()` is meant to be followed by a plain reconnect (the plugin's own
   * `onunload`/next `onload` is the only caller today), so a *later* `ensure()` call starts a
   * brand new attempt rather than staying permanently rejected.
   */
  #generation = 0;

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

    const generation = this.#generation;
    const pending: Promise<AppClientLike> = this.connect().then(
      (client) => {
        // Only clear the slot if it still holds this attempt's own promise: a stale attempt
        // that resolves after dispose() started a newer ensure() must not clobber that newer
        // #pending out from under it, or a later ensure() would return this attempt's already-
        // settled (and about-to-be-rejected) promise instead of the in-flight one.
        if (this.#pending === pending) this.#pending = undefined;
        if (generation !== this.#generation) {
          // dispose() bumped #generation while this connect was still in flight. Closing the
          // client and rejecting here — rather than adopting it — is what stops it leaking an
          // open socket nothing would ever close, and stops it silently overriding whatever a
          // newer ensure() has since connected instead. The caller who started this attempt
          // sees that rejection, since this `.then` handler settles their `ensure()` promise.
          client.close();
          throw new Error("The Shorthand app connection was disposed before this connect attempt finished.");
        }
        this.#client = client;
        client.onClose(() => {
          // Only clear the slot if this is still the client that closed: dispose() may
          // already have replaced it with nothing by the time a stale onClose fires.
          if (this.#client === client) this.#client = undefined;
        });
        return client;
      },
      (error: unknown) => {
        // Same guard as the success handler: don't clear a newer #pending a later ensure()
        // has since installed.
        if (this.#pending === pending) this.#pending = undefined;
        throw error;
      },
    );
    this.#pending = pending;
    return pending;
  }

  /**
   * Closes a live client and forgets it, so the next `ensure()` dials a fresh connection.
   * Also invalidates any connect attempt already in flight (see `#generation`): its caller's
   * `ensure()` promise rejects once that attempt resolves, instead of quietly handing back a
   * client this connection no longer owns.
   */
  dispose(): void {
    this.#generation += 1;
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

import { describe, expect, mock, test } from "bun:test";
import { AppUnavailableError } from "shorthand-core";
import type { AppClientLike, AppCredentialSlot, AppCredentialStatus } from "shorthand-core";
import { AppConnection, runCredentialMigration } from "../src/app-connection.js";
import { DEFAULT_PLUGIN_SETTINGS, normalizePluginSettings, type ShorthandPluginSettings } from "../src/settings.js";

function settingsWith(overrides: Partial<ShorthandPluginSettings>): ShorthandPluginSettings {
  return normalizePluginSettings({ ...DEFAULT_PLUGIN_SETTINGS, ...overrides });
}

/** A minimal, fully-typed stand-in for `ShorthandAppClient`, so tests never open a socket. */
class FakeAppClient implements AppClientLike {
  readonly appVersion = "0.5.0";
  readonly capabilities: readonly string[] = [];
  readonly setCredentialCalls: { slot: AppCredentialSlot; secret: string }[] = [];
  readonly clearCredentialCalls: AppCredentialSlot[] = [];
  closed = false;
  #closeListeners = new Set<(error?: Error) => void>();
  #setCredentialImpl: (slot: AppCredentialSlot, secret: string) => Promise<void>;

  constructor(setCredentialImpl?: (slot: AppCredentialSlot, secret: string) => Promise<void>) {
    this.#setCredentialImpl = setCredentialImpl ?? (async () => undefined);
  }

  request<T = unknown>(): Promise<T> {
    return Promise.reject(new Error("not implemented"));
  }

  startRequest<T = unknown>(): Readonly<{ id: string; result: Promise<T> }> {
    return { id: "fake", result: Promise.reject(new Error("not implemented")) };
  }

  onEvent(): () => void {
    return () => undefined;
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.#closeListeners.add(listener);
    return () => {
      this.#closeListeners.delete(listener);
    };
  }

  close(): void {
    this.closed = true;
  }

  async setCredential(slot: AppCredentialSlot, secret: string): Promise<void> {
    this.setCredentialCalls.push({ slot, secret });
    await this.#setCredentialImpl(slot, secret);
  }

  async clearCredential(slot: AppCredentialSlot): Promise<void> {
    this.clearCredentialCalls.push(slot);
  }

  credentialStatus(slots: readonly AppCredentialSlot[]): Promise<readonly AppCredentialStatus[]> {
    return Promise.resolve(slots.map(() => "missing" as const));
  }

  /** Simulates the app's process going away, or the socket closing for any other reason. */
  emitClose(error?: Error): void {
    for (const listener of [...this.#closeListeners]) listener(error);
  }
}

describe("AppConnection.ensure", () => {
  test("connects once for two calls", async () => {
    const client = new FakeAppClient();
    const connect = mock(() => Promise.resolve<AppClientLike>(client));
    const connection = new AppConnection(connect);

    const first = await connection.ensure();
    const second = await connection.ensure();

    expect(first).toBe(client);
    expect(second).toBe(client);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  test("reconnects after the live client's onClose fires", async () => {
    const first = new FakeAppClient();
    const second = new FakeAppClient();
    let attempts = 0;
    const connect = mock(() => {
      attempts += 1;
      return Promise.resolve<AppClientLike>(attempts === 1 ? first : second);
    });
    const connection = new AppConnection(connect);

    expect(await connection.ensure()).toBe(first);
    first.emitClose();
    expect(await connection.ensure()).toBe(second);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("rethrows AppUnavailableError from the underlying connect", async () => {
    const error = new AppUnavailableError("not-running", "Shorthand is not running.");
    const connect = mock(() => Promise.reject(error));
    const connection = new AppConnection(connect);

    let caught: unknown;
    try {
      await connection.ensure();
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBe(error);
  });

  test("concurrent calls before the connect settles share the same connection attempt", async () => {
    const client = new FakeAppClient();
    let resolveConnect: (client: AppClientLike) => void = () => undefined;
    const connect = mock(
      () =>
        new Promise<AppClientLike>((resolve) => {
          resolveConnect = resolve;
        }),
    );
    const connection = new AppConnection(connect);

    const firstCall = connection.ensure();
    const secondCall = connection.ensure();
    resolveConnect(client);

    expect(await firstCall).toBe(client);
    expect(await secondCall).toBe(client);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});

describe("AppConnection.dispose", () => {
  test("closes a live client and forces the next ensure() to reconnect", async () => {
    const first = new FakeAppClient();
    const second = new FakeAppClient();
    let calls = 0;
    const connect = mock(() => {
      calls += 1;
      return Promise.resolve<AppClientLike>(calls === 1 ? first : second);
    });
    const connection = new AppConnection(connect);

    expect(await connection.ensure()).toBe(first);
    connection.dispose();
    expect(await connection.ensure()).toBe(second);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("closes, rather than adopts, a client that connects after dispose() already ran", async () => {
    const late = new FakeAppClient();
    const second = new FakeAppClient();
    let attempts = 0;
    let resolveFirstConnect: (client: AppClientLike) => void = () => undefined;
    const connect = mock(() => {
      attempts += 1;
      if (attempts === 1) {
        return new Promise<AppClientLike>((resolve) => {
          resolveFirstConnect = resolve;
        });
      }
      return Promise.resolve<AppClientLike>(second);
    });
    const connection = new AppConnection(connect);

    // Started, but not yet settled, when dispose() runs.
    const firstEnsure = connection.ensure();
    connection.dispose();
    resolveFirstConnect(late);

    let caught: unknown;
    try {
      await firstEnsure;
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBeInstanceOf(Error);
    // The late client is closed instead of adopted: dispose() must not leak an open socket
    // just because its connect attempt was already on the wire when dispose() ran.
    expect(late.closed).toBe(true);

    // Documented policy: dispose() is followed by a plain reconnect, not permanent rejection —
    // the next ensure() call starts (and succeeds with) a brand new connect attempt.
    expect(await connection.ensure()).toBe(second);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("a stale connect resolving after dispose() does not clobber a newer ensure()'s pending", async () => {
    const late = new FakeAppClient();
    const second = new FakeAppClient();
    let attempts = 0;
    let resolveFirstConnect: (client: AppClientLike) => void = () => undefined;
    let resolveSecondConnect: (client: AppClientLike) => void = () => undefined;
    const connect = mock(() => {
      attempts += 1;
      if (attempts === 1) {
        return new Promise<AppClientLike>((resolve) => {
          resolveFirstConnect = resolve;
        });
      }
      return new Promise<AppClientLike>((resolve) => {
        resolveSecondConnect = resolve;
      });
    });
    const connection = new AppConnection(connect);

    const firstEnsure = connection.ensure(); // attempt #1, still in flight
    connection.dispose();
    const secondEnsure = connection.ensure(); // attempt #2, installs a new #pending

    // Attempt #1 settles late, after dispose() and after ensure() #2 is already in flight.
    resolveFirstConnect(late);
    let caught: unknown;
    try {
      await firstEnsure;
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(late.closed).toBe(true);

    // A third ensure(), issued after the stale settlement, must return attempt #2's
    // promise/client rather than dialing again: the bug this guards against cleared #pending
    // unconditionally from attempt #1's own handler, clobbering attempt #2's in-flight promise.
    const thirdEnsure = connection.ensure();
    resolveSecondConnect(second);

    expect(await secondEnsure).toBe(second);
    expect(await thirdEnsure).toBe(second);
    expect(connect).toHaveBeenCalledTimes(2);
  });
});

const vaultId = "3f9a1c2b4d5e6f70";

describe("runCredentialMigration", () => {
  test('returns "skipped" and calls nothing when appCredentialsMigrated is already true', async () => {
    const settings = settingsWith({ appCredentialsMigrated: true, acpAuthToken: "tok" });
    const save = mock(() => Promise.resolve());
    const connection = new AppConnection(() => Promise.reject(new Error("must not connect")));

    const result = await runCredentialMigration({ settings, vaultId, connection, save });

    expect(result).toBe("skipped");
    expect(save).not.toHaveBeenCalled();
  });

  test('returns "deferred" and does not save when the app is unavailable', async () => {
    const settings = settingsWith({ acpAuthToken: "tok", acpNetworkUrl: "wss://agent.example/acp" });
    const save = mock(() => Promise.resolve());
    const connection = new AppConnection(() =>
      Promise.reject(new AppUnavailableError("not-running", "Shorthand is not running.")));

    const result = await runCredentialMigration({ settings, vaultId, connection, save });

    expect(result).toBe("deferred");
    expect(save).not.toHaveBeenCalled();
  });

  test('performs setCredential before save, and returns "done"', async () => {
    const settings = settingsWith({ acpAuthToken: "tok", acpNetworkUrl: "wss://agent.example/acp" });
    const order: string[] = [];
    const client = new FakeAppClient(async () => {
      order.push("setCredential");
    });
    const save = mock(async () => {
      order.push("save");
    });
    const connection = new AppConnection(() => Promise.resolve<AppClientLike>(client));

    const result = await runCredentialMigration({ settings, vaultId, connection, save });

    expect(result).toBe("done");
    expect(client.setCredentialCalls).toHaveLength(1);
    expect(order).toEqual(["setCredential", "save"]);
  });

  test("nothing is saved when setCredential rejects", async () => {
    const settings = settingsWith({ acpAuthToken: "tok", acpNetworkUrl: "wss://agent.example/acp" });
    const client = new FakeAppClient(async () => {
      throw new Error("keyring rejected the secret");
    });
    const save = mock(() => Promise.resolve());
    const connection = new AppConnection(() => Promise.resolve<AppClientLike>(client));

    let caught: unknown;
    try {
      await runCredentialMigration({ settings, vaultId, connection, save });
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("keyring rejected the secret");
    expect(save).not.toHaveBeenCalled();
  });

  test("a plan with zero sets still saves the marker without reaching the app", async () => {
    const settings = settingsWith({});
    const save = mock((patch: Partial<ShorthandPluginSettings>) => {
      expect(patch).toEqual({ appCredentialsMigrated: true });
      return Promise.resolve();
    });
    // No connection needed: a plan with nothing to set never has to reach the app.
    const connection = new AppConnection(() => Promise.reject(new Error("must not connect")));

    const result = await runCredentialMigration({ settings, vaultId, connection, save });

    expect(result).toBe("done");
    expect(save).toHaveBeenCalledTimes(1);
  });
});

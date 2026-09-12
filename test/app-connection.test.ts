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
    // No real socket to tear down.
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

    await expect(connection.ensure()).rejects.toBe(error);
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
});

const vaultId = "3f9a1c2b4d5e6f70";

describe("runCredentialMigration", () => {
  test('returns "skipped" and calls nothing when appCredentialsMigrated is already true', async () => {
    const settings = settingsWith({ appCredentialsMigrated: true });
    const readLegacy = mock(() => Promise.resolve(undefined));
    const deleteLegacy = mock(() => Promise.resolve());
    const save = mock(() => Promise.resolve());
    const connection = new AppConnection(() => Promise.reject(new Error("must not connect")));

    const result = await runCredentialMigration({ settings, vaultId, readLegacy, deleteLegacy, connection, save });

    expect(result).toBe("skipped");
    expect(readLegacy).not.toHaveBeenCalled();
    expect(deleteLegacy).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  test('returns "deferred" and calls neither deleteLegacy nor save when the app is unavailable', async () => {
    const settings = settingsWith({});
    const readLegacy = mock(() => Promise.resolve({ provider: "openai" as const, model: "gpt-5", api_key: "sk-test" }));
    const deleteLegacy = mock(() => Promise.resolve());
    const save = mock(() => Promise.resolve());
    const connection = new AppConnection(() =>
      Promise.reject(new AppUnavailableError("not-running", "Shorthand is not running.")));

    const result = await runCredentialMigration({ settings, vaultId, readLegacy, deleteLegacy, connection, save });

    expect(result).toBe("deferred");
    expect(deleteLegacy).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  test('performs every setCredential before deleteLegacy and save, and returns "done"', async () => {
    const settings = settingsWith({
      llmProvider: "openai",
      llmModel: "gpt-5",
      acpAuthToken: "tok",
      acpNetworkUrl: "wss://agent.example/acp",
    });
    const readLegacy = mock(() =>
      Promise.resolve({ provider: "openai" as const, model: "gpt-5", api_key: "sk-test" }));
    const order: string[] = [];
    const client = new FakeAppClient(async () => {
      order.push("setCredential");
    });
    const deleteLegacy = mock(async () => {
      order.push("deleteLegacy");
    });
    const save = mock(async () => {
      order.push("save");
    });
    const connection = new AppConnection(() => Promise.resolve<AppClientLike>(client));

    const result = await runCredentialMigration({ settings, vaultId, readLegacy, deleteLegacy, connection, save });

    expect(result).toBe("done");
    expect(client.setCredentialCalls).toHaveLength(2);
    expect(order).toEqual(["setCredential", "setCredential", "deleteLegacy", "save"]);
  });

  test("nothing is deleted or saved when the second setCredential rejects", async () => {
    const settings = settingsWith({
      llmProvider: "openai",
      llmModel: "gpt-5",
      acpAuthToken: "tok",
      acpNetworkUrl: "wss://agent.example/acp",
    });
    const readLegacy = mock(() =>
      Promise.resolve({ provider: "openai" as const, model: "gpt-5", api_key: "sk-test" }));
    let calls = 0;
    const client = new FakeAppClient(async () => {
      calls += 1;
      if (calls === 2) throw new Error("keyring rejected the secret");
    });
    const deleteLegacy = mock(() => Promise.resolve());
    const save = mock(() => Promise.resolve());
    const connection = new AppConnection(() => Promise.resolve<AppClientLike>(client));

    await expect(
      runCredentialMigration({ settings, vaultId, readLegacy, deleteLegacy, connection, save }),
    ).rejects.toThrow("keyring rejected the secret");

    expect(deleteLegacy).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  test("a plan with zero sets still saves the marker and deletes a legacy file with no key", async () => {
    const settings = settingsWith({});
    const readLegacy = mock(() => Promise.resolve({ provider: "anthropic" as const, model: "claude-opus-4-6" }));
    const deleteLegacy = mock(() => Promise.resolve());
    const save = mock((patch: Partial<ShorthandPluginSettings>) => {
      expect(patch).toEqual({
        llmProvider: "anthropic",
        llmModel: "claude-opus-4-6",
        llmBaseUrl: "",
        appCredentialsMigrated: true,
      });
      return Promise.resolve();
    });
    // No connection needed: a plan with nothing to set never has to reach the app.
    const connection = new AppConnection(() => Promise.reject(new Error("must not connect")));

    const result = await runCredentialMigration({ settings, vaultId, readLegacy, deleteLegacy, connection, save });

    expect(result).toBe("done");
    expect(deleteLegacy).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

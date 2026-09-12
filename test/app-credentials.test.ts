import { describe, expect, test } from "bun:test";
import { AppUnavailableError } from "shorthand-core";
import { DEFAULT_PLUGIN_SETTINGS, normalizePluginSettings, type ShorthandPluginSettings } from "../src/settings.js";
import {
  APP_NOT_RUNNING_MESSAGE,
  APP_TOO_OLD_MESSAGE,
  acpSlot,
  appUnavailableMessage,
  llmSlot,
  planCredentialMigration,
  vaultIdFor,
} from "../src/app-credentials.js";

function settingsWith(overrides: Partial<ShorthandPluginSettings>): ShorthandPluginSettings {
  return normalizePluginSettings({ ...DEFAULT_PLUGIN_SETTINGS, ...overrides });
}

describe("vaultIdFor", () => {
  test("is deterministic for the same vault path", () => {
    expect(vaultIdFor("C:/Users/mike/vault")).toBe(vaultIdFor("C:/Users/mike/vault"));
  });

  test("is 16 lower-case hex characters", () => {
    expect(vaultIdFor("C:/Users/mike/vault")).toMatch(/^[0-9a-f]{16}$/);
  });

  test("differs for a different vault path", () => {
    expect(vaultIdFor("C:/Users/mike/vault-a")).not.toBe(vaultIdFor("C:/Users/mike/vault-b"));
  });
});

describe("llmSlot", () => {
  test("is undefined when no provider is chosen", () => {
    expect(llmSlot(settingsWith({ llmProvider: "" }))).toBeUndefined();
  });

  // openai's default endpoint is fixed by the SDK, so a blank base URL is a working state,
  // not a missing one — this is the `origin` a request with no override actually hits.
  test("openai with a blank base URL derives its fixed default origin", () => {
    expect(llmSlot(settingsWith({ llmProvider: "openai", llmModel: "gpt-5", llmBaseUrl: "" }))).toEqual({
      kind: "notes-llm",
      provider: "openai",
      origin: "https://api.openai.com",
    });
  });

  test("an explicit base URL overrides the default origin", () => {
    expect(
      llmSlot(settingsWith({ llmProvider: "openai", llmModel: "gpt-5", llmBaseUrl: "https://gateway.example/v1" })),
    ).toEqual({
      kind: "notes-llm",
      provider: "openai",
      origin: "https://gateway.example",
    });
  });

  // Ollama's default origin is local: the same "blank base URL still resolves" rule as
  // openai, just pointed at core's local-endpoint constant instead of a public API.
  test("ollama with a blank base URL derives core's local default origin", () => {
    expect(llmSlot(settingsWith({ llmProvider: "ollama", llmModel: "llama3" }))).toEqual({
      kind: "notes-llm",
      provider: "ollama",
      origin: "http://127.0.0.1:11434",
    });
  });

  // openai-compatible names no endpoint of its own; core's llmEndpointOrigin throws rather
  // than guess one, and that throw is exactly what must not escape as an unhandled error.
  test("is undefined when openai-compatible has no base URL to derive an origin from", () => {
    expect(llmSlot(settingsWith({ llmProvider: "openai-compatible", llmModel: "local-model", llmBaseUrl: "" })))
      .toBeUndefined();
  });

  test("openai-compatible with a base URL derives that origin", () => {
    expect(
      llmSlot(settingsWith({
        llmProvider: "openai-compatible",
        llmModel: "local-model",
        llmBaseUrl: "http://localhost:8080/v1",
      })),
    ).toEqual({
      kind: "notes-llm",
      provider: "openai-compatible",
      origin: "http://localhost:8080",
    });
  });
});

describe("acpSlot", () => {
  const vaultId = "3f9a1c2b4d5e6f70";

  test("derives the origin from the ACP network URL, dropping the path", () => {
    expect(acpSlot(vaultId, "wss://agent.example/acp")).toEqual({
      kind: "notes-acp",
      vaultId,
      origin: "wss://agent.example",
    });
  });

  test("is undefined for a blank network URL", () => {
    expect(acpSlot(vaultId, "")).toBeUndefined();
    expect(acpSlot(vaultId, "   ")).toBeUndefined();
  });

  test("is undefined for an unparseable network URL", () => {
    expect(acpSlot(vaultId, "not a url")).toBeUndefined();
  });
});

describe("planCredentialMigration", () => {
  const vaultId = "3f9a1c2b4d5e6f70";

  test("moves both a legacy LLM key and the stored ACP token into slots", () => {
    const settings = settingsWith({ acpAuthToken: "tok", acpNetworkUrl: "wss://agent.example/acp" });
    const plan = planCredentialMigration(settings, vaultId, {
      provider: "openai",
      model: "gpt-5",
      api_key: "sk-test",
    });
    expect(plan.sets).toHaveLength(2);
    expect(plan.sets).toContainEqual({
      slot: { kind: "notes-llm", provider: "openai", origin: "https://api.openai.com" },
      secret: "sk-test",
    });
    expect(plan.sets).toContainEqual({
      slot: { kind: "notes-acp", vaultId, origin: "wss://agent.example" },
      secret: "tok",
    });
    expect(plan.patch).toEqual({
      llmProvider: "openai",
      llmModel: "gpt-5",
      llmBaseUrl: "",
      acpAuthToken: "",
      appCredentialsMigrated: true,
    });
  });

  test("with no legacy file and a blank ACP token, plans nothing but marks migration done", () => {
    const settings = settingsWith({});
    const plan = planCredentialMigration(settings, vaultId, undefined);
    expect(plan.sets).toEqual([]);
    expect(plan.patch).toEqual({ appCredentialsMigrated: true });
  });

  // A legacy file with no key still names a provider and model worth keeping; there is
  // simply no secret to move, since the user (or a prior partial migration) already cleared it.
  test("copies provider and model from a legacy file with no api_key, but sets nothing", () => {
    const settings = settingsWith({});
    const plan = planCredentialMigration(settings, vaultId, { provider: "anthropic", model: "claude-opus-4-6" });
    expect(plan.sets).toEqual([]);
    expect(plan.patch).toEqual({
      llmProvider: "anthropic",
      llmModel: "claude-opus-4-6",
      llmBaseUrl: "",
      appCredentialsMigrated: true,
    });
  });

  // The load-bearing property: a user who has already configured the new fields must win
  // over a legacy file that may be stale, or name a different provider entirely.
  test("does not overwrite an already-chosen provider with the legacy file's", () => {
    const settings = settingsWith({ llmProvider: "openai", llmModel: "gpt-5" });
    const plan = planCredentialMigration(settings, vaultId, { provider: "anthropic", model: "claude-opus-4-6" });
    expect(plan.patch).not.toHaveProperty("llmProvider");
    expect(plan.patch).not.toHaveProperty("llmModel");
    expect(plan.patch).not.toHaveProperty("llmBaseUrl");
    expect(plan.patch).toEqual({ appCredentialsMigrated: true });
  });

  // The failure a missing provider check would produce: settings is already on anthropic
  // (with its own correct secret already in the keyring), and a stale llm-credentials.json
  // still holds an openai key. Migrating that key into the anthropic slot would silently
  // overwrite the real anthropic secret with the wrong provider's key.
  test("does not migrate a legacy api_key whose provider does not match the settings already chosen", () => {
    const settings = settingsWith({ llmProvider: "anthropic", llmModel: "claude-opus-4-6" });
    const plan = planCredentialMigration(settings, vaultId, {
      provider: "openai",
      model: "gpt-5",
      api_key: "sk-test",
    });
    expect(plan.sets).toEqual([]);
  });

  // Sticky per settings.ts's doc comment on appCredentialsMigrated: once migration has run,
  // re-running it must not look like a legacy secret reappearing from nowhere.
  test("plans nothing once migration has already run", () => {
    const settings = settingsWith({ appCredentialsMigrated: true, acpAuthToken: "tok" });
    const plan = planCredentialMigration(settings, vaultId, {
      provider: "openai",
      model: "gpt-5",
      api_key: "sk-test",
    });
    expect(plan).toEqual({ sets: [], patch: {} });
  });
});

describe("appUnavailableMessage", () => {
  test("maps a too-old app to the fixed upgrade message", () => {
    expect(appUnavailableMessage(new AppUnavailableError("too-old", "Shorthand 0.4.0 speaks protocol 0."))).toBe(
      APP_TOO_OLD_MESSAGE,
    );
  });

  test("maps a not-running app to the fixed launch message", () => {
    expect(appUnavailableMessage(new AppUnavailableError("not-running", "no request socket published"))).toBe(
      APP_NOT_RUNNING_MESSAGE,
    );
  });

  // "protocol" means the app is NEWER than this plugin build understands — the opposite
  // direction from "too-old" — so there is no fixed "update Shorthand" string for it; core's
  // own message already names both versions, and surfacing it beats inventing a vaguer one.
  test("surfaces core's own message for a protocol mismatch", () => {
    const error = new AppUnavailableError("protocol", "Shorthand 0.9.0 speaks protocol 2, newer than protocol 1.");
    expect(appUnavailableMessage(error)).toBe(error.message);
  });

  test("is undefined for an error that has nothing to do with app availability", () => {
    expect(appUnavailableMessage(new Error("boom"))).toBeUndefined();
    expect(appUnavailableMessage("boom")).toBeUndefined();
    expect(appUnavailableMessage(undefined)).toBeUndefined();
  });
});

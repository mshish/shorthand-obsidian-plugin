import { describe, expect, test } from "bun:test";
import { AppUnavailableError } from "shorthand-core";
import { credentialRowDescription, credentialRowState, type CredentialRowOutcome } from "../src/credential-row.js";

describe("credentialRowDescription", () => {
  test("loading names what the row is waiting on", () => {
    expect(credentialRowDescription({ kind: "loading" }, "openai")).toBe("Checking the Shorthand app…");
  });

  test("a status outcome delegates to apiKeyDescription", () => {
    expect(credentialRowDescription({ kind: "status", status: "configured" }, "openai"))
      .toBe("A key is saved in the Shorthand app — leave this blank to keep it, or use Clear key to remove it.");
    expect(credentialRowDescription({ kind: "status", status: "missing" }, "openai")).toBe("No key is saved.");
    expect(credentialRowDescription({ kind: "status", status: "unavailable" }, "openai"))
      .toBe("Secure storage is unavailable on this device.");
  });

  test("an app-unavailable error surfaces the app's own message", () => {
    const error = new AppUnavailableError("not-running", "Shorthand is not running: it has published no request socket.");
    expect(credentialRowDescription({ kind: "error", error }, "openai")).toBe("Open Shorthand to use AI enhancement.");
  });

  test("an error unrelated to app availability still gets a description, not an empty string", () => {
    expect(credentialRowDescription({ kind: "error", error: new Error("socket reset") }, "openai"))
      .toBe("The Shorthand app could not be reached.");
  });

  test("ollama needs no key regardless of outcome", () => {
    const outcomes: readonly CredentialRowOutcome[] = [
      { kind: "loading" },
      { kind: "status", status: "configured" },
      { kind: "status", status: "missing" },
      { kind: "error", error: new Error("boom") },
    ];
    for (const outcome of outcomes) {
      expect(credentialRowDescription(outcome, "ollama")).toBe("No API key is needed for local Ollama.");
    }
  });
});

describe("credentialRowState", () => {
  test("loading disables both the field and the Clear key button", () => {
    const state = credentialRowState({ kind: "loading" }, "openai");
    expect(state.fieldsDisabled).toBe(true);
    expect(state.clearDisabled).toBe(true);
  });

  test("an error disables both, the same as loading", () => {
    const state = credentialRowState({ kind: "error", error: new Error("boom") }, "openai");
    expect(state.fieldsDisabled).toBe(true);
    expect(state.clearDisabled).toBe(true);
  });

  test("configured enables the field and the Clear key button", () => {
    const state = credentialRowState({ kind: "status", status: "configured" }, "openai");
    expect(state.fieldsDisabled).toBe(false);
    expect(state.clearDisabled).toBe(false);
  });

  test("missing enables the field but not Clear key: there is nothing yet to remove", () => {
    const state = credentialRowState({ kind: "status", status: "missing" }, "openai");
    expect(state.fieldsDisabled).toBe(false);
    expect(state.clearDisabled).toBe(true);
  });

  test("unavailable disables both: a setCredential call would only fail", () => {
    const state = credentialRowState({ kind: "status", status: "unavailable" }, "openai");
    expect(state.fieldsDisabled).toBe(true);
    expect(state.clearDisabled).toBe(true);
  });

  test("every state carries the same description credentialRowDescription would produce", () => {
    const outcome: CredentialRowOutcome = { kind: "status", status: "missing" };
    expect(credentialRowState(outcome, "anthropic").description).toBe(credentialRowDescription(outcome, "anthropic"));
  });
});

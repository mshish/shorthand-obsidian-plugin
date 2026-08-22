import { describe, expect, test } from "bun:test";
import {
  EMPTY_LLM_PROFILE_DRAFT,
  isCompleteLlmProfileDraft,
  missingLlmProfileFields,
  resolveLlmProfileReadState,
  validateLlmProfileDraft,
  type LlmProfileDraft,
} from "../src/llm-profile-draft.js";

function draft(overrides: Partial<LlmProfileDraft> = {}): LlmProfileDraft {
  return {
    provider: "openai",
    model: "gpt-5",
    api_key: "key",
    base_url: "",
    ...overrides,
  };
}

describe("LLM profile draft rules", () => {
  test("accepts each provider when its required fields are present", () => {
    expect(isCompleteLlmProfileDraft(draft({ provider: "openai" }))).toBeTrue();
    expect(isCompleteLlmProfileDraft(draft({ provider: "anthropic", model: "claude-opus-4-1" }))).toBeTrue();
    expect(isCompleteLlmProfileDraft(draft({
      provider: "openai-compatible",
      model: "llama3.2",
      base_url: "http://localhost:11434/v1",
    }))).toBeTrue();
  });

  test("names an absent provider and model", () => {
    const incomplete = draft({ provider: "", model: "" });
    expect(isCompleteLlmProfileDraft(incomplete)).toBeFalse();
    expect(missingLlmProfileFields(incomplete)).toEqual(["provider", "model"]);
  });

  test("rejects a whitespace-only model", () => {
    expect(missingLlmProfileFields(draft({ model: " \t\n" }))).toEqual(["model"]);
  });

  test("requires a base URL only for openai-compatible", () => {
    expect(missingLlmProfileFields(draft({
      provider: "openai-compatible",
      base_url: "  ",
    }))).toEqual(["base URL"]);
    expect(missingLlmProfileFields(draft({ provider: "openai", base_url: "" }))).toEqual([]);
    expect(missingLlmProfileFields(draft({ provider: "anthropic", base_url: "" }))).toEqual([]);
  });

  test("accepts a keyless profile", () => {
    expect(isCompleteLlmProfileDraft(draft({ api_key: "" }))).toBeTrue();
    expect(isCompleteLlmProfileDraft(draft({
      provider: "openai-compatible",
      api_key: "",
      base_url: "http://localhost:11434/v1",
    }))).toBeTrue();
  });

  test("turns a complete draft into the exact whole profile the writer accepts", () => {
    expect(validateLlmProfileDraft(draft({
      model: "  gpt-5  ",
      api_key: "secret",
      base_url: "  https://example.test/v1  ",
    }))).toEqual({
      ok: true,
      credentials: {
        provider: "openai",
        model: "gpt-5",
        api_key: "secret",
        base_url: "https://example.test/v1",
      },
    });
  });

  test("omits cleared optional fields instead of assigning undefined", () => {
    expect(validateLlmProfileDraft(draft({ api_key: "", base_url: "" }))).toEqual({
      ok: true,
      credentials: { provider: "openai", model: "gpt-5" },
    });
  });

  test("returns the missing fields instead of producing an invalid profile", () => {
    expect(validateLlmProfileDraft(draft({ provider: "", model: "" }))).toEqual({
      ok: false,
      missing: ["provider", "model"],
    });
  });
});

describe("LLM profile reader states", () => {
  test("hydrates an existing profile and reports whether it carries a key", () => {
    expect(resolveLlmProfileReadState({
      ok: true,
      value: { provider: "anthropic", model: "claude-opus-4-1", api_key: "secret" },
    }, true)).toEqual({
      status: "ok",
      draft: {
        provider: "anthropic",
        model: "claude-opus-4-1",
        api_key: "secret",
        base_url: "",
      },
      hasStoredKey: true,
    });

    expect(resolveLlmProfileReadState({
      ok: true,
      value: { provider: "openai", model: "gpt-5" },
    }, true)).toMatchObject({ status: "ok", hasStoredKey: false });
  });

  test("treats an absent file as an empty first-run form", () => {
    expect(resolveLlmProfileReadState({ ok: false, message: "missing" }, false)).toEqual({
      status: "missing",
      draft: EMPTY_LLM_PROFILE_DRAFT,
      hasStoredKey: false,
    });
  });

  test("preserves a malformed reader message when the file exists", () => {
    expect(resolveLlmProfileReadState({ ok: false, message: "bad JSON" }, true)).toEqual({
      status: "malformed",
      message: "bad JSON",
    });
  });

});

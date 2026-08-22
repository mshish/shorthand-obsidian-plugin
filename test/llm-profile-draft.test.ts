import { describe, expect, test } from "bun:test";
import {
  isCompleteLlmProfileDraft,
  missingLlmProfileFields,
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
});

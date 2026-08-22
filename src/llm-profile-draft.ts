import type { LlmProviderId } from "shorthand-core";

export type LlmProfileDraft = Readonly<{
  provider: LlmProviderId | "";
  model: string;
  api_key: string;
  base_url: string;
}>;

export type MissingLlmProfileField = "provider" | "model" | "base URL";

export function missingLlmProfileFields(
  draft: LlmProfileDraft,
): readonly MissingLlmProfileField[] {
  const missing: MissingLlmProfileField[] = [];
  if (draft.provider === "") missing.push("provider");
  if (draft.model.trim().length === 0) missing.push("model");
  if (draft.provider === "openai-compatible" && draft.base_url.trim().length === 0) {
    missing.push("base URL");
  }
  return missing;
}

export function isCompleteLlmProfileDraft(draft: LlmProfileDraft): boolean {
  return missingLlmProfileFields(draft).length === 0;
}

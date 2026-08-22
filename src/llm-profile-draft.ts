import type {
  LlmCredentials,
  LlmCredentialsReadResult,
  LlmProviderId,
} from "shorthand-core";

export type LlmProfileDraft = Readonly<{
  provider: LlmProviderId | "";
  model: string;
  api_key: string;
  base_url: string;
}>;

export type MissingLlmProfileField = "provider" | "model" | "base URL";

export type LlmProfileDraftValidation =
  | Readonly<{ ok: true; credentials: LlmCredentials }>
  | Readonly<{ ok: false; missing: readonly MissingLlmProfileField[] }>;

export type LlmProfileReadState =
  | Readonly<{ status: "ok"; draft: LlmProfileDraft; hasStoredKey: boolean }>
  | Readonly<{ status: "missing"; draft: LlmProfileDraft; hasStoredKey: false }>
  | Readonly<{ status: "malformed"; message: string }>;

export const EMPTY_LLM_PROFILE_DRAFT: LlmProfileDraft = {
  provider: "",
  model: "",
  api_key: "",
  base_url: "",
};

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

export function validateLlmProfileDraft(
  draft: LlmProfileDraft,
): LlmProfileDraftValidation {
  const missing = missingLlmProfileFields(draft);
  if (missing.length > 0) return { ok: false, missing };
  const apiKey = draft.api_key.trim().length === 0 ? undefined : draft.api_key;

  return {
    ok: true,
    credentials: {
      provider: draft.provider as LlmProviderId,
      model: draft.model.trim(),
      ...(apiKey === undefined ? {} : { api_key: apiKey }),
      ...(draft.base_url.trim().length === 0 ? {} : { base_url: draft.base_url.trim() }),
    },
  };
}

export function resolveLlmProfileReadState(
  result: LlmCredentialsReadResult,
  credentialsFileExists: boolean,
): LlmProfileReadState {
  if (!result.ok) {
    return credentialsFileExists
      ? { status: "malformed", message: result.message }
      : { status: "missing", draft: EMPTY_LLM_PROFILE_DRAFT, hasStoredKey: false };
  }

  const storedApiKey = result.value.api_key !== undefined &&
    result.value.api_key.trim().length > 0
    ? result.value.api_key
    : "";

  return {
    status: "ok",
    draft: {
      provider: result.value.provider,
      model: result.value.model,
      api_key: storedApiKey,
      base_url: result.value.base_url ?? "",
    },
    hasStoredKey: storedApiKey.length > 0,
  };
}

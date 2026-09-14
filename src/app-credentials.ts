import { createHash } from "node:crypto";
import {
  AppUnavailableError,
  llmEndpointOrigin,
  type AppCredentialSlot,
  type LlmCredentials,
  type LlmProfile,
} from "shorthand-core";
import type { ShorthandPluginSettings } from "./settings.js";

/**
 * Identifies one vault to the Shorthand app's keyring, without ever sending the vault's
 * real filesystem path over the request socket: a path can contain a Windows username or a
 * OneDrive-synced folder name, neither of which belongs in a credential's service string.
 * Truncated to 16 hex characters — enough to make a same-machine collision practically
 * impossible for the small number of vaults one user opens, and short enough to read back
 * in a keyring inspector without wrapping.
 */
export function vaultIdFor(basePath: string): string {
  return createHash("sha256").update(basePath).digest("hex").slice(0, 16);
}

/**
 * The slot a `notes-llm` credential belongs under, or `undefined` when there is not enough
 * settings to derive one: no provider chosen yet, or `openai-compatible` with no base URL to
 * name an endpoint. `llmEndpointOrigin` is core's own derivation — reused rather than
 * re-implemented here, because the app authorises a request by comparing its URL's origin
 * against this slot's `origin`, and two separate implementations of "the origin of a
 * provider" would drift into rejecting every call as a mismatch.
 */
export function llmSlot(settings: ShorthandPluginSettings): AppCredentialSlot | undefined {
  if (settings.llmProvider === "") return undefined;
  const profile: LlmProfile = {
    provider: settings.llmProvider,
    model: settings.llmModel,
    ...(settings.llmBaseUrl.length > 0 ? { base_url: settings.llmBaseUrl } : {}),
  };
  let origin: string;
  try {
    origin = llmEndpointOrigin(profile);
  } catch {
    // openai-compatible with no base URL, or a base URL that is not an absolute http(s) URL:
    // core throws rather than guess an endpoint, and there is no slot to register a
    // credential under until the user supplies one that resolves.
    return undefined;
  }
  return { kind: "notes-llm", provider: settings.llmProvider, origin };
}

/**
 * The slot a `notes-acp` credential belongs under, or `undefined` for a blank or unparseable
 * network URL. Derived with `URL.origin` directly rather than through `llmEndpointOrigin`:
 * that helper is scoped to the LLM providers' http(s) endpoints and rejects `ws`/`wss`, which
 * is exactly the scheme every ACP network URL uses.
 */
export function acpSlot(vaultId: string, acpNetworkUrl: string): AppCredentialSlot | undefined {
  const trimmed = acpNetworkUrl.trim();
  if (trimmed.length === 0) return undefined;
  let origin: string;
  try {
    origin = new URL(trimmed).origin;
  } catch {
    return undefined;
  }
  // "null" is what URL.origin gives a scheme with no real origin (e.g. a relative or
  // opaque-path URL that still parsed). A slot naming it would authorise nothing the app
  // could ever match a request's origin against.
  if (origin === "null") return undefined;
  return { kind: "notes-acp", vaultId, origin };
}

export type MigrationPlan = Readonly<{
  sets: readonly { slot: AppCredentialSlot; secret: string }[];
  patch: Partial<ShorthandPluginSettings>;
}>;

/**
 * Plans the one-time move of secrets out of `data.json` and the legacy
 * `llm-credentials.json` file into the Shorthand app's keyring. Returns a plan rather than
 * performing the move itself, because setting a credential is a request-socket call — I/O
 * that belongs in `main.ts` wiring, not in a rule `bun test` can reach; this function is the
 * part of that rule worth testing without a socket.
 *
 * Settings the user already has on the new fields outrank the legacy file: a user who has
 * already chosen a provider (by hand, or from an earlier partial migration) must not have it
 * silently replaced by whatever an old `llm-credentials.json` still names.
 */
export function planCredentialMigration(
  settings: ShorthandPluginSettings,
  vaultId: string,
  legacy: LlmCredentials | undefined,
): MigrationPlan {
  // Sticky per settings.ts's own doc comment on appCredentialsMigrated: re-running after the
  // user has since cleared a field (e.g. blanked llmProvider back out) must not look like a
  // legacy secret reappearing from nowhere.
  if (settings.appCredentialsMigrated) return { sets: [], patch: {} };

  const sets: { slot: AppCredentialSlot; secret: string }[] = [];
  // `Partial<ShorthandPluginSettings>` keeps every field's `readonly` modifier — correct for
  // the type this function *returns*, since a caller has no business mutating a settings
  // patch, but wrong for building one incrementally. `-readonly` here is local to that build
  // step; `MigrationPlan.patch` stays the read-only type callers see.
  const patch: { -readonly [K in keyof ShorthandPluginSettings]?: ShorthandPluginSettings[K] } = {
    appCredentialsMigrated: true,
  };

  // Built from whichever provider/model/base URL the migration is about to leave in place —
  // the settings the user already chose when present, the legacy file's when they were
  // blank — so a secret this function moves lands in the slot the profile that will
  // actually make requests uses, once the patch below is applied.
  let profileSettings = settings;

  if (settings.llmProvider === "" && legacy !== undefined) {
    patch.llmProvider = legacy.provider;
    patch.llmModel = legacy.model;
    patch.llmBaseUrl = legacy.base_url ?? "";
    profileSettings = { ...settings, llmProvider: legacy.provider, llmModel: legacy.model, llmBaseUrl: legacy.base_url ?? "" };
  }

  // Guarded on the legacy file naming the SAME provider profileSettings is about to use: when
  // settings already has its own provider chosen, profileSettings keeps it rather than the
  // legacy file's, and pushing the legacy key there anyway would write one provider's secret
  // into another provider's slot — silently overwriting whatever correct secret is already
  // in the keyring for it.
  if (legacy?.api_key !== undefined && legacy.api_key.length > 0 && legacy.provider === profileSettings.llmProvider) {
    const slot = llmSlot(profileSettings);
    if (slot !== undefined) sets.push({ slot, secret: legacy.api_key });
  }

  const acpToken = settings.acpAuthToken.trim();
  if (acpToken.length > 0) {
    const slot = acpSlot(vaultId, settings.acpNetworkUrl);
    if (slot !== undefined) sets.push({ slot, secret: acpToken });
    // Cleared whether or not a slot could be derived: a token with no resolvable ACP network
    // URL is not a secret this migration can place anywhere, but it is still not a secret
    // `data.json` should keep holding in plain text going forward.
    patch.acpAuthToken = "";
  }

  return { sets, patch };
}

export const APP_TOO_OLD_MESSAGE = "Update Shorthand to 0.5.0 or newer.";
export const APP_NOT_RUNNING_MESSAGE = "Open Shorthand to use AI enhancement.";

/**
 * The user-facing text for an `AppUnavailableError`, or `undefined` for any other error —
 * callers fall back to their own generic handling in that case. `not-running` and `too-old`
 * get fixed, actionable copy; `protocol` (the app is *newer* than this plugin build
 * understands — the opposite direction from `too-old`) has no fixed string here, because
 * core's own message already names both versions and a plugin update is what actually fixes
 * it, not anything about Shorthand.
 */
export function appUnavailableMessage(error: unknown): string | undefined {
  if (!(error instanceof AppUnavailableError)) return undefined;
  switch (error.reason) {
    case "too-old":
      return APP_TOO_OLD_MESSAGE;
    case "not-running":
      return APP_NOT_RUNNING_MESSAGE;
    case "protocol":
      return error.message;
  }
}

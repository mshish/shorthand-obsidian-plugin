import type { AppCredentialStatus, LlmProviderId } from "shorthand-core";
import { appUnavailableMessage } from "./app-credentials.js";
import { apiKeyDescription } from "./settings-display.js";

/**
 * What the imperative "API key" row (`main.ts`'s `credentialKeyRow`) has learned about its
 * slot, from the point of view of deciding what to show and whether to let the user type.
 * `loading` is the state between the row's `render` firing and `credentialStatus` answering —
 * both `AppConnection.ensure()` and the status call itself can take a moment, and the row must
 * not look editable while either is still in flight. `error` covers both: `ensure()` throwing
 * (almost always `AppUnavailableError`) and `credentialStatus` itself rejecting.
 */
export type CredentialRowOutcome =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "status"; status: AppCredentialStatus }>
  | Readonly<{ kind: "error"; error: unknown }>;

/**
 * The row's description text for one outcome. Split out from `credentialRowState` so a caller
 * that only needs the sentence — none exists yet, but `decideModelRow`/`applyCatalogDecision`
 * next door split the same way — never has to unpack the rest of the decision to get it.
 */
export function credentialRowDescription(outcome: CredentialRowOutcome, provider: LlmProviderId | ""): string {
  // Fixed regardless of outcome, and checked before it: ollama needs no key at all, so the
  // row must not flash "Checking the Shorthand app…" while a fetch nothing depends on is
  // still in flight, only to replace it with this same sentence once it resolves.
  if (provider === "ollama") return apiKeyDescription("missing", provider);
  switch (outcome.kind) {
    case "loading":
      return "Checking the Shorthand app…";
    case "error":
      return apiKeyDescription(
        { appUnavailable: appUnavailableMessage(outcome.error) ?? "The Shorthand app could not be reached." },
        provider,
      );
    case "status":
      return apiKeyDescription(outcome.status, provider);
  }
}

/** What the row's description, key field, and Clear key button should show right now. */
export type CredentialRowState = Readonly<{
  description: string;
  fieldsDisabled: boolean;
  clearDisabled: boolean;
}>;

/**
 * The full decision for the row, the same shape `decideModelRow`/`decideEffortRow` in
 * `settings-display.ts` return for a catalog dropdown: everything `main.ts`'s thin DOM apply
 * needs, and nothing it has to decide for itself.
 *
 * Both controls stay disabled until a real status comes back — there is nothing yet to type
 * over or clear, and typing into a field the app has not confirmed exists yet could commit a
 * key to the wrong slot if the provider changes before the fetch resolves. `unavailable` (the
 * OS keyring itself, not the app) disables the same way: a `setCredential` call would only
 * fail. Clear key additionally stays disabled for `missing`, since there is no key in the
 * app's keyring for it to remove.
 */
export function credentialRowState(outcome: CredentialRowOutcome, provider: LlmProviderId | ""): CredentialRowState {
  const description = credentialRowDescription(outcome, provider);
  if (outcome.kind !== "status" || outcome.status === "unavailable") {
    return { description, fieldsDisabled: true, clearDisabled: true };
  }
  return { description, fieldsDisabled: false, clearDisabled: outcome.status !== "configured" };
}

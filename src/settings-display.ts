import type { AgentCatalog, CatalogFailureReason } from "shorthand-core";

/**
 * Every settings-tab string computed from a stored value, plus the handful of decisions
 * (which options a dropdown offers, which one is selected, whether the row is disabled) that
 * choose among them — and nothing else.
 *
 * These live here rather than beside their `Setting` in `main.ts` because
 * `node_modules/obsidian` has `"main": ""` and ships only type declarations, so nothing in
 * `main.ts` can be imported under `bun test`. A string — or a decision — built there is one
 * with no test.
 *
 * See `docs/settings-copy-style.md` § rule 4 for when a row shows its value instead of
 * describing itself, and § rule 2 for why several of these return `""`.
 */

/** The two backends the model/effort catalog rows exist for, exactly as a user reads them. */
export type AgentBackendLabel = "Claude" | "Codex" | "ACP";

/**
 * Shown on the model and effort rows while `listClaudeModels`/`listCodexModels` is in flight.
 * Both probes spawn a subprocess and take up to a couple of seconds even on a warm machine —
 * see `CATALOG_TIMEOUT_MS`'s doc comment in core — so a picker with no interim state here would
 * look broken rather than merely slow.
 */
export function catalogLoadingDescription(): string {
  return "Loading available models…";
}

/**
 * The catalog fetch itself failed — as opposed to succeeding with `signedIn: false`, which is
 * not a failure and gets its own row (the sign-in prompt) rather than this one. Keyed off
 * `CatalogFailureReason` rather than the caught error's own message: catalog.ts's contract is
 * that a consumer reacts to `reason`, not to prose that could change between core releases.
 * Out of scope for the nine copy rules (see docs/settings-copy-style.md's "Deviations" § 5) the
 * same way a save failure is, so this names the backend and the reason in whatever length that
 * takes rather than being held to one sentence. All four branches still name Shorthand as the
 * actor and the backend as what failed, so the voice is consistent across the switch even
 * though § 5 does not require that.
 */
export function catalogFetchFailedDescription(backend: AgentBackendLabel, reason: CatalogFailureReason): string {
  switch (reason) {
    case "executable-not-found":
      return `Shorthand could not find ${backend}. Install it, or set its path under Advanced.`;
    case "spawn-failed":
      return `Shorthand could not start ${backend}.`;
    case "timeout":
      return `Shorthand did not hear back from ${backend} in time.`;
    case "protocol":
      return `Shorthand could not understand ${backend}'s response.`;
  }
}

/**
 * Option text for a stored model or effort id the fetched catalog no longer lists. Rendered
 * selected and disabled rather than dropped: `AgentCatalog` never promises a stored id stays
 * valid, and silently clearing it would send a different value than the one the user last
 * chose, while silently keeping it would send a value the backend has already rejected.
 *
 * Quoted rather than bare: real model ids contain brackets of their own (`opus[1m]`,
 * `claude-fable-5[1m]`), so an unquoted id is genuinely ambiguous about where it starts and
 * ends. The sign-in row marks an exact literal with an Obsidian `<code>` element (see
 * `codex login` in `displayAgentCatalog`), but a `<code>` element cannot appear inside an
 * `<option>` text node, so plain straight double quotes stand in for it here instead — the same
 * disambiguation, with no markup and no glyph unfamiliar to the rest of the plugin.
 */
export function unavailableOptionLabel(storedValue: string): string {
  return `"${storedValue}" (unavailable)`;
}

/**
 * Rule 4's second case: the field's selected option is the stored value, but that value is not
 * what the picker actually offers any more, so the row earns a description the way a plain
 * dropdown normally would not. Quoted the same way `unavailableOptionLabel` quotes the option
 * text, since both name the same value.
 */
export function unavailableValueDescription(storedValue: string): string {
  return `"${storedValue}" is not in the current list. Pick another one.`;
}

/** `AgentModel.efforts` is empty for this model — a real state, not a missing answer. */
export function noEffortForModelDescription(modelName: string): string {
  return `${modelName} doesn't take an effort setting.`;
}

/**
 * Shown when no concrete model is selected (either "Provider default", or a stored id absent
 * from the catalog, already reported by the model row itself) — there is no model to read an
 * efforts list from, so there is nothing valid to offer here yet.
 */
export function effortNeedsModelDescription(): string {
  return "Pick a model to see its effort options.";
}

/**
 * One option of a model or effort dropdown, independent of Obsidian's `DropdownComponent` so it
 * can be produced and asserted on without importing `obsidian` (which ships no runtime module —
 * see this file's header comment). `main.ts` turns this into a `<select>` `<option>`, disabled
 * ones included: a disabled option can still be the element's programmatic value even though a
 * user cannot click it into place, which is exactly the "shown, but not a live choice" state an
 * unavailable stored id needs.
 */
export type CatalogOption = Readonly<{ value: string; label: string; disabled: boolean }>;

const PROVIDER_DEFAULT_OPTION: CatalogOption = { value: "", label: "Provider default", disabled: false };

/** What a model or effort dropdown should show: its options, the selected value, its description, and whether it's disabled. */
export type CatalogRowDecision = Readonly<{
  options: readonly CatalogOption[];
  selected: string;
  description: string;
  disabled: boolean;
}>;

/**
 * The model row's four-branch decision table, extracted so it is verifiable by `bun test`
 * rather than only by typecheck and a human reading `main.ts` — see AGENTS.md § "The settings
 * surface" on why nothing expressed only in `main.ts` is testable.
 *
 * A stored id absent from `catalog.models` is not dropped: it is appended as a disabled option
 * and left selected, which is what forces a visible re-pick instead of a silent substitution —
 * see `unavailableOptionLabel`. Disabling the whole row tracks `catalog.signedIn` only; whether
 * the stored id is still valid is an orthogonal question the description answers instead.
 */
export function decideModelRow(catalog: AgentCatalog, storedModelId: string): CatalogRowDecision {
  const knownModel = catalog.models.some((model) => model.id === storedModelId);
  const options: CatalogOption[] = [PROVIDER_DEFAULT_OPTION];
  for (const model of catalog.models) options.push({ value: model.id, label: model.displayName, disabled: false });
  if (storedModelId.length > 0 && !knownModel) {
    options.push({ value: storedModelId, label: unavailableOptionLabel(storedModelId), disabled: true });
  }
  return {
    options,
    selected: storedModelId,
    description: storedModelId.length > 0 && !knownModel ? unavailableValueDescription(storedModelId) : "",
    disabled: !catalog.signedIn,
  };
}

/**
 * The effort row's decision, covering the same ground `decideModelRow` does one level down and
 * also embodying this repo's preserve-and-flag policy for a model switch (see `main.ts`'s
 * `displayAgentCatalog`, whose model dropdown no longer clears the stored effort itself): the
 * caller passes whatever `storedEffort` is on disk, unchanged, whichever model is now selected,
 * and this function decides whether that effort still applies.
 *
 * Four branches, matching `AgentModel.efforts`'s own shape:
 * - No model selected, or the stored model id is not in `catalog` (reported already by the
 *   model row): there is no efforts list to validate against, so the row is disabled either
 *   way. A stored effort is still shown, flagged, rather than hidden, for the same reason the
 *   model row does not hide its own value.
 * - The selected model takes no effort at all (`efforts` is empty) — a real state, not a
 *   missing answer.
 * - The selected model has efforts and the stored one is among them: kept, and offered as a
 *   normal, enabled option.
 * - The selected model has efforts but the stored one is not among them (including because the
 *   previously selected model's effort does not apply to a newly chosen model): kept rather
 *   than reset, appended as a disabled option, and flagged with a description — the same
 *   presentation `decideModelRow` uses for a stale model id, so switching models can never
 *   silently discard a still-valid choice or silently launder an invalid one into "Provider
 *   default".
 */
export function decideEffortRow(catalog: AgentCatalog, storedModelId: string, storedEffort: string): CatalogRowDecision {
  const model = catalog.models.find((candidate) => candidate.id === storedModelId);

  if (model === undefined) {
    if (storedEffort.length > 0) {
      return {
        options: [PROVIDER_DEFAULT_OPTION, { value: storedEffort, label: unavailableOptionLabel(storedEffort), disabled: true }],
        selected: storedEffort,
        description: unavailableValueDescription(storedEffort),
        disabled: true,
      };
    }
    return { options: [PROVIDER_DEFAULT_OPTION], selected: "", description: effortNeedsModelDescription(), disabled: true };
  }

  if (model.efforts.length === 0) {
    return {
      options: [PROVIDER_DEFAULT_OPTION],
      selected: "",
      description: noEffortForModelDescription(model.displayName),
      disabled: true,
    };
  }

  const knownEffort = model.efforts.includes(storedEffort);
  const options: CatalogOption[] = [
    PROVIDER_DEFAULT_OPTION,
    ...model.efforts.map((effort): CatalogOption => ({ value: effort, label: sentenceCase(effort), disabled: false })),
  ];
  if (storedEffort.length > 0 && !knownEffort) {
    options.push({ value: storedEffort, label: unavailableOptionLabel(storedEffort), disabled: true });
  }
  return {
    options,
    selected: storedEffort,
    description: storedEffort.length > 0 && !knownEffort ? unavailableValueDescription(storedEffort) : "",
    disabled: !catalog.signedIn,
  };
}

function sentenceCase(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

/**
 * Empty means core detects Shorthand itself (rule 2's opposite case: the label alone doesn't
 * say that, so it gets a sentence). A full path needs nothing added — the field already shows
 * it (rule 4's "already self-describing" carve-out) — but a bare command name is worth a word:
 * `shorthandCommand()` in `main.ts` resolves it relative to Obsidian's working folder, not
 * through `PATH`, so a name typed here almost never does what it looks like it does. That's a
 * consequence a user can act on, not core's internal vocabulary (rule 3), so it earns a
 * sentence steering back to blank instead of staying silent.
 */
export function shorthandExecutableDescription(stored: string): string {
  const trimmed = stored.trim();
  if (trimmed.length === 0) return "Shorthand is found automatically.";
  if (/[\\/]/.test(trimmed)) return "";
  return "A bare name resolves relative to Obsidian's working folder, not PATH — clear the field to detect Shorthand automatically.";
}

/** Empty means core detects the CLI itself, and the path it finds is shown nowhere. */
export function claudeExecutableDescription(stored: string): string {
  return stored.trim().length === 0 ? "Claude is found automatically." : "";
}

/**
 * Word-for-word the shape of `claudeExecutableDescription`, because the two rows now mean the
 * same thing: blank is a working default that core resolves for itself. It once said "Required",
 * which was true only while core had no detection of its own — core 0.11.2 searches PATH, so a
 * user with `codex` installed needs this field only to name a different build. "On PATH" is left
 * out for the same reason the Shorthand and Claude rows leave out *their* search order: the row
 * says whether the user has to act, and the README says how detection works.
 */
export function codexExecutableDescription(stored: string): string {
  return stored.trim().length === 0 ? "Codex is found automatically." : "";
}

/** Empty means core detects Cursor or an ACP agent CLI automatically. */
export function acpExecutableDescription(stored: string): string {
  return stored.trim().length === 0 ? "Cursor is found automatically." : "";
}

/**
 * Rendered from the stored folder, not the typed one: `normalizePluginSettings` rejects
 * absolute, drive-letter and traversing paths back to the default, so the field and the
 * folder in force can legitimately disagree.
 */
export function transcriptFolderDescription(folder: string): string {
  return `New transcript notes go in ${folder}.`;
}

export function newCharacterThresholdDescription(characters: number): string {
  const safe = Number.isFinite(characters) && characters >= 1 ? Math.floor(characters) : 1;
  return safe === 1
    ? "A live pass waits until 1 new character of transcript has arrived."
    : `A live pass waits until ${safe} new characters of transcript have arrived.`;
}

/** The field and this description both speak seconds; storage remains milliseconds for core. */
export function passIntervalDescription(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds >= 10 ? seconds : 10;
  return `Live passes run no more often than once every ${countOf(safe, "second")}.`;
}

export function baseUrlDescription(provider: string): string {
  return provider === "openai-compatible"
    ? "Required. The provider name alone does not identify an endpoint."
    : "Optional. Leave it blank unless you route through a gateway or proxy.";
}

export type StoredKeyState = "stored" | "absent" | "unknown";

export function apiKeyDescription(state: StoredKeyState): string {
  // The blank/replace/clear tail belongs to exactly one state. It answers "what happens if I
  // leave this blank", which is a real question only where a key exists that the password field
  // cannot show and all three actions can be taken. With nothing stored, blank keeps nothing and
  // Clear key removes nothing. When the profile cannot be read, the caller disables the field
  // and the Clear key button before this renders, so none of the three is available while the
  // sentence is on screen — and Discard file, the one action that state does offer, is described
  // on the row that owns the button.
  if (state === "absent") return "No key is stored.";
  if (state === "unknown") return "The stored key cannot be read.";
  return "A key is stored. Blank keeps the stored key, a new value replaces it, and Clear key removes it.";
}

function countOf(count: number, unit: string): string {
  return count === 1 ? `1 ${unit}` : `${count} ${unit}s`;
}

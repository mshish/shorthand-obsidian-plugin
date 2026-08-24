import { DEFAULT_CONFIG, MAX_GUIDANCE_CHARACTERS, parseTemplateSections, type Section } from "shorthand-core";

export type ShorthandPluginSettings = Readonly<{
  backend: "claude-agent-sdk" | "llm";
  shorthandExecutable: string;
  claudeExecutable: string;
  sidecarDirectory: string;
  minNewChars: number;
  minIntervalMs: number;
  enableLiveEnhancement: boolean;
  controlShorthandRecording: boolean;
  /**
   * Whether capture creates and maintains a linked transcript sidecar note holding the raw
   * transcript on disk. Off by default, so a fresh install writes nothing to the vault beyond
   * the meeting note itself.
   */
  writeTranscriptNote: boolean;
  /**
   * Replaces core's `DEFAULT_EDITORIAL_GUIDANCE`. Empty means "use core's default" and is
   * stored as empty rather than as a copy of that default: a user who never touches this
   * keeps inheriting improvements to it, instead of being frozen at whatever the text
   * happened to be the day they installed the plugin. The safety preamble is prepended by
   * core regardless and is not reachable from here.
   */
  noteTakingGuidance: string;
  /**
   * Logs every enhancement status, plus core's per-transition machine trace, to the
   * console. Off by default because the trace is one line per microstep. It exists
   * because the two self-healing outcomes — a plain re-queue and a timeout — are
   * deliberately silent in the UI, so a capture that keeps re-queueing looks identical
   * to one that is idle. Snapshotted per capture, so it applies to the next one.
   */
  debugLogging: boolean;
  /** One heading per line. Empty means core's `DEFAULT_CONFIG.templateSections`, for the same reason. */
  templateSectionText: string;
}>;

export const DEFAULT_PLUGIN_SETTINGS: ShorthandPluginSettings = Object.freeze({
  backend: "claude-agent-sdk",
  shorthandExecutable: "",
  claudeExecutable: "",
  sidecarDirectory: DEFAULT_CONFIG.sidecarDirectory.replaceAll("\\", "/"),
  minNewChars: DEFAULT_CONFIG.thresholds.enhancementNewCharacters,
  minIntervalMs: DEFAULT_CONFIG.thresholds.enhancementIntervalMs,
  enableLiveEnhancement: true,
  controlShorthandRecording: true,
  writeTranscriptNote: false,
  debugLogging: false,
  noteTakingGuidance: "",
  templateSectionText: "",
});

export function normalizePluginSettings(input: unknown): ShorthandPluginSettings {
  const value = isRecord(input) ? input : {};
  return {
    backend: backendValue(value.backend, DEFAULT_PLUGIN_SETTINGS.backend),
    shorthandExecutable: migrateLegacyShorthandExecutable(
      stringValue(value.shorthandExecutable, DEFAULT_PLUGIN_SETTINGS.shorthandExecutable),
    ),
    claudeExecutable: stringValue(value.claudeExecutable, DEFAULT_PLUGIN_SETTINGS.claudeExecutable),
    sidecarDirectory: vaultRelativeDirectory(value.sidecarDirectory, DEFAULT_PLUGIN_SETTINGS.sidecarDirectory),
    minNewChars: finiteInteger(value.minNewChars, DEFAULT_PLUGIN_SETTINGS.minNewChars, 1),
    minIntervalMs: finiteInteger(value.minIntervalMs, DEFAULT_PLUGIN_SETTINGS.minIntervalMs, 0),
    enableLiveEnhancement: typeof value.enableLiveEnhancement === "boolean"
      ? value.enableLiveEnhancement
      : DEFAULT_PLUGIN_SETTINGS.enableLiveEnhancement,
    controlShorthandRecording: typeof value.controlShorthandRecording === "boolean"
      ? value.controlShorthandRecording
      : DEFAULT_PLUGIN_SETTINGS.controlShorthandRecording,
    writeTranscriptNote: typeof value.writeTranscriptNote === "boolean"
      ? value.writeTranscriptNote
      : DEFAULT_PLUGIN_SETTINGS.writeTranscriptNote,
    debugLogging: typeof value.debugLogging === "boolean"
      ? value.debugLogging
      : DEFAULT_PLUGIN_SETTINGS.debugLogging,
    noteTakingGuidance: guidanceText(value.noteTakingGuidance, DEFAULT_PLUGIN_SETTINGS.noteTakingGuidance),
    templateSectionText: headingListText(value.templateSectionText, DEFAULT_PLUGIN_SETTINGS.templateSectionText),
  };
}

export type PromptSettingsValidation =
  | Readonly<{ ok: true; settings: Readonly<{ noteTakingGuidance: string; templateSectionText: string }> }>
  | Readonly<{ ok: false; field: "noteTakingGuidance" | "templateSectionText"; error: string }>;

/**
 * Everything the prompt modal does that is not DOM wiring. It lives here, not in `main.ts`,
 * because nothing in this repository can import `main.ts` under `bun test` — so a rule left
 * inside the modal is a rule with no test at all.
 *
 * Empty is always valid on both fields and always means "use the default".
 */
export function validatePromptSettings(
  input: Readonly<{ noteTakingGuidance: string; templateSectionText: string }>,
): PromptSettingsValidation {
  const noteTakingGuidance = input.noteTakingGuidance.trim();
  if (noteTakingGuidance.length > MAX_GUIDANCE_CHARACTERS) {
    return {
      ok: false,
      field: "noteTakingGuidance",
      error: `The note-taking prompt is ${noteTakingGuidance.length} characters; the limit is ${MAX_GUIDANCE_CHARACTERS}.`,
    };
  }
  const templateSectionText = input.templateSectionText.trim();
  if (templateSectionText.length > 0) {
    const parsed = parseTemplateSections(templateSectionText);
    // Core's message names the offending heading; a rewritten one here would drift from the
    // rule that actually rejected it.
    if (!parsed.ok) return { ok: false, field: "templateSectionText", error: parsed.error };
  }
  return { ok: true, settings: { noteTakingGuidance, templateSectionText } };
}

/**
 * The sections a note is scaffolded with. Falls back to core's default rather than to a copy
 * of it, and never throws: a stored value can be unparseable, and a note scaffolded with no
 * sections at all is worse than one scaffolded with the standard three.
 */
export function resolveTemplateSections(templateSectionText: string): readonly Section[] {
  const parsed = parseTemplateSections(templateSectionText);
  return parsed.ok ? parsed.sections : DEFAULT_CONFIG.templateSections;
}

/** Shown as the heading field's placeholder, so a user can read what they are replacing. */
export function defaultTemplateSectionText(): string {
  return DEFAULT_CONFIG.templateSections.map(({ heading }) => heading).join("\n");
}

export type PromptFieldMode = "default" | "custom";

/**
 * What one field of the prompt modal is showing right now. `mode` is never stored: it is
 * derived from the stored string, because a second stored key could disagree with the text
 * and there would be no way to tell which one was right.
 *
 * `seeded` is modal-session state and is likewise never stored. It records that this field has
 * already been filled from the default once, so a later switch to Custom leaves the editor
 * alone. Without it, "has the user cleared this box on purpose?" and "has this box never been
 * filled?" are the same observation, and the second reading silently overwrites the first.
 */
export type PromptFieldState = Readonly<{
  mode: PromptFieldMode;
  editorText: string;
  seeded: boolean;
}>;

/**
 * Empty stored value means "use the default", so it derives the default mode.
 *
 * A stored custom value counts as already seeded: the box holds the user's own text, and
 * nothing should ever overwrite it.
 */
export function initialPromptFieldState(stored: string): PromptFieldState {
  const trimmed = stored.trim();
  return trimmed.length === 0
    ? { mode: "default", editorText: "", seeded: false }
    : { mode: "custom", editorText: stored, seeded: true };
}

/**
 * What gets written to `data.json`. The default mode always stores "", never a copy of the
 * default's text — even though `editorText` may still hold that text from a seeded edit the
 * user then backed out of. Storing the copy would freeze the user at whatever core's guidance
 * said that day instead of letting them keep inheriting improvements to it.
 */
export function storedPromptFieldValue(state: PromptFieldState): string {
  return state.mode === "default" ? "" : state.editorText;
}

/**
 * Seeds on the first switch to custom and never again.
 *
 * The guard is `seeded`, not "is the box empty". Those differ in exactly one case, and it is a
 * case users hit: clear the box to write from scratch, flip to "Default" to re-read the
 * original, flip back — and an emptiness test would refill the box with the default, throwing
 * away the blank canvas the user deliberately made. Flipping across to compare is the one thing
 * this control exists for, so it must be free.
 */
export function choosePromptFieldMode(
  state: PromptFieldState,
  mode: PromptFieldMode,
  effectiveDefault: string,
): PromptFieldState {
  if (mode === "default") return { ...state, mode: "default" };
  if (state.seeded) return { ...state, mode: "custom" };
  return { mode: "custom", editorText: effectiveDefault, seeded: true };
}

function vaultRelativeDirectory(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (normalized.length === 0 || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return fallback;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return fallback;
  return normalized;
}

function finiteInteger(value: unknown, fallback: number, minimum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum
    ? Math.floor(value)
    : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

/**
 * `"shorthand"` here is a fixed sentinel, not `DEFAULT_CONFIG.shorthandBinaryPath`: it is the
 * value `DEFAULT_PLUGIN_SETTINGS.shorthandExecutable` held before this fix, and Obsidian
 * persisted it into every `data.json` an earlier plugin version wrote. Leaving it in place
 * would keep `resolve("shorthand")` in force for every upgrading user, pointing at a file no
 * install has, with no route back to `shorthandCommand()`'s detection. Tying the comparison to
 * core's current constant instead would stop protecting those users the day core's own default
 * changes to a real path, while their stored value stays "shorthand" — so the sentinel is
 * fixed on purpose.
 */
function migrateLegacyShorthandExecutable(value: string): string {
  return value === "shorthand" ? "" : value;
}

function backendValue(
  value: unknown,
  fallback: ShorthandPluginSettings["backend"],
): ShorthandPluginSettings["backend"] {
  return value === "claude-agent-sdk" || value === "llm" ? value : fallback;
}

/**
 * Over the cap falls back to "" — core's own default guidance — rather than throwing or
 * truncating. `data.json` is untrusted (hand-edited, synced, written by an older build), and
 * a prompt cut off mid-sentence is worse than no override at all: the user would see notes
 * following half an instruction with nothing anywhere to explain why.
 */
function guidanceText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > MAX_GUIDANCE_CHARACTERS ? fallback : trimmed;
}

/**
 * Same discipline, same fallback: "" means `DEFAULT_CONFIG.templateSections`. Validated on
 * load and not only on save, because the value could have arrived from anywhere.
 */
function headingListText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  return parseTemplateSections(trimmed).ok ? trimmed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

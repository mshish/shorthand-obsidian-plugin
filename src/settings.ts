import {
  CLAUDE_EFFORT_LEVELS,
  CODEX_REASONING_EFFORTS,
  DEFAULT_CONFIG,
  MAX_GUIDANCE_CHARACTERS,
  MAX_USER_NAME_CHARACTERS,
  parseTemplateSections,
  type ClaudeAgentClientOptions,
  type ClaudeEffort,
  type CodexAgentClientOptions,
  type CodexReasoningEffort,
  type Section,
} from "shorthand-core";
import type { CaptureMode } from "./follow-policy.js";

/**
 * Every stored enhancement-backend identifier, and the one source the union below is derived
 * from. Deriving rather than restating it is what stops a backend from existing in the type
 * while a validator elsewhere still rejects it: the settings tab's dropdown handler narrows
 * through `isEnhancementBackend`, and the hand-written literal comparison it replaced would
 * have dropped a newly added option on the floor — the dropdown moves, nothing saves, and no
 * error is raised anywhere.
 */
const ENHANCEMENT_BACKENDS = ["claude-agent-sdk", "codex", "cursor", "acp", "llm"] as const;

export type EnhancementBackend = (typeof ENHANCEMENT_BACKENDS)[number];

export function isEnhancementBackend(value: unknown): value is EnhancementBackend {
  return (ENHANCEMENT_BACKENDS as readonly unknown[]).includes(value);
}

export type AcpTransport = "stdio" | "network";

export type ShorthandPluginSettings = Readonly<{
  backend: EnhancementBackend;
  shorthandExecutable: string;
  claudeExecutable: string;
  /** Blank values inherit the installed Claude CLI/SDK defaults. */
  claudeModel: string;
  claudeEffort: ClaudeEffort | "";
  /**
   * Path to the Codex program, or blank to let core find it. Blank is the working default, as it
   * is for `claudeExecutable`: `detectCodexExecutable` searches PATH and hands the SDK an
   * absolute path to spawn. That detection is what the plugin leans on, because the SDK's own
   * lookup cannot work here — it resolves `@openai/codex` relative to the file it is running in,
   * and this plugin ships as one bundled `main.js` installed into
   * `<vault>/.obsidian/plugins/shorthand/` with no `node_modules` at or above it. A value stored
   * here overrides that search, for a Codex off PATH or for naming one specific build.
   */
  codexExecutable: string;
  /** Blank values inherit the installed Codex CLI defaults. */
  codexModel: string;
  codexEffort: CodexReasoningEffort | "";
  cursorExecutable: string;
  cursorModel: string;
  acpTransport: AcpTransport;
  acpExecutable: string;
  acpArgs: string;
  acpNetworkUrl: string;
  acpAuthToken: string;
  acpModel: string;
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
   * Whether a note with no Shorthand marker block is scaffolded without asking.
   *
   * On by default: the user has already expressed intent by running a Shorthand command
   * on that note, and the modal's answer was yes almost every time.
   *
   * It governs the *confirmation* only. `preflightMarkers`' `error` status — markers
   * present but malformed — is untouched by it and is still never repaired implicitly,
   * because a broken ownership boundary is a different question from an absent one.
   */
  autoScaffold: boolean;
  /** Optional name supplied to either note-taking mode as untrusted session context. */
  userName: string;
  /**
   * Replaces core's meeting guidance. Empty means "use core's default" and is
   * stored as empty rather than as a copy of that default: a user who never touches this
   * keeps inheriting improvements to it, instead of being frozen at whatever the text
   * happened to be the day they installed the plugin. The safety preamble is prepended by
   * core regardless and is not reachable from here.
   */
  meetingNoteTakingGuidance: string;
  /** Same override behavior as meeting guidance, scoped to Assisted Notes. */
  assistedNotesNoteTakingGuidance: string;
  /**
   * Logs every enhancement status, plus core's per-transition machine trace, plus every
   * capture lifecycle event (`src/capture-log.ts`), to the console. Off by default because
   * the trace is one line per microstep. It exists because the outcomes that matter most are
   * the ones with no UI: the two self-healing enhancement outcomes — a plain re-queue and a
   * timeout — are deliberately silent, so a capture that keeps re-queueing looks identical to
   * one that is idle, and every control signal that *worked* used to be invisible too, which
   * left a misbehaving start or stop with no evidence but the user's recollection.
   * Snapshotted per capture for the enhancement half, so that applies to the next one.
   */
  debugLogging: boolean;
  /** Advanced opt-in; local Claude/Codex history is deleted when false. */
  retainAgentSessionHistory: boolean;
  /** One heading per line. Empty means core's `DEFAULT_CONFIG.templateSections`, for the same reason. */
  templateSectionText: string;
  /**
   * Whether the plugin keeps a follower attached while idle, so a recording started with
   * Shorthand's own hotkey also starts a capture here.
   *
   * Off by default, and deliberately: it holds a `shorthand --follow-stream` child process
   * open for as long as the plugin is loaded, which is not something to switch on for
   * someone without asking. Eight followers may attach at once, so the slot itself is free.
   */
  followAppRecording: boolean;
}>;

export const DEFAULT_PLUGIN_SETTINGS: ShorthandPluginSettings = Object.freeze({
  backend: "claude-agent-sdk",
  shorthandExecutable: "",
  claudeExecutable: "",
  claudeModel: "",
  claudeEffort: "",
  codexExecutable: "",
  codexModel: "",
  codexEffort: "",
  cursorExecutable: "",
  cursorModel: "",
  acpTransport: "stdio",
  acpExecutable: "",
  acpArgs: "",
  acpNetworkUrl: "",
  acpAuthToken: "",
  acpModel: "",
  sidecarDirectory: DEFAULT_CONFIG.sidecarDirectory.replaceAll("\\", "/"),
  minNewChars: DEFAULT_CONFIG.thresholds.enhancementNewCharacters,
  minIntervalMs: DEFAULT_CONFIG.thresholds.enhancementIntervalMs,
  enableLiveEnhancement: true,
  controlShorthandRecording: true,
  writeTranscriptNote: false,
  autoScaffold: true,
  debugLogging: false,
  retainAgentSessionHistory: false,
  userName: "",
  meetingNoteTakingGuidance: "",
  assistedNotesNoteTakingGuidance: "",
  templateSectionText: "",
  followAppRecording: false,
});

export function normalizePluginSettings(input: unknown): ShorthandPluginSettings {
  const value = isRecord(input) ? input : {};
  // Before prompts were mode-specific, one `noteTakingGuidance` value governed every capture.
  // Applying that legacy value to both new fields preserves the user's explicit choice instead
  // of silently sending one mode back to Shorthand's default after an upgrade.
  const legacyGuidance = guidanceText(value.noteTakingGuidance, "");
  return {
    backend: backendValue(value.backend, DEFAULT_PLUGIN_SETTINGS.backend),
    shorthandExecutable: migrateLegacyShorthandExecutable(
      stringValue(value.shorthandExecutable, DEFAULT_PLUGIN_SETTINGS.shorthandExecutable),
    ),
    claudeExecutable: stringValue(value.claudeExecutable, DEFAULT_PLUGIN_SETTINGS.claudeExecutable),
    claudeModel: stringValue(value.claudeModel, DEFAULT_PLUGIN_SETTINGS.claudeModel),
    claudeEffort: enumValue(value.claudeEffort, CLAUDE_EFFORT_LEVELS, DEFAULT_PLUGIN_SETTINGS.claudeEffort),
    codexExecutable: stringValue(value.codexExecutable, DEFAULT_PLUGIN_SETTINGS.codexExecutable),
    codexModel: stringValue(value.codexModel, DEFAULT_PLUGIN_SETTINGS.codexModel),
    codexEffort: enumValue(value.codexEffort, CODEX_REASONING_EFFORTS, DEFAULT_PLUGIN_SETTINGS.codexEffort),
    cursorExecutable: stringValue(value.cursorExecutable, DEFAULT_PLUGIN_SETTINGS.cursorExecutable),
    cursorModel: stringValue(value.cursorModel, DEFAULT_PLUGIN_SETTINGS.cursorModel),
    acpTransport: acpTransportValue(value.acpTransport, DEFAULT_PLUGIN_SETTINGS.acpTransport),
    acpExecutable: stringValue(value.acpExecutable, DEFAULT_PLUGIN_SETTINGS.acpExecutable),
    acpArgs: stringValue(value.acpArgs, DEFAULT_PLUGIN_SETTINGS.acpArgs),
    acpNetworkUrl: stringValue(value.acpNetworkUrl, DEFAULT_PLUGIN_SETTINGS.acpNetworkUrl),
    acpAuthToken: stringValue(value.acpAuthToken, DEFAULT_PLUGIN_SETTINGS.acpAuthToken),
    acpModel: stringValue(value.acpModel, DEFAULT_PLUGIN_SETTINGS.acpModel),
    sidecarDirectory: vaultRelativeDirectory(value.sidecarDirectory, DEFAULT_PLUGIN_SETTINGS.sidecarDirectory),
    minNewChars: finiteInteger(value.minNewChars, DEFAULT_PLUGIN_SETTINGS.minNewChars, 1),
    // The plugin UI deliberately has a ten-second floor: starting an agent pass more often
    // cannot make it finish faster and can pile up redundant work. Core keeps its own broader
    // contract; this is the plugin's product limit, applied at the data.json trust boundary.
    minIntervalMs: intervalMilliseconds(value.minIntervalMs, DEFAULT_PLUGIN_SETTINGS.minIntervalMs),
    enableLiveEnhancement: typeof value.enableLiveEnhancement === "boolean"
      ? value.enableLiveEnhancement
      : DEFAULT_PLUGIN_SETTINGS.enableLiveEnhancement,
    controlShorthandRecording: typeof value.controlShorthandRecording === "boolean"
      ? value.controlShorthandRecording
      : DEFAULT_PLUGIN_SETTINGS.controlShorthandRecording,
    writeTranscriptNote: typeof value.writeTranscriptNote === "boolean"
      ? value.writeTranscriptNote
      : DEFAULT_PLUGIN_SETTINGS.writeTranscriptNote,
    autoScaffold: typeof value.autoScaffold === "boolean"
      ? value.autoScaffold
      : DEFAULT_PLUGIN_SETTINGS.autoScaffold,
    debugLogging: typeof value.debugLogging === "boolean"
      ? value.debugLogging
      : DEFAULT_PLUGIN_SETTINGS.debugLogging,
    retainAgentSessionHistory: typeof value.retainAgentSessionHistory === "boolean"
      ? value.retainAgentSessionHistory
      : DEFAULT_PLUGIN_SETTINGS.retainAgentSessionHistory,
    userName: userNameText(value.userName, DEFAULT_PLUGIN_SETTINGS.userName),
    meetingNoteTakingGuidance: guidanceText(value.meetingNoteTakingGuidance, legacyGuidance),
    assistedNotesNoteTakingGuidance: guidanceText(value.assistedNotesNoteTakingGuidance, legacyGuidance),
    templateSectionText: headingListText(value.templateSectionText, DEFAULT_PLUGIN_SETTINGS.templateSectionText),
    followAppRecording: typeof value.followAppRecording === "boolean"
      ? value.followAppRecording
      : DEFAULT_PLUGIN_SETTINGS.followAppRecording,
  };
}

/** Snapshot the provider choices that belong to one Claude client lifetime. */
export function claudeAgentOptions(
  settings: ShorthandPluginSettings,
): ClaudeAgentClientOptions {
  return {
    ...(settings.claudeModel.length === 0 ? {} : { model: settings.claudeModel }),
    ...(settings.claudeEffort === "" ? {} : { effort: settings.claudeEffort }),
    retainSessionHistory: settings.retainAgentSessionHistory,
  };
}

/** Snapshot the provider choices that belong to one Codex client lifetime. */
export function codexAgentOptions(
  settings: ShorthandPluginSettings,
): Pick<CodexAgentClientOptions, "model" | "modelReasoningEffort" | "retainSessionHistory"> {
  return {
    ...(settings.codexModel.length === 0 ? {} : { model: settings.codexModel }),
    ...(settings.codexEffort === "" ? {} : { modelReasoningEffort: settings.codexEffort }),
    retainSessionHistory: settings.retainAgentSessionHistory,
  };
}

export type PromptSettingsValidation =
  | Readonly<{
    ok: true;
    settings: Readonly<{
      userName: string;
      meetingNoteTakingGuidance: string;
      assistedNotesNoteTakingGuidance: string;
      templateSectionText: string;
    }>;
  }>
  | Readonly<{
    ok: false;
    field: "userName" | "meetingNoteTakingGuidance" | "assistedNotesNoteTakingGuidance" | "templateSectionText";
    error: string;
  }>;

/**
 * Everything the prompt modal does that is not DOM wiring. It lives here, not in `main.ts`,
 * because nothing in this repository can import `main.ts` under `bun test` — so a rule left
 * inside the modal is a rule with no test at all.
 *
 * Empty is always valid on both fields and always means "use the default".
 */
export function validatePromptSettings(
  input: Readonly<{
    userName: string;
    meetingNoteTakingGuidance: string;
    assistedNotesNoteTakingGuidance: string;
    templateSectionText: string;
  }>,
): PromptSettingsValidation {
  const userName = input.userName.trim();
  if (userName.length > MAX_USER_NAME_CHARACTERS) {
    return {
      ok: false,
      field: "userName",
      error: `Your name is ${userName.length} characters; the limit is ${MAX_USER_NAME_CHARACTERS}.`,
    };
  }
  const meetingNoteTakingGuidance = input.meetingNoteTakingGuidance.trim();
  const assistedNotesNoteTakingGuidance = input.assistedNotesNoteTakingGuidance.trim();
  for (const [field, label, guidance] of [
    ["meetingNoteTakingGuidance", "meeting prompt", meetingNoteTakingGuidance],
    ["assistedNotesNoteTakingGuidance", "Assisted Notes prompt", assistedNotesNoteTakingGuidance],
  ] as const) {
    if (guidance.length <= MAX_GUIDANCE_CHARACTERS) continue;
    return {
      ok: false,
      field,
      error: `The ${label} is ${guidance.length} characters; the limit is ${MAX_GUIDANCE_CHARACTERS}.`,
    };
  }
  const templateSectionText = input.templateSectionText.trim();
  if (templateSectionText.length > 0) {
    const parsed = parseTemplateSections(templateSectionText);
    // Core's message names the offending heading; a rewritten one here would drift from the
    // rule that actually rejected it.
    if (!parsed.ok) return { ok: false, field: "templateSectionText", error: parsed.error };
  }
  return {
    ok: true,
    settings: { userName, meetingNoteTakingGuidance, assistedNotesNoteTakingGuidance, templateSectionText },
  };
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

/**
 * Resolves the sections a note is scaffolded with based on the capture mode.
 * Meeting notes receive the configured or default template sections (Summary, Decisions, Actions).
 * Assisted notes receives an empty section array so that only the ownership comments
 * (<!-- shorthand:notes -->, <!-- shorthand:ai:start -->, <!-- shorthand:ai:end -->) are inserted.
 */
export function resolveScaffoldSections(
  mode: CaptureMode,
  templateSectionText: string,
): readonly Section[] {
  if (mode === "assisted-notes") return [];
  return resolveTemplateSections(templateSectionText);
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

function intervalMilliseconds(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(10_000, Math.floor(value));
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  fallback: Values[number] | "",
): Values[number] | "" {
  if (value === "") return "";
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? value
    : fallback;
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

function backendValue(value: unknown, fallback: EnhancementBackend): EnhancementBackend {
  return isEnhancementBackend(value) ? value : fallback;
}

function acpTransportValue(value: unknown, fallback: AcpTransport): AcpTransport {
  return value === "stdio" || value === "network" ? value : fallback;
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

function userNameText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length <= MAX_USER_NAME_CHARACTERS ? trimmed : fallback;
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

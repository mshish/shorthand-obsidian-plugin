import {
  FileSystemAdapter,
  ItemView,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  setIcon,
  requestUrl,
  type App,
  type ButtonComponent,
  type DropdownComponent,
  type TFile,
  normalizePath,
  type Editor,
  type SettingDefinitionControl,
  type SettingDefinitionItem,
  type TextComponent,
  type WorkspaceLeaf,
} from "obsidian";
import { existsSync } from "node:fs";
// Core is consumed by package name through its `exports` map — never a deep path.
// It is a separate repository (mshish/shorthand-core), pinned by tag in package.json.
import {
  AcpAgentClient,
  AgentCatalogError,
  ClaudeAgentClient,
  CodexAgentClient,
  DEFAULT_CONFIG,
  DEFAULT_ASSISTED_NOTES_EDITORIAL_GUIDANCE,
  DEFAULT_MEETING_EDITORIAL_GUIDANCE,
  MAX_USER_NAME_CHARACTERS,
  detectClaudeExecutable,
  detectCodexExecutable,
  detectCursorExecutable,
  detectShorthandExecutable,
  EnhanceRunner,
  KNOWN_REFUSAL_REASONS,
  KNOWN_START_FAILURE_CODES,
  listAcpModels,
  listClaudeModels,
  listCodexModels,
  LlmAgentClient,
  llmCredentialsPath,
  readLlmCredentials,
  ShorthandControl,
  SidecarWriter,
  StreamClient,
  TranscriptStore,
  enhancementDelta,
  type AgentCatalog,
  type ControlResult,
  type ControlSignal,
  type EnhanceStatus,
  type ExitDiagnosis,
  type KnownRefusalReason,
  type KnownStartFailureCode,
  type PassOutcome,
} from "shorthand-core";
import {
  transcriptWikilink,
} from "shorthand-core/markdown";
import {
  enhanceCommandName,
  inferTranscriptNoteTakingMode,
  resolveEnhanceMode,
  type EnhanceCommandId,
} from "./src/enhance-mode.js";
import { COMMAND_NAMES } from "./src/commands.js";
import {
  DEFAULT_PLUGIN_SETTINGS,
  claudeAgentOptions,
  choosePromptFieldMode,
  codexAgentOptions,
  defaultTemplateSectionText,
  initialPromptFieldState,
  normalizePluginSettings,
  resolveTemplateSections,
  storedPromptFieldValue,
  validatePromptSettings,
  type EnhancementBackend,
  type ShorthandPluginSettings,
} from "./src/settings.js";
import {
  acpExecutableDescription,
  apiKeyDescription,
  baseUrlDescription,
  catalogFetchFailedDescription,
  catalogLoadingDescription,
  claudeExecutableDescription,
  codexExecutableDescription,
  decideEffortRow,
  decideModelRow,
  newCharacterThresholdDescription,
  passIntervalDescription,
  shorthandExecutableDescription,
  transcriptFolderDescription,
  type AgentBackendLabel,
  type CatalogRowDecision,
  type StoredKeyState,
} from "./src/settings-display.js";
import {
  INITIAL_PLUGIN_STATE,
  canStartCapture,
  reducePluginState,
  type PluginUiEvent,
  type PluginUiState,
} from "./src/state.js";
import {
  EMPTY_PENDING_ATTACH_BUFFER,
  decideFollow,
  endsSession,
  pushPendingAttachRecord,
  type CaptureMode,
  type PendingAttachBuffer,
} from "./src/follow-policy.js";
import {
  ShorthandRecorder,
  shorthandProvenDown,
  type HelloInfo,
  type RecorderPhase,
  type RecorderSignals,
  type RecorderStartFailure,
} from "./src/recorder.js";
import {
  describeControl,
  describeRecord,
  describeStart,
  describeStop,
  isLoggableRecord,
} from "./src/capture-log.js";
import { describeStatus } from "./src/status-text.js";
import { describePanel, SHORTHAND_PANEL_VIEW, type PanelButtonId, type PanelModel } from "./src/panel-model.js";
import { createRequestUrlFetch } from "./src/request-url-fetch.js";
import { deleteLlmCredentials, writeLlmCredentials } from "./src/llm-credentials-writer.js";
import { LlmProfileCommitQueue } from "./src/llm-profile-commit-queue.js";
import { ObsidianNoteSink } from "./src/obsidian-note-sink.js";
import { ObsidianSidecarStore } from "./src/obsidian-sidecar-store.js";
import {
  ensureTranscriptLink,
  preflightMarkers,
  scaffoldAfterPreflight,
} from "./src/obsidian-note-setup.js";
import {
  EMPTY_LLM_PROFILE_DRAFT,
  missingLlmProfileFields,
  resolveLlmProfileReadState,
  type LlmProfileDraft,
} from "./src/llm-profile-draft.js";

/**
 * Shorthand's follower needs a moment after spawn before Shorthand's events reach it, and the
 * start toggle must not be fired until then — see `ShorthandRecorder.start()`. Long enough to
 * cover a warm attach (measured control forwards land in 48-71ms; the follower's own
 * `hello` is the same order), short enough that a follower which never says `hello`
 * does not visibly delay the recording.
 */
const ATTACH_GRACE_MS = 2_000;

/**
 * How long a stop waits for the `begin` of a recording this capture just started but has
 * not seen announced yet. Sized off the same measurement as the attach grace: the gap is
 * one Shorthand round trip, not a user-visible wait.
 */
const BEGIN_GRACE_MS = 1_500;

/**
 * The backstop `ShorthandRecorder` waits on once the mode's `start` signal is confirmed
 * delivered — see `RecorderStartFailure`'s `start-timeout`. A real refusal (`refused`) or failed start
 * (`start_failed`) is reported the moment its record arrives, so this only ever fires against
 * a Shorthand that accepted the command and then said nothing at all. Sized a little more
 * generously than `BEGIN_GRACE_MS`: that budget covers only the ordinary gap between a signal
 * landing and Shorthand announcing the session, while this one also has to absorb Shorthand
 * raising its window before it can even evaluate the flag.
 */
const START_ACKNOWLEDGEMENT_MS = 3_000;

/**
 * The `hello` capabilities each mode's explicit start/stop pair requires before either signal
 * is sent at all — see `ShorthandRecorder`'s `RecorderSignals`. An app that advertises only
 * the mode's toggle is refused upfront rather than falling back to a toggle dance: keeping
 * two capture paths alive for one mode doubles the state space this shrinks, and the app and
 * plugin ship together, so a build new enough to be running this plugin version is new enough
 * to have both. Meeting was the last mode still on that fallback; a toggle-driven "finalize"
 * could *start* a recording against an app that had already stopped, and a stop could be
 * suppressed entirely when the plugin's belief about the app's state was wrong.
 *
 * `capture-state` is in both lists, not merely a nice-to-have: `ShorthandRecorder`'s start
 * path reads `capture_state`'s reported "already recording" fact as authority rather than
 * inferring it from an observed `begin` (see `recorder.ts`'s `#reportedRecordingMode`), and
 * that inference had a real gap for a non-publishing capture, which never emits a `begin` this
 * follower can see at all — see that comment for the P1 it closes. An app that cannot send
 * `capture_state` can only fall back into that same gap, so it is refused upfront here too,
 * the same reasoning the other entries already use.
 */
const REQUIRED_CAPABILITIES: Readonly<Record<CaptureMode, readonly string[]>> = Object.freeze({
  meeting: ["start-transcription", "stop-transcription", "capture-state"],
  "assisted-notes": ["start-assisted-notes", "stop-assisted-notes", "capture-state"],
});

/** Which signals a capture of `mode` starts and stops Shorthand's recorder with. */
function captureSignals(mode: CaptureMode): RecorderSignals {
  return mode === "assisted-notes"
    ? {
      mode: "assisted-notes",
      start: "start-assisted-notes",
      stop: "stop-assisted-notes",
      requiredCapabilities: REQUIRED_CAPABILITIES["assisted-notes"],
      startAcknowledgementMs: START_ACKNOWLEDGEMENT_MS,
    }
    : {
      mode: "meeting",
      start: "start-transcription",
      stop: "stop-transcription",
      requiredCapabilities: REQUIRED_CAPABILITIES.meeting,
      startAcknowledgementMs: START_ACKNOWLEDGEMENT_MS,
    };
}

/**
 * How long to wait before re-spawning an idle follower whose Shorthand was not running.
 * Deliberately slow: this is a poll for an app that may not be launched for hours and
 * every attempt spawns a process, so a tight retry is a spinning child-process loop in an
 * otherwise idle vault.
 */
const IDLE_FOLLOWER_RETRY_MS = 30_000;

type CaptureRuntime = {
  /** The live Obsidian identity, retained across normal rename and move operations. */
  noteFile: TFile;
  /** The user-facing mode remains attached to the runtime for the full capture lifecycle. */
  mode: CaptureMode;
  client: StreamClient;
  control: ShorthandControl;
  /**
   * Present exactly when this capture drives Shorthand's recorder. Built once, at start, from
   * the settings as they were then: reading them live at each call site let a setting
   * flipped mid-capture send a stop signal that had no matching start.
   */
  recorder: ShorthandRecorder | undefined;
  /**
   * Set only when Shorthand is *known* not to be running: the follower's binary is missing, or
   * its exit said "not running" and nothing this capture saw contradicts that. Control
   * signals are then suppressed, because a control spawn with no Shorthand to forward to
   * *becomes* the Shorthand app starting up and a failed capture must not launch Shorthand unbidden.
   * Deliberately biased toward staying false — see `shorthandProvenDown()`.
   */
  shorthandDown: boolean;
  /**
   * True once the follower's `hello` arrived, i.e. it really did connect to a running
   * Shorthand. The follower's exit code cannot say this on its own.
   */
  helloEver: boolean;
  /** `undefined` when `writeTranscriptNote` is off: no sidecar file exists for this capture. */
  sidecar: SidecarWriter | undefined;
  enhancer: EnhanceRunner | undefined;
  settled: Promise<ExitDiagnosis>;
  stopping: boolean;
  /**
   * Set once, at capture start, and used to compute the elapsed-time display. Deliberately
   * not sourced from `enhancer?.state.elapsedMs`: `createEnhancer()` can throw, in which case
   * capture continues with `enhancer` left `undefined` (see `enhancementUnavailable` below) —
   * exactly the case where the user most needs reassurance that capture is still running. A
   * clock borrowed from the enhancer would vanish along with it. The plugin keeps its own
   * independent anchor so the status bar's timer survives an enhancer that never got built.
   */
  startedAt: number;
};

/**
 * A `not-running` result means something different on every path that can produce it, and
 * one shared sentence was wrong on three of them — it told the user to re-run a command
 * they had already finished, up to five seconds after being told the capture had stopped.
 *
 * `start` is not among these: which manual command can resume the capture depends on which
 * mode it was trying to start, so it is a function of that mode instead — see
 * `START_NOT_RUNNING`. A manual recovery that always named "Toggle Shorthand meeting recording"
 * would start a *Meeting* on a capture that was trying to start Assisted Notes.
 *
 * `recall` and `backstop` no longer name "cancel" specifically: Assisted Notes' explicit kind
 * sends its own `stop-assisted-notes` for both, not `--cancel` — see `ShorthandRecorder`.
 */
const NOT_RUNNING_NOTICES: Record<Exclude<RecorderPhase, "start"> | "manual", string> = {
  recall: "Shorthand did not confirm ending the recording that had just started. Check that Shorthand is not still recording.",
  finalize: "Shorthand was not running, so there was no recording to finalize. The transcript keeps whatever Shorthand had already sent.",
  backstop: "Shorthand did not confirm the final stop. Check that Shorthand is not still recording.",
  manual: "Shorthand was not running; it is starting now. Run the command again once it is up.",
};

const START_NOT_RUNNING = (mode: CaptureMode): string =>
  `Shorthand was not running, so the recording did not start; Shorthand is starting now. Once it is up, start the recording with Shorthand's shortcut or "${
    mode === "assisted-notes"
      ? COMMAND_NAMES["toggle-assisted-notes"]
      : COMMAND_NAMES["toggle-recording"]
  }" — note-taking is already underway and will pick it up.`;

/**
 * How each mode names itself in a notice. The app's own settings pane spells these
 * "Meetings" and "Assisted notes"; these are the singular forms that read correctly as the
 * subject of a sentence about one capture.
 */
const MODE_LABELS: Readonly<Record<CaptureMode, string>> = Object.freeze({
  meeting: "Meeting notes",
  "assisted-notes": "Assisted Notes",
});

function modeLabel(mode: CaptureMode): string {
  return MODE_LABELS[mode];
}

/**
 * Where in Shorthand's settings each mode's own live-transcript publication toggle lives.
 * Both are the same field (`FollowStreamOutput`), shown once per mode's Advanced group.
 */
const FOLLOW_STREAM_SETTING_PATH: Readonly<Record<CaptureMode, string>> = Object.freeze({
  meeting: "Settings → Modes → Meetings → Advanced",
  "assisted-notes": "Settings → Modes → Notetaking → Assisted notes → Advanced",
});

/**
 * The user-facing text for each `RecorderStartFailure`, named by
 * `ShorthandRecorder.startFailure` after `start()` resolves `"not-started"`. An ordinary
 * control failure (`ShorthandControl.send()` itself reporting `not-running` or `error`) leaves
 * `startFailure` `undefined` and never reaches this: `reportControl` already showed a complete,
 * specific message for it via the ordinary report channel, and a second, generic notice on top
 * would only be noise.
 *
 * A `switch` with a `never` default, not a lookup table: two of the five kinds carry data
 * (`refused.reason`, `start-failed.code`/`message`) that has to be read, not just named.
 */
function startFailureNotice(mode: CaptureMode, failure: RecorderStartFailure): string {
  const label = modeLabel(mode);
  switch (failure.kind) {
    case "no-hello":
      return `${label} needs a compatible running Shorthand with live transcript following; none was found in time. Start Shorthand with that setting enabled and try again.`;
    case "unsupported":
      return `This Shorthand build does not support starting and stopping ${label} directly. Install a Shorthand build that advertises it and try again.`;
    case "refused":
      return refusalNotice(mode, failure.reason);
    case "start-failed":
      return startFailedNotice(mode, failure.code, failure.message);
    case "start-timeout":
      return `${label} did not start, and Shorthand never explained why. Check that Shorthand is running and try again.`;
    default: {
      const unhandled: never = failure;
      throw new Error(`Unhandled start failure: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * Turns a `refused.reason` into a specific instruction for each of `shorthand-core`'s
 * `KNOWN_REFUSAL_REASONS`. Deliberately not an exhaustive switch: FOLLOW_STREAM.md is explicit
 * that `reason` is not a closed union, so a value this build does not recognize is a real,
 * expected case — shown verbatim — not a defect to compile away.
 */
function refusalNotice(mode: CaptureMode, reason: string): string {
  const label = modeLabel(mode);
  const known = (KNOWN_REFUSAL_REASONS as readonly string[]).includes(reason)
    ? (reason as KnownRefusalReason)
    : undefined;
  switch (known) {
    case "busy":
      return `${label} was refused: a different Shorthand recording is already running. Stop it, then try again.`;
    case "mode-disabled":
      // Only Assisted Notes has a switch that can produce this; Meeting has none, so the app
      // can never send it for a meeting. Worded to survive being wrong about that anyway.
      return `${label} did not start because the mode is switched off in Shorthand. In Shorthand, open ${FOLLOW_STREAM_SETTING_PATH[mode]}, enable the mode, and try again.`;
    case "publication-disabled":
      return `${label} did not start: its live transcript output is switched off. In Shorthand, open ${FOLLOW_STREAM_SETTING_PATH[mode]}, enable Follow live transcript output, and try again.`;
    default:
      return `${label} was refused by Shorthand (${reason}).`;
  }
}

/**
 * Turns a `start_failed.code` into a specific instruction for each of `shorthand-core`'s
 * `KNOWN_START_FAILURE_CODES`, mirroring `refusalNotice` just above — same reasoning, and the
 * same deliberately non-exhaustive switch: FOLLOW_STREAM.md is explicit that `code` is an open
 * set (the classifier can grow a new value without a protocol bump) and `code` itself is
 * optional (an app old enough to predate `start-failed-code` sends none at all), so both an
 * unrecognized code and a missing one fall through to `message` verbatim rather than being
 * treated as defects.
 */
function startFailedNotice(mode: CaptureMode, code: string | undefined, message: string): string {
  const label = modeLabel(mode);
  const known = code !== undefined && (KNOWN_START_FAILURE_CODES as readonly string[]).includes(code)
    ? (code as KnownStartFailureCode)
    : undefined;
  switch (known) {
    case "no-input-device":
      return `${label} did not start: no input device was found. Connect a microphone and try again.`;
    case "microphone-permission-denied":
      return `${label} did not start: microphone access was denied. Grant Shorthand microphone permission in your OS settings and try again.`;
    case "audio-capture-failed":
    default:
      // `audio-capture-failed` is FOLLOW_STREAM.md's own deliberate catch-all for everything
      // else the start path's classifier cannot name more specifically, so it gets the same
      // plain fallback as an unrecognized or absent code: Shorthand's own explanation, verbatim.
      return `${label} did not start: ${message}`;
  }
}

export default class ShorthandPlugin extends Plugin {
  settings: ShorthandPluginSettings = DEFAULT_PLUGIN_SETTINGS;
  #state: PluginUiState = INITIAL_PLUGIN_STATE;
  // Declared `| undefined` rather than optional: `exactOptionalPropertyTypes` forbids
  // assigning `undefined` to an optional property, and both are cleared on teardown.
  #statusBar: HTMLElement | undefined = undefined;
  #capture: CaptureRuntime | undefined = undefined;
  /** Makes the selected mode visible during setup, before a runtime exists to own it. */
  #requestedCaptureMode: CaptureMode | undefined = undefined;
  /**
   * A follower held open while no capture owns one, so a recording started with
   * Shorthand's hotkey is seen at all. Adopted by an attached capture rather than
   * replaced — see `adoptIdleFollower`.
   */
  #idleFollower: StreamClient | undefined = undefined;
  /**
   * Whether the connected app's `hello` listed `begin-mode`. Reset whenever the idle
   * follower (re)connects or stops — not on attach: the capability was negotiated on this
   * connection and stays valid regardless of who is currently consuming its events, so
   * handing the client to a capture must not touch it.
   */
  #idleAppAdvertisesMode = false;
  /** So the "update Shorthand" notice fires once per plugin load, not once per recording. */
  #warnedAboutAppVersion = false;
  /** Backoff timer for reconnecting the idle follower. Cleared on unload. */
  #idleRetry: number | undefined = undefined;
  /**
   * The session `onAppRecordingBegan` just decided to attach to, set for exactly the
   * window between that decision and the capture's own listener taking over. Marker
   * preflight, a possible confirmation modal, sidecar setup and `createEnhancer` all run in
   * between, and the recording's audio keeps flowing through all of it. The idle listener
   * is the only thing attached for that whole window, so it is the only place that can see
   * those records land — including, if the recording is short enough, the terminal one; see
   * the "event" handler in `syncIdleFollower` and `#idlePendingAttachBuffer` below.
   */
  #idlePendingAttachSession: number | undefined = undefined;
  /**
   * Every record that same idle listener saw for `#idlePendingAttachSession` before the
   * capture's own listener could attach. Replayed through that listener — via
   * `client.emit("event", …)`, the exact path a live record takes — once
   * `drainPendingAttachBuffer` claims it, so the opening of a followed recording is not
   * silently lost to however long setup happens to take. Bounded: see
   * `PENDING_ATTACH_BUFFER_CAP`'s own comment for why "unbounded" is not safe either.
   */
  #idlePendingAttachBuffer: PendingAttachBuffer = EMPTY_PENDING_ATTACH_BUFFER;

  async onload(): Promise<void> {
    this.settings = normalizePluginSettings(await this.loadData());
    this.#statusBar = this.addStatusBarItem();
    // Clickable, and stop-only. The item is hidden while idle (see describeStatus),
    // so there is never a moment where a click could mean "start" — starting lives on
    // the ribbon icon and in the side panel.
    this.#statusBar.addClass("mod-clickable");
    this.registerDomEvent(this.#statusBar, "click", () => {
      if (this.#capture === undefined) return;
      void this.stopCapture().catch((error: unknown) => this.fail(errorMessage(error)));
    });
    this.#render();
    // The elapsed-time display is otherwise only refreshed from a transcript-delta handler
    // and from dispatch(), so between utterances it would visibly freeze. A ticking interval
    // keeps it advancing during silence; registerInterval auto-clears it on unload.
    this.registerInterval(window.setInterval(() => this.#render(), 1_000));
    this.addSettingTab(new ShorthandSettingTab(this.app, this));

    this.registerView(SHORTHAND_PANEL_VIEW, (leaf) => new ShorthandPanelView(leaf, this));
    // The idle panel names the focused note as the place a start would write. Nothing in the
    // capture lifecycle fires when focus merely moves between notes, so without this the link
    // would lag a click by up to the clock interval above.
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => { this.#renderPanel(); }));
    this.addRibbonIcon("mic", "Open Shorthand panel", () => { void this.revealPanel(); });

    // Names come from src/commands.ts so they are covered by bun test; main.ts cannot
    // be imported under it. They carry no plugin prefix and are sentence case, per
    // Obsidian's plugin guidelines: the palette already renders these as "Shorthand:
    // Start meeting notes on this note". Spelling it out here produced "Shorthand:
    // Shorthand: start meeting notes…".
    // checkCallback, not callback: Obsidian hides a command whose check returns false,
    // which is its prescribed way to express "needs an open Markdown note". The check
    // runs on every palette render, so it must not fire a Notice — hence
    // hasActiveMarkdownFile rather than activeMarkdownFile.
    this.addCommand({
      id: "start-meeting-notes-this-note",
      name: COMMAND_NAMES["start-meeting-notes-this-note"],
      checkCallback: (checking: boolean) => {
        if (!this.hasActiveMarkdownFile()) return false;
        if (checking) return true;
        void this.startCaptureOnActiveNote();
        return true;
      },
    });
    this.addCommand({
      id: "start-assisted-notes-this-note",
      name: COMMAND_NAMES["start-assisted-notes-this-note"],
      checkCallback: (checking: boolean) => {
        if (!this.hasActiveMarkdownFile()) return false;
        if (checking) return true;
        void this.startCaptureOnActiveNote("assisted-notes");
        return true;
      },
    });
    this.addCommand({
      id: "stop-notes",
      name: COMMAND_NAMES["stop-notes"],
      callback: () => { void this.stopCapture().catch((error: unknown) => this.fail(errorMessage(error))); },
    });
    this.addCommand({
      id: "enhance-now",
      name: COMMAND_NAMES["enhance-now"],
      checkCallback: (checking: boolean) => {
        if (!this.hasActiveMarkdownFile()) return false;
        if (!checking) void this.enhanceActiveNote();
        return true;
      },
    });
    this.addCommand({
      id: "clean-up-this-note",
      name: COMMAND_NAMES["clean-up-this-note"],
      checkCallback: (checking: boolean) => {
        if (!this.hasActiveMarkdownFile()) return false;
        if (!checking) void this.cleanUpActiveNote();
        return true;
      },
    });
    // The user's manual override of Shorthand's recorder, independent of capture: a plain
    // toggle and an unconditional cancel, neither of which touches the capture itself.
    this.addCommand({
      id: "toggle-recording",
      name: COMMAND_NAMES["toggle-recording"],
      callback: () => { this.fireControl("toggle-transcription"); },
    });
    // Not decoration: a manual recovery that named "Toggle Shorthand meeting recording" would
    // start a *Meeting*. The Assisted Notes recovery path has to select the same mode it was
    // trying to start — see START_NOT_RUNNING, which points here for that signal.
    this.addCommand({
      id: "toggle-assisted-notes",
      name: COMMAND_NAMES["toggle-assisted-notes"],
      callback: () => { this.fireControl("toggle-assisted-notes"); },
    });
    this.addCommand({
      id: "cancel-recording",
      name: COMMAND_NAMES["cancel-recording"],
      callback: () => { this.fireControl("cancel"); },
    });
    this.addCommand({
      id: "open-panel",
      name: COMMAND_NAMES["open-panel"],
      callback: () => { void this.revealPanel(); },
    });

    // StreamClient owns the child process. These hooks synchronously signal it
    // before Obsidian tears down the plugin or application. The idle follower is a second,
    // independent child process and needs the same backstop: without `stopIdleFollower()`
    // here too, a follower running with no capture active (the ordinary idle state) would
    // never be told to exit on this path, only on `onunload`.
    this.registerDomEvent(window, "beforeunload", () => { this.stopIdleFollower(); this.forceStopCapture(); });
    this.registerEvent(this.app.workspace.on("quit", () => { this.stopIdleFollower(); this.forceStopCapture(); }));

    this.syncIdleFollower();
  }

  onunload(): void {
    this.stopIdleFollower();
    this.forceStopCapture();
  }

  async saveSettings(candidate: unknown): Promise<void> {
    this.settings = normalizePluginSettings(candidate);
    await this.saveData(this.settings);
    this.syncIdleFollower();
  }

  async startCaptureOnActiveNote(
    mode: CaptureMode = "meeting",
    options: Readonly<{ attachToSession?: number }> = {},
  ): Promise<void> {
    // Synchronous, before any await. The guard this replaces tested `#capture`, which is
    // assigned further down — so two starts fired inside the setup window both passed it,
    // and the second orphaned the first's follower, control and enhancer.
    // Keep the runtime ownership guard as a second line of defence. The reducer is the normal
    // source of truth (and closes the async setup race), but a stale panel/runtime mismatch must
    // never let a new start overwrite an existing follower, recorder, or enhancer.
    if (this.#capture !== undefined || !canStartCapture(this.#state)) {
      new Notice("Shorthand is already taking notes. Stop it before starting another note.");
      return;
    }
    this.#requestedCaptureMode = mode;
    this.dispatch({ type: "capture-starting" });
    let unownedEnhancer: EnhanceRunner | undefined;
    // "Handed off" means something else now owns this runtime's lifecycle — not that a
    // capture started. Set immediately after `#capture = runtime` below, before either
    // dispatch that could follow it: from that assignment on, `finishRuntime`,
    // `forceStopCapture`, `captureSettled` and `abortCaptureStart` are all reachable
    // and each dispatches its own terminal event, so this `finally` must not also fire.
    let handedOff = false;
    // Mirrors `adopted` inside the try below, at a scope the `catch` can also see (a
    // `const` declared inside `try` is not visible in its `catch`). Needed only for the
    // narrow window between a successful adoption and `handedOff` becoming true: nothing
    // else owns that client until the runtime object exists, so a throw in between would
    // otherwise leak it — see the `catch` block.
    let adoptedFollower: StreamClient | undefined;

    try {
      try {
        // `file` and `vaultRoot` moved inside this try along with everything after them:
        // both can fail, and a failure here is exactly the kind of exit the outer `finally`
        // exists to catch. Leaving them ahead of the guard would dispatch "starting" and
        // then abandon it on the very first early return.
        const file = this.activeMarkdownFile();
        if (file === undefined) return;
        const vaultRoot = this.vaultRoot();
        if (vaultRoot === undefined) return;
        const noteSink = this.noteSink(file, vaultRoot);
        // Preparation is one completed step, before sidecar frontmatter or any recorder
        // runtime. Frontmatter and an open editor are two Obsidian write surfaces for the
        // same note; interleaving processFrontMatter between the marker check and the editor
        // scaffold left their refresh/save ordering to timing. Writing the scaffold first
        // gives the later frontmatter transform the already-prepared file as its input. Both
        // capture modes cross this same gate, and declining still leaves every byte untouched
        // because this is the first mutation in the start path.
        if (!await this.prepareScaffold(noteSink)) return;
        let sidecar: SidecarWriter | undefined;
        if (this.settings.writeTranscriptNote) {
          const noteContent = await noteSink.readContent();
          if (!noteContent.ok) {
            this.fail(noteContent.message);
            return;
          }
          let linked = transcriptWikilink(noteContent.content);
          if (linked === undefined) {
            const candidate = `${this.settings.sidecarDirectory}/${timestampName(new Date()).replace(/\.md$/i, "")}`;
            // A folder named `Notes [2026]` is legal in Obsidian but cannot survive
            // a round trip through `[[...]]`: every later capture would fail to
            // read the link back and would generate another sidecar.
            if (/[[\]|#^]/.test(candidate)) {
              this.fail(
                `The transcript folder "${this.settings.sidecarDirectory}" contains a character a wikilink cannot hold `
                + "([, ], |, # or ^). Rename the folder or change the transcript folder setting.",
              );
              return;
            }
            const linkedResult = await ensureTranscriptLink({
              fileManager: this.app.fileManager,
              metadataCache: this.app.metadataCache,
            }, file, candidate);
            if (linkedResult.status === "error") {
              this.fail(`Could not add the transcript link: ${linkedResult.message}`);
              return;
            }
            linked = linkedResult.linkPath;
          }
          const target = this.app.metadataCache.getFirstLinkpathDest(linkTarget(linked), file.path);
          const store = this.sidecarStore(file, linked, target);
          if (store === undefined) return;
          sidecar = new SidecarWriter(store.describe, {
            flushIntervalMs: DEFAULT_CONFIG.sidecarFlushIntervalMs,
            store,
          });
        }
        const transcript = new TranscriptStore();
        let enhancer: EnhanceRunner | undefined;
        let enhancementUnavailable: string | undefined;
        try {
          enhancer = await this.createEnhancer(
            noteSink,
            DEFAULT_CONFIG.enhancement.timeoutMs,
            mode,
          );
          unownedEnhancer = enhancer;
        } catch (error) {
          enhancementUnavailable = `${errorMessage(error)} Note-taking will continue with transcript only.`;
        }
        const command = this.shorthandCommand();
        // Adopted, not replaced, when attaching. The app replays a session only while it is
        // still active, and this setup can spend a whole confirmation modal — so a short
        // recording could end before a freshly spawned follower ever attached, leaving the
        // capture permanently empty. The capture's own `TranscriptStore` does not need the
        // `begin` it missed: `ingest` falls back to an implicit session for one whose `begin`
        // it never saw, which is what makes adoption cheap.
        //
        // `adopted` is kept apart from `client` deliberately: adoption can fail even when
        // attaching, if the idle follower emitted `settled` during one of this function's own
        // `await`s (Shorthand quit or died between the `begin` and here). `options
        // .attachToSession === undefined` answers "is this an attach", not "did adoption
        // succeed", and the two differ exactly in that case — using it below to decide whether
        // to `start()` the client left a capture holding a freshly built, never-spawned child.
        const adopted = options.attachToSession === undefined ? undefined : this.adoptIdleFollower();
        adoptedFollower = adopted;
        const client = adopted ?? new StreamClient({
          command,
          args: DEFAULT_CONFIG.followStreamArgs,
          maxReconnectAttempts: DEFAULT_CONFIG.reconnect.maxAttempts,
          backoffMs: DEFAULT_CONFIG.reconnect.backoffMs,
          drainTimeoutMs: DEFAULT_CONFIG.drainTimeoutMs,
        });
        const settled = new Promise<ExitDiagnosis>((resolveSettled) => client.once("settled", resolveSettled));
        const control = new ShorthandControl({ command });
        // Resolved with the follower's parsed `hello` record; `ShorthandRecorder.start()` explains
        // why the start signal waits on it, and Assisted Notes additionally gates it on the
        // record's advertised `capabilities`.
        let markAttached = (_info: HelloInfo): void => {};
        const attached = new Promise<HelloInfo>((resolveAttached) => { markAttached = resolveAttached; });
        // Which signals this capture starts and stops the recording with: the mode's own
        // idempotent pair, gated on its capabilities, with the acknowledgement backstop —
        // see `ShorthandRecorder`'s `RecorderSignals` and `REQUIRED_CAPABILITIES`.
        const signals: RecorderSignals = captureSignals(mode);
        // No recorder when attaching to a recording Shorthand already started: the recorder
        // exists to send the start signal, and starting a recording that is already running
        // is not what an attach is for. The cost is that this capture cannot finalize
        // Shorthand's recording either, so the user stops it the way they started it — see
        // README, "Following Shorthand's recordings".
        const recorder = this.settings.controlShorthandRecording && options.attachToSession === undefined
          ? new ShorthandRecorder({
            control,
            signals,
            report: (phase, result) => this.reportControl(phase, result, mode),
            // The recorder's wait for the terminal record replaces the follower's own drain
            // rather than preceding it, so it gets the same budget.
            finalizeTimeoutMs: DEFAULT_CONFIG.drainTimeoutMs,
            attachGraceMs: ATTACH_GRACE_MS,
            beginGraceMs: BEGIN_GRACE_MS,
          })
          : undefined;
        const runtime: CaptureRuntime = {
          noteFile: file,
          mode,
          client,
          control,
          recorder,
          shorthandDown: false,
          helloEver: false,
          sidecar,
          enhancer,
          settled,
          stopping: false,
          startedAt: Date.now(),
        };
        this.#capture = runtime;
        handedOff = true;
        unownedEnhancer = undefined;
        // Only a capture with no recorder of its own — an attach, or control switched off —
        // goes straight to capturing. Everything this plugin starts itself waits for
        // Shorthand's own acknowledgement; see the branch below and START_ACKNOWLEDGEMENT_MS
        // for why a `sent` signal is not proof a recording began.
        if (recorder === undefined) {
          this.dispatch({ type: "capture-started" });
        }
        if (enhancementUnavailable !== undefined) this.fail(enhancementUnavailable);

        client.on("event", ({ generation, record }) => {
          // The recorder's whole view of Shorthand's session state comes from here — this
          // handler already sees every record Shorthand sends, and unlike StreamClient's own
          // session set it is never reset behind the plugin's back by a reconnect.
          // `observe()` takes session-scoped records only; `hello` is the sole session-less
          // record that reaches this event at all (a connection-level `error` is emitted as
          // `connectionError`, never here), and it has its own entry point.
          if (isLoggableRecord(record)) this.debugCapture(describeRecord(record));
          if (record.t === "hello") {
            runtime.helloEver = true;
            recorder?.noteAttached();
            // `record.capabilities`, when present, already passed core's own defensive parsing
            // (`stringArrayField`): a malformed field is dropped before this event ever fires, so
            // it is not re-validated here. Conditional spread, not `capabilities:
            // record.capabilities`: `exactOptionalPropertyTypes` forbids assigning an explicit
            // `undefined` to an optional property, and `record.capabilities` is `string[] | undefined`.
            markAttached({
              ...(record.capabilities !== undefined ? { capabilities: record.capabilities } : {}),
            });
          } else recorder?.observe(record);
          // An attached capture has no recorder to notice the recording ending, and
          // StreamClient kills its child on a terminal record only once stopAfterDrain has
          // been requested. Without this, stopping the recording in Shorthand leaves the
          // Obsidian capture running until the user stops it by hand. A no-op for a capture
          // that started its own recording: `endsSession` is always false when there is no
          // `attachToSession` to match against.
          if (endsSession(record, options.attachToSession)) {
            void this.stopCapture().catch((error: unknown) => this.fail(errorMessage(error)));
          }
          const update = transcript.ingest(generation, record);
          if (update === null) return;
          sidecar?.apply(update);
          const delta = enhancementDelta(update);
          if (delta.length === 0) return;
          enhancer?.appendTranscript(delta);
          if (enhancer !== undefined && this.settings.enableLiveEnhancement) {
            enhancer.requestTick();
            if (this.settings.debugLogging) {
              console.debug(
                `[shorthand] transcript +${delta.length} chars; pending ${enhancer.state.pendingCharacters}/${this.settings.minNewChars} toward next pass`,
              );
            }
          }
          this.#render();
        });
        // Claims whatever the idle listener buffered for this session before this handler
        // existed. The claim itself stays unconditional on `attachToSession` alone: that is
        // what keeps a 4,000-record array from outliving a refused or aborted attempt (see
        // the `finally` in `onAppRecordingBegan`). The *replay*, though, is gated on
        // `adopted`, not on `attachToSession` — the same distinction Important 1 above
        // exists for, and confused a second time here would undo it: buffered records carry
        // the *adopted* client's connection generation, and `TranscriptStore` keys a session
        // by `${generation}:${session}`. Replaying them onto a *freshly built* fallback
        // client (adoption failed — the idle follower emitted `settled` mid-setup) would
        // file them under a generation `markConnectionEnded` will never close, sitting
        // `active` forever; if the app then replays the still-live session onto the new
        // connection, the same speech is written twice, under two different keys.
        //
        // Zero `await` since `adopted` was computed, by construction (nothing between here
        // and there yields): an `await` inserted anywhere in that stretch would let a real
        // record slip in ahead of this drain with nothing watching for it, reopening the
        // hole `#idlePendingAttachSession` exists to close. Keep it that way if this moves.
        if (options.attachToSession !== undefined) {
          const pending = this.drainPendingAttachBuffer(options.attachToSession);
          if (adopted !== undefined) {
            for (const buffered of pending.records) client.emit("event", buffered);
            if (pending.droppedCount > 0) {
              console.warn(
                `[shorthand] Dropped ${pending.droppedCount} transcript record(s) for a followed `
                + "recording: more arrived than this build buffers while the capture was starting up.",
              );
            }
          }
        }
        client.on("disconnect", ({ generation }) => {
          for (const update of transcript.markConnectionEnded(generation)) sidecar?.apply(update);
        });
        client.on("reconnect", ({ generation, gap }) => {
          if (gap) sidecar?.addReconnectWarning(generation);
        });
        client.on("connectionError", ({ record }) => this.fail(`Shorthand connection error (${record.code}): ${record.message}`));
        client.on("protocolError", ({ error }) => this.fail(error.message));
        client.on("processError", ({ error, command: attempted, fatal }) => {
          // ENOENT is the follower telling us there is no Shorthand binary at all, which is also
          // the answer for every control spawn this capture might still make.
          if (fatal) runtime.shorthandDown = true;
          this.fail(`Could not start "${attempted}". Check the shorthand.exe path in Shorthand settings. ${error.message}`);
        });
        client.on("giveUp", ({ attempts }) => this.fail(`Shorthand stream disconnected repeatedly; gave up after ${attempts} reconnect attempts.`));
        client.on("drainTimeout", () => this.fail("Shorthand did not finish the active transcript before the drain timeout; the child was stopped."));
        sidecar?.on("writeError", ({ error }) => this.fail(`Transcript sidecar write failed: ${error.message}`));
        // Registered before anything else awaits `settled`, so `shorthandDown` is already set by
        // the time `stopCapture()` resumes and decides whether a control spawn is safe.
        void settled.then(
          (diagnosis) => {
            // Not `diagnosis.code === 2`: that code is ambiguous, and reading it as proof is
            // what left Shorthand recording with no follower. `shorthandProvenDown` says why.
            if (shorthandProvenDown({
              exitCode: diagnosis.code,
              helloEver: runtime.helloEver,
              observedSession: recorder?.observedSession ?? false,
              // The one piece of evidence that is not follower-derived, and the strongest:
              // a control signal Shorthand confirmed cannot have been forwarded to a Shorthand that
              // was not running. Without it, a capture whose follower was refused (streaming
              // off, slot taken) concluded "Shorthand is down" while its own start sequence had
              // just put that same Shorthand into recording.
              controlConfirmed: recorder?.controlConfirmed ?? false,
            })) runtime.shorthandDown = true;
            return this.captureSettled(runtime, diagnosis);
          },
        ).catch((error: unknown) => {
          // Nothing else is watching this chain; an unhandled rejection here would take the
          // failure out of the user's sight entirely.
          this.fail(`Wrapping up failed: ${errorMessage(error)}`);
        });
        // Gated on `adopted`, not on `attachToSession`: only a client we did NOT adopt needs
        // starting. Gating this on "is this an attach" instead conflates that question with
        // "did adoption succeed", and an idle follower that died mid-setup (see `adopted`'s
        // own comment above) makes those differ — the freshly built fallback client would
        // then never be told to start, leaving the capture holding a child that was never
        // spawned: no `hello`, no records, no `settled`, capturing forever.
        if (adopted === undefined) client.start();
        if (recorder === undefined) {
          // Nothing to start: an attach follows a recording Shorthand is already running, and
          // a capture with control switched off is driven by Shorthand's own hotkey.
          new Notice(`Shorthand started taking notes: ${file.path}`);
        } else {
          // Both modes take the bounded acknowledgement: a `sent` signal is not proof
          // Shorthand actually started recording (see `START_ACKNOWLEDGEMENT_MS`), so the
          // "capture started" notice — and the dispatch that claims capturing — wait for that
          // proof instead of firing unconditionally.
          void recorder.start(attached).then(async (outcome) => {
            this.debugCapture(describeStart(outcome, recorder.startFailure));
            if (outcome === "started") {
              // `recorder.start()`'s own race can settle "ack" — and so resolve `"started"`
              // here — even after `requestStop()` flipped its stop flag, if the acknowledgement
              // and the stop request land in the same microtask window; see `#runStart`'s
              // acknowledgement race in recorder.ts. That would reset `stopping: false` while a
              // stop is tearing this same runtime down. Left alone deliberately: the ordinary
              // path (`requestStop()` synchronous with the call site) never races this way, and
              // whichever order wins, `finishRuntime` dispatches `capture-stopped` right behind
              // it and the mode self-heals.
              this.dispatch({ type: "capture-started" });
              new Notice(`Shorthand started taking notes: ${file.path}`);
              return;
            }
            if (outcome === "stopped") {
              // A concurrent stop/quit already owns its own notices and teardown.
              return;
            }
            const failure = recorder.startFailure;
            if (failure !== undefined) new Notice(startFailureNotice(mode, failure), 10_000);
            await this.abortCaptureStart(runtime);
          }).catch((error: unknown) => {
            // Nothing else is watching this chain (same reasoning as the `settled` chain
            // above). This `.then` body is the sole clearer of `starting` on this path: a
            // throw here — before it reaches `abortCaptureStart` on its own — would otherwise
            // leave `starting` stuck true for the rest of the session, refusing every later
            // start with "already taking notes" until a plugin reload.
            this.fail(`${modeLabel(mode)} start failed: ${errorMessage(error)}`);
            void this.abortCaptureStart(runtime);
          });
        }
      } catch (error) {
        await unownedEnhancer?.dispose().catch((cleanupError: unknown) => {
          this.fail(`Agent session cleanup failed: ${errorMessage(cleanupError)}`);
        });
        this.fail(errorMessage(error));
        if (handedOff) {
          // The runtime already took ownership, so `forceStopCapture()` tears down a real,
          // live capture here — unlike its three other call sites (`beforeunload`, `quit`,
          // `onunload`), which are all shutdown paths and deliberately do not re-sync the
          // idle follower afterward (see that method's own comment). This one is not a
          // shutdown: without the explicit re-sync below, the "follow" feature would go
          // silently dead until the next `saveSettings()` or a plugin reload.
          this.forceStopCapture();
          this.syncIdleFollower();
        } else {
          // Setup failed before the runtime took ownership, so `forceStopCapture()` would be
          // a no-op (`#capture` was never assigned) — but an *adopted* client can already be
          // running by this point: adoption happens, and clears `#idleFollower`, before the
          // runtime object exists. Nothing else owns that client in this branch, so it must
          // be stopped directly here, or it leaks — a detached child process outliving the
          // plugin instance that spawned it, doing nothing, forever. And the same re-sync
          // the `handedOff` branch above needs, needs it here too: `adoptIdleFollower()`
          // already cleared `#idleFollower` and its retry timer, so nothing else is left to
          // reschedule the idle follower — without this, "follow" would go silently dead
          // until the next `saveSettings()` or a plugin reload, same symptom as the sibling
          // branch. `#capture` is `undefined` here, so the sync does the right thing.
          adoptedFollower?.forceStop();
          this.syncIdleFollower();
        }
      }
    } finally {
      this.#requestedCaptureMode = undefined;
      // Any path that left without handing ownership to a live runtime has to release
      // `starting`, or the plugin refuses every later start with "already taking notes".
      // `capture-start-failed` returns to idle only from `starting`, so a setup error
      // that already dispatched a sticky `error` keeps its message.
      if (!handedOff) this.dispatch({ type: "capture-start-failed" });
      // A post-handoff failure can clear the runtime before this finally block runs. Repaint
      // after dropping the setup-only mode so the idle card cannot retain the old mode color.
      else this.#render();
    }
  }

  async stopCapture(): Promise<void> {
    const runtime = this.#capture;
    if (runtime === undefined) {
      new Notice("Shorthand is not taking notes.");
      return;
    }
    // `#capture` is not cleared until finishRuntime(), which is up to a full drain timeout
    // away. Guarding on it alone let a second Stop press during that window send a second
    // control signal to Shorthand.
    if (runtime.stopping) {
      new Notice("Shorthand is already stopping.");
      return;
    }
    runtime.stopping = true;
    // Synchronous, before the first await: a start sequence still in flight has to see the
    // stop at its next checkpoint, and it is the only thing that can recall its own spawn.
    runtime.recorder?.requestStop();
    runtime.enhancer?.stopLiveTicks();
    // Stopping can spend a control timeout plus the whole drain budget. Without this the
    // status bar read "capturing" for all of it.
    this.dispatch({ type: "capture-stopping" });
    // The recorder owns the finalize signal *and* the wait for the record that proves it
    // landed. Tearing the follower down before that record arrives is what silently loses
    // the corrected transcript, and StreamClient cannot decide it for us: a reconnect
    // clears its session set, after which stopAfterDrain() kills the child instantly.
    // `settled` is handed in as the abandon signal: once the follower is gone, no terminal
    // record can arrive from anywhere, and waiting out the rest of the budget would only
    // make the stop look hung.
    // `shorthandDown` is threaded in rather than checked here: the recorder still has to await
    // its own start sequence before this returns, it just must not send the finalize toggle.
    // Shorthand quitting mid-capture can beat `captureSettled` to the user's Stop press, and a
    // toggle spawned with no Shorthand to forward to would *become* Shorthand starting up.
    const outcome = await (runtime.recorder?.stop({
      abandoned: runtime.settled,
      shorthandDown: runtime.shorthandDown,
    }) ?? Promise.resolve("no-session" as const));
    this.debugCapture(describeStop(outcome));
    if (outcome === "timed-out") {
      this.fail("Shorthand did not deliver the final transcript in time; the transcript keeps whatever Shorthand had already sent.");
      runtime.client.forceStop();
    } else if (outcome === "restarted") {
      // Shorthand answered the finalize toggle by starting a recording, so it was idle: it had
      // restarted while the follower was away and the recording this capture followed died
      // with the old process. Draining would wait on that brand-new session; the backstop
      // below is what ends it.
      this.fail("Shorthand was restarted while taking notes, so the recording it was following was already gone and the stop request started a new one. That new recording is being cancelled; the transcript keeps whatever Shorthand had already sent.");
      runtime.client.forceStop();
    } else {
      runtime.client.stopAfterDrain();
    }
    await runtime.settled;
    await this.finishRuntime(runtime, "stopped");
  }

  forceStopCapture(): void {
    const runtime = this.#capture;
    if (runtime === undefined) return;
    runtime.stopping = true;
    runtime.enhancer?.stopLiveTicks();
    // dispose() calls stop() synchronously before its first await, so no provider work can
    // outlive unload even though Obsidian cannot await this hook.
    void runtime.enhancer?.dispose().catch((error: unknown) => {
      console.error(`[shorthand] Agent session cleanup failed: ${errorMessage(error)}`);
    });
    runtime.client.forceStop();
    // `--cancel`, never a toggle: this runs during Obsidian's shutdown, where a toggle
    // would *start* a recording if Shorthand happened to be idle. `--cancel` can only ever
    // drive Shorthand toward idle. It is sent even though nothing here can await it: a start
    // sequence still in flight re-checks the stop flag after its own toggle and sequences
    // a second cancel behind it, which is what makes the outcome deterministic.
    runtime.recorder?.teardown();
    // Signal first so the child cannot be orphaned, then best-effort flush pending sidecar
    // bytes: Obsidian does not await onunload/beforeunload.
    void runtime.sidecar?.close().catch(() => {});
    this.#capture = undefined;
    this.dispatch({ type: "capture-stopped" });
    // Deliberately no `syncIdleFollower()` here, unlike `finishRuntime` and
    // `abortCaptureStart`: three of this method's four call sites — `beforeunload`,
    // `quit`, `onunload` — are shutdown paths that already call `stopIdleFollower()` of
    // their own accord. Syncing here would spawn a brand-new follower process on the way
    // out the door, with nothing left running to ever stop it. The fourth call site — the
    // `catch` in `startCaptureOnActiveNote`, for a post-handoff setup failure — is not a
    // shutdown, and re-syncs explicitly right after calling this, for exactly that reason.
  }

  /**
   * Assisted Notes' start acknowledgement timed out, its capability check refused, or no hello
   * ever arrived — `startCaptureOnActiveNote()`'s `not-started` branch calls this rather than
   * `finishRuntime()`, because nothing here was ever driven to "capturing" in the sense that
   * path expects: there is no finalized transcript worth a closing enhancement pass, and
   * "Shorthand stopped taking notes" would tell the user a capture had run when it never actually
   * started recording. Unlike `forceStopCapture()` this can and does await the follower's exit
   * and the sidecar's flush, since it runs from inside the start sequence, not a shutdown hook.
   */
  private async abortCaptureStart(runtime: CaptureRuntime): Promise<void> {
    if (this.#capture !== runtime) return;
    runtime.stopping = true;
    runtime.enhancer?.stopLiveTicks();
    runtime.client.forceStop();
    await runtime.settled;
    await runtime.sidecar?.close().catch(() => {});
    await runtime.enhancer?.dispose().catch((error: unknown) => {
      this.fail(`Agent session cleanup failed: ${errorMessage(error)}`);
    });
    if (this.#capture === runtime) this.#capture = undefined;
    // Not `capture-stopped`: this path exists precisely because no recording ever
    // started, and reporting a stopped capture tells the user something ran.
    this.dispatch({ type: "capture-start-failed" });
    this.syncIdleFollower();
  }

  /** Start or stop the idle follower to match the setting and the capture state. */
  private syncIdleFollower(): void {
    const wanted = this.settings.followAppRecording && this.#capture === undefined;
    if (!wanted) { this.stopIdleFollower(); return; }
    if (this.#idleFollower !== undefined) return;
    const client = new StreamClient({
      command: this.shorthandCommand(),
      args: DEFAULT_CONFIG.followStreamArgs,
      maxReconnectAttempts: DEFAULT_CONFIG.reconnect.maxAttempts,
      backoffMs: DEFAULT_CONFIG.reconnect.backoffMs,
      drainTimeoutMs: DEFAULT_CONFIG.drainTimeoutMs,
    });
    this.#idleFollower = client;
    this.#idleAppAdvertisesMode = false;
    client.on("event", ({ generation, record }) => {
      if (record.t === "hello") {
        this.#idleAppAdvertisesMode = record.capabilities?.includes("begin-mode") === true;
        return;
      }
      // Deliberately no `return` here: `onAppRecordingBegan` decides synchronously, so by
      // the time control reaches the buffering check below, `#idlePendingAttachSession` is
      // already set if this `begin` is one to attach to — and the `begin` itself is worth
      // buffering too, not just what follows it. Core's `ingest()` can reconstruct a session
      // it never saw `begin` for, but only with an ordering floor of zero; replaying the
      // real `begin` gives it the real one.
      if (record.t === "begin") this.onAppRecordingBegan(record.mode, record.session);
      // Buffers every record for the session `onAppRecordingBegan` just decided to attach
      // to, for exactly the window before the capture's own listener takes over — see
      // `#idlePendingAttachSession`'s and `#idlePendingAttachBuffer`'s own comments. A no-op
      // whenever nothing is pending, which is true for almost every record this follower
      // ever sees: only that one window buffers anything at all.
      if (this.#idlePendingAttachSession !== undefined) {
        this.#idlePendingAttachBuffer = pushPendingAttachRecord(
          this.#idlePendingAttachBuffer,
          this.#idlePendingAttachSession,
          { generation, record },
        );
      }
    });
    // `settled`, not `processError`/`giveUp`. A Shorthand that is not running exits the
    // follower with code 2 before any hello, which StreamClient treats as terminal: it
    // deactivates and emits only this — never `processError` or `giveUp`. A follower
    // listening only for those two would be silently dead after its first attempt, and
    // "open Obsidian, start Shorthand later" is the ordinary order users hit this in.
    client.once("settled", () => {
      if (this.#idleFollower !== client) return;
      this.#idleFollower = undefined;
      this.#idleAppAdvertisesMode = false;
      this.scheduleIdleRetry();
    });
    // Deliberately quiet otherwise: an idle follower failing means Shorthand is not
    // running, which is the normal state of a vault that is not in a meeting. A Notice
    // would fire at a user who asked for nothing. Capture reports its own failures.
    client.start();
  }

  private scheduleIdleRetry(): void {
    if (this.#idleRetry !== undefined) return;
    if (!this.settings.followAppRecording || this.#capture !== undefined) return;
    this.#idleRetry = window.setTimeout(() => {
      this.#idleRetry = undefined;
      this.syncIdleFollower();
    }, IDLE_FOLLOWER_RETRY_MS);
  }

  private stopIdleFollower(): void {
    if (this.#idleRetry !== undefined) { window.clearTimeout(this.#idleRetry); this.#idleRetry = undefined; }
    this.#idleFollower?.forceStop();
    this.#idleFollower = undefined;
    this.#idleAppAdvertisesMode = false;
  }

  /**
   * Release the idle follower for a capture to adopt, without stopping it. The idle
   * listeners come off first, so the capture's own handler is the only one left.
   */
  private adoptIdleFollower(): StreamClient | undefined {
    const client = this.#idleFollower;
    if (client === undefined) return undefined;
    client.removeAllListeners("event");
    client.removeAllListeners("settled");
    this.#idleFollower = undefined;
    if (this.#idleRetry !== undefined) { window.clearTimeout(this.#idleRetry); this.#idleRetry = undefined; }
    return client;
  }

  /** `mode` is whatever the wire carried; `decideFollow` is what validates it. */
  private onAppRecordingBegan(mode: unknown, session: number | undefined): void {
    const decision = decideFollow({
      mode,
      state: this.#state,
      hasActiveNote: this.hasActiveNote(),
      followEnabled: this.settings.followAppRecording,
      appAdvertisesMode: this.#idleAppAdvertisesMode,
    });
    if (decision.kind === "needs-newer-app") {
      if (this.#warnedAboutAppVersion) return;
      this.#warnedAboutAppVersion = true;
      new Notice(
        "This Shorthand build does not say which mode a recording is, so Obsidian cannot follow it. Update Shorthand and try again.",
        10_000,
      );
      return;
    }
    if (decision.kind === "ignore") return;
    this.#idlePendingAttachSession = session;
    this.#idlePendingAttachBuffer = EMPTY_PENDING_ATTACH_BUFFER;
    // Conditional spread, not `{ attachToSession: session }`: `exactOptionalPropertyTypes`
    // forbids assigning an explicit `undefined` to `attachToSession`, and `session` here can
    // be `undefined` in principle even though a real `begin` record always carries one.
    void this.startCaptureOnActiveNote(
      decision.mode,
      session === undefined ? {} : { attachToSession: session },
    ).finally(() => {
      // A successful attach already claimed and cleared this via `drainPendingAttachBuffer`
      // — see the zero-`await` note at its call site for why that claim cannot be beaten by
      // a record arriving late. If the field still names this session, the attempt never
      // got that far (`canStartCapture` refused it, or it aborted or threw before adoption),
      // and whatever accumulated has nowhere to go: discard it rather than let it leak into
      // whatever attach happens next.
      if (this.#idlePendingAttachSession === session) {
        this.#idlePendingAttachSession = undefined;
        this.#idlePendingAttachBuffer = EMPTY_PENDING_ATTACH_BUFFER;
      }
    });
  }

  /**
   * Hands back whatever the idle listener buffered for `session` while this capture was
   * starting up, and claims it — clearing the pending fields so the `finally` in
   * `onAppRecordingBegan` knows this attach reached adoption and does not also discard it.
   *
   * Must be called with no `await` since the idle listener last ran — i.e. right after the
   * capture's own `client.on("event", …)` handler is registered, which the call site also
   * replays this buffer through. An `await` inserted anywhere in that stretch would let a
   * real record slip in ahead of this call with nothing watching for it — the exact hole
   * `#idlePendingAttachSession` exists to close.
   */
  private drainPendingAttachBuffer(session: number): PendingAttachBuffer {
    if (this.#idlePendingAttachSession !== session) return EMPTY_PENDING_ATTACH_BUFFER;
    const buffer = this.#idlePendingAttachBuffer;
    this.#idlePendingAttachSession = undefined;
    this.#idlePendingAttachBuffer = EMPTY_PENDING_ATTACH_BUFFER;
    return buffer;
  }

  async enhanceActiveNote(): Promise<void> {
    await this.runEnhancement("enhance-now");
  }

  async cleanUpActiveNote(): Promise<void> {
    await this.runEnhancement("clean-up-this-note");
  }

  /**
   * Both enhancement commands, which differ only in where the text comes from. The choice
   * itself is `resolveEnhanceMode` in src/, because nothing here can be imported under
   * bun test; what is left here is the file and vault plumbing that has to touch Obsidian.
   */
  private async runEnhancement(command: EnhanceCommandId): Promise<void> {
    const file = this.activeMarkdownFile();
    if (file === undefined) return;
    const vaultRoot = this.vaultRoot();
    if (vaultRoot === undefined) return;
    const noteSink = this.noteSink(file, vaultRoot);
    try {
      // Two separate facts, deliberately. A capture survives a failed createEnhancer, so
      // "is a capture running here" and "does it have a runner" are not the same question,
      // and collapsing them would let a second enhancer start on a note a capture still owns.
      const captureOnThisNote = this.#capture?.noteFile === file;
      const liveEnhancer = captureOnThisNote ? this.#capture?.enhancer : undefined;
      const noteContent = await noteSink.readContent();
      if (!noteContent.ok) throw new Error(noteContent.message);
      const mode = resolveEnhanceMode({
        command,
        captureOnThisNote,
        captureEnhancerReady: liveEnhancer !== undefined,
        transcriptLink: transcriptWikilink(noteContent.content),
        writeTranscriptNote: this.settings.writeTranscriptNote,
      });
      // Resolved before scaffolding, and returned here on refusal, so that a command which
      // declines never has side effects to show for it: ensureScaffold can pop a confirmation
      // modal and write marker text into the note, and a refusal that did that first would have
      // silently changed the note on its way to telling the user it changed nothing.
      if (mode.kind === "unavailable") {
        this.fail(mode.message);
        return;
      }
      if (!await this.prepareScaffold(noteSink)) return;
      switch (mode.kind) {
        case "live-capture":
          // `liveEnhancer` is what made this mode reachable; re-checking is for the compiler.
          if (liveEnhancer === undefined) return;
          this.reportOutcome(await liveEnhancer.enhanceNow("link"), command);
          return;
        case "transcript": {
          const sidecar = this.app.metadataCache.getFirstLinkpathDest(linkTarget(mode.transcriptLink), file.path);
          if (sidecar === null || sidecar === file) {
            this.fail("The note's shorthand-transcript link does not resolve to a separate vault note.");
            return;
          }
          const transcript = await this.app.vault.read(sidecar);
          const enhancer = await this.createEnhancer(
            noteSink,
            DEFAULT_CONFIG.enhancement.standaloneTimeoutMs,
            inferTranscriptNoteTakingMode(transcript),
          );
          try {
            enhancer.appendTranscript(transcript);
            this.reportOutcome(await enhancer.enhanceNow("link"), command);
          } finally {
            await enhancer.dispose();
          }
          return;
        }
        case "notes-only": {
          const enhancer = await this.createEnhancer(
            noteSink,
            DEFAULT_CONFIG.enhancement.standaloneTimeoutMs,
            "assisted-notes",
          );
          try {
            // No appendTranscript, and core's empty-transcript gate would decline forever
            // without the waiver. The note's own prose reaches the model as `user_notes`.
            this.reportOutcome(await enhancer.enhanceNow("link", { allowEmptyTranscript: true }), command);
          } finally {
            await enhancer.dispose();
          }
          return;
        }
        default: {
          const unhandled: never = mode;
          throw new Error(`Unhandled enhancement mode: ${JSON.stringify(unhandled)}`);
        }
      }
    } catch (error) {
      this.fail(`Enhancement failed: ${errorMessage(error)}`);
    }
  }

  /**
   * One resolution for both the follower and every control child. Resolving twice would
   * let them land on different binaries once a setting changes mid-capture, and a control
   * signal delivered to a different Shorthand install than the one being followed is silent.
   */
  private shorthandCommand(): string {
    // detectShorthandExecutable defers to SHORTHAND_BIN only when its override argument is
    // nullish (`??`), not merely empty, so a blank setting has to become `undefined` here
    // rather than passing "" straight through: pass "" instead, and every user who leaves
    // this field blank would silently skip the SHORTHAND_BIN fallback and land straight in
    // the PATH search.
    return detectShorthandExecutable(this.settings.shorthandExecutable || undefined);
  }

  /**
   * The standalone commands: a one-off signal that belongs to no capture sequence, so the
   * outcome is only reported, never awaited. Capture works perfectly well with Shorthand's own
   * hotkey, so a missed toggle must never abort or unwind a capture that is otherwise
   * healthy.
   */
  private fireControl(signal: ControlSignal): void {
    const control = this.#capture?.control ?? new ShorthandControl({ command: this.shorthandCommand() });
    void control.send(signal).then(
      (result) => this.reportControl("manual", result),
      (error: unknown) => this.fail(`Shorthand control failed: ${errorMessage(error)}`),
    );
  }

  /**
   * `mode` is only consulted for phase `"start"`, which is the one notice that has to name a
   * specific recovery command — see `START_NOT_RUNNING`. Every other phase's wording is fixed
   * regardless of which mode was being started.
   */
  private reportControl(phase: RecorderPhase | "manual", result: ControlResult, mode?: CaptureMode): void {
    // Logged before the early return: a `sent` signal is the majority of what happens and was
    // the half of the sequence nothing could see, which is precisely what made a misbehaving
    // stop impossible to diagnose after the fact.
    this.debugCapture(describeControl(phase, result));
    if (result.status === "sent") return;
    if (result.status === "not-running") {
      new Notice(phase === "start" ? START_NOT_RUNNING(mode ?? "meeting") : NOT_RUNNING_NOTICES[phase], 10_000);
      return;
    }
    this.fail(`Shorthand control failed: ${result.message}`);
  }

  private async createEnhancer(
    sink: ObsidianNoteSink,
    timeoutMs: number,
    mode: CaptureMode,
  ): Promise<EnhanceRunner> {
    const backend = this.settings.backend;
    const configuredClaude = this.settings.claudeExecutable;
    const guidance = mode === "assisted-notes"
      ? this.settings.assistedNotesNoteTakingGuidance
      : this.settings.meetingNoteTakingGuidance;
    let claudeExecutable: string | undefined;
    let agent: ClaudeAgentClient | CodexAgentClient | LlmAgentClient | AcpAgentClient;
    if (backend === "claude-agent-sdk") {
      if (configuredClaude.length > 0 && !existsSync(configuredClaude)) {
        throw new Error(`claude.exe was not found at "${configuredClaude}". Update the path in Shorthand settings.`);
      }
      claudeExecutable = detectClaudeExecutable(configuredClaude.length === 0 ? undefined : configuredClaude);
      if (claudeExecutable === undefined && process.platform === "win32") {
        throw new Error("claude.exe was not found. Install and log in to Claude CLI, or configure its full path in Shorthand settings.");
      }
      agent = new ClaudeAgentClient(claudeAgentOptions(this.settings));
    } else if (backend === "codex") {
      // A path is always passed, even when the user configured none, because the SDK's own
      // lookup cannot work here: left to itself it resolves `@openai/codex` relative to the file
      // it is running in, and that file is this bundle, installed at
      // `<vault>/.obsidian/plugins/shorthand/` with no `node_modules` at or above it. The SDK
      // defers that lookup to the first query(), so a bare client loads, saves and reports
      // healthy, then throws "Unable to locate Codex CLI binaries" mid-meeting.
      //
      // `detectCodexExecutable` is what makes the blank setting work: it searches PATH itself and
      // returns an absolute path the SDK can spawn. So blank is a working default here exactly as
      // it is for `claudeExecutable`, and only a genuinely absent Codex reaches the throw below.
      //
      // Both checks run on the resolved path rather than on the stored one, because
      // detectCodexExecutable also honours SHORTHAND_CODEX_EXE; testing the setting alone would
      // skip a path this plugin is about to spawn. A configured path is returned unverified —
      // core resolves it without stat'ing — so existsSync is still what makes a typo fail here,
      // naming the field, instead of failing inside the SDK on the first pass.
      const configuredCodex = this.settings.codexExecutable;
      const codexExecutable = detectCodexExecutable(configuredCodex.length === 0 ? undefined : configuredCodex);
      if (codexExecutable === undefined) {
        throw new Error("Codex was not found on PATH. Install the Codex CLI and run \"codex login\", or enter the full path to the codex program in \"Codex executable\" under Advanced in Shorthand settings.");
      }
      if (!existsSync(codexExecutable)) {
        throw new Error(`Codex was not found at "${codexExecutable}". Update "Codex executable" in Shorthand settings, or clear it to find Codex on PATH.`);
      }
      agent = new CodexAgentClient({
        codexPathOverride: codexExecutable,
        ...codexAgentOptions(this.settings),
      });
    } else if (backend === "acp") {
      if (this.settings.acpTransport === "network") {
        const url = this.settings.acpNetworkUrl.trim();
        if (url.length === 0) {
          throw new Error("ACP network URL is required when using network transport. Configure the URL in Shorthand settings.");
        }
        agent = new AcpAgentClient({
          transport: {
            type: "network",
            url,
            ...(this.settings.acpAuthToken.length === 0 ? {} : { authToken: this.settings.acpAuthToken }),
          },
          ...(this.settings.acpModel.length === 0 ? {} : { model: this.settings.acpModel }),
        });
      } else {
        const configuredAcp = this.settings.acpExecutable;
        const acpExecutable = detectCursorExecutable(configuredAcp.length === 0 ? undefined : configuredAcp);
        if (acpExecutable === undefined) {
          throw new Error("Cursor or ACP agent executable was not found on PATH. Install Cursor or an ACP agent CLI, or configure its full path in Shorthand settings.");
        }
        if (!existsSync(acpExecutable)) {
          throw new Error(`ACP executable was not found at "${acpExecutable}". Update "ACP executable" in Shorthand settings, or clear it to find Cursor automatically.`);
        }
        const args = this.settings.acpArgs.trim().length > 0
          ? this.settings.acpArgs.trim().split(/\s+/)
          : [];
        agent = new AcpAgentClient({
          transport: {
            type: "stdio",
            command: acpExecutable,
            args,
          },
          ...(this.settings.acpModel.length === 0 ? {} : { model: this.settings.acpModel }),
        });
      }
    } else {
      const credentialsPath = llmCredentialsPath();
      const credentials = await readLlmCredentials(credentialsPath);
      if (!credentials.ok) throw new Error(credentials.message);
      agent = new LlmAgentClient({
        credentials: credentials.value,
        credentialsPath,
        fetch: createRequestUrlFetch(requestUrl),
      });
    }
    // Snapshotted, not read live: core takes traceMachine once at construction, so reading
    // the setting live for statuses would let the two streams disagree mid-capture.
    const debugLogging = this.settings.debugLogging;
    return new EnhanceRunner({
      sink,
      agent,
      mode,
      ...(this.settings.userName.length === 0 ? {} : { userName: this.settings.userName }),
      minNewChars: this.settings.minNewChars,
      minIntervalMs: this.settings.minIntervalMs,
      // Conditional spread, like pathToClaudeCodeExecutable below: `exactOptionalPropertyTypes`
      // forbids handing over an explicit `undefined`, and an empty setting has to mean "core
      // picks the guidance", not "run with no editorial instruction at all".
      ...(guidance.length === 0 ? {} : { guidance }),
      maxDurationMs: DEFAULT_CONFIG.enhancement.maxDurationMs,
      // This bound belongs to the runner, not the individual call: there is one runner per
      // capture, so its closing pass inherits the live bound. Unlike the core CLI's retry ladder,
      // the plugin issues that pass once: if it exceeds the bound, only the closing summary is
      // lost. Standalone "Enhance now" builds its own runner and gets the longer one-shot bound.
      timeoutMs,
      maxTurns: DEFAULT_CONFIG.enhancement.maxTurns,
      ...(claudeExecutable === undefined ? {} : { pathToClaudeCodeExecutable: claudeExecutable }),
      // Both together, or neither: core routes its error log to `logger` only when no
      // `onStatus` is supplied, and we always supply one — so without `traceMachine` a
      // logger here would be silent. The trace is the whole point of the toggle.
      ...(debugLogging ? { logger: console, traceMachine: true } : {}),
      onStatus: (status) => this.onEnhanceStatus(status, debugLogging),
    });
  }

  private async prepareScaffold(sink: ObsidianNoteSink): Promise<boolean> {
    const preflight = await preflightMarkers(sink);
    if (preflight.status === "error") {
      this.fail(preflight.message);
      return false;
    }
    if (preflight.status === "needs-scaffold"
      && !this.settings.autoScaffold
      && !await confirmScaffold(this.app)) return false;
    return this.ensureScaffold(sink);
  }

  private async ensureScaffold(sink: ObsidianNoteSink): Promise<boolean> {
    const result = await scaffoldAfterPreflight(sink, resolveTemplateSections(this.settings.templateSectionText));
    if (result.ok) return true;
    this.fail(result.message);
    return false;
  }

  private async finishRuntime(runtime: CaptureRuntime, reason: "stopped" | "died"): Promise<void> {
    if (this.#capture !== runtime) return;
    // Backstop, once nothing is left to finalize: the mode's own stop signal is a no-op
    // against an idle Shorthand, so firing it costs nothing and is the only thing that
    // guarantees a capture cannot leave Shorthand recording when the belief about its state
    // was wrong. Only for a capture that drove the recorder in the first place — otherwise
    // this would stop a recording the user started by hand. It is the mode's stop rather
    // than `--cancel` because it is scoped to this capture's own mode and, unlike a cancel,
    // leaves Shorthand's own copy of the recording finalized rather than discarded.
    if (runtime.recorder !== undefined && !runtime.shorthandDown) {
      const stoppingBlind = reason === "died" && runtime.recorder.mayBeRecording;
      runtime.recorder.backstop();
      if (stoppingBlind) {
        // Deliberate: leaving the microphone hot is the failure this whole sequence exists
        // to prevent, and it outranks waiting for a `final` no follower is left to receive.
        new Notice(
          "The Shorthand recording in progress was stopped: the transcript stream ended, so nothing was left to receive its final transcript. Already-transcribed text is kept in this note; Shorthand's corrected version stays in Shorthand.",
          10_000,
        );
      }
    }
    try {
      try {
        await runtime.sidecar?.close();
        await runtime.enhancer?.waitForIdle();
        if (reason === "stopped" && runtime.enhancer !== undefined) {
          // Not issued from either command: this is capture's own finishing pass. "Enhance now"
          // is still the right retry, since it is the command that resumes work on a note this
          // capture already owns.
          this.reportOutcome(await runtime.enhancer.enhanceNow("link"), "enhance-now");
        }
      } finally {
        await runtime.enhancer?.dispose();
      }
      new Notice("Shorthand stopped taking notes.");
    } catch (error) {
      this.fail(`Wrapping up failed: ${errorMessage(error)}`);
    } finally {
      if (this.#capture === runtime) this.#capture = undefined;
      this.dispatch({ type: "capture-stopped" });
      this.syncIdleFollower();
    }
  }

  private async captureSettled(runtime: CaptureRuntime, diagnosis: ExitDiagnosis): Promise<void> {
    if (runtime.stopping || this.#capture !== runtime) return;
    runtime.stopping = true;
    // The follower is gone, so nothing can observe a recording any more. Recall an in-
    // flight start sequence for the same reason a Stop press does.
    runtime.recorder?.requestStop();
    // And wait for that recall to actually land before the runtime is dropped. Unlike
    // `stopCapture`, nothing on this path awaits `stop()`, so without this the cancel of a
    // dead capture's start sequence could still be in flight when the user starts the next
    // capture — and land on the recording that capture had just started.
    await runtime.recorder?.whenStartSettled();
    if (!diagnosis.clean) this.fail(streamExitMessage(diagnosis));
    this.dispatch({ type: "capture-stopping" });
    await this.finishRuntime(runtime, "died");
  }

  /**
   * A `switch` with a `never` default, not an if/else chain. This handler previously
   * dropped statuses it did not name, and shorthand-core 0.10.0 added three kinds:
   * a silent fall-through would have hidden `disabled-for-read-failures`, after which
   * enhancement is off for the rest of the capture and the user is never told. The
   * default branch turns the next added kind into a compile error instead.
   */
  private onEnhanceStatus(status: EnhanceStatus, debugLogging = this.settings.debugLogging): void {
    // Before the switch, so the two intentionally silent outcomes are still observable.
    if (debugLogging) console.debug(`[shorthand:status] ${JSON.stringify(status)}`);
    switch (status.kind) {
      case "started":
        this.dispatch({ type: "enhancement-started" });
        return;
      case "finished":
        this.dispatch({ type: "enhancement-finished" });
        return;
      case "expired":
        this.dispatch({ type: "enhancement-stopped", message: status.message });
        new Notice(status.message, 8_000);
        return;
      case "disabled-for-read-failures":
        // Terminal for this capture: the note could not be read repeatedly and the
        // kill switch never resets. Before 0.10.0 this arrived as `error`, so losing
        // it here would silently strand enhancement for the rest of the meeting.
        this.dispatch({ type: "enhancement-stopped", message: status.message });
        new Notice(status.message, 8_000);
        return;
      case "error":
      case "skipped":
        // Dispatched before `fail()`, not after: `fail()` dispatches its own sticky
        // `error`, and this pass's slot has to be released without disturbing it.
        // `enhancement-finished` would also release the slot, but it additionally clears
        // a sticky `error`/`enhancement-stopped` via `restingMode` — the reward for a pass
        // that actually completed. This pass didn't, so nothing here may fix what `fail()`
        // is about to report as broken.
        this.dispatch({ type: "enhancement-ended" });
        this.fail(status.message);
        return;
      case "requeued":
        // `enhancement-ended` fires on both branches below, including the silent one: a
        // plain re-queue (no `retryAfterMs`) is the routine case — the note kept changing
        // under the writer, i.e. the user typing during the meeting — and it still has to
        // release the slot `started` claimed, or the depth never returns to zero and the
        // status bar reads "· writing" for the rest of the capture. Only a target that
        // asked for a backoff is actionable as a `Notice`.
        //
        // Writing through Obsidian, the note itself is never the busy party, so the
        // `Notice` reports the delay without advising a remedy that would not apply.
        this.dispatch({ type: "enhancement-ended" });
        if (status.retryAfterMs !== undefined) {
          this.fail(`${status.message} Shorthand will retry on the next pass.`);
        }
        return;
      case "timed-out":
        // Self-healing like a re-queue: the transcript is kept and retried. Only the
        // eventual drop at the re-queue limit loses data, and that arrives as `error`.
        // Still releases the slot `started` claimed — see the `requeued` comment above.
        this.dispatch({ type: "enhancement-ended" });
        return;
      case "declined":
        // Fires whenever a gate holds, which is most stream events. Never user-facing.
        return;
      default: {
        const unhandled: never = status;
        throw new Error(`Unhandled enhancement status: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  /**
   * `command` names the retry the requeued-with-backoff message points at. The three
   * `runEnhancement` call sites pass through the command that produced their route; the
   * automatic post-capture pass at `finishRuntime` names "enhance-now" itself, since it
   * belongs to no user command. Passing the wrong one would send a "notes-only" user (who can
   * only have run "Clean up this note") to "Enhance now", which then refuses for lack of a
   * transcript link — a dead end dressed up as guidance.
   */
  private reportOutcome(outcome: PassOutcome, command: EnhanceCommandId): void {
    if (outcome.status === "completed") {
      // No `enhancement-finished` here: core emitted a `finished` status before
      // returning this outcome, and `onEnhanceStatus` already dispatched for it.
      // Both firing double-decrements the pass counter, which ends the `enhancing`
      // state while a second, overlapping pass is still writing.
      new Notice(outcome.written ? "Shorthand updated the AI block." : "The AI block was already up to date.");
    } else if (outcome.status === "expired") {
      // Same reason: `onEnhanceStatus`'s `expired` arm owns the dispatch and the Notice.
    } else if (outcome.status === "requeued") {
      this.fail(outcome.retryAfterMs === undefined
        ? `Enhancement was safely re-queued (${outcome.reason}).`
        : `The meeting note was busy. Run ${enhanceCommandName(command)} again in a moment.`);
    } else if (outcome.status === "failed") {
      this.fail(outcome.error);
    } else if (outcome.status === "timed-out") {
      this.fail(`Enhancement did not complete (${outcome.status}).`);
    }
  }

  /**
   * `getActiveFile()`, not `getActiveViewOfType(MarkdownView)?.file`: this resolves the file
   * a start actually captures into, and a start can be triggered from the panel — a sidebar
   * view, which becomes the active *leaf* the moment it is revealed. Resolving through the
   * active leaf would then answer "no note is open" while a note plainly sits in the main
   * pane. `getActiveFile()` tracks the active file independent of which leaf has focus, which
   * is exactly what a panel-initiated (or follow-initiated) start needs. `openEditor()`
   * already searches all markdown leaves by file rather than by view, so nothing downstream
   * of this depends on the active view either.
   */
  private activeMarkdownFile(): TFile | undefined {
    const file = this.app.workspace.getActiveFile();
    if (file !== null && file.extension === "md") return file;
    new Notice("Open a Markdown note before running Shorthand.");
    return undefined;
  }

  private noteSink(file: TFile, vaultRoot: string): ObsidianNoteSink {
    return new ObsidianNoteSink({
      file,
      agentContext: { cwd: vaultRoot },
      api: {
        vault: this.app.vault,
        openEditor: (target) => this.openEditor(target),
      },
    });
  }

  /**
   * The editor holding `file`, in whichever leaf holds it. Deliberately not
   * `getActiveViewOfType`: Obsidian keeps a separate unsaved buffer per leaf,
   * so a note in a split or a background tab can be holding keystrokes that its
   * file does not have yet. Writing such a note through the Vault would put the
   * update underneath that buffer, and the buffer wins on its next save.
   */
  private openEditor(file: TFile): Readonly<{ editor: Editor; save(): Promise<void> }> | undefined {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || view.file !== file) continue;
      return { editor: view.editor, save: () => view.save() };
    }
    return undefined;
  }

  /**
   * Convert a wikilink into a Vault store, never an operating-system path.
   * MetadataCache is authoritative for an existing target (including aliases
   * and renamed files); only a missing generated target falls back to its
   * vault-relative link text so Vault.create can make it on first flush.
   */
  private sidecarStore(note: TFile, link: string, resolved: TFile | null): ObsidianSidecarStore | undefined {
    // Only an unresolved link falls back to being read as a path, and a link is
    // not a path: `[[Note#Section]]` names a heading inside a note, so the
    // subpath has to come off before either half is used. What is left can be
    // empty — `[[#Section]]` points into the meeting note itself — and an empty
    // name would otherwise become a file called `.md` at the vault root.
    const target = linkTarget(link);
    const path = resolved?.path ?? (target === "" ? "" : normalizePath(addMarkdownExtension(target)));
    if (!isVaultMarkdownPath(path) || resolved === note || path === note.path) {
      this.fail("The shorthand-transcript link must name a separate Markdown note inside this vault.");
      return undefined;
    }
    return new ObsidianSidecarStore({
      api: {
        vault: this.app.vault,
        openEditor: (target) => this.openEditor(target),
      },
      path,
      ...(resolved === null ? {} : { file: resolved }),
    });
  }

  /**
   * The `checkCallback` predicate for both enhancement commands. Silent, unlike
   * `activeMarkdownFile`: Obsidian calls this while merely rendering the command palette,
   * so a Notice here would fire at a user who never chose the command.
   */
  private hasActiveMarkdownFile(): boolean {
    const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
    return file !== null && file !== undefined;
  }

  /**
   * The panel and follow predicate. Silent, like `hasActiveMarkdownFile`, but built on
   * `getActiveFile()` rather than the active view: both callers ask this from a context that
   * is never the note's own leaf — the panel is a sidebar view that becomes the active leaf
   * the instant it is revealed, and `onAppRecordingBegan` fires from a stream event, not a
   * user action on any leaf — so resolving through the active leaf would answer the wrong
   * question (see `activeMarkdownFile`'s comment). `hasActiveMarkdownFile` stays as it is for
   * the command palette: opening the palette does not move the active leaf, so it asks the
   * right question already, and churning a predicate that is correct and well-commented would
   * only cost review time.
   */
  private hasActiveNote(): boolean {
    return this.activeNote() !== undefined;
  }

  /** The note `hasActiveNote` is answering about, for callers that need the file itself. */
  private activeNote(): TFile | undefined {
    const file = this.app.workspace.getActiveFile();
    return file !== null && file.extension === "md" ? file : undefined;
  }

  private vaultRoot(): string | undefined {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    this.fail("Shorthand requires a desktop filesystem-backed Obsidian vault.");
    return undefined;
  }

  /**
   * One line per capture lifecycle event, when Debug logging is on. `console.debug`, like
   * `onEnhanceStatus`'s trace, so the two halves of a capture read as one stream in the
   * developer console. Silent otherwise: this fires several times per capture and once per
   * lifecycle record, which is noise for anyone not diagnosing a capture.
   */
  private debugCapture(message: string): void {
    if (!this.settings.debugLogging) return;
    console.debug(`[shorthand:capture] ${message}`);
  }

  private fail(message: string): void {
    this.dispatch({ type: "error", message });
    new Notice(`Shorthand: ${message}`, 10_000);
    console.error(`[shorthand] ${message}`);
  }

  private dispatch(event: PluginUiEvent): void {
    this.#state = reducePluginState(this.#state, event);
    this.#render();
  }

  /** The panel's whole view of the world, assembled from the same facts the status bar uses. */
  panelModel(): PanelModel {
    return describePanel({
      state: this.#state,
      elapsedMs: this.#capture === undefined ? undefined : Date.now() - this.#capture.startedAt,
      noteName: this.#capture?.noteFile.basename,
      notePath: this.#capture?.noteFile.path,
      activeNoteName: this.activeNote()?.basename,
      activeNotePath: this.activeNote()?.path,
      captureMode: this.#capture?.mode ?? this.#requestedCaptureMode,
      hasActiveNote: this.hasActiveNote(),
      hasCapture: this.#capture !== undefined,
    });
  }

  runPanelAction(id: PanelButtonId): void {
    if (id === "stop") {
      void this.stopCapture().catch((error: unknown) => this.fail(errorMessage(error)));
      return;
    }
    void this.startCaptureOnActiveNote(id === "start-assisted-notes" ? "assisted-notes" : "meeting");
  }

  /**
   * Open the note the panel's link names — the capture's own while one runs, otherwise the
   * focused note an idle start would write to — without confusing the sidebar for its target.
   */
  async openPanelNote(newTab: boolean): Promise<void> {
    const file = this.#capture?.noteFile ?? this.activeNote();
    if (file === undefined) return;
    if (!newTab) {
      const existing = this.app.workspace.getLeavesOfType("markdown").find((leaf) =>
        leaf.view instanceof MarkdownView && leaf.view.file === file
      );
      if (existing !== undefined) {
        await this.app.workspace.revealLeaf(existing);
        return;
      }
    }
    await this.app.workspace.getLeaf(newTab ? "tab" : false).openFile(file);
  }

  #renderPanel(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(SHORTHAND_PANEL_VIEW)) {
      const view = leaf.view;
      if (view instanceof ShorthandPanelView) view.render();
    }
  }

  /**
   * Reveal the panel, creating it if the workspace has none. `getRightLeaf(false)` can
   * return null on a workspace with no right sidebar, which is why this is guarded rather
   * than chained.
   */
  private async revealPanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(SHORTHAND_PANEL_VIEW);
    const leaf = existing[0] ?? this.app.workspace.getRightLeaf(false);
    if (leaf === null || leaf === undefined) return;
    if (existing.length === 0) await leaf.setViewState({ type: SHORTHAND_PANEL_VIEW, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  /**
   * Both surfaces, always together. Deliberately not `#renderPanel()` appended to
   * `#renderStatus()`: that method returns early when the status bar is hidden, which
   * is exactly the idle transition the panel most needs to hear about.
   */
  #render(): void {
    this.#renderStatus();
    this.#renderPanel();
  }

  #renderStatus(): void {
    if (this.#statusBar === undefined) return;
    const display = describeStatus({
      state: this.#state,
      elapsedMs: this.#capture === undefined ? undefined : Date.now() - this.#capture.startedAt,
    });
    // `hide()`/`show()` rather than clearing the text: an item holding "" still
    // occupies its separator, which is the space this change exists to reclaim.
    if (!display.visible) {
      this.#statusBar.hide();
      return;
    }
    this.#statusBar.show();
    this.#statusBar.setText(display.text);
    this.#statusBar.setAttribute("title", display.tooltip);
  }
}

/**
 * Every key the settings tab's `control` definitions read and write through
 * `getControlValue`/`setControlValue`, plus `minIntervalSeconds` — a UI-only key with no
 * matching settings field: the tab shows and edits `minIntervalMs` in seconds, so this key
 * carries that unit conversion through the same generic get/set path every other control uses,
 * rather than giving the interval row a bespoke `render` callback.
 */
type SettingsKey = keyof ShorthandPluginSettings | "minIntervalSeconds";

class ShorthandSettingTab extends PluginSettingTab {
  /**
   * The most recent catalog fetched for each agent backend, read by that backend's sign-in row
   * `visible` predicate (see `agentCatalogItem`) and written when its model row's `render`
   * callback's fetch lands. Lives on the tab instance rather than inside that `render`'s own
   * closure because `visible` is a sibling property the framework evaluates independently of
   * `render` — a closure-local variable would be out of scope for it. Cleared when the model
   * row is torn down, so a fresh render always starts the sign-in row from "unknown" (hidden)
   * rather than the previous selection's stale answer.
   */
  #agentCatalogs: Map<"claude" | "codex" | "acp", AgentCatalog> = new Map();

  /**
   * Each agent backend's effort row, registered by that row's own `render` and read by the
   * model row's `render`, which owns the catalog fetch and applies its result to both rows (see
   * `agentCatalogItem`). Two sibling definitions with separate `render` closures cannot share
   * a local — the same reason `#agentCatalogs` lives here — and the effort row cannot be built
   * *inside* the model row's `render` through `group.addSetting`: Obsidian renders a group's
   * declared items and then resets the group's `listEl` to exactly those rows'
   * elements, which removes any row appended from a callback. test/settings-tab-source.test.ts
   * keeps that from coming back. Cleared by the effort row's cleanup so a fetch that lands after
   * the row is torn down finds nothing to write into.
   */
  #effortRows: Map<"claude" | "codex", { row: Setting; dropdown: DropdownComponent }> = new Map();

  /**
   * The editor behind the five "LLM provider profile" rows, created by the status row's
   * `render` and attached to by the four field rows' renders (see `llmProfileGroup`). Same
   * constraint as `#effortRows`: the fields have to be declared items, so their shared state
   * lives here rather than in one row's closure.
   */
  #llmProfile: LlmProfileEditor | undefined;

  constructor(app: App, private readonly plugin: ShorthandPlugin) {
    super(app, plugin);
  }

  /**
   * Called on every re-render and once more when the tab is registered, purely to index its
   * rows for Obsidian's settings search — so this must stay a plain, side-effect-free read of
   * current settings. The agent catalog fetch and the LLM credential read are the two things
   * here that are neither: both sit inside a `render` callback (see `agentCatalogItem` and
   * `llmProfileGroup`), which Obsidian never invokes for the search-indexing pass. `render`
   * *does* run for every declared row on a display pass, including rows in a group whose
   * `visible` is false — visibility is applied afterwards, as CSS — so each of those callbacks
   * also checks the selected backend itself before spawning or reading anything.
   */
  getSettingDefinitions(): SettingDefinitionItem<SettingsKey>[] {
    return [
      ...this.basicDefinitions(),
      this.advancedGroup(),
    ];
  }

  /**
   * Bridges the plugin's own `saveSettings()`-based persistence to the declarative API's
   * per-key get/set contract. `minIntervalSeconds` is the one key with no settings field of its
   * own — see `SettingsKey`'s doc comment.
   */
  getControlValue(key: string): unknown {
    if (key === "minIntervalSeconds") return this.plugin.settings.minIntervalMs / 1_000;
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  /**
   * Overriding this replaces the framework's automatic `saveData()` call, so every branch
   * persists explicitly through `saveSettings()` — the same method every other write in this
   * plugin uses, which is what keeps `syncIdleFollower()` running after a settings-tab edit.
   *
   * A control's own row has no reactive `desc`, so a row whose description is computed from its
   * current value (docs/settings-copy-style.md rule 4) goes stale after a commit unless
   * `getSettingDefinitions()` runs again — `update()` is what re-runs it. `writeTranscriptNote`
   * gates a plain `control` row's `visible` predicate (the transcript folder row) and nothing
   * else about it — that row is already built, so re-evaluating the predicate is
   * `refreshDomState()`'s job and does not need a full rebuild. `backend`, though, gates rows
   * whose `render` callbacks (the agent model/effort rows, the LLM profile rows) skipped their
   * catalog fetch or credential read because the backend was not selected at the time — see
   * `getSettingDefinitions()`'s doc comment. `refreshDomState()` only toggles CSS on rows that
   * already exist; it cannot re-run a `render`. `backend` therefore goes through the full
   * `update()` rebuild instead, via `RESTRUCTURING_KEYS`.
   */
  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key === "minIntervalSeconds") {
      const seconds = typeof value === "number" ? value : Number(value);
      await this.plugin.saveSettings({ ...this.plugin.settings, minIntervalMs: seconds * 1_000 });
      this.update();
      return;
    }
    await this.plugin.saveSettings({ ...this.plugin.settings, [key]: value });
    if (RESTRUCTURING_KEYS.has(key)) {
      this.update();
    } else if (REVEALS_OTHER_ROWS.has(key)) {
      this.refreshDomState();
    } else if (SELF_DESCRIBING_KEYS.has(key)) {
      this.update();
    }
  }

  private basicDefinitions(): SettingDefinitionItem<SettingsKey>[] {
    return [
      {
        name: "Enhancement backend",
        desc: "Only Claude Code can look things up elsewhere in your vault.",
        control: {
          type: "dropdown",
          key: "backend",
          options: {
            "claude-agent-sdk": "Claude Code",
            codex: "Codex",
            acp: "Cursor / ACP Agent",
            llm: "LLM provider",
          } satisfies Record<EnhancementBackend, string>,
        },
      },
      // Each backend fetches its own catalog and renders its own sign-in row (shown only once
      // `signedIn: false` comes back — see agentCatalogItem's render callback), rather than an
      // if/else on a shared block, for the reason recorded on the LLM-profile branch below: a
      // third backend added later must not inherit a block written for a different one.
      this.agentCatalogItem("claude"),
      this.agentCatalogItem("codex"),
      this.acpCatalogGroup(),
      // Each half of this pair names its own backend rather than being an if/else, and that is
      // what keeps a third backend from inheriting a block written for a different one: Codex
      // wants neither the LLM profile rows nor the Claude executable field in Advanced. Turning
      // either test back into an else silently hands whichever block sits on that branch to
      // every backend added after it.
      this.llmProfileGroup(),
      {
        name: "Transcript notes",
        desc: "Each note-taking session also saves the raw transcript in its own linked note.",
        control: { type: "toggle", key: "writeTranscriptNote" },
      },
      {
        ...textControlItem("Transcript folder", transcriptFolderDescription, "sidecarDirectory", this.plugin.settings.sidecarDirectory),
        visible: () => this.plugin.settings.writeTranscriptNote,
      },
      {
        name: "Automatic note scaffolding",
        desc: "Shorthand adds its section markers to a note that has none, instead of asking you first.",
        control: { type: "toggle", key: "autoScaffold" },
      },
      this.noteWritingGroup(),
    ];
  }

  /**
   * "Note writing"'s heading and its introductory sentence are two separate items because
   * `SettingDefinitionGroup` has no `desc` field of its own — only `heading`. The sentence
   * becomes a nameless, control-less row instead: a plain label-and-description row with no
   * interactive element, the same shape `SettingDefinitionEmpty` describes.
   */
  private noteWritingGroup(): SettingDefinitionItem<SettingsKey> {
    // Which of the two are overridden, so the pane answers "am I on the defaults?" without
    // opening the window. Read fresh on every call, which is why the modal's onSaved callback
    // calls update() — otherwise this row would keep reporting the state from before the edit.
    const overridden = [
      this.plugin.settings.meetingNoteTakingGuidance.length > 0 ? "meeting prompt" : undefined,
      this.plugin.settings.assistedNotesNoteTakingGuidance.length > 0 ? "Assisted Notes prompt" : undefined,
      this.plugin.settings.templateSectionText.length > 0 ? "starting sections" : undefined,
    ].filter((label): label is string => label !== undefined);
    return {
      type: "group",
      heading: "Note writing",
      items: [
        { name: "", desc: "Shorthand's defaults change with each release. Anything you customize stays as you wrote it." },
        {
          name: "Name, prompts, and starting sections",
          desc: overridden.length === 0
            ? "Both follow Shorthand's defaults."
            : `Custom ${overridden.join(" and ")} in use.`,
          // A button with its own "Edit…" label, not a whole-row `action`: an action definition
          // renders the entire row as the click target with no button of its own, which would
          // drop the labelled button docs/settings-copy-style.md rule 6 explicitly keeps.
          render: (setting) => {
            setting.addButton((button) => button
              .setButtonText("Edit…")
              .onClick(() => new NotePromptModal(this.app, this.plugin, () => this.update()).open()));
          },
        },
      ],
    };
  }

  /**
   * The sign-in, model and effort rows for one agent backend — three declared items in one
   * unheaded `type: "group"`, so the backend's `visible` predicate governs all three at once.
   *
   * The effort row is declared, not appended from the model row's `render` via
   * `group.addSetting`, which is what 0.6.0–0.6.9 did and why it never appeared: Obsidian
   * renders a group's declared items and then resets the group's `listEl` to exactly those rows'
   * elements, so a row added from inside a callback is removed the moment `render` returns,
   * silently. The two rows share the fetched catalog through `#agentCatalogs` and the effort
   * row's controls through `#effortRows` instead.
   *
   * The sign-in row is a plain declarative item with no `render` of its own: its `visible` is
   * the row's single owner, reading the catalog state the model row's `render` writes once its
   * fetch lands. The model row owns the fetch because it is the row whose presentation the
   * fetch changes first — "Loading…" and disabled until the catalog arrives — and it applies the
   * result to the effort row through `#effortRows`, then refreshes the sign-in row's predicate.
   *
   * `getSettingDefinitions()` runs on every render and once more when the tab is registered for
   * search indexing, and the catalog fetch spawns a subprocess costing ~0.6-2.6s (see
   * `CATALOG_TIMEOUT_MS`'s doc comment in core) — it must stay behind `render`, which Obsidian
   * never invokes for search indexing. `render` does run for a backend the group's `visible`
   * hides, though (see `getSettingDefinitions()`'s doc comment), so the fetch is additionally
   * skipped unless this backend is the selected one. A backend switch reaches this `render`
   * again through `update()` (`RESTRUCTURING_KEYS`), which is what makes that check safe.
   *
   * `disposed` replaces the old `#displayGeneration` counter. Obsidian calls a `render`
   * callback's returned cleanup function before tearing the row down — backend switched away,
   * or the tab closed — which is the same "the fetch resolved into a row that is already gone"
   * window the counter used to guard. The cleanup also forgets this backend's cached catalog —
   * see `#agentCatalogs`'s doc comment.
   */
  private agentCatalogItem(backend: "claude" | "codex"): SettingDefinitionItem<SettingsKey> {
    const backendLabel: AgentBackendLabel = backend === "claude" ? "Claude" : "Codex";
    const loginCommand = backend === "claude" ? "claude login" : "codex login";
    const modelKey = backend === "claude" ? "claudeModel" : "codexModel";
    const effortKey = backend === "claude" ? "claudeEffort" : "codexEffort";
    const ownsBackend: EnhancementBackend = backend === "claude" ? "claude-agent-sdk" : "codex";
    return {
      type: "group",
      // Each backend names itself rather than sharing an else — see basicDefinitions().
      visible: () => this.plugin.settings.backend === ownsBackend,
      items: [
        {
          // Reserved here, in the same position the old unconditional "Codex sign-in" row held,
          // and hidden until the fetch resolves and says nobody is signed in — a hard fetch
          // failure gets its own message on the rows below instead, per catalog.ts's
          // AgentCatalog.signedIn doc: neither backend fails merely because nobody is signed in,
          // so this is not the row a failed fetch uses.
          name: `${backendLabel} sign-in`,
          desc: createFragment((desc) => {
            desc.appendText("Sign in with ");
            desc.createEl("code", { text: loginCommand });
            desc.appendText(" in a terminal first. Shorthand uses that sign-in and cannot start it for you.");
          }),
          visible: () => {
            const catalog = this.#agentCatalogs.get(backend);
            return catalog !== undefined && !catalog.signedIn;
          },
        },
        {
          name: `${backendLabel} model`,
          desc: catalogLoadingDescription(),
          render: (modelRow) => {
            let disposed = false;

            let modelDropdown!: DropdownComponent;
            modelRow.addDropdown((dropdown) => {
              modelDropdown = dropdown
                .addOption("", "Provider default")
                .setValue(this.plugin.settings[modelKey]);
              dropdown.onChange(async (value) => {
                // Preserve-and-flag, not clear-and-reset: whether `value`'s model still accepts
                // the stored effort is exactly what `decideEffortRow` (see `applyEffortRow`)
                // already works out from `this.plugin.settings[effortKey]`, so the effort is
                // left untouched here. A model switch that invalidates it does not lose it — the
                // next render shows it selected, disabled, and described as unavailable, the
                // same presentation `decideModelRow` uses for a stale model id, which is what
                // forces a visible re-pick instead of a silent substitution.
                await this.plugin.saveSettings({ ...this.plugin.settings, [modelKey]: value });
                const catalog = this.#agentCatalogs.get(backend);
                if (catalog !== undefined) this.applyEffortRow(backend, catalog);
              });
            });
            modelRow.setDisabled(true);

            if (this.plugin.settings.backend !== ownsBackend) return;

            const executableOverride = this.plugin.settings[backend === "claude" ? "claudeExecutable" : "codexExecutable"];
            const fetchCatalog = backend === "claude"
              ? listClaudeModels(executableOverride.length === 0 ? {} : { executableOverride })
              : listCodexModels(executableOverride.length === 0 ? {} : { codexPathOverride: executableOverride });

            void fetchCatalog.then((loadedCatalog) => {
              if (disposed) return;
              this.#agentCatalogs.set(backend, loadedCatalog);
              // Cheap: only re-applies `visible`/`disabled` predicates to rows that already
              // exist — here, that's the sign-in row above, now that its predicate has a
              // catalog to read. Never `update()` here: that would re-run
              // `getSettingDefinitions()`, which re-invokes this same `render`, which fires
              // another fetch, whose own `.then()` would call `update()` again, forever.
              this.refreshDomState();

              applyCatalogDecision(modelDropdown, modelRow, decideModelRow(loadedCatalog, this.plugin.settings[modelKey]));
              this.applyEffortRow(backend, loadedCatalog);
            }).catch((error: unknown) => {
              if (disposed) return;
              const message = catalogFetchFailedDescription(
                backendLabel,
                error instanceof AgentCatalogError ? error.reason : "protocol",
              );
              modelRow.setDesc(message).setDisabled(true);
              this.#effortRows.get(backend)?.row.setDesc(message).setDisabled(true);
            });

            return () => {
              disposed = true;
              this.#agentCatalogs.delete(backend);
            };
          },
        },
        {
          name: `${backendLabel} effort`,
          desc: catalogLoadingDescription(),
          render: (effortRow) => {
            let effortDropdown!: DropdownComponent;
            effortRow.addDropdown((dropdown) => {
              effortDropdown = dropdown.addOption("", "Provider default");
              dropdown.onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, [effortKey]: value }));
            });
            effortRow.setDisabled(true);
            this.#effortRows.set(backend, { row: effortRow, dropdown: effortDropdown });
            // Obsidian renders sibling items in declaration order and the model row's fetch is
            // asynchronous, so on any pass through here the catalog is still in flight and this
            // finds nothing. It is here for the one ordering it cannot see: a future item
            // reordering that puts this row first would otherwise leave it "Loading…" forever.
            const catalog = this.#agentCatalogs.get(backend);
            if (catalog !== undefined) this.applyEffortRow(backend, catalog);
            return () => {
              this.#effortRows.delete(backend);
            };
          },
        },
      ],
    };
  }

  /**
   * Applies the fetched catalog to a backend's effort row, whichever row is asking — the model
   * row when its fetch lands or its selection changes, the effort row itself if it ever renders
   * after the catalog is already cached. A missing entry means the effort row has been torn
   * down (or has not rendered yet), and there is nothing to draw on.
   */
  private applyEffortRow(backend: "claude" | "codex", catalog: AgentCatalog): void {
    const effort = this.#effortRows.get(backend);
    if (effort === undefined) return;
    const modelKey = backend === "claude" ? "claudeModel" : "codexModel";
    const effortKey = backend === "claude" ? "claudeEffort" : "codexEffort";
    const decision = decideEffortRow(catalog, this.plugin.settings[modelKey], this.plugin.settings[effortKey]);
    applyCatalogDecision(effort.dropdown, effort.row, decision);
  }

  private acpCatalogGroup(): SettingDefinitionItem<SettingsKey> {
    return {
      type: "group",
      visible: () => this.plugin.settings.backend === "acp",
      items: [
        {
          name: "ACP sign-in",
          desc: createFragment((desc) => {
            desc.appendText("Sign in with ");
            desc.createEl("code", { text: "agent login" });
            desc.appendText(" in a terminal first. Shorthand uses that sign-in and cannot start it for you.");
          }),
          visible: () => {
            const catalog = this.#agentCatalogs.get("acp");
            return catalog !== undefined && !catalog.signedIn;
          },
        },
        {
          name: "ACP model",
          desc: catalogLoadingDescription(),
          render: (modelRow) => {
            let disposed = false;

            let modelDropdown!: DropdownComponent;
            modelRow.addDropdown((dropdown) => {
              modelDropdown = dropdown
                .addOption("", "Provider default")
                .setValue(this.plugin.settings.acpModel);
              dropdown.onChange(async (value) => {
                await this.plugin.saveSettings({ ...this.plugin.settings, acpModel: value });
              });
            });
            modelRow.setDisabled(true);

            if (this.plugin.settings.backend !== "acp") return;

            if (this.plugin.settings.acpTransport === "network") {
              modelRow.setDesc("Network transport uses the remote agent's default model.").setDisabled(false);
              return () => {
                disposed = true;
                this.#agentCatalogs.delete("acp");
              };
            }

            const executableOverride = this.plugin.settings.acpExecutable;
            const args = this.plugin.settings.acpArgs.trim().length > 0
              ? this.plugin.settings.acpArgs.trim().split(/\s+/)
              : undefined;
            const fetchCatalog = listAcpModels({
              ...(executableOverride.length === 0 ? {} : { executableOverride }),
              ...(args === undefined ? {} : { args }),
            });

            void fetchCatalog.then((loadedCatalog) => {
              if (disposed) return;
              this.#agentCatalogs.set("acp", loadedCatalog);
              this.refreshDomState();

              applyCatalogDecision(modelDropdown, modelRow, decideModelRow(loadedCatalog, this.plugin.settings.acpModel));
            }).catch((error: unknown) => {
              if (disposed) return;
              const message = catalogFetchFailedDescription(
                "ACP",
                error instanceof AgentCatalogError ? error.reason : "protocol",
              );
              modelRow.setDesc(message).setDisabled(true);
            });

            return () => {
              disposed = true;
              this.#agentCatalogs.delete("acp");
            };
          },
        },
        {
          name: "ACP transport",
          desc: "Connect to a local agent process (stdio) or a remote agent endpoint (network).",
          control: {
            type: "dropdown",
            key: "acpTransport",
            options: {
              stdio: "stdio",
              network: "network",
            },
          },
        },
        {
          ...textControlItem("ACP executable", acpExecutableDescription, "acpExecutable", this.plugin.settings.acpExecutable),
          visible: () => this.plugin.settings.acpTransport === "stdio",
        },
        {
          name: "ACP arguments",
          desc: "Arguments passed to the agent executable (default: acp).",
          control: { type: "text", key: "acpArgs" },
          visible: () => this.plugin.settings.acpTransport === "stdio",
        },
        {
          name: "ACP network URL",
          desc: "WebSocket (ws://, wss://) or HTTP (http://, https://) endpoint for the remote agent.",
          control: { type: "text", key: "acpNetworkUrl" },
          visible: () => this.plugin.settings.acpTransport === "network",
        },
        {
          name: "ACP authentication token",
          desc: "Optional authentication token for the remote agent.",
          control: { type: "text", key: "acpAuthToken" },
          visible: () => this.plugin.settings.acpTransport === "network",
        },
      ],
    };
  }

  /**
   * Always visible, at the bottom, no expander — same as before the migration, just declarative
   * now: a static `SettingDefinitionGroup` with its own conditional rows, rather than a section
   * that only made sense as the tail end of one imperative `display()` pass.
   */
  private advancedGroup(): SettingDefinitionItem<SettingsKey> {
    return {
      type: "group",
      heading: "Advanced",
      items: [
        textControlItem("Shorthand executable", shorthandExecutableDescription, "shorthandExecutable", this.plugin.settings.shorthandExecutable),
        // Both revealed by the backend dropdown in basicDefinitions(), and each naming its own
        // backend rather than sharing an else, for the reason recorded there. Both are optional
        // — blank means automatic detection, of `claude` at its install location and of `codex`
        // on PATH — which is why they can sit this far from the dropdown that reveals them.
        {
          ...textControlItem("Claude executable", claudeExecutableDescription, "claudeExecutable", this.plugin.settings.claudeExecutable),
          visible: () => this.plugin.settings.backend === "claude-agent-sdk",
        },
        {
          ...textControlItem("Codex executable", codexExecutableDescription, "codexExecutable", this.plugin.settings.codexExecutable),
          visible: () => this.plugin.settings.backend === "codex",
        },
        {
          name: "Agent session history",
          desc: "Keeps local Claude or Codex transcripts after a note-taking session or one-off enhancement ends.",
          control: { type: "toggle", key: "retainAgentSessionHistory" },
          visible: () => this.plugin.settings.backend === "claude-agent-sdk" || this.plugin.settings.backend === "codex",
        },
        numberControlItem("Minimum new characters", newCharacterThresholdDescription, "minNewChars", this.plugin.settings.minNewChars),
        {
          name: "Minimum interval (seconds)",
          desc: passIntervalDescription(this.plugin.settings.minIntervalMs / 1_000),
          control: {
            type: "number",
            key: "minIntervalSeconds",
            min: 10,
            step: 1,
            defaultValue: DEFAULT_PLUGIN_SETTINGS.minIntervalMs / 1_000,
          },
        },
        {
          name: "Live enhancement",
          desc: "The note is rewritten while the meeting runs, instead of only when you stop or run Enhance now.",
          control: { type: "toggle", key: "enableLiveEnhancement" },
        },
        {
          name: "Control Shorthand transcription",
          desc: createFragment((desc) => {
            desc.appendText(
              "Automatically start and stop transcription in the Shorthand app when note-taking begins and ends. "
              + "When turned off, start and stop transcription manually in Shorthand. ",
            );
            desc.createEl("a", {
              text: "Read how recorder control works",
              href: "https://github.com/mshish/shorthand-obsidian-plugin#driving-shorthands-recorder",
              cls: "shorthand-settings-link",
            });
            desc.appendText(".");
          }),
          control: { type: "toggle", key: "controlShorthandRecording" },
        },
        {
          name: "Follow Shorthand's recordings",
          desc: createFragment((desc) => {
            desc.appendText(
              "Starting a recording with Shorthand's own hotkey also starts taking notes on the note you have open — see ",
            );
            desc.createEl("a", {
              text: "Following Shorthand's recordings",
              href: "https://github.com/mshish/shorthand-obsidian-plugin#following-shorthands-recordings",
            });
            desc.appendText(".");
          }),
          control: { type: "toggle", key: "followAppRecording" },
        },
        {
          name: "Debug logging",
          desc: "Logs note-taking and enhancement activity to the developer console. Turn this on if note-taking does not start or stop as expected, or a note stops updating while you're taking notes.",
          control: { type: "toggle", key: "debugLogging" },
        },
      ],
    };
  }

  /**
   * "LLM provider profile"'s heading and its introductory sentence are two separate items for
   * the same reason `noteWritingGroup()` splits them — `SettingDefinitionGroup` has no `desc`.
   *
   * The status row and the four fields are five declared items sharing one `LlmProfileEditor`
   * through `#llmProfile` — not one `render` that appends the fields via `group.addSetting`,
   * which 0.6.0–0.6.9 did and which left the group with only its status row: Obsidian resets a
   * group's `listEl` to its declared rows once they are rendered (see `#effortRows`). The
   * status row's `render` creates the editor and starts the credential-file read; each field's
   * `render` attaches its controls. Obsidian renders sibling items in declaration order,
   * synchronously, so every field is attached before that read can resolve — which is the
   * ordering `LlmProfileEditor`'s definite-assignment fields rely on.
   *
   * The read stays behind `render` for the reasons `agentCatalogItem` gives, and with the same
   * caveat: `render` runs for this group even while the `llm` backend is not selected, so the
   * read is skipped unless it is. `dispose()` (called from the status row's cleanup) stands in
   * for the old `#displayGeneration` guard so a read or write that resolves after these rows
   * are torn down cannot write into them.
   */
  private llmProfileGroup(): SettingDefinitionItem<SettingsKey> {
    return {
      type: "group",
      heading: "LLM provider profile",
      visible: () => this.plugin.settings.backend === "llm",
      items: [
        { name: "", desc: "The API key is stored outside your vault, so it never syncs." },
        {
          name: "Profile status",
          desc: "Loading the provider profile…",
          render: (statusSetting) => {
            const editor = new LlmProfileEditor(() => this.update());
            this.#llmProfile = editor;
            editor.attachStatus(statusSetting);
            if (this.plugin.settings.backend === "llm") editor.load();
            return () => {
              editor.dispose();
              if (this.#llmProfile === editor) this.#llmProfile = undefined;
            };
          },
        },
        {
          name: "Provider",
          render: (row) => { this.#llmProfile?.attachProvider(row); },
        },
        {
          name: "Model",
          desc: "Model IDs are exact strings, not display names.",
          render: (row) => { this.#llmProfile?.attachModel(row); },
        },
        {
          name: "Base URL",
          render: (row) => { this.#llmProfile?.attachBaseUrl(row); },
        },
        {
          name: "API key",
          render: (row) => { this.#llmProfile?.attachApiKey(row); },
        },
      ],
    };
  }
}

/**
 * Renders a `CatalogRowDecision` from `src/settings-display.ts` onto a model or effort
 * dropdown and its `Setting` row — the thin, untested half of the pair described in that
 * module's `decideModelRow`/`decideEffortRow` doc comments. All the branching lives in the
 * decision; this only walks its `options` array.
 *
 * `DropdownComponent.addOption` has no `disabled` parameter, so a flagged option reaches the
 * underlying `<select>` directly. A disabled `<option>` can still be the element's `.value`
 * when set programmatically — browsers only refuse it as a *user* selection — which is what
 * lets an unavailable stored id stay selected and visible instead of silently falling back to
 * "Provider default".
 */
function applyCatalogDecision(dropdown: DropdownComponent, row: Setting, decision: CatalogRowDecision): void {
  dropdown.selectEl.empty();
  for (const option of decision.options) {
    const optionEl = dropdown.selectEl.createEl("option", { value: option.value, text: option.label });
    optionEl.disabled = option.disabled;
  }
  dropdown.setValue(decision.selected);
  row.setDesc(decision.description);
  row.setDisabled(decision.disabled);
}

/**
 * The imperative state behind the "LLM provider profile" rows: the draft, the stored key, the
 * commit queue, and the controls each of the five declared rows hands over through its
 * `attach*` call (see `ShorthandSettingTab.llmProfileGroup`). One instance per render of the
 * status row; `dispose()` fences off every callback that could land after the rows are gone.
 *
 * The control fields are definite-assignment rather than optional because every `attach*` call
 * happens synchronously, in declaration order, before `load()`'s read can resolve — Obsidian
 * renders a group's items in one pass — and reading one before then is a programming error
 * this class would rather surface than paper over with an `undefined` check per line.
 */
class LlmProfileEditor {
  #disposed = false;
  #draft: LlmProfileDraft = EMPTY_LLM_PROFILE_DRAFT;
  #storedKey = "";
  #ready = false;
  #commitQueue: LlmProfileCommitQueue | undefined;
  #clearKeyPointerDown = false;
  readonly #credentialsPath = llmCredentialsPath();
  readonly #credentialsFileExisted = existsSync(this.#credentialsPath);

  #statusSetting!: Setting;
  #startOverButton!: ButtonComponent;
  #providerSetting!: Setting;
  #providerInput!: DropdownComponent;
  #modelSetting!: Setting;
  #modelInput!: TextComponent;
  #baseUrlSetting!: Setting;
  #baseUrlInput!: TextComponent;
  #apiKeySetting!: Setting;
  #apiKeyInput!: TextComponent;
  #clearKeyButton!: ButtonComponent;

  /** `rebuildTab` is the tab's `update()`: Discard file rebuilds every row from a clean read. */
  constructor(private readonly rebuildTab: () => void) {}

  attachStatus(setting: Setting): void {
    this.#statusSetting = setting;
    setting.addButton((button) => {
      this.#startOverButton = button
        .setButtonText("Discard file")
        .setDestructive()
        .onClick(() => { void this.#startOver(); });
      button.buttonEl.hide();
    });
  }

  attachProvider(row: Setting): void {
    this.#providerSetting = row;
    row.addDropdown((dropdown) => {
      this.#providerInput = dropdown
        .addOption("", "No provider chosen")
        .addOption("openai", "OpenAI")
        .addOption("anthropic", "Anthropic")
        .addOption("openai-compatible", "OpenAI-compatible")
        .setDisabled(true)
        .onChange((value) => {
          if (value !== "" && value !== "openai" && value !== "anthropic" && value !== "openai-compatible") return;
          this.#draft = { ...this.#draft, provider: value };
          this.#commitQueue?.acceptEdit(this.#draft);
          this.#showDraftStatus();
        });
      dropdown.selectEl.addEventListener("blur", () => { void this.#commitDraft(); });
    });
  }

  attachModel(row: Setting): void {
    this.#modelSetting = row;
    row.addText((text) => {
      this.#modelInput = text.setDisabled(true).onChange((value) => {
        this.#draft = { ...this.#draft, model: value };
        this.#commitQueue?.acceptEdit(this.#draft);
        this.#showDraftStatus();
      });
      text.inputEl.addEventListener("blur", () => { void this.#commitDraft(); });
    });
  }

  attachBaseUrl(row: Setting): void {
    this.#baseUrlSetting = row.setDesc(baseUrlDescription(this.#draft.provider));
    row.addText((text) => {
      this.#baseUrlInput = text.setDisabled(true).onChange((value) => {
        this.#draft = { ...this.#draft, base_url: value };
        this.#commitQueue?.acceptEdit(this.#draft);
        this.#showDraftStatus();
      });
      text.inputEl.addEventListener("blur", () => { void this.#commitDraft(); });
    });
  }

  attachApiKey(row: Setting): void {
    this.#apiKeySetting = row;
    row
      .addText((text) => {
        this.#apiKeyInput = text.setDisabled(true).onChange((value) => {
          // The rendered field stays blank for a loaded secret. An empty edit therefore
          // restores the carried key; otherwise deleting masked text would clear it by
          // accident.
          this.#draft = { ...this.#draft, api_key: value.length === 0 ? this.#storedKey : value };
          this.#commitQueue?.acceptEdit(this.#draft);
          this.#showDraftStatus();
        });
        text.inputEl.type = "password";
        text.inputEl.addEventListener("blur", () => {
          if (!this.#clearKeyPointerDown) void this.#commitDraft();
        });
      })
      .addButton((button) => {
        this.#clearKeyButton = button
          .setButtonText("Clear key")
          .setDisabled(true)
          .onClick(() => {
            this.#draft = { ...this.#draft, api_key: "" };
            this.#apiKeyInput.setValue("");
            this.#commitQueue?.acceptEdit(this.#draft);
            this.#clearKeyPointerDown = false;
            this.#showDraftStatus();
            void this.#commitDraft();
          });
        button.buttonEl.addEventListener("pointerdown", () => {
          // Pointer-down precedes the password field's blur. Suppressing that blur prevents
          // Clear key from first writing a partially typed rotation and then writing a clear.
          this.#clearKeyPointerDown = true;
          window.setTimeout(() => { this.#clearKeyPointerDown = false; }, 0);
        });
      });
  }

  /** Reads the credentials file and, once it resolves, enables the fields it populated. */
  load(): void {
    void readLlmCredentials(this.#credentialsPath).then((result) => {
      if (this.#disposed) return;
      const state = resolveLlmProfileReadState(result, this.#credentialsFileExisted);
      if (state.status === "malformed") {
        this.#renderMalformed(state.message);
        return;
      }

      this.#draft = state.draft;
      this.#storedKey = state.hasStoredKey ? this.#draft.api_key : "";
      this.#commitQueue = new LlmProfileCommitQueue(this.#draft, {
        write: writeLlmCredentials,
        onInvalid: (missing) => {
          // Same wording as #showDraftStatus: one condition must not have two sentences.
          this.#statusSetting.setDesc(`Not saved yet. Still needed: ${missing.join(", ")}.`);
        },
        onSaving: () => {
          this.#statusSetting.setDesc(`Saving to ${this.#credentialsPath}…`);
        },
        onSaved: (credentials, isLatestRevision) => {
          if (this.#disposed) return;
          this.#storedKey = credentials.api_key ?? "";
          if (isLatestRevision) this.#apiKeyInput.setValue("");
          this.#setKeyDescription();
          if (isLatestRevision) {
            this.#statusSetting.setDesc(`Profile saved to ${this.#credentialsPath}.`);
          } else {
            this.#showDraftStatus();
          }
        },
        onSaveFailed: (error) => {
          if (this.#disposed) return;
          this.#statusSetting.setDesc(`The profile could not be saved: ${errorMessage(error)}`);
        },
      });
      this.#providerInput.setValue(this.#draft.provider);
      this.#modelInput.setValue(this.#draft.model);
      this.#baseUrlInput.setValue(this.#draft.base_url);
      this.#apiKeyInput.setValue("");
      this.#ready = true;
      // setValue() does not fire onChange, so nothing above recomputed the provider-dependent
      // copy. Without this, a loaded openai-compatible profile shows Base URL as optional.
      this.#showDraftStatus();
      this.#setFieldsDisabled(false);
      this.#setKeyDescription();
      this.#statusSetting.setDesc(state.status === "missing"
        ? "The profile is written once every required field has a value."
        : `Profile loaded from ${this.#credentialsPath}.`);
    }).catch((error: unknown) => {
      if (!this.#disposed) this.#renderMalformed(`The provider profile could not be loaded: ${errorMessage(error)}`);
    });
  }

  dispose(): void {
    this.#disposed = true;
  }

  #setFieldsDisabled(disabled: boolean): void {
    this.#providerSetting.setDisabled(disabled);
    this.#modelSetting.setDisabled(disabled);
    this.#baseUrlSetting.setDisabled(disabled);
    this.#apiKeySetting.setDisabled(disabled);
    this.#clearKeyButton.setDisabled(disabled);
  }

  #setKeyDescription(keyStatus: "known" | "unknown" = "known"): void {
    const state: StoredKeyState = keyStatus === "unknown"
      ? "unknown"
      : this.#storedKey.length > 0 ? "stored" : "absent";
    this.#apiKeySetting.setDesc(apiKeyDescription(state));
  }

  #showDraftStatus(): void {
    if (!this.#ready) return;
    this.#baseUrlSetting.setDesc(baseUrlDescription(this.#draft.provider));
    const missing = missingLlmProfileFields(this.#draft);
    this.#statusSetting.setDesc(missing.length > 0
      ? `Not saved yet. Still needed: ${missing.join(", ")}.`
      : "Saved when you leave the field you are editing.");
  }

  // This deliberately introduces commit-on-blur. The credentials file is an external,
  // whole-profile document validated as a unit: keystroke writes would emit profiles core
  // rejects wholesale and would put an API key on disk once for every character typed.
  async #commitDraft(): Promise<void> {
    if (!this.#ready) return;
    await this.#commitQueue?.commit();
  }

  async #startOver(): Promise<void> {
    this.#startOverButton.setDisabled(true);
    this.#statusSetting.setDesc(`Discarding the malformed profile at ${this.#credentialsPath}…`);
    try {
      await deleteLlmCredentials();
      if (!this.#disposed) this.rebuildTab();
    } catch (error) {
      if (this.#disposed) return;
      this.#statusSetting.setDesc(`The profile could not be discarded: ${errorMessage(error)}`);
      this.#startOverButton.setDisabled(false);
    }
  }

  #renderMalformed(message: string): void {
    this.#ready = false;
    this.#setFieldsDisabled(true);
    this.#statusSetting.setDesc(`${message} Discard file deletes the existing profile, including any key that could still be recovered from it by hand.`);
    this.#startOverButton.buttonEl.show();
    this.#startOverButton.setDisabled(false);
    this.#setKeyDescription("unknown");
  }
}

/**
 * Keys whose value changes what a row's `render` has to do, rather than merely hiding or
 * showing a row that already does — e.g. `backend` selects which agent model/effort group or
 * LLM profile group is live, and each of those `render` callbacks skips its fetch or read
 * while its backend is not the selected one. `refreshDomState()` only toggles CSS on rows that
 * already exist in the DOM; it cannot re-run a `render`, so a key in this set must go through
 * `update()`'s full rebuild instead. See `ShorthandSettingTab.setControlValue`.
 */
const RESTRUCTURING_KEYS = new Set<string>(["backend", "acpTransport"]);

/**
 * Keys whose value gates another declarative row's `visible` predicate where that row is a
 * plain `control` with no `render` callback of its own (the transcript folder row) — the row is
 * already built, so revealing or hiding it is a DOM-state change `refreshDomState()`
 * re-evaluates cheaply, without the full rebuild `update()` does. See
 * `ShorthandSettingTab.setControlValue`.
 */
const REVEALS_OTHER_ROWS = new Set<string>(["writeTranscriptNote"]);

/**
 * Keys whose declarative `desc` is computed from their own current value
 * (docs/settings-copy-style.md rule 4). `desc` has no reactive form the way `visible`/`disabled`
 * do, so it goes stale after a commit unless `getSettingDefinitions()` runs again — only
 * `update()` does that. See `ShorthandSettingTab.setControlValue`.
 */
const SELF_DESCRIBING_KEYS = new Set<string>([
  "shorthandExecutable",
  "claudeExecutable",
  "codexExecutable",
  "acpExecutable",
  "sidecarDirectory",
  "minNewChars",
]);

function textControlItem(
  name: string,
  describe: (value: string) => string,
  key: "shorthandExecutable" | "claudeExecutable" | "codexExecutable" | "acpExecutable" | "sidecarDirectory",
  value: string,
): SettingDefinitionControl<SettingsKey> {
  return { name, desc: describe(value), control: { type: "text", key } };
}

function numberControlItem(
  name: string,
  describe: (value: number) => string,
  key: "minNewChars",
  value: number,
): SettingDefinitionControl<SettingsKey> {
  return { name, desc: describe(value), control: { type: "number", key, defaultValue: DEFAULT_PLUGIN_SETTINGS[key] } };
}

/**
 * The right-sidebar controls. Everything it decides is `describePanel`; this class is the
 * DOM wiring only, which is what keeps it reviewable by reading — it cannot be imported
 * under `bun test`.
 */
class ShorthandPanelView extends ItemView {
  // `#build` assigns these together, exactly once, before `#patch` ever reads them — see
  // `render()`'s guard. Definite-assignment fields rather than `| undefined` because every
  // read after that point is meant to be unconditional; the guard belongs in one place
  // (`render()`), not repeated as a null check in every line of `#patch`.
  #built = false;
  #statusEl!: HTMLElement;
  #statusIconEl!: HTMLElement;
  #statusLabelEl!: HTMLElement;
  #headlineEl!: HTMLElement;
  #elapsedEl!: HTMLElement;
  #noteEl!: HTMLAnchorElement;
  #noteNameEl!: HTMLElement;
  #activityEl!: HTMLElement;
  #activityLabelEl!: HTMLElement;
  #detailEl!: HTMLElement;
  #actionsEl!: HTMLElement;
  #buttonEls: ReadonlyMap<PanelButtonId, Readonly<{
    button: HTMLButtonElement;
    label: HTMLElement;
    hint: HTMLElement;
  }>> = new Map();

  constructor(leaf: WorkspaceLeaf, private readonly plugin: ShorthandPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return SHORTHAND_PANEL_VIEW;
  }

  getDisplayText(): string {
    return "Shorthand";
  }

  getIcon(): string {
    return "mic";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  /**
   * Builds the DOM at most once per view instance, then patches the existing nodes on every
   * later call. The one-second interval that keeps the panel's clock current calls this
   * unconditionally, whether or not anything actually changed — `container.empty()` and
   * rebuilding every element on that cadence dropped keyboard focus off whichever button a
   * keyboard user was holding, and made a screen reader re-announce the whole panel once a
   * second, forever, for as long as the panel stayed open.
   */
  render(): void {
    const model = this.plugin.panelModel();
    if (!this.#built) { this.#build(model); this.#built = true; }
    this.#patch(model);
  }

  /** Runs once. The same three button nodes remain mounted so recurring clock repaints never
   * disturb focus; `#patch` changes which actions are relevant with the `hidden` attribute. */
  #build(model: PanelModel): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("shorthand-panel");

    this.#statusEl = container.createDiv({ cls: "shorthand-panel-status" });
    const statusTop = this.#statusEl.createDiv({ cls: "shorthand-panel-status-top" });
    const mode = statusTop.createDiv({ cls: "shorthand-panel-mode" });
    this.#statusIconEl = mode.createSpan({ cls: "shorthand-panel-mode-icon", attr: { "aria-hidden": "true" } });
    this.#statusLabelEl = mode.createSpan({ cls: "shorthand-panel-mode-label" });
    this.#elapsedEl = statusTop.createEl("time", { cls: "shorthand-panel-elapsed" });
    this.#headlineEl = this.#statusEl.createEl("h3", {
      cls: "shorthand-panel-headline",
      attr: { "aria-live": "polite" },
    });

    this.#noteEl = this.#statusEl.createEl("a", {
      cls: "shorthand-panel-note internal-link",
      attr: { href: "#" },
    });
    this.#noteEl.onclick = (event) => {
      event.preventDefault();
      void this.plugin.openPanelNote(event.metaKey || event.ctrlKey);
    };
    const noteIcon = this.#noteEl.createSpan({ cls: "shorthand-panel-note-icon", attr: { "aria-hidden": "true" } });
    setIcon(noteIcon, "file-text");
    this.#noteNameEl = this.#noteEl.createSpan({ cls: "shorthand-panel-note-name" });

    this.#activityEl = this.#statusEl.createDiv({ cls: "shorthand-panel-activity" });
    const pulse = this.#activityEl.createSpan({ cls: "shorthand-panel-pulse", attr: { "aria-hidden": "true" } });
    pulse.createSpan();
    pulse.createSpan();
    pulse.createSpan();
    this.#activityLabelEl = this.#activityEl.createSpan();
    this.#detailEl = this.#statusEl.createEl("p", { cls: "shorthand-panel-detail" });

    this.#actionsEl = container.createDiv({ cls: "shorthand-panel-actions" });
    this.#actionsEl.createEl("p", { cls: "shorthand-panel-actions-label", text: "Choose a mode" });
    const buttons = this.#actionsEl.createDiv({ cls: "shorthand-panel-buttons" });
    const buttonEls = new Map<PanelButtonId, Readonly<{
      button: HTMLButtonElement;
      label: HTMLElement;
      hint: HTMLElement;
    }>>();
    for (const button of model.buttons) {
      const parent = button.id === "stop" ? this.#statusEl : buttons;
      const element = parent.createEl("button", {
        cls: `shorthand-panel-button is-${button.id}`,
        attr: { type: "button" },
      });
      const icon = element.createSpan({ cls: "shorthand-panel-button-icon", attr: { "aria-hidden": "true" } });
      setIcon(icon, button.icon);
      const copy = element.createSpan({ cls: "shorthand-panel-button-copy" });
      const label = copy.createSpan({ cls: "shorthand-panel-button-label" });
      const hint = copy.createSpan({ cls: "shorthand-panel-button-hint" });
      element.onclick = () => { this.plugin.runPanelAction(button.id); };
      buttonEls.set(button.id, { button: element, label, hint });
    }
    this.#buttonEls = buttonEls;
  }

  /**
   * Patches text and `disabled` in place — never `.empty()`, never a fresh element — so an
   * idle repaint cannot move focus or trigger accessibility-tree churn. `.hidden` toggles the
   * note/detail lines' visibility rather than adding or removing them, which stays within
   * "patch `textContent`/`disabled`, not `style`": it is a boolean content attribute, not
   * inline styling, and the browser's own UA stylesheet does the hiding.
   */
  #patch(model: PanelModel): void {
    for (const tone of ["idle", "meeting", "assisted-notes", "working", "warning", "error"] as const) {
      this.#statusEl.classList.toggle(`is-${tone}`, model.tone === tone);
    }
    setIcon(this.#statusIconEl, model.statusIcon);
    this.#statusLabelEl.textContent = model.statusLabel;
    this.#headlineEl.textContent = model.headline;
    this.#elapsedEl.textContent = model.elapsed ?? "";
    this.#elapsedEl.hidden = model.elapsed === undefined;
    this.#noteNameEl.textContent = model.noteName ?? "";
    this.#noteEl.setAttribute("href", model.notePath ?? "#");
    this.#noteEl.dataset.href = model.notePath ?? "";
    this.#noteEl.ariaLabel = model.noteName === undefined ? "" : `Open ${model.noteName}`;
    this.#noteEl.title = model.noteName === undefined ? "" : `Open ${model.noteName}`;
    this.#noteEl.hidden = model.noteName === undefined;
    this.#activityLabelEl.textContent = model.activityLabel ?? "";
    this.#activityEl.hidden = model.activityLabel === undefined;
    this.#detailEl.textContent = model.detail ?? "";
    this.#detailEl.hidden = model.detail === undefined;
    this.#actionsEl.hidden = !model.buttons.some(({ id, visible }) => id !== "stop" && visible);

    for (const button of model.buttons) {
      const elements = this.#buttonEls.get(button.id);
      if (elements === undefined) continue; // Unreachable while the button-set invariant above holds.
      elements.label.textContent = button.label;
      elements.hint.textContent = button.hint ?? "";
      elements.hint.hidden = button.hint === undefined;
      elements.button.disabled = !button.enabled;
      elements.button.hidden = !button.visible;
    }
  }
}

class ScaffoldModal extends Modal {
  #settled = false;

  constructor(app: App, private readonly resolveChoice: (choice: boolean) => void) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Add Shorthand markers?");
    this.contentEl.createEl("p", {
      text: "This note has no Shorthand AI ownership block. Add the user-notes marker and seeded AI section scaffold without changing existing note text?",
    });
    const buttons = this.contentEl.createDiv();
    const add = buttons.createEl("button", { text: "Add scaffold" });
    add.addClass("mod-cta");
    add.onclick = () => { this.choose(true); this.close(); };
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.onclick = () => { this.choose(false); this.close(); };
  }

  onClose(): void {
    this.choose(false);
    this.contentEl.empty();
  }

  private choose(choice: boolean): void {
    if (this.#settled) return;
    this.#settled = true;
    this.resolveChoice(choice);
  }
}

/**
 * What the modal needs back from one field: the value to store, and a way to put the cursor
 * in it when validation rejects it. A bare textarea element cannot answer the first, because
 * "Default" stores "" no matter what text the textarea is holding.
 */
type PromptFieldHandle = Readonly<{ value: () => string; focus: () => void }>;

/**
 * Both multi-line settings live in a modal rather than in the settings tab.
 *
 * Obsidian 1.13.7 makes the declarative settings API and its textarea control available. This
 * modal remains part of the existing imperative settings surface until that surface migrates
 * as a whole: it owns tested Default/Custom state, validation, focus recovery, and save timing
 * that a one-control substitution would bypass. The raw textareas follow ScaffoldModal's form
 * pattern, and the mode control remains an Obsidian `Setting` dropdown.
 */
class NotePromptModal extends Modal {
  #settled = false;

  constructor(
    app: App,
    private readonly plugin: ShorthandPlugin,
    private readonly onSaved: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Note writing");
    let userNameInput!: TextComponent;
    new Setting(this.contentEl)
      .setName("Your name")
      .setDesc("Shorthand uses this optional name when attributing your words in either note-taking mode.")
      .addText((text) => {
        userNameInput = text
          .setPlaceholder("Optional")
          .setValue(this.plugin.settings.userName);
        text.inputEl.maxLength = MAX_USER_NAME_CHARACTERS;
      });
    const meetingGuidance = this.field(
      "Meeting prompt",
      createFragment((desc) => {
        desc.appendText(
          "Your instructions replace Shorthand's meeting-specific voice and note structure. "
          + "Its safety rules always apply as well — see ",
        );
        desc.createEl("a", {
          text: "Note writing",
          href: "https://github.com/mshish/shorthand-obsidian-plugin#note-writing",
        });
        desc.appendText(".");
      }),
      DEFAULT_MEETING_EDITORIAL_GUIDANCE,
      this.plugin.settings.meetingNoteTakingGuidance,
    );
    const assistedNotesGuidance = this.field(
      "Assisted Notes prompt",
      "Your instructions for organizing and visualizing your spoken thinking.",
      DEFAULT_ASSISTED_NOTES_EDITORIAL_GUIDANCE,
      this.plugin.settings.assistedNotesNoteTakingGuidance,
    );
    const sections = this.field(
      "Starting section headings",
      "One heading per line, added when Shorthand first writes to a note.",
      defaultTemplateSectionText(),
      this.plugin.settings.templateSectionText,
    );
    // Inline and persistent, not a Notice: a validation message that fades after a few seconds
    // is unreadable next to the several hundred characters of text it is about.
    const error = this.contentEl.createDiv({ cls: "mod-warning" });
    const buttons = this.contentEl.createDiv();
    const save = buttons.createEl("button", { text: "Save" });
    save.addClass("mod-cta");
    save.onclick = () => {
      void this.save(userNameInput, meetingGuidance, assistedNotesGuidance, sections, error);
    };
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  /**
   * One field: label, explanation, a Default / Custom control, and the body that
   * control switches between. The mode is derived from the stored string by
   * `initialPromptFieldState`, so there is no second key that could disagree with the text.
   */
  private field(
    name: string,
    // `DocumentFragment` as well as `string`, which is what `setDesc` itself accepts: a
    // description that links out to README cannot be a plain string.
    description: string | DocumentFragment,
    effectiveDefault: string,
    stored: string,
  ): PromptFieldHandle {
    let state = initialPromptFieldState(stored);
    let editor: HTMLTextAreaElement | undefined;
    const setting = new Setting(this.contentEl).setName(name).setDesc(description);
    const body = this.contentEl.createDiv();

    const render = (): void => {
      body.empty();
      editor = undefined;
      if (state.mode === "default") {
        // Read-only rather than hidden: the point of this control is that the text a user is
        // inheriting is legible without first agreeing to replace it. A placeholder was not,
        // because it vanished on the first keystroke.
        body.createEl("textarea", {
          text: effectiveDefault,
          cls: "shorthand-prompt-textarea",
          // aria-label because these textareas are siblings of the Setting rather than children
          // of a <label>, so a screen reader has nothing to announce them by. Obsidian's own
          // components carry this for you; hand-rolled elements do not, which is the trade this
          // modal accepts to get a multi-line field at all.
          attr: { readonly: "true", rows: 10, spellcheck: "false", "aria-label": `${name} (Shorthand's default, read-only)` },
        });
        return;
      }
      const area = body.createEl("textarea", {
        cls: "shorthand-prompt-textarea",
        attr: { rows: 10, spellcheck: "false", "aria-label": name },
      });
      area.value = state.editorText;
      // Mirrored into the state on every keystroke so `storedPromptFieldValue` stays the only
      // thing that decides what is written. Reading `area.value` at save time instead would
      // route around it and could store the seeded default after a switch back to Default.
      area.addEventListener("input", () => { state = { ...state, editorText: area.value }; });
      editor = area;
      area.focus();
    };

    setting.addDropdown((dropdown) => dropdown
      .addOption("default", "Default")
      .addOption("custom", "Custom")
      .setValue(state.mode)
      .onChange((value) => {
        state = choosePromptFieldMode(state, value === "custom" ? "custom" : "default", effectiveDefault);
        render();
      }));
    render();

    return {
      value: () => storedPromptFieldValue(state),
      focus: () => { editor?.focus(); },
    };
  }

  private async save(
    userName: TextComponent,
    meetingGuidance: PromptFieldHandle,
    assistedNotesGuidance: PromptFieldHandle,
    sections: PromptFieldHandle,
    error: HTMLElement,
  ): Promise<void> {
    // Guards a second click landing while the first save is still awaiting saveData(), the
    // same job #settled does in ScaffoldModal.
    if (this.#settled) return;
    const validated = validatePromptSettings({
      userName: userName.getValue(),
      meetingNoteTakingGuidance: meetingGuidance.value(),
      assistedNotesNoteTakingGuidance: assistedNotesGuidance.value(),
      templateSectionText: sections.value(),
    });
    if (!validated.ok) {
      // Invalid input is never saved and the window stays open, focused on the field that
      // failed, so the text being complained about is still on screen next to the complaint.
      error.setText(validated.error);
      if (validated.field === "userName") {
        userName.inputEl.focus();
      } else if (validated.field === "meetingNoteTakingGuidance") {
        meetingGuidance.focus();
      } else if (validated.field === "assistedNotesNoteTakingGuidance") {
        assistedNotesGuidance.focus();
      } else {
        sections.focus();
      }
      return;
    }
    this.#settled = true;
    await this.plugin.saveSettings({ ...this.plugin.settings, ...validated.settings });
    this.onSaved();
    this.close();
  }
}

function confirmScaffold(app: App): Promise<boolean> {
  return new Promise((resolveChoice) => new ScaffoldModal(app, resolveChoice).open());
}

function timestampName(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.md`;
}

function addMarkdownExtension(path: string): string {
  return /\.md$/i.test(path) ? path : `${path}.md`;
}

/** The note half of a wikilink: `Folder/Note#Heading` names the note `Folder/Note`. */
function linkTarget(link: string): string {
  return link.split(/[#^]/, 1)[0]?.trim() ?? link;
}

function isVaultMarkdownPath(path: string): boolean {
  // A name, not merely an extension: `.md` is a dot-file, not a note.
  return /[^/]\.md$/i.test(path)
    && !path.startsWith("/")
    && !/^[A-Za-z]:/.test(path)
    && !path.includes("\\")
    && path.split("/").every((segment) => segment.trim().length > 0 && segment !== "." && segment !== "..");
}

function streamExitMessage(diagnosis: ExitDiagnosis): string {
  if (diagnosis.code === 2) {
    return "Shorthand is not running, or Follow Live Transcript Output is disabled in Shorthand's Advanced settings.";
  }
  return diagnosis.message || `Shorthand follow-stream exited with code ${String(diagnosis.code)}.`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

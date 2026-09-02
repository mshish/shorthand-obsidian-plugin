import { formatElapsed } from "./elapsed.js";
import { canStartCapture, type PluginUiState } from "./state.js";
import type { CaptureMode } from "./follow-policy.js";

/** The view type Obsidian registers this panel under. Stable: it is persisted in workspace layout. */
export const SHORTHAND_PANEL_VIEW = "shorthand-controls";

export type PanelButtonId = "start-meeting" | "start-assisted-notes" | "stop";
export type PanelIcon = "users" | "lightbulb" | "square" | "circle-check" | "loader-circle" | "triangle-alert";
export type PanelTone = "idle" | "meeting" | "assisted-notes" | "working" | "warning" | "error";

export type PanelButton = Readonly<{
  id: PanelButtonId;
  label: string;
  hint: string | undefined;
  icon: Extract<PanelIcon, "users" | "lightbulb" | "square">;
  enabled: boolean;
  visible: boolean;
}>;

export type PanelModel = Readonly<{
  statusLabel: string;
  headline: string;
  /** The clock is visually prominent and deliberately separate from the state name. */
  elapsed: string | undefined;
  /** A second line reserved for guidance or an error's own message. */
  detail: string | undefined;
  /** A calm, non-recording activity cue while live note-taking is healthy. */
  activityLabel: string | undefined;
  /** The basename of the note being captured, when a capture owns one. */
  noteName: string | undefined;
  /** Vault-relative target for the note link. */
  notePath: string | undefined;
  statusIcon: PanelIcon;
  tone: PanelTone;
  buttons: readonly PanelButton[];
}>;

export type PanelInput = Readonly<{
  state: PluginUiState;
  elapsedMs: number | undefined;
  noteName: string | undefined;
  notePath: string | undefined;
  captureMode: CaptureMode | undefined;
  /** Whether a Markdown note is open, mirroring both start commands' `checkCallback`. */
  hasActiveNote: boolean;
  /**
   * Whether a `CaptureRuntime` currently exists, mirroring the status bar's own click
   * gate (`#capture !== undefined`) rather than `state.captureActive`. Assisted Notes
   * defers `capture-started` — and so `captureActive` — into its bounded acknowledgement,
   * so for up to that whole window a real runtime is running with `captureActive: false`.
   * `canStop` needs "is there something to stop", which this answers and `captureActive`
   * does not.
   */
  hasCapture: boolean;
}>;

/** What the side panel shows for a given state. */
export function describePanel(input: PanelInput): PanelModel {
  const { state, elapsedMs, noteName, notePath, captureMode, hasActiveNote, hasCapture } = input;
  const elapsed = elapsedMs === undefined ? undefined : formatElapsed(elapsedMs);
  const canStart = hasActiveNote && canStartCapture(state);
  // Not `state.captureActive`: Assisted Notes defers `capture-started` into its bounded
  // acknowledgement, so a real runtime can be running for that whole window with
  // `captureActive` still false. `hasCapture` answers whether there is something to stop.
  // The reducer's idle mode is the authoritative "nothing is running" state. `hasCapture`
  // is intentionally separate because Assisted Notes owns a runtime during its acknowledgement
  // window, but a stale runtime reference must not put Stop back on an idle panel (or hide the
  // two valid starts). This keeps the UI self-consistent without weakening the control guard.
  const captureInFlight = hasCapture && state.mode !== "idle";
  const canStop = captureInFlight && !state.stopping;
  const showStartChoices = !captureInFlight && canStartCapture(state);
  const showStop = captureInFlight;

  const modeName = captureMode === "assisted-notes" ? "Assisted notes" : "Meeting";
  const buttons: readonly PanelButton[] = [
    {
      id: "start-meeting",
      label: "Meeting",
      hint: "Conversation",
      icon: "users",
      enabled: canStart,
      visible: showStartChoices,
    },
    {
      id: "start-assisted-notes",
      label: "Assisted notes",
      hint: "Solo thinking",
      icon: "lightbulb",
      enabled: canStart,
      visible: showStartChoices,
    },
    {
      id: "stop",
      label: state.stopping ? "Wrapping up…" : captureMode === "assisted-notes"
        ? "Stop assisted notes"
        : "Stop meeting",
      hint: undefined,
      icon: "square",
      enabled: canStop,
      visible: showStop,
    },
  ];

  const idleWithoutNote = state.mode === "idle" && !hasActiveNote;
  const detail = state.message ?? (idleWithoutNote ? "Open a Markdown note to begin." : undefined);
  const activityLabel = state.captureActive
    && !state.stopping
    && state.mode !== "error"
    && state.mode !== "enhancement-stopped"
    ? state.mode === "enhancing" ? "Updating your note" : "Listening and writing"
    : undefined;

  if (state.stopping) {
    return {
      statusLabel: modeName,
      headline: "Wrapping up",
      elapsed,
      detail,
      activityLabel: undefined,
      noteName,
      notePath,
      statusIcon: "loader-circle",
      tone: "working",
      buttons,
    };
  }

  switch (state.mode) {
    case "idle":
      return {
        statusLabel: "Ready",
        headline: "Start taking notes",
        elapsed: undefined,
        detail,
        activityLabel: undefined,
        noteName: undefined,
        notePath: undefined,
        statusIcon: "circle-check",
        tone: "idle",
        buttons,
      };
    case "starting":
      return {
        statusLabel: modeName,
        headline: "Starting…",
        elapsed,
        detail,
        activityLabel: undefined,
        noteName,
        notePath,
        statusIcon: "loader-circle",
        tone: "working",
        buttons,
      };
    case "capturing":
    case "enhancing":
      return {
        statusLabel: modeName,
        headline: "Taking notes",
        elapsed,
        detail,
        activityLabel,
        noteName,
        notePath,
        statusIcon: captureMode === "assisted-notes" ? "lightbulb" : "users",
        tone: captureMode === "assisted-notes" ? "assisted-notes" : "meeting",
        buttons,
      };
    case "stopping":
      // `state.stopping` is the authority and returned above. This remains exhaustive for
      // hand-built test inputs whose mode and flag disagree.
      return {
        statusLabel: modeName,
        headline: "Wrapping up",
        elapsed,
        detail,
        activityLabel: undefined,
        noteName,
        notePath,
        statusIcon: "loader-circle",
        tone: "working",
        buttons,
      };
    case "enhancement-stopped":
      return {
        statusLabel: captureMode === undefined ? "Update paused" : modeName,
        headline: "AI updates paused",
        elapsed,
        detail,
        activityLabel: undefined,
        noteName: hasCapture ? noteName : undefined,
        notePath: hasCapture ? notePath : undefined,
        statusIcon: "triangle-alert",
        tone: "warning",
        buttons,
      };
    case "error":
      return {
        statusLabel: captureMode === undefined ? "Needs attention" : modeName,
        headline: "Something went wrong",
        elapsed,
        detail,
        activityLabel: undefined,
        noteName: hasCapture ? noteName : undefined,
        notePath: hasCapture ? notePath : undefined,
        statusIcon: "triangle-alert",
        tone: "error",
        buttons,
      };
    default: {
      const unhandled: never = state.mode;
      throw new Error(`Unhandled plugin mode: ${JSON.stringify(unhandled)}`);
    }
  }
}

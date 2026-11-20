import { formatElapsed } from "./elapsed.js";
import { canStartCapture, type PluginUiState } from "./state.js";
import type { CaptureMode } from "./follow-policy.js";
import type { MeetingEndCountdown } from "./meeting-end.js";

/** The view type Obsidian registers this panel under. Stable: it is persisted in workspace layout. */
export const SHORTHAND_PANEL_VIEW = "shorthand-controls";

export type PanelButtonId = "start-meeting" | "start-assisted-notes" | "stop" | "cancel";
export type PanelIcon = "users" | "lightbulb" | "square" | "x" | "circle-check" | "loader-circle" | "triangle-alert";
export type PanelTone = "idle" | "meeting" | "assisted-notes" | "working" | "warning" | "error";

/** The ids that act on a running capture rather than start one; both sit in the status card. */
export const CAPTURE_CONTROL_IDS: ReadonlySet<PanelButtonId> = new Set<PanelButtonId>(["stop", "cancel"]);

export type PanelButton = Readonly<{
  id: PanelButtonId;
  label: string;
  hint: string | undefined;
  icon: Extract<PanelIcon, "users" | "lightbulb" | "square" | "x">;
  enabled: boolean;
  visible: boolean;
}>;

/** The countdown card shown while a detected meeting end is about to stop the capture. */
export type PanelMeetingEnd = Readonly<{
  headline: string;
  /** Live, so the card shows how long is left without a second timer of its own. */
  countdown: string;
  /** The agent's reason, or `undefined` when it gave none. */
  reason: string | undefined;
  cancelLabel: string;
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
  meetingEnd: PanelMeetingEnd | undefined;
}>;

export type PanelInput = Readonly<{
  state: PluginUiState;
  elapsedMs: number | undefined;
  noteName: string | undefined;
  notePath: string | undefined;
  /**
   * The focused Markdown note, whether or not a capture is running. Idle shows it on the
   * note link so a user can see where a start would write before pressing anything; every
   * other state shows the capture's own note instead, since focus can move mid-capture.
   */
  activeNoteName: string | undefined;
  activeNotePath: string | undefined;
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
  /** A running meeting-end countdown, if any. */
  meetingEnd: MeetingEndCountdown | undefined;
}>;

export type CancelConfirmation = Readonly<{
  title: string;
  body: string;
  confirmLabel: string;
  keepLabel: string;
}>;

/**
 * The question asked before Cancel ends a capture. It asks because Cancel cannot be undone:
 * Shorthand discards the recording, so the final transcript and the closing notes pass are
 * gone for good. The keep button repeats the countdown card's wording on purpose, since both
 * mean "carry on as before".
 */
export function describeCancelConfirmation(mode: CaptureMode | undefined): CancelConfirmation {
  const what = mode === "assisted-notes" ? "this session" : "this meeting";
  return {
    title: "Cancel note taking?",
    body: `Shorthand stops recording and discards ${what} without finishing your notes. Anything already in the note stays.`,
    confirmLabel: "Cancel note taking",
    keepLabel: "Keep taking notes",
  };
}

/** What the side panel shows for a given state. */
export function describePanel(input: PanelInput): PanelModel {
  const model = describePanelStatus(input);
  const { state, hasCapture, meetingEnd } = input;
  // Not while stopping: the countdown is over by then, and a Cancel that cannot cancel
  // anything would be a button that lies.
  if (meetingEnd === undefined || !hasCapture || state.stopping || state.mode === "idle") return model;
  return {
    ...model,
    meetingEnd: {
      headline: "Meeting looks like it has ended",
      countdown: `Stopping in ${meetingEnd.remainingSeconds}s`,
      reason: meetingEnd.reason.length === 0 ? undefined : meetingEnd.reason,
      // Not "Cancel": the status card has its own Cancel, which ends note taking. Two buttons
      // with one label and opposite effects would make a misclick lose the meeting.
      cancelLabel: "Keep taking notes",
    },
  };
}

function describePanelStatus(input: PanelInput): PanelModel {
  const {
    state, elapsedMs, noteName, notePath, activeNoteName, activeNotePath, captureMode, hasActiveNote, hasCapture,
  } = input;
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
      // "Finish", not "Stop": with Cancel beside it, "Stop" no longer says which of the two
      // writes the notes. Finish is the one that does.
      label: state.stopping ? "Wrapping up…" : captureMode === "assisted-notes"
        ? "Finish assisted notes"
        : "Finish meeting",
      hint: undefined,
      icon: "square",
      enabled: canStop,
      visible: showStop,
    },
    {
      id: "cancel",
      label: "Cancel",
      hint: undefined,
      icon: "x",
      enabled: canStop,
      // Hidden once Finish is pressed: the recording is already being finalized by then, and
      // a Cancel that cannot take that back would be a button that lies.
      visible: showStop && !state.stopping,
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
      meetingEnd: undefined,
    };
  }

  switch (state.mode) {
    case "idle":
      return {
        statusLabel: "Ready",
        // This is a status, not an action. The two mode tiles below are the only controls
        // that start a capture, so imperative copy here made the non-interactive header look
        // like a third button.
        headline: "Ready to take notes",
        elapsed: undefined,
        detail,
        activityLabel: undefined,
        noteName: hasActiveNote ? activeNoteName : undefined,
        notePath: hasActiveNote ? activeNotePath : undefined,
        statusIcon: "circle-check",
        tone: "idle",
        buttons,
        meetingEnd: undefined,
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
        meetingEnd: undefined,
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
        meetingEnd: undefined,
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
        meetingEnd: undefined,
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
        meetingEnd: undefined,
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
        meetingEnd: undefined,
      };
    default: {
      const unhandled: never = state.mode;
      throw new Error(`Unhandled plugin mode: ${JSON.stringify(unhandled)}`);
    }
  }
}

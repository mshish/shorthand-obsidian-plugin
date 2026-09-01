import { formatElapsed } from "./elapsed.js";
import { canStartCapture, type PluginUiState } from "./state.js";

/** The view type Obsidian registers this panel under. Stable: it is persisted in workspace layout. */
export const SHORTHAND_PANEL_VIEW = "shorthand-controls";

export type PanelButtonId = "start-meeting" | "start-assisted-notes" | "stop";

export type PanelButton = Readonly<{ id: PanelButtonId; label: string; enabled: boolean }>;

export type PanelModel = Readonly<{
  headline: string;
  /** A second line reserved for guidance or an error's own message. */
  detail: string | undefined;
  /** A calm, non-recording activity cue while live note-taking is healthy. */
  activityLabel: string | undefined;
  /** The basename of the note being captured, when a capture owns one. */
  noteName: string | undefined;
  buttons: readonly PanelButton[];
}>;

export type PanelInput = Readonly<{
  state: PluginUiState;
  elapsedMs: number | undefined;
  noteName: string | undefined;
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

/**
 * What the side panel shows for a given state.
 *
 * Every button is always present and only its `enabled` moves. A panel whose controls
 * appear and disappear moves the button the user was reaching for, and Obsidian's right
 * sidebar is narrow enough that one row vanishing reflows the rest.
 */
export function describePanel(input: PanelInput): PanelModel {
  const { state, elapsedMs, noteName, hasActiveNote, hasCapture } = input;
  const clock = elapsedMs === undefined ? undefined : formatElapsed(elapsedMs);
  const canStart = hasActiveNote && canStartCapture(state);
  // Not `state.captureActive`: Assisted Notes defers `capture-started` into its bounded
  // acknowledgement, so a real runtime can be running for that whole window with
  // `captureActive` still false. `hasCapture` mirrors the status bar's own click gate and
  // answers "is there something to stop", which is what this button needs.
  const canStop = hasCapture && !state.stopping;

  const buttons: readonly PanelButton[] = [
    { id: "start-meeting", label: "Start meeting", enabled: canStart },
    { id: "start-assisted-notes", label: "Start assisted notes", enabled: canStart },
    { id: "stop", label: state.stopping ? "Wrapping up…" : "Stop", enabled: canStop },
  ];

  const headline = ((): string => {
    if (state.stopping) return clock === undefined ? "Wrapping up…" : `Wrapping up — ${clock}`;
    switch (state.mode) {
      case "idle": return "Not capturing";
      case "starting": return "Starting…";
      case "capturing": return clock === undefined ? "Capturing" : `Capturing — ${clock}`;
      case "enhancing": return clock === undefined ? "Writing the note" : `Writing the note — ${clock}`;
      case "stopping": return "Wrapping up…";
      case "enhancement-stopped": return "Enhancement stopped";
      case "error": return "Error";
      default: {
        const unhandled: never = state.mode;
        throw new Error(`Unhandled plugin mode: ${JSON.stringify(unhandled)}`);
      }
    }
  })();

  // Idle with no note open is the one case where every button is greyed and neither a
  // message nor a gate exists to say why — without this a user opening the panel cold sees
  // three disabled buttons and nothing telling them what to do about it.
  const idleWithoutNote = state.mode === "idle" && !hasActiveNote;

  const detail = state.message ?? (idleWithoutNote ? "Open a Markdown note to start a capture." : undefined);
  const activityLabel = state.captureActive
    && !state.stopping
    && state.mode !== "error"
    && state.mode !== "enhancement-stopped"
    ? "Taking notes"
    : undefined;

  return {
    headline,
    detail,
    activityLabel,
    noteName: state.captureActive ? noteName : undefined,
    buttons,
  };
}

import { formatElapsed } from "./elapsed.js";
import { canStartCapture, type PluginUiState } from "./state.js";

/** The view type Obsidian registers this panel under. Stable: it is persisted in workspace layout. */
export const SHORTHAND_PANEL_VIEW = "shorthand-controls";

export type PanelButtonId = "start-meeting" | "start-assisted-notes" | "stop";

export type PanelButton = Readonly<{ id: PanelButtonId; label: string; enabled: boolean }>;

export type PanelModel = Readonly<{
  headline: string;
  /** A second line, when there is one: the character gate, or an error's own message. */
  detail: string | undefined;
  /** The basename of the note being captured, when a capture owns one. */
  noteName: string | undefined;
  buttons: readonly PanelButton[];
}>;

export type PanelInput = Readonly<{
  state: PluginUiState;
  elapsedMs: number | undefined;
  pendingCharacters: number | undefined;
  minNewChars: number;
  noteName: string | undefined;
  /** Whether a Markdown note is open, mirroring both start commands' `checkCallback`. */
  hasActiveNote: boolean;
}>;

/**
 * What the side panel shows for a given state.
 *
 * Every button is always present and only its `enabled` moves. A panel whose controls
 * appear and disappear moves the button the user was reaching for, and Obsidian's right
 * sidebar is narrow enough that one row vanishing reflows the rest.
 */
export function describePanel(input: PanelInput): PanelModel {
  const { state, elapsedMs, pendingCharacters, minNewChars, noteName, hasActiveNote } = input;
  const clock = elapsedMs === undefined ? undefined : formatElapsed(elapsedMs);
  const canStart = hasActiveNote && canStartCapture(state);
  const canStop = state.captureActive && !state.stopping;

  const buttons: readonly PanelButton[] = [
    { id: "start-meeting", label: "Start meeting", enabled: canStart },
    { id: "start-assisted-notes", label: "Start assisted notes", enabled: canStart },
    { id: "stop", label: "Stop", enabled: canStop },
  ];

  const gate = pendingCharacters === undefined
    ? undefined
    : `${pendingCharacters} of ${minNewChars} characters toward the next pass`;

  const headline = ((): string => {
    switch (state.mode) {
      case "idle": return "Not capturing";
      case "starting": return "Starting…";
      case "capturing": return clock === undefined ? "Capturing" : `Capturing — ${clock}`;
      case "enhancing": return clock === undefined ? "Writing the note" : `Writing the note — ${clock}`;
      case "stopping": return "Stopping…";
      case "enhancement-stopped": return "Enhancement stopped";
      case "error": return "Error";
      default: {
        const unhandled: never = state.mode;
        throw new Error(`Unhandled plugin mode: ${JSON.stringify(unhandled)}`);
      }
    }
  })();

  // A message, when there is one, outranks the gate: it is the thing that went wrong,
  // and the gate is reassurance nobody needs while looking at an error.
  const detail = state.message ?? gate;

  return {
    headline,
    detail,
    noteName: state.captureActive ? noteName : undefined,
    buttons,
  };
}

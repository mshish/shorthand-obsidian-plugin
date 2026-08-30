import { formatElapsed } from "./elapsed.js";
import type { PluginUiState } from "./state.js";

/**
 * What the status bar shows, or that it should not exist at all.
 *
 * `visible: false` is a real outcome rather than an empty string: an Obsidian status
 * bar item that holds "" still occupies its separator and padding, so an idle vault
 * kept a visible gap where the old permanent "Shorthand: idle" used to be.
 */
export type StatusDisplay =
  | Readonly<{ visible: false }>
  | Readonly<{ visible: true; text: string; tooltip: string }>;

export type StatusInput = Readonly<{
  state: PluginUiState;
  /** Milliseconds since the running capture started, or `undefined` when none is. */
  elapsedMs: number | undefined;
  /** Characters banked toward the next enhancement pass, when a runner exists. */
  pendingCharacters: number | undefined;
  minNewChars: number;
}>;

const HIDDEN: StatusDisplay = Object.freeze({ visible: false });

/**
 * The status bar is a clock, not a state readout.
 *
 * Two things were removed and one added. The character counter went to the side panel,
 * which has room to explain it; the raw `PluginMode` token went entirely, because
 * `enhancement-stopped` is a name from this plugin's reducer and no user has seen it.
 * What is left is the elapsed time, which is the one thing a person glances at the
 * status bar for during a meeting.
 */
export function describeStatus(input: StatusInput): StatusDisplay {
  const { state, elapsedMs, pendingCharacters, minNewChars } = input;
  // Idle with nothing to report is the only state that hides. An error survives its
  // capture — `state.ts` deliberately has no clear-error event — so it must still be
  // shown once `captureActive` has gone false, or the plugin would fail silently.
  if (state.mode === "idle") return HIDDEN;

  const clock = elapsedMs === undefined ? "" : ` ${formatElapsed(elapsedMs)}`;
  const gate = pendingCharacters === undefined
    ? ""
    : ` ${pendingCharacters} of ${minNewChars} characters toward the next pass.`;

  switch (state.mode) {
    case "capturing":
      return {
        visible: true,
        text: `Shorthand${clock}`,
        tooltip: `Capturing.${gate} Click to stop.`,
      };
    case "enhancing":
      return {
        visible: true,
        text: `Shorthand${clock} · writing`,
        tooltip: "Writing the note. Click to stop the capture.",
      };
    case "stopping":
      return {
        visible: true,
        text: `Shorthand${clock} · stopping`,
        tooltip: "Finishing the capture.",
      };
    case "enhancement-stopped":
      return {
        visible: true,
        text: `Shorthand${clock} · enhancement stopped`,
        tooltip: state.message ?? "Enhancement stopped; capture continues.",
      };
    case "error":
      return {
        visible: true,
        text: `Shorthand${clock} · error`,
        tooltip: state.message ?? "Shorthand hit an error.",
      };
    default: {
      // A new mode must choose its own words rather than falling through to a
      // union member the user would then be shown.
      const unhandled: never = state.mode;
      throw new Error(`Unhandled plugin mode: ${JSON.stringify(unhandled)}`);
    }
  }
}

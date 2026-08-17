export type PluginMode = "idle" | "capturing" | "stopping" | "enhancing" | "budget-exhausted" | "error";

export type PluginUiState = Readonly<{
  mode: PluginMode;
  captureActive: boolean;
  /**
   * Set between the stop request and the capture actually finishing. Stopping is not
   * instant — it can spend a control timeout plus a full post-processing drain waiting for
   * Shorthand's `final` — and without this the status bar still read "capturing" for the whole
   * of it, which looks like a hang. Kept as its own flag rather than only a mode because
   * the final enhancement pass runs inside that window and must return to "stopping", not
   * back to "capturing".
   */
  stopping: boolean;
  passCount: number;
  message?: string;
}>;

export type PluginUiEvent =
  | Readonly<{ type: "capture-started" }>
  | Readonly<{ type: "capture-stopping" }>
  | Readonly<{ type: "capture-stopped" }>
  | Readonly<{ type: "enhancement-started"; passCount: number }>
  | Readonly<{ type: "enhancement-finished"; passCount: number }>
  | Readonly<{ type: "budget-exhausted"; passCount: number; message: string }>
  // There is deliberately no "clear-error": an error stays visible until the work that
  // could have fixed it succeeds (a completed enhancement pass) or a new capture starts.
  // A dismiss event existed and was never dispatched, so it only made the status bar's
  // stickiness look accidental.
  | Readonly<{ type: "error"; passCount?: number; message: string }>;

export const INITIAL_PLUGIN_STATE: PluginUiState = Object.freeze({
  mode: "idle",
  captureActive: false,
  stopping: false,
  passCount: 0,
});

export function reducePluginState(state: PluginUiState, event: PluginUiEvent): PluginUiState {
  switch (event.type) {
    case "capture-started":
      return { mode: "capturing", captureActive: true, stopping: false, passCount: 0 };
    case "capture-stopping":
      return state.mode === "error" || state.mode === "budget-exhausted"
        ? { ...state, stopping: true }
        : { mode: "stopping", captureActive: state.captureActive, stopping: true, passCount: state.passCount };
    case "capture-stopped":
      return state.mode === "error" || state.mode === "budget-exhausted"
        ? { ...state, captureActive: false, stopping: false }
        : { mode: "idle", captureActive: false, stopping: false, passCount: state.passCount };
    case "enhancement-started":
      return {
        mode: "enhancing",
        captureActive: state.captureActive,
        stopping: state.stopping,
        passCount: event.passCount,
      };
    case "enhancement-finished":
      return {
        mode: restingMode(state),
        captureActive: state.captureActive,
        stopping: state.stopping,
        passCount: event.passCount,
      };
    case "budget-exhausted":
      return {
        mode: "budget-exhausted",
        captureActive: state.captureActive,
        stopping: state.stopping,
        passCount: event.passCount,
        message: event.message,
      };
    case "error":
      return {
        mode: "error",
        captureActive: state.captureActive,
        stopping: state.stopping,
        passCount: event.passCount ?? state.passCount,
        message: event.message,
      };
  }
}

/** Where the status returns to once a transient mode ends. */
function restingMode(state: PluginUiState): PluginMode {
  if (state.stopping) return "stopping";
  return state.captureActive ? "capturing" : "idle";
}

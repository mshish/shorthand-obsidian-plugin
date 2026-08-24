export type PluginMode = "idle" | "capturing" | "stopping" | "enhancing" | "enhancement-stopped" | "error";

export type PluginUiState = Readonly<{
  mode: PluginMode;
  captureActive: boolean;
  /**
   * Set between the stop request and the capture actually finishing. Stopping is not
   * instant — it can spend a control timeout plus the full drain budget waiting for
   * Shorthand's `final` — and without this the status bar still read "capturing" for the whole
   * of it, which looks like a hang. Kept as its own flag rather than only a mode because
   * the final enhancement pass runs inside that window and must return to "stopping", not
   * back to "capturing".
   */
  stopping: boolean;
  message?: string;
}>;

export type PluginUiEvent =
  | Readonly<{ type: "capture-started" }>
  | Readonly<{ type: "capture-stopping" }>
  | Readonly<{ type: "capture-stopped" }>
  | Readonly<{ type: "enhancement-started" }>
  | Readonly<{ type: "enhancement-finished" }>
  | Readonly<{ type: "enhancement-stopped"; message: string }>
  // There is deliberately no "clear-error": an error stays visible until the work that
  // could have fixed it succeeds (a completed enhancement pass) or a new capture starts.
  // A dismiss event existed and was never dispatched, so it only made the status bar's
  // stickiness look accidental.
  | Readonly<{ type: "error"; message: string }>;

export const INITIAL_PLUGIN_STATE: PluginUiState = Object.freeze({
  mode: "idle",
  captureActive: false,
  stopping: false,
});

export function reducePluginState(state: PluginUiState, event: PluginUiEvent): PluginUiState {
  switch (event.type) {
    case "capture-started":
      return { mode: "capturing", captureActive: true, stopping: false };
    case "capture-stopping":
      return state.mode === "error" || state.mode === "enhancement-stopped"
        ? { ...state, stopping: true }
        : { mode: "stopping", captureActive: state.captureActive, stopping: true };
    case "capture-stopped":
      return state.mode === "error" || state.mode === "enhancement-stopped"
        ? { ...state, captureActive: false, stopping: false }
        : { mode: "idle", captureActive: false, stopping: false };
    case "enhancement-started":
      return {
        mode: "enhancing",
        captureActive: state.captureActive,
        stopping: state.stopping,
      };
    case "enhancement-finished":
      return {
        mode: restingMode(state),
        captureActive: state.captureActive,
        stopping: state.stopping,
      };
    case "enhancement-stopped":
      return {
        mode: "enhancement-stopped",
        captureActive: state.captureActive,
        stopping: state.stopping,
        message: event.message,
      };
    case "error":
      return {
        mode: "error",
        captureActive: state.captureActive,
        stopping: state.stopping,
        message: event.message,
      };
  }
}

/** Where the status returns to once a transient mode ends. */
function restingMode(state: PluginUiState): PluginMode {
  if (state.stopping) return "stopping";
  return state.captureActive ? "capturing" : "idle";
}

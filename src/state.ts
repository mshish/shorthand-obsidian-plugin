export type PluginMode =
  | "idle"
  | "starting"
  | "capturing"
  | "stopping"
  | "enhancing"
  | "enhancement-stopped"
  | "error";

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
  /**
   * How many enhancement passes are running, not whether one is.
   *
   * "Enhance now" on a note the capture does not own builds its own `EnhanceRunner`, so two
   * passes can be in flight at once and both report here. A boolean let whichever finished
   * first end the state while the other was still writing into a note.
   */
  enhancementDepth: number;
  message?: string;
}>;

export type PluginUiEvent =
  /**
   * Dispatched synchronously, as the first statement of `startCaptureOnActiveNote`, before
   * any await. That is the whole point of it: the runtime it announces does not exist for
   * some time yet — marker preflight, a possible confirmation modal, frontmatter writes,
   * sidecar setup and `createEnhancer` all run first — and the guard that used to protect
   * that window tested `#capture`, which is assigned at the end of it.
   */
  | Readonly<{ type: "capture-starting" }>
  /** The start sequence gave up before a capture existed. Distinct from a capture stopping. */
  | Readonly<{ type: "capture-start-failed" }>
  | Readonly<{ type: "capture-started" }>
  | Readonly<{ type: "capture-stopping" }>
  | Readonly<{ type: "capture-stopped" }>
  | Readonly<{ type: "enhancement-started" }>
  | Readonly<{ type: "enhancement-finished" }>
  /**
   * A pass ended without completing — core reported `error`, `skipped`, `requeued` or
   * `timed-out`. Distinct from `enhancement-finished`: that event both releases a slot
   * *and* clears a sticky `error`/`enhancement-stopped`, because a completed pass is the
   * work the "no clear-error" rule below is waiting for. A pass that did not complete
   * earns neither — it must still release its slot (core's terminal statuses were going
   * undecremented, leaving `enhancementDepth` positive forever once one fired), but it
   * must not wipe a sticky mode it did nothing to fix.
   */
  | Readonly<{ type: "enhancement-ended" }>
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
  enhancementDepth: 0,
});

/**
 * Whether a start command may proceed.
 *
 * The predicate is here rather than in `main.ts` so it can be tested: `main.ts` cannot be
 * imported under `bun test`, which is exactly why the old asynchronous guard survived
 * review. `starting` is the state this exists for.
 */
export function canStartCapture(state: PluginUiState): boolean {
  // Deliberately not "mode === idle". `error` and `enhancement-stopped` are sticky by
  // design and outlive the capture that raised them, so gating on the mode alone would
  // make one failed capture refuse every start until Obsidian restarted. What actually
  // blocks a start is another start or capture being in flight.
  return state.mode !== "starting"
    && state.mode !== "capturing"
    && state.mode !== "stopping"
    && !state.captureActive
    && !state.stopping;
}

export function reducePluginState(state: PluginUiState, event: PluginUiEvent): PluginUiState {
  switch (event.type) {
    case "capture-starting":
      return { mode: "starting", captureActive: false, stopping: false, enhancementDepth: 0 };
    case "capture-start-failed":
      // Only `starting` returns to idle. A setup failure calls `fail()` first, which
      // dispatches a sticky `error` carrying the message the user needs; clearing that
      // to idle on the way out would blank the status bar on the one path where
      // something actually went wrong. From any other mode this just releases the start.
      return state.mode === "starting"
        ? { mode: "idle", captureActive: false, stopping: false, enhancementDepth: 0 }
        : { ...state, captureActive: false, stopping: false };
    case "capture-started":
      // Not gated on `state.mode`: only `error` and `enhancement-stopped` ever set
      // `message`, and both unconditionally overwrite `mode` away from `starting` — so a
      // `state.mode === "starting"` check here could never fire, on any input. What makes
      // preserving the message safe instead is `capture-starting` above: its case is a
      // literal reset that unconditionally drops any message left over from a *previous*
      // capture the instant a new one begins. So whatever is still present by the time
      // this dispatches can only have arisen during *this* start's own setup — enhancer
      // unavailable, or a connection error before Assisted Notes' acknowledgement landed
      // (up to `START_ACKNOWLEDGEMENT_MS` later) — never a stale leftover, and it must
      // survive onto the capture it belongs to rather than being wiped by the very dispatch
      // that confirms it. `exactOptionalPropertyTypes` is why this is a conditional spread
      // rather than `message: state.message`, which would assign `undefined` explicitly.
      return {
        mode: "capturing",
        captureActive: true,
        stopping: false,
        enhancementDepth: 0,
        ...(state.message !== undefined ? { message: state.message } : {}),
      };
    case "capture-stopping":
      return state.mode === "error" || state.mode === "enhancement-stopped"
        ? { ...state, stopping: true }
        : {
          mode: "stopping",
          captureActive: state.captureActive,
          stopping: true,
          enhancementDepth: state.enhancementDepth,
        };
    case "capture-stopped":
      return state.mode === "error" || state.mode === "enhancement-stopped"
        ? { ...state, captureActive: false, stopping: false }
        : { mode: "idle", captureActive: false, stopping: false, enhancementDepth: 0 };
    case "enhancement-started":
      return {
        mode: "enhancing",
        captureActive: state.captureActive,
        stopping: state.stopping,
        enhancementDepth: state.enhancementDepth + 1,
      };
    case "enhancement-finished": {
      // Floored at zero rather than trusted: `reportOutcome` and `onEnhanceStatus` both
      // dispatch "finished", so a single pass can report twice, and a negative depth would
      // strand the mode in `enhancing` for the rest of the session.
      const depth = Math.max(0, state.enhancementDepth - 1);
      return {
        mode: depth > 0 ? "enhancing" : restingMode(state),
        captureActive: state.captureActive,
        stopping: state.stopping,
        enhancementDepth: depth,
      };
    }
    case "enhancement-ended": {
      // A pass that did not complete. It releases its slot but earns nothing: unlike
      // `enhancement-finished` it must not clear a sticky error, because no work that
      // could have fixed the error actually succeeded.
      const depth = Math.max(0, state.enhancementDepth - 1);
      const settled = state.mode === "error" || state.mode === "enhancement-stopped"
        ? state.mode
        : restingMode(state);
      return { ...state, mode: depth > 0 ? "enhancing" : settled, enhancementDepth: depth };
    }
    case "enhancement-stopped":
      return {
        mode: "enhancement-stopped",
        captureActive: state.captureActive,
        stopping: state.stopping,
        // The pass that stopped released its slot; it is not still running.
        enhancementDepth: Math.max(0, state.enhancementDepth - 1),
        message: event.message,
      };
    case "error":
      return {
        mode: "error",
        captureActive: state.captureActive,
        stopping: state.stopping,
        enhancementDepth: state.enhancementDepth,
        message: event.message,
      };
  }
}

/** Where the status returns to once a transient mode ends. */
function restingMode(state: PluginUiState): PluginMode {
  // `starting` outranks the rest: a capture being set up is not a resting state, and a
  // pass belonging to some *other* note must not be able to end it. Dropping out of
  // `starting` here is dropping the only guard against a second start — `canStartCapture`
  // is now the sole gate, the old `#capture` test having gone.
  if (state.mode === "starting") return "starting";
  if (state.stopping) return "stopping";
  return state.captureActive ? "capturing" : "idle";
}

/**
 * Every transition the reducer can make, as data.
 *
 * It exists so `docs/capture-states.md` can be checked against the code rather than
 * maintained beside it. A hand-drawn diagram of a state machine is wrong within two
 * changes; a test that regenerates it is not.
 */
export const STATE_TRANSITIONS: readonly Readonly<{
  from: PluginMode;
  event: PluginUiEvent["type"];
  to: PluginMode;
}>[] = Object.freeze([
  { from: "idle", event: "capture-starting", to: "starting" },
  // Reachable, and listed rather than quietly omitted: `capture-started` does not
  // require a preceding `capture-starting`, and a table that only drew the happy
  // path would let that go unnoticed.
  { from: "idle", event: "capture-started", to: "capturing" },
  // Neither of these requires an active capture either — the reducer computes the next
  // mode from the event alone, not from whether a capture is actually running.
  { from: "idle", event: "capture-stopping", to: "stopping" },
  { from: "idle", event: "enhancement-started", to: "enhancing" },
  { from: "idle", event: "enhancement-stopped", to: "enhancement-stopped" },
  { from: "idle", event: "error", to: "error" },
  { from: "starting", event: "capture-started", to: "capturing" },
  { from: "starting", event: "capture-start-failed", to: "idle" },
  { from: "starting", event: "capture-stopping", to: "stopping" },
  { from: "starting", event: "capture-stopped", to: "idle" },
  { from: "starting", event: "enhancement-started", to: "enhancing" },
  // Self-loops, not omissions: a pass belonging to some *other* note reports into this same
  // reducer (every `EnhanceRunner`, capture-owned or standalone, shares one `onStatus`), and
  // without `restingMode`'s `starting` special case both of these used to drop to `idle`,
  // reopening the guard `capture-starting` exists to hold shut. Listed explicitly so the
  // diagram shows the guard surviving rather than an edge quietly not being drawn.
  { from: "starting", event: "enhancement-finished", to: "starting" },
  { from: "starting", event: "enhancement-ended", to: "starting" },
  // "Stopped" always lands on its own sticky mode regardless of what was in flight, since
  // its case sets `mode: "enhancement-stopped"` unconditionally rather than consulting
  // `restingMode` — unlike `enhancement-finished`/`enhancement-ended`, this one is not
  // guarded, and a standalone pass can still walk `starting` forward here.
  { from: "starting", event: "enhancement-stopped", to: "enhancement-stopped" },
  { from: "starting", event: "error", to: "error" },
  { from: "capturing", event: "capture-stopping", to: "stopping" },
  { from: "capturing", event: "capture-stopped", to: "idle" },
  { from: "capturing", event: "capture-starting", to: "starting" },
  { from: "capturing", event: "enhancement-started", to: "enhancing" },
  { from: "capturing", event: "enhancement-stopped", to: "enhancement-stopped" },
  { from: "capturing", event: "error", to: "error" },
  { from: "stopping", event: "capture-stopped", to: "idle" },
  { from: "stopping", event: "capture-starting", to: "starting" },
  { from: "stopping", event: "capture-started", to: "capturing" },
  { from: "stopping", event: "enhancement-started", to: "enhancing" },
  { from: "stopping", event: "enhancement-stopped", to: "enhancement-stopped" },
  { from: "stopping", event: "error", to: "error" },
  { from: "enhancing", event: "enhancement-finished", to: "capturing" },
  // Unlike "finished", "ended" checks the incoming mode for a sticky error/enhancement-
  // stopped before falling back to `restingMode` — but `enhancing` is neither, so the two
  // agree here and both land on "capturing".
  { from: "enhancing", event: "enhancement-ended", to: "capturing" },
  { from: "enhancing", event: "enhancement-stopped", to: "enhancement-stopped" },
  { from: "enhancing", event: "capture-starting", to: "starting" },
  { from: "enhancing", event: "capture-started", to: "capturing" },
  { from: "enhancing", event: "capture-stopping", to: "stopping" },
  { from: "enhancing", event: "capture-stopped", to: "idle" },
  { from: "enhancing", event: "error", to: "error" },
  { from: "enhancement-stopped", event: "capture-starting", to: "starting" },
  { from: "enhancement-stopped", event: "capture-started", to: "capturing" },
  { from: "enhancement-stopped", event: "enhancement-started", to: "enhancing" },
  // Unpaired: this mode is entered only by an enhancement pass already having stopped,
  // so a "finished" reaching it is a second dispatch for the same pass (see the doubled-
  // dispatch comment on the "enhancement-finished" case). It floors the depth at zero
  // and, because it does not look at the mode it started from, releases the sticky
  // "enhancement-stopped" mode back to "capturing" rather than leaving it stuck.
  { from: "enhancement-stopped", event: "enhancement-finished", to: "capturing" },
  { from: "enhancement-stopped", event: "error", to: "error" },
  { from: "error", event: "capture-starting", to: "starting" },
  { from: "error", event: "capture-started", to: "capturing" },
  { from: "error", event: "enhancement-started", to: "enhancing" },
  // Same unpairing as above: an error is cleared by a completed pass, and
  // "enhancement-finished" clears it even when no pass this reducer saw start caused it.
  { from: "error", event: "enhancement-finished", to: "capturing" },
  { from: "error", event: "enhancement-stopped", to: "enhancement-stopped" },
]);

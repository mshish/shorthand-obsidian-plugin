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
   * Set between `capture-starting` and whichever of `capture-started` /
   * `capture-start-failed` / `capture-stopped` ends the attempt. Kept as its own flag for
   * the same reason `stopping` is: `error` and `enhancement-stopped` overwrite `mode`
   * unconditionally (so the user sees what went wrong), and a mode-only guard let one of
   * those, raised mid-setup, silently reopen `canStartCapture` — a second start could then
   * build a second runtime and orphan the first's follower, control and recorder while it
   * was still being assembled. The flag survives that overwrite even though the mode does
   * not, so `canStartCapture` has a fact to gate on that a sticky label can't clobber.
   */
  starting: boolean;
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
  starting: false,
  enhancementDepth: 0,
});

/**
 * Whether a start command may proceed.
 *
 * The predicate is here rather than in `main.ts` so it can be tested: `main.ts` cannot be
 * imported under `bun test`, which is exactly why the old asynchronous guard survived
 * review. Gates on the `starting` *flag*, not `mode === "starting"`: an `error` or
 * `enhancement-stopped` raised mid-setup overwrites the mode (deliberately — the user needs
 * to see what went wrong) but must not release this guard, since nothing else stops a
 * second start from building a second runtime while the first is still being assembled.
 */
export function canStartCapture(state: PluginUiState): boolean {
  // Deliberately not "mode === idle" either. `error` and `enhancement-stopped` are sticky
  // by design and outlive the capture that raised them, so gating on the mode alone would
  // make one failed capture refuse every start until Obsidian restarted. What actually
  // blocks a start is another start (`starting`) or a capture (`captureActive`/`stopping`)
  // being in flight.
  return !state.starting
    && state.mode !== "capturing"
    && state.mode !== "stopping"
    && !state.captureActive
    && !state.stopping;
}

export function reducePluginState(state: PluginUiState, event: PluginUiEvent): PluginUiState {
  switch (event.type) {
    case "capture-starting":
      return { mode: "starting", captureActive: false, stopping: false, starting: true, enhancementDepth: 0 };
    case "capture-start-failed":
      // The *mode* decision is still "only `starting` returns to idle" — a setup failure
      // calls `fail()` first, which dispatches a sticky `error` carrying the message the
      // user needs, and clearing that to idle on the way out would blank the status bar on
      // the one path where something actually went wrong. But `starting` the *flag* clears
      // unconditionally either way: this event is one of the three that end a start attempt
      // (see the flag's own comment), regardless of which mode it lands on.
      return state.mode === "starting"
        ? { mode: "idle", captureActive: false, stopping: false, starting: false, enhancementDepth: 0 }
        : { ...state, captureActive: false, stopping: false, starting: false };
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
        starting: false,
        enhancementDepth: 0,
        ...(state.message !== undefined ? { message: state.message } : {}),
      };
    case "capture-stopping":
      // Carries `starting` through untouched in both branches (explicitly in the second,
      // via the spread in the first): a stop requested mid-setup does not resolve the start
      // attempt by itself — `capture-stopped`, dispatched once teardown actually finishes,
      // is what ends it. Until then a second start must still be refused.
      return state.mode === "error" || state.mode === "enhancement-stopped"
        ? { ...state, stopping: true }
        : {
          mode: "stopping",
          captureActive: state.captureActive,
          stopping: true,
          starting: state.starting,
          enhancementDepth: state.enhancementDepth,
        };
    case "capture-stopped":
      // One of the three events that end a start attempt (see the flag's own comment),
      // so `starting` clears unconditionally here too — including on the branch that
      // otherwise preserves a sticky `error`/`enhancement-stopped` mode and message.
      return state.mode === "error" || state.mode === "enhancement-stopped"
        ? { ...state, captureActive: false, stopping: false, starting: false }
        : { mode: "idle", captureActive: false, stopping: false, starting: false, enhancementDepth: 0 };
    case "enhancement-started":
      return {
        mode: "enhancing",
        captureActive: state.captureActive,
        stopping: state.stopping,
        starting: state.starting,
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
        starting: state.starting,
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
        // Carried through, not cleared: a pass stopping does not end a start attempt, and
        // this case (like "error") sets `mode` unconditionally without consulting
        // `restingMode` — see `canStartCapture`'s comment for why the flag has to survive
        // that regardless.
        starting: state.starting,
        // The pass that stopped released its slot; it is not still running.
        enhancementDepth: Math.max(0, state.enhancementDepth - 1),
        message: event.message,
      };
    case "error":
      return {
        mode: "error",
        captureActive: state.captureActive,
        stopping: state.stopping,
        // Carried through, not cleared: an error mid-setup is the exact case `starting`
        // exists to protect. `mode` shows "error" so the user sees what went wrong;
        // `starting` stays true underneath so `canStartCapture` keeps refusing a second
        // start until this attempt actually ends.
        starting: state.starting,
        enhancementDepth: state.enhancementDepth,
        message: event.message,
      };
  }
}

/** Where the status returns to once a transient mode ends. */
function restingMode(state: PluginUiState): PluginMode {
  // `starting` outranks the rest: a capture being set up is not a resting state, and a
  // pass belonging to some *other* note must not be able to end it. Reads the flag, not
  // the mode: `error`/`enhancement-stopped` can be showing by the time this runs (see their
  // own comments), and the flag is what actually still guards `canStartCapture`.
  if (state.starting) return "starting";
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
  // `restingMode` — unlike `enhancement-finished`/`enhancement-ended`, this row is not
  // guarded by `restingMode`. It used to be a real gap for exactly that reason: a
  // standalone pass could walk the *mode* out of `starting` here the same way `error`
  // could. `PluginUiState.starting` is the fix — a second, independent flag that survives
  // this exact overwrite — so the mode transition below is fine to keep drawing as-is; only
  // `canStartCapture` needed to stop trusting the mode for this.
  { from: "starting", event: "enhancement-stopped", to: "enhancement-stopped" },
  // Same story as "enhancement-stopped" just above, and the more reachable of the two in
  // practice: `main.ts` calls `fail()` for an unavailable enhancer *after* the runtime is
  // already live, and on the Assisted Notes path *instead of* the deferred `capture-started`
  // — so this row fires on the plugin's most likely start-time failure, not a rare timing
  // coincidence. `starting` the flag is what still refuses a second start here.
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

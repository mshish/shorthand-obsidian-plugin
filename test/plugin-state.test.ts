import { describe, expect, test } from "bun:test";
import {
  INITIAL_PLUGIN_STATE,
  reducePluginState,
  STATE_TRANSITIONS,
  canStartCapture,
  type PluginMode,
  type PluginUiEvent,
  type PluginUiState,
} from "../src/state.js";

const ALL_MODES = [
  "idle", "starting", "capturing", "stopping", "enhancing", "enhancement-stopped", "error",
] as const satisfies readonly PluginMode[];

const ALL_EVENT_TYPES = [
  "capture-starting", "capture-start-failed", "capture-started", "capture-stopping",
  "capture-stopped", "enhancement-started", "enhancement-finished", "enhancement-ended",
  "enhancement-stopped", "error",
] as const satisfies readonly PluginUiEvent["type"][];

/** A state parked in `mode`, built only through the reducer so it is always reachable. */
function stateInMode(mode: PluginMode): PluginUiState {
  switch (mode) {
    case "idle":
      return INITIAL_PLUGIN_STATE;
    case "starting":
      return reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-starting" });
    case "capturing":
      return reducePluginState(stateInMode("starting"), { type: "capture-started" });
    case "stopping":
      return reducePluginState(stateInMode("capturing"), { type: "capture-stopping" });
    case "enhancing":
      return reducePluginState(stateInMode("capturing"), { type: "enhancement-started" });
    case "enhancement-stopped":
      return reducePluginState(stateInMode("enhancing"), { type: "enhancement-stopped", message: "out of time" });
    case "error":
      return reducePluginState(stateInMode("capturing"), { type: "error", message: "boom" });
  }
}

/**
 * A representative event of each type, for driving the transition table.
 *
 * Exhaustive by hand, like `stateInMode` above and for the same reason: a `default` branch
 * would compile for any new payload-less event and let it silently miss `ALL_EVENT_TYPES`,
 * which is exactly the vacuous-pass failure the "table lists every transition" test exists
 * to catch, just on the event axis instead of the mode axis.
 */
function eventOfType(type: PluginUiEvent["type"]): PluginUiEvent {
  switch (type) {
    case "capture-starting":
    case "capture-start-failed":
    case "capture-started":
    case "capture-stopping":
    case "capture-stopped":
    case "enhancement-started":
    case "enhancement-finished":
    case "enhancement-ended":
      return { type };
    case "enhancement-stopped":
      return { type, message: "out of time" };
    case "error":
      return { type, message: "boom" };
    default: {
      const unhandled: never = type;
      throw new Error(`Unhandled event type: ${JSON.stringify(unhandled)}`);
    }
  }
}

describe("plugin status state machine", () => {
  test("returns to capture after an enhancement pass", () => {
    const capturing = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-started" });
    const enhancing = reducePluginState(capturing, { type: "enhancement-started" });
    expect(reducePluginState(enhancing, { type: "enhancement-finished" }))
      .toEqual({ mode: "capturing", captureActive: true, stopping: false, enhancementDepth: 0 });
  });

  test("keeps capture active when enhancement stops after the maximum capture window", () => {
    const capturing = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-started" });
    expect(reducePluginState(capturing, {
      type: "enhancement-stopped", message: "Enhancement stopped after the maximum capture window",
    })).toEqual({
      mode: "enhancement-stopped",
      captureActive: true,
      stopping: false,
      enhancementDepth: 0,
      message: "Enhancement stopped after the maximum capture window",
    });
  });

  // There is no dismiss event: an error clears only when the work that could have fixed it
  // succeeds. A completed pass is that work, and it must not forget the active capture.
  test("a completed pass clears an error without forgetting an active capture", () => {
    const capturing = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-started" });
    const failed = reducePluginState(capturing, { type: "error", message: "locked" });
    expect(reducePluginState(failed, { type: "enhancement-finished" }))
      .toEqual({ mode: "capturing", captureActive: true, stopping: false, enhancementDepth: 0 });
  });

  // Stopping is not instant: it can spend a control timeout plus the whole drain budget
  // waiting for Shorthand's `final`, and the status bar used to read "capturing"
  // throughout, which looks like a hang.
  test("a stop request is visible before the capture has finished stopping", () => {
    const capturing = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-started" });
    const stopping = reducePluginState(capturing, { type: "capture-stopping" });
    expect(stopping).toEqual({ mode: "stopping", captureActive: true, stopping: true, enhancementDepth: 0 });
    expect(reducePluginState(stopping, { type: "capture-stopped" }))
      .toEqual({ mode: "idle", captureActive: false, stopping: false, enhancementDepth: 0 });
  });

  // The final link-tier pass runs inside the stop window, so its own started/finished
  // events must not advertise a capture that is already on its way out.
  test("the final enhancement pass returns to stopping, not to capturing", () => {
    const capturing = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-started" });
    const stopping = reducePluginState(capturing, { type: "capture-stopping" });
    const enhancing = reducePluginState(stopping, { type: "enhancement-started" });
    expect(enhancing.stopping).toBe(true);
    expect(reducePluginState(enhancing, { type: "enhancement-finished" }))
      .toEqual({ mode: "stopping", captureActive: true, stopping: true, enhancementDepth: 0 });
  });

  // The other half of "no dismiss event": the error is documented as staying visible until a
  // completed pass or a *new capture*. The clearing happens at `capture-starting`, not at
  // `capture-started` — its case is a literal reset that drops any message unconditionally
  // — because every real start dispatches `capture-starting` first, synchronously, before
  // `capture-started` can ever follow. Routed through both here to match that real sequence:
  // a version of this test that skipped straight to `capture-started` would demonstrate
  // nothing, since `capture-started` alone cannot tell a stale message from a fresh one (see
  // its case comment) and only preserves what is still there when it fires.
  test("starting a new capture clears an error left over from the last one", () => {
    const failed = reducePluginState(INITIAL_PLUGIN_STATE, { type: "error", message: "locked" });
    expect(failed.message).toBe("locked");
    const starting = reducePluginState(failed, { type: "capture-starting" });
    expect(starting.message).toBeUndefined();
    const restarted = reducePluginState(starting, { type: "capture-started" });
    expect(restarted).toEqual({ mode: "capturing", captureActive: true, stopping: false, enhancementDepth: 0 });
    expect(restarted.message).toBeUndefined();
  });

  test("a stop request during an error keeps the error message", () => {
    const capturing = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-started" });
    const failed = reducePluginState(capturing, { type: "error", message: "locked" });
    const stopping = reducePluginState(failed, { type: "capture-stopping" });
    expect(stopping).toEqual({
      mode: "error", captureActive: true, stopping: true, enhancementDepth: 0, message: "locked",
    });
    // And the message survives the capture ending, so the user still sees why it failed.
    expect(reducePluginState(stopping, { type: "capture-stopped" })).toEqual({
      mode: "error", captureActive: false, stopping: false, enhancementDepth: 0, message: "locked",
    });
  });

  test("a start is refused while another start is still in flight", () => {
    // The bug this closes: startCaptureOnActiveNote guarded on `#capture !== undefined`,
    // which is assigned only after marker preflight, a possible modal, frontmatter
    // writes, sidecar setup and createEnhancer. Two invocations inside that window both
    // passed the guard and both built a runtime; the second assignment orphaned the
    // first, leaving a live follower child, a control and an enhancer nothing would ever
    // dispose, and a Shorthand recording still running.
    const starting = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-starting" });
    expect(starting.mode).toBe("starting");
    expect(canStartCapture(starting)).toBe(false);
    expect(canStartCapture(INITIAL_PLUGIN_STATE)).toBe(true);
  });

  test("a start that never became a capture returns to idle, not to stopped", () => {
    // Assisted Notes' start acknowledgement can time out after the runtime exists.
    // Reporting that as a stopped capture tells the user something ran when nothing did.
    const starting = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-starting" });
    const failed = reducePluginState(starting, { type: "capture-start-failed" });
    expect(failed).toEqual({ mode: "idle", captureActive: false, stopping: false, enhancementDepth: 0 });
  });

  test("capturing is only claimed once the capture actually exists", () => {
    const starting = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-starting" });
    expect(starting.captureActive).toBe(false);
    const started = reducePluginState(starting, { type: "capture-started" });
    expect(started).toEqual({ mode: "capturing", captureActive: true, stopping: false, enhancementDepth: 0 });
  });

  test("counts overlapping enhancement passes instead of toggling", () => {
    // "Enhance now" on a second note while a capture runs on the first builds an
    // independent EnhanceRunner. Both report here. With a boolean sense of "enhancing",
    // whichever finished first ended the state while the other was still writing.
    const capturing = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-started" });
    const one = reducePluginState(capturing, { type: "enhancement-started" });
    const two = reducePluginState(one, { type: "enhancement-started" });
    expect(two.enhancementDepth).toBe(2);
    const stillWriting = reducePluginState(two, { type: "enhancement-finished" });
    expect(stillWriting.mode).toBe("enhancing");
    const done = reducePluginState(stillWriting, { type: "enhancement-finished" });
    expect(done.mode).toBe("capturing");
    expect(done.enhancementDepth).toBe(0);
  });

  test("the depth floors at zero, so an unpaired finish cannot strand it negative", () => {
    const capturing = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-started" });
    const done = reducePluginState(capturing, { type: "enhancement-finished" });
    expect(done.enhancementDepth).toBe(0);
    expect(done.mode).toBe("capturing");
  });

  test("a stopped enhancement releases its own slot", () => {
    const capturing = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-started" });
    const one = reducePluginState(capturing, { type: "enhancement-started" });
    const stopped = reducePluginState(one, { type: "enhancement-stopped", message: "out of time" });
    expect(stopped.enhancementDepth).toBe(0);
    expect(stopped.mode).toBe("enhancement-stopped");
  });

  test("a pass belonging to some other note cannot release the starting guard", () => {
    // `enhancement-finished` never reads `state.mode` — it floors the depth and rests
    // wherever `restingMode` says. "Enhance now" on a note the capture does not own builds
    // its own `EnhanceRunner`, wired to the same `onEnhanceStatus`, so its "finished" reaches
    // this reducer too. Without `restingMode`'s own `starting` guard, that unrelated pass
    // finishing while a second capture was mid-setup dropped the mode to `idle` and reopened
    // exactly the re-entrancy window `capture-starting` exists to hold shut.
    const starting = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-starting" });
    const stillStarting = reducePluginState(starting, { type: "enhancement-finished" });
    expect(stillStarting.mode).toBe("starting");
    expect(canStartCapture(stillStarting)).toBe(false);
  });

  test("a pass that ends without completing also cannot release the starting guard", () => {
    const starting = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-starting" });
    const stillStarting = reducePluginState(starting, { type: "enhancement-ended" });
    expect(stillStarting.mode).toBe("starting");
    expect(canStartCapture(stillStarting)).toBe(false);
  });

  test("started, error, started, finished lands on capturing — not stuck in enhancing", () => {
    // Mirrors `onEnhanceStatus`'s fixed dispatch order for a pass that ends in core's
    // `error` status: it now fires `enhancement-ended` (releasing the slot) *before*
    // `fail()` (which dispatches the sticky `error`) — see the ordering comment there.
    // Before this fix, `onEnhanceStatus` dispatched nothing at all for a pass ending in
    // `error`, `skipped`, `requeued` or `timed-out`, so the slot the first pass held was
    // never released: a second pass's own "finished" only brought the count from 2 down to
    // 1, and the mode stayed pinned on "enhancing" for the rest of the capture — the old
    // boolean did not have this failure, only the counter does.
    const capturing = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-started" });
    const started = reducePluginState(capturing, { type: "enhancement-started" });
    const ended = reducePluginState(started, { type: "enhancement-ended" });
    const flagged = reducePluginState(ended, { type: "error", message: "connection reset" });
    const startedAgain = reducePluginState(flagged, { type: "enhancement-started" });
    const finished = reducePluginState(startedAgain, { type: "enhancement-finished" });
    expect(finished.mode).toBe("capturing");
    expect(finished.enhancementDepth).toBe(0);
  });

  test("an ended pass does not clear a sticky error the way a finished one does", () => {
    // The pass is still the one running when the error landed — no intervening "started" —
    // so when it too ends without completing, the error it did nothing to fix must stand.
    const capturing = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-started" });
    const started = reducePluginState(capturing, { type: "enhancement-started" });
    const flagged = reducePluginState(started, { type: "error", message: "connection reset" });
    const stillFlagged = reducePluginState(flagged, { type: "enhancement-ended" });
    expect(stillFlagged.mode).toBe("error");
    expect(stillFlagged.message).toBe("connection reset");
    expect(stillFlagged.enhancementDepth).toBe(0);
  });

  test("a start that raised its own error keeps it once Assisted Notes confirms the capture", () => {
    // The Assisted Notes acknowledgement can land up to `START_ACKNOWLEDGEMENT_MS` after
    // `#capture` is assigned, so an error raised in that window (enhancer unavailable, a
    // connection error) predates the `capture-started` dispatch that confirms the runtime.
    // `capture-started` returning a fresh object with no `message` erased it.
    const starting = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-starting" });
    const flagged = reducePluginState(starting, { type: "error", message: "enhancer unavailable" });
    const started = reducePluginState(flagged, { type: "capture-started" });
    expect(started).toEqual({
      mode: "capturing", captureActive: true, stopping: false, enhancementDepth: 0,
      message: "enhancer unavailable",
    });
  });

  // Two directions, and the second is the one that matters. Checking only that each
  // listed row is reachable lets an unlisted transition — `capture-started` straight
  // from idle, `error` from anywhere — pass vacuously by simply never being written
  // down, which is exactly the drift the diagram exists to prevent.
  test("every listed transition is what the reducer actually does", () => {
    for (const { from, event, to } of STATE_TRANSITIONS) {
      const next = reducePluginState(stateInMode(from), eventOfType(event));
      expect({ from, event, to: next.mode }).toEqual({ from, event, to });
    }
  });

  test("the table lists every mode-changing transition the reducer can make", () => {
    const listed = new Set(STATE_TRANSITIONS.map(({ from, event }) => `${from}|${event}`));
    const missing: string[] = [];
    for (const from of ALL_MODES) {
      for (const event of ALL_EVENT_TYPES) {
        const before = stateInMode(from);
        const after = reducePluginState(before, eventOfType(event));
        // Self-transitions that change nothing observable are not edges worth drawing.
        if (after.mode === before.mode && after.message === before.message) continue;
        if (!listed.has(`${from}|${event}`)) missing.push(`${from} --${event}--> ${after.mode}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

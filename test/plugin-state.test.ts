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
  "capture-stopped", "enhancement-started", "enhancement-finished", "enhancement-stopped", "error",
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

/** A representative event of each type, for driving the transition table. */
function eventOfType(type: PluginUiEvent["type"]): PluginUiEvent {
  switch (type) {
    case "enhancement-stopped":
      return { type, message: "out of time" };
    case "error":
      return { type, message: "boom" };
    default:
      return { type };
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
  // completed pass or a *new capture*. Every other test drives `capture-started` from the
  // initial state, which carries no message, so a `capture-started` that retained one was
  // indistinguishable from one that cleared it.
  test("starting a new capture clears an error left over from the last one", () => {
    const failed = reducePluginState(INITIAL_PLUGIN_STATE, { type: "error", message: "locked" });
    expect(failed.message).toBe("locked");
    const restarted = reducePluginState(failed, { type: "capture-started" });
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

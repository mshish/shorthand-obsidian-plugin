import { describe, expect, test } from "bun:test";
import { INITIAL_PLUGIN_STATE, reducePluginState } from "../src/state.js";

describe("plugin status state machine", () => {
  test("returns to capture after an enhancement pass", () => {
    const capturing = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-started" });
    const enhancing = reducePluginState(capturing, { type: "enhancement-started", passCount: 0 });
    expect(reducePluginState(enhancing, { type: "enhancement-finished", passCount: 1 }))
      .toEqual({ mode: "capturing", captureActive: true, stopping: false, passCount: 1 });
  });

  test("keeps capture active when the enhancement budget is exhausted", () => {
    const capturing = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-started" });
    expect(reducePluginState(capturing, {
      type: "budget-exhausted", passCount: 3, message: "Pass budget exhausted",
    })).toEqual({
      mode: "budget-exhausted",
      captureActive: true,
      stopping: false,
      passCount: 3,
      message: "Pass budget exhausted",
    });
  });

  // There is no dismiss event: an error clears only when the work that could have fixed it
  // succeeds. A completed pass is that work, and it must not forget the active capture.
  test("a completed pass clears an error without forgetting an active capture", () => {
    const capturing = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-started" });
    const failed = reducePluginState(capturing, { type: "error", message: "locked" });
    expect(reducePluginState(failed, { type: "enhancement-finished", passCount: 0 }))
      .toEqual({ mode: "capturing", captureActive: true, stopping: false, passCount: 0 });
  });

  // Stopping is not instant: it can spend a control timeout plus a whole post-processing
  // drain waiting for Handy's `final`, and the status bar used to read "capturing"
  // throughout, which looks like a hang.
  test("a stop request is visible before the capture has finished stopping", () => {
    const capturing = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-started" });
    const stopping = reducePluginState(capturing, { type: "capture-stopping" });
    expect(stopping).toEqual({ mode: "stopping", captureActive: true, stopping: true, passCount: 0 });
    expect(reducePluginState(stopping, { type: "capture-stopped" }))
      .toEqual({ mode: "idle", captureActive: false, stopping: false, passCount: 0 });
  });

  // The final link-tier pass runs inside the stop window, so its own started/finished
  // events must not advertise a capture that is already on its way out.
  test("the final enhancement pass returns to stopping, not to capturing", () => {
    const capturing = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-started" });
    const stopping = reducePluginState(capturing, { type: "capture-stopping" });
    const enhancing = reducePluginState(stopping, { type: "enhancement-started", passCount: 2 });
    expect(enhancing.stopping).toBe(true);
    expect(reducePluginState(enhancing, { type: "enhancement-finished", passCount: 3 }))
      .toEqual({ mode: "stopping", captureActive: true, stopping: true, passCount: 3 });
  });

  // The other half of "no dismiss event": the error is documented as staying visible until a
  // completed pass or a *new capture*. Every other test drives `capture-started` from the
  // initial state, which carries no message, so a `capture-started` that retained one was
  // indistinguishable from one that cleared it.
  test("starting a new capture clears an error left over from the last one", () => {
    const failed = reducePluginState(INITIAL_PLUGIN_STATE, { type: "error", message: "locked" });
    expect(failed.message).toBe("locked");
    const restarted = reducePluginState(failed, { type: "capture-started" });
    expect(restarted).toEqual({ mode: "capturing", captureActive: true, stopping: false, passCount: 0 });
    expect(restarted.message).toBeUndefined();
  });

  test("a stop request during an error keeps the error message", () => {
    const capturing = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-started" });
    const failed = reducePluginState(capturing, { type: "error", message: "locked" });
    const stopping = reducePluginState(failed, { type: "capture-stopping" });
    expect(stopping).toEqual({
      mode: "error", captureActive: true, stopping: true, passCount: 0, message: "locked",
    });
    // And the message survives the capture ending, so the user still sees why it failed.
    expect(reducePluginState(stopping, { type: "capture-stopped" })).toEqual({
      mode: "error", captureActive: false, stopping: false, passCount: 0, message: "locked",
    });
  });
});

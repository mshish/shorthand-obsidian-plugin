import { describe, expect, test } from "bun:test";
import { describePanel, SHORTHAND_PANEL_VIEW } from "../src/panel-model.js";
import { INITIAL_PLUGIN_STATE, reducePluginState } from "../src/state.js";
import type { PluginUiState } from "../src/state.js";

const capturing: PluginUiState = reducePluginState(
  reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-starting" }),
  { type: "capture-started" },
);

const base = {
  elapsedMs: undefined,
  noteName: undefined,
  hasActiveNote: true,
  // Defaults to "nothing to stop"; tests for a live runtime override this explicitly so the
  // scenario reads plainly, rather than a shared default doing invisible work for them.
  hasCapture: false,
} as const;

const enabled = (model: ReturnType<typeof describePanel>): string[] =>
  model.buttons.filter((button) => button.enabled).map((button) => button.id);

describe("describePanel", () => {
  test("offers both starts and no stop when idle", () => {
    const model = describePanel({ ...base, state: INITIAL_PLUGIN_STATE });
    expect(model.headline).toBe("Not capturing");
    expect(enabled(model)).toEqual(["start-meeting", "start-assisted-notes"]);
  });

  test("always renders all three buttons, so the panel never reflows", () => {
    // Disabled rather than hidden: a panel whose controls appear and disappear
    // moves the button the user was reaching for.
    for (const state of [INITIAL_PLUGIN_STATE, capturing]) {
      expect(describePanel({ ...base, state }).buttons.map((button) => button.id))
        .toEqual(["start-meeting", "start-assisted-notes", "stop"]);
    }
  });

  test("offers only stop while capturing, and shows the clock", () => {
    const model = describePanel({ ...base, state: capturing, hasCapture: true, elapsedMs: 754_000, noteName: "Weekly sync" });
    expect(model.headline).toBe("Capturing — 12:34");
    expect(model.noteName).toBe("Weekly sync");
    expect(model.activityLabel).toBe("Taking notes");
    expect(enabled(model)).toEqual(["stop"]);
  });

  test("keeps Stop available during Assisted Notes' acknowledgement wait, before captureActive flips", () => {
    // Assisted Notes defers `capture-started` into its bounded acknowledgement, so a real
    // runtime can exist — and need stopping — for that whole window while `state.mode` is
    // still "starting" and `captureActive` is still false. Gating Stop on `captureActive`
    // greyed it out for exactly the capture the panel most needs to let a user cancel.
    const starting = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-starting" });
    const model = describePanel({ ...base, state: starting, hasCapture: true });
    expect(enabled(model)).toEqual(["stop"]);
  });

  test("uses a simple note-taking cue instead of an internal character gate", () => {
    const model = describePanel({ ...base, state: capturing, elapsedMs: 60_000 });
    expect(model.detail).toBeUndefined();
    expect(model.activityLabel).toBe("Taking notes");
  });

  test("disables every button with no Markdown note open, and says what to do", () => {
    // Both start commands are checkCallback-gated on an open note; a panel button
    // that ignored that would fire a command the palette would have hidden.
    const model = describePanel({ ...base, state: INITIAL_PLUGIN_STATE, hasActiveNote: false });
    expect(enabled(model)).toEqual([]);
    // Idle with no note and no error is the one case where every button is disabled and
    // no other message exists to say why.
    expect(model.detail).toBe("Open a Markdown note to start a capture.");
  });

  test("offers nothing while a start (with no runtime yet) or a stop is in flight", () => {
    const starting = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-starting" });
    expect(enabled(describePanel({ ...base, state: starting }))).toEqual([]);
    const stopping = reducePluginState(capturing, { type: "capture-stopping" });
    const stoppingModel = describePanel({ ...base, state: stopping, hasCapture: true });
    expect(stoppingModel.headline).toBe("Wrapping up…");
    expect(stoppingModel.buttons.find(({ id }) => id === "stop")?.label).toBe("Wrapping up…");
    expect(stoppingModel.activityLabel).toBeUndefined();
    // `stopping` overrides `hasCapture` even though a runtime still exists: a second Stop
    // press during teardown must not send a second control signal to Shorthand.
    expect(enabled(stoppingModel)).toEqual([]);
  });

  test("keeps wrapping-up language while final cleanup temporarily enters enhancing", () => {
    const stopping = reducePluginState(capturing, { type: "capture-stopping" });
    const finalCleanup = reducePluginState(stopping, { type: "enhancement-started" });
    const model = describePanel({ ...base, state: finalCleanup, hasCapture: true, elapsedMs: 61_000 });
    expect(model.headline).toBe("Wrapping up — 1:01");
    expect(model.buttons.find(({ id }) => id === "stop")?.label).toBe("Wrapping up…");
  });

  test("shows an error's own message as the detail", () => {
    const failed = reducePluginState(INITIAL_PLUGIN_STATE, { type: "error", message: "Shorthand was not running." });
    const model = describePanel({ ...base, state: failed });
    expect(model.headline).toBe("Error");
    expect(model.detail).toBe("Shorthand was not running.");
    // An error does not hold the capture open, so starting again must stay possible.
    expect(enabled(model)).toEqual(["start-meeting", "start-assisted-notes"]);
  });

  test("sticky enhancement-stopped also re-enables Start, same as sticky error", () => {
    // `canStartCapture` treats both sticky modes alike; this covers the one this suite was
    // missing so the property is verified for both rather than just `error`.
    const stopped = reducePluginState(INITIAL_PLUGIN_STATE, { type: "enhancement-stopped", message: "Enhancement disabled after repeated read failures." });
    const model = describePanel({ ...base, state: stopped });
    expect(model.headline).toBe("Enhancement stopped");
    expect(enabled(model)).toEqual(["start-meeting", "start-assisted-notes"]);
  });

  test("names the view type Obsidian registers", () => {
    expect(SHORTHAND_PANEL_VIEW).toBe("shorthand-controls");
  });
});

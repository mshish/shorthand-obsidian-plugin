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
  notePath: undefined,
  captureMode: undefined,
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
    expect(model.statusLabel).toBe("Ready");
    expect(model.headline).toBe("Start taking notes");
    expect(enabled(model)).toEqual(["start-meeting", "start-assisted-notes"]);
  });

  test("keeps stable button nodes but only presents actions that make sense now", () => {
    const idle = describePanel({ ...base, state: INITIAL_PLUGIN_STATE });
    expect(idle.buttons.filter(({ visible }) => visible).map(({ id }) => id))
      .toEqual(["start-meeting", "start-assisted-notes"]);

    const live = describePanel({ ...base, state: capturing, hasCapture: true });
    expect(live.buttons.filter(({ visible }) => visible).map(({ id }) => id))
      .toEqual(["stop"]);
  });

  test("does not let a stale runtime reference put Stop on an idle panel", () => {
    const model = describePanel({ ...base, state: INITIAL_PLUGIN_STATE, hasCapture: true });
    expect(model.buttons.filter(({ visible }) => visible).map(({ id }) => id))
      .toEqual(["start-meeting", "start-assisted-notes"]);
    expect(enabled(model)).toEqual(["start-meeting", "start-assisted-notes"]);
  });

  test("makes a live meeting's mode, clock, note and next action explicit", () => {
    const model = describePanel({
      ...base,
      state: capturing,
      captureMode: "meeting",
      hasCapture: true,
      elapsedMs: 754_000,
      noteName: "Weekly sync",
      notePath: "Meetings/Weekly sync.md",
    });
    expect(model.statusLabel).toBe("Meeting");
    expect(model.headline).toBe("Taking notes");
    expect(model.elapsed).toBe("12:34");
    expect(model.noteName).toBe("Weekly sync");
    expect(model.notePath).toBe("Meetings/Weekly sync.md");
    expect(model.activityLabel).toBe("Listening and writing");
    expect(model.tone).toBe("meeting");
    expect(model.buttons.find(({ id }) => id === "stop")?.label).toBe("Stop meeting");
    expect(enabled(model)).toEqual(["stop"]);
  });

  test("names assisted notes distinctly from a meeting", () => {
    const model = describePanel({
      ...base,
      state: capturing,
      captureMode: "assisted-notes",
      hasCapture: true,
      elapsedMs: 7_000,
    });
    expect(model.statusLabel).toBe("Assisted notes");
    expect(model.elapsed).toBe("0:07");
    expect(model.statusIcon).toBe("lightbulb");
    expect(model.tone).toBe("assisted-notes");
    expect(model.buttons.find(({ id }) => id === "stop")?.label).toBe("Stop assisted notes");
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
    expect(model.activityLabel).toBe("Listening and writing");
  });

  test("disables every button with no Markdown note open, and says what to do", () => {
    // Both start commands are checkCallback-gated on an open note; a panel button
    // that ignored that would fire a command the palette would have hidden.
    const model = describePanel({ ...base, state: INITIAL_PLUGIN_STATE, hasActiveNote: false });
    expect(enabled(model)).toEqual([]);
    // Idle with no note and no error is the one case where every button is disabled and
    // no other message exists to say why.
    expect(model.detail).toBe("Open a Markdown note to begin.");
  });

  test("offers nothing while a start (with no runtime yet) or a stop is in flight", () => {
    const starting = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-starting" });
    expect(enabled(describePanel({ ...base, state: starting }))).toEqual([]);
    const stopping = reducePluginState(capturing, { type: "capture-stopping" });
    const stoppingModel = describePanel({ ...base, state: stopping, hasCapture: true });
    expect(stoppingModel.headline).toBe("Wrapping up");
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
    expect(model.headline).toBe("Wrapping up");
    expect(model.elapsed).toBe("1:01");
    expect(model.buttons.find(({ id }) => id === "stop")?.label).toBe("Wrapping up…");
  });

  test("shows an error's own message as the detail", () => {
    const failed = reducePluginState(INITIAL_PLUGIN_STATE, { type: "error", message: "Shorthand was not running." });
    const model = describePanel({ ...base, state: failed });
    expect(model.headline).toBe("Something went wrong");
    expect(model.statusLabel).toBe("Needs attention");
    expect(model.detail).toBe("Shorthand was not running.");
    // An error does not hold the capture open, so starting again must stay possible.
    expect(enabled(model)).toEqual(["start-meeting", "start-assisted-notes"]);
  });

  test("sticky enhancement-stopped also re-enables Start, same as sticky error", () => {
    // `canStartCapture` treats both sticky modes alike; this covers the one this suite was
    // missing so the property is verified for both rather than just `error`.
    const stopped = reducePluginState(INITIAL_PLUGIN_STATE, { type: "enhancement-stopped", message: "Enhancement disabled after repeated read failures." });
    const model = describePanel({ ...base, state: stopped });
    expect(model.headline).toBe("AI updates paused");
    expect(model.statusLabel).toBe("Update paused");
    expect(enabled(model)).toEqual(["start-meeting", "start-assisted-notes"]);
  });

  test("names the view type Obsidian registers", () => {
    expect(SHORTHAND_PANEL_VIEW).toBe("shorthand-controls");
  });
});

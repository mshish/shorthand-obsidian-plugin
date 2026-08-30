import { describe, expect, test } from "bun:test";
import { describeStatus } from "../src/status-text.js";
import { INITIAL_PLUGIN_STATE, reducePluginState } from "../src/state.js";
import type { PluginUiState } from "../src/state.js";

const capturing: PluginUiState = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-started" });

const base = { elapsedMs: undefined, pendingCharacters: undefined, minNewChars: 180 } as const;

describe("describeStatus", () => {
  test("shows nothing at all when idle", () => {
    // The whole point of the change: an idle vault carried "Shorthand: idle · 0/180 chars"
    // permanently, for a plugin that was doing nothing.
    expect(describeStatus({ ...base, state: INITIAL_PLUGIN_STATE })).toEqual({ visible: false });
  });

  test("shows the elapsed clock and nothing else while capturing", () => {
    expect(describeStatus({ ...base, state: capturing, elapsedMs: 754_000 })).toEqual({
      visible: true,
      text: "Shorthand 12:34",
      tooltip: "Capturing. Click to stop.",
    });
  });

  test("keeps the clock while a pass is writing, so the meeting timer never jumps", () => {
    const enhancing = reducePluginState(capturing, { type: "enhancement-started" });
    expect(describeStatus({ ...base, state: enhancing, elapsedMs: 754_000 })).toEqual({
      visible: true,
      text: "Shorthand 12:34 · writing",
      tooltip: "Writing the note. Click to stop the capture.",
    });
  });

  test("reports the character gate in the tooltip, not in the bar", () => {
    // The counter moved off the bar but the reassurance it carried has to survive:
    // a capture sitting below the gate must not look broken.
    const display = describeStatus({
      ...base,
      state: capturing,
      elapsedMs: 60_000,
      pendingCharacters: 140,
    });
    expect(display).toEqual({
      visible: true,
      text: "Shorthand 1:00",
      tooltip: "Capturing. 140 of 180 characters toward the next pass. Click to stop.",
    });
  });

  test("says stopping, because a stop can spend the whole drain budget", () => {
    const stopping = reducePluginState(capturing, { type: "capture-stopping" });
    expect(describeStatus({ ...base, state: stopping, elapsedMs: 754_000 })).toEqual({
      visible: true,
      text: "Shorthand 12:34 · stopping",
      tooltip: "Finishing the capture.",
    });
  });

  test("never shows a mode union member to the user", () => {
    const stopped = reducePluginState(capturing, {
      type: "enhancement-stopped",
      message: "Enhancement stopped after the maximum capture window; capture continues.",
    });
    const display = describeStatus({ ...base, state: stopped, elapsedMs: 60_000 });
    expect(display.visible).toBe(true);
    if (!display.visible) return;
    expect(display.text).not.toContain("enhancement-stopped");
    expect(display.text).toBe("Shorthand 1:00 · enhancement stopped");
    expect(display.tooltip).toBe("Enhancement stopped after the maximum capture window; capture continues.");
  });

  test("stays visible for an error after the capture has ended", () => {
    // An error outlives its capture by design — state.ts has no clear-error event —
    // so hiding on idle must not hide the one state the user needs to see.
    const failed = reducePluginState(INITIAL_PLUGIN_STATE, { type: "error", message: "Shorthand was not running." });
    expect(describeStatus({ ...base, state: failed })).toEqual({
      visible: true,
      text: "Shorthand · error",
      tooltip: "Shorthand was not running.",
    });
  });
});

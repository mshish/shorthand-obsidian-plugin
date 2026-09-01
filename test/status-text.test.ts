import { describe, expect, test } from "bun:test";
import { describeStatus } from "../src/status-text.js";
import { INITIAL_PLUGIN_STATE, reducePluginState } from "../src/state.js";
import type { PluginUiState } from "../src/state.js";

const capturing: PluginUiState = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-started" });

const base = { elapsedMs: undefined } as const;

describe("describeStatus", () => {
  test("shows nothing at all when idle", () => {
    // The whole point of the change: an idle vault carried "Shorthand: idle · 0/180 chars"
    // permanently, for a plugin that was doing nothing.
    expect(describeStatus({ ...base, state: INITIAL_PLUGIN_STATE })).toEqual({ visible: false });
  });

  test("shows a starting state before any capture exists, with no clock yet", () => {
    const starting = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-starting" });
    expect(describeStatus({ ...base, state: starting })).toEqual({
      visible: true,
      text: "Shorthand · starting",
      tooltip: "Starting the capture.",
    });
  });

  test("shows the elapsed clock and nothing else while capturing", () => {
    expect(describeStatus({ ...base, state: capturing, elapsedMs: 754_000 })).toEqual({
      visible: true,
      text: "Shorthand 12:34",
      tooltip: "Taking notes. Click to stop.",
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

  test("says wrapping up, because stop includes a final cleanup pass", () => {
    const stopping = reducePluginState(capturing, { type: "capture-stopping" });
    expect(describeStatus({ ...base, state: stopping, elapsedMs: 754_000 })).toEqual({
      visible: true,
      text: "Shorthand 12:34 · wrapping up",
      tooltip: "Running final cleanup before finishing the capture.",
    });
  });

  test("does not fall back to writing while the final cleanup pass runs", () => {
    const stopping = reducePluginState(capturing, { type: "capture-stopping" });
    const finalCleanup = reducePluginState(stopping, { type: "enhancement-started" });
    expect(describeStatus({ ...base, state: finalCleanup, elapsedMs: 754_000 })).toEqual({
      visible: true,
      text: "Shorthand 12:34 · wrapping up",
      tooltip: "Running final cleanup before finishing the capture.",
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

  test("keeps the clock on an error that did not end the capture", () => {
    // fail() is reached from connectionError, giveUp and drainTimeout while the
    // capture is still running, so the meeting timer must not vanish at the moment
    // something goes wrong — the recording is still going.
    const failed = reducePluginState(capturing, { type: "error", message: "Shorthand connection error." });
    expect(describeStatus({ ...base, state: failed, elapsedMs: 754_000 })).toEqual({
      visible: true,
      text: "Shorthand 12:34 · error",
      tooltip: "Shorthand connection error. Click to stop.",
    });
  });
});

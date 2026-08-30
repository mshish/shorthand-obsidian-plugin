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
  pendingCharacters: undefined,
  minNewChars: 180,
  noteName: undefined,
  hasActiveNote: true,
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
    const model = describePanel({ ...base, state: capturing, elapsedMs: 754_000, noteName: "Weekly sync" });
    expect(model.headline).toBe("Capturing — 12:34");
    expect(model.noteName).toBe("Weekly sync");
    expect(enabled(model)).toEqual(["stop"]);
  });

  test("carries the character gate the status bar gave up", () => {
    const model = describePanel({ ...base, state: capturing, elapsedMs: 60_000, pendingCharacters: 140 });
    expect(model.detail).toBe("140 of 180 characters toward the next pass");
  });

  test("disables every button with no Markdown note open", () => {
    // Both start commands are checkCallback-gated on an open note; a panel button
    // that ignored that would fire a command the palette would have hidden.
    const model = describePanel({ ...base, state: INITIAL_PLUGIN_STATE, hasActiveNote: false });
    expect(enabled(model)).toEqual([]);
  });

  test("offers nothing while a start or a stop is in flight", () => {
    const starting = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-starting" });
    expect(enabled(describePanel({ ...base, state: starting }))).toEqual([]);
    const stopping = reducePluginState(capturing, { type: "capture-stopping" });
    expect(describePanel({ ...base, state: stopping }).headline).toBe("Stopping…");
    expect(enabled(describePanel({ ...base, state: stopping }))).toEqual([]);
  });

  test("shows an error's own message as the detail", () => {
    const failed = reducePluginState(INITIAL_PLUGIN_STATE, { type: "error", message: "Shorthand was not running." });
    const model = describePanel({ ...base, state: failed });
    expect(model.headline).toBe("Error");
    expect(model.detail).toBe("Shorthand was not running.");
    // An error does not hold the capture open, so starting again must stay possible.
    expect(enabled(model)).toEqual(["start-meeting", "start-assisted-notes"]);
  });

  test("names the view type Obsidian registers", () => {
    expect(SHORTHAND_PANEL_VIEW).toBe("shorthand-controls");
  });
});

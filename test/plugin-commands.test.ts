import { describe, expect, test } from "bun:test";
import { COMMAND_NAMES, type CommandId } from "../src/commands.js";

describe("command names", () => {
  test("name the two capture modes symmetrically", () => {
    // The asymmetry this fixes: one sibling said which mode it started and the
    // other did not, so the palette read as though there were a default and a
    // special case rather than two peers.
    expect(COMMAND_NAMES["start-capture-this-note"]).toBe("Start meeting capture on this note");
    expect(COMMAND_NAMES["start-assisted-notes-capture-this-note"]).toBe(
      "Start assisted notes capture on this note",
    );
  });

  test("name the two recorder toggles symmetrically", () => {
    expect(COMMAND_NAMES["toggle-shorthand-recording"]).toBe("Toggle Shorthand meeting recording");
    expect(COMMAND_NAMES["toggle-shorthand-assisted-notes"]).toBe(
      "Toggle Shorthand assisted notes recording",
    );
  });

  test("use the app's own spelling of the modes", () => {
    // shorthand-app/src/shorthand/locales/en.json is authoritative:
    //   "settings.modes.tabs.meetings": "Meetings"
    //   "settings.modes.tabs.assistedNotes": "Assisted notes"
    // Sentence case, lowercase "notes". Not "Meeting Notes" / "Assisted Notes".
    for (const name of Object.values(COMMAND_NAMES)) {
      expect(name).not.toContain("Assisted Notes");
      expect(name).not.toContain("Meeting Notes");
    }
  });

  test("are sentence case and carry no plugin prefix", () => {
    // Obsidian renders these as "Shorthand: <name>", so a prefix here produced
    // "Shorthand: Shorthand: start capture…". Its guidelines also require
    // sentence case for all UI text.
    for (const name of Object.values(COMMAND_NAMES)) {
      expect(name.startsWith("Shorthand:")).toBe(false);
      expect(name[0]).toBe(name[0]?.toUpperCase());
      expect(name.endsWith(".")).toBe(false);
    }
  });

  test("cover every id exactly once", () => {
    const ids: CommandId[] = [
      "start-capture-this-note",
      "start-assisted-notes-capture-this-note",
      "stop-capture",
      "enhance-now",
      "clean-up-this-note",
      "toggle-shorthand-recording",
      "toggle-shorthand-assisted-notes",
      "cancel-shorthand-recording",
    ];
    expect(Object.keys(COMMAND_NAMES).sort()).toEqual([...ids].sort());
    expect(new Set(Object.values(COMMAND_NAMES)).size).toBe(ids.length);
  });
});

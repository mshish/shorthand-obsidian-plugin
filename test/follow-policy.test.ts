import { describe, expect, test } from "bun:test";
import { decideFollow, endsSession } from "../src/follow-policy.js";
import { INITIAL_PLUGIN_STATE, reducePluginState } from "../src/state.js";

const base = {
  state: INITIAL_PLUGIN_STATE,
  hasActiveNote: true,
  followEnabled: true,
  appAdvertisesMode: true,
} as const;

describe("decideFollow", () => {
  test("attaches a meeting recording to the open note", () => {
    expect(decideFollow({ ...base, mode: "meeting" })).toEqual({
      kind: "attach",
      signal: "toggle-transcription",
    });
  });

  test("attaches an assisted notes recording", () => {
    expect(decideFollow({ ...base, mode: "assisted-notes" })).toEqual({
      kind: "attach",
      signal: "toggle-assisted-notes",
    });
  });

  test("never attaches to a dictation burst", () => {
    // Dictation ships with follow-stream publication off, but a user can turn it on.
    // Attaching would write a dictated sentence into their meeting note.
    expect(decideFollow({ ...base, mode: "dictation" })).toEqual({ kind: "ignore" });
  });

  test("refuses to guess when the app never advertised the field", () => {
    // "No mode on this record" and "this app predates the field" are the same bytes.
    // The hello capability is the only thing that separates them, and without it the
    // safe answer is to do nothing and say why — not to assume meeting.
    expect(decideFollow({ ...base, mode: undefined, appAdvertisesMode: false })).toEqual({
      kind: "needs-newer-app",
    });
  });

  test("ignores a modeless record from an app that does advertise the field", () => {
    // A current app that sent something this build does not recognize. Core dropped it.
    // Nothing to tell the user to do, so this is silent rather than a nag.
    expect(decideFollow({ ...base, mode: undefined, appAdvertisesMode: true })).toEqual({ kind: "ignore" });
  });

  test("ignores anything that is not one of the modes it knows", () => {
    // `mode` arrives as `any` from an untyped EventEmitter listener, so this module is
    // the only thing standing between the wire and a capture attaching to a note.
    for (const junk of ["karaoke", "", 7, null, {}, ["meeting"], true]) {
      expect(decideFollow({ ...base, mode: junk })).toEqual({ kind: "ignore" });
    }
  });

  test("does nothing while the setting is off", () => {
    expect(decideFollow({ ...base, mode: "meeting", followEnabled: false })).toEqual({ kind: "ignore" });
  });

  test("does nothing with no Markdown note open", () => {
    expect(decideFollow({ ...base, mode: "meeting", hasActiveNote: false })).toEqual({ kind: "ignore" });
  });

  test("does not attach a second capture over a running one", () => {
    // The recording announced here may well be the one this plugin's own capture just
    // asked Shorthand to start. Attaching to it would race the capture that caused it.
    const capturing = reducePluginState(
      reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-starting" }),
      { type: "capture-started" },
    );
    expect(decideFollow({ ...base, mode: "meeting", state: capturing })).toEqual({ kind: "ignore" });
    const starting = reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-starting" });
    expect(decideFollow({ ...base, mode: "meeting", state: starting })).toEqual({ kind: "ignore" });
  });
});

describe("endsSession", () => {
  test("ends only on a terminal record of the attached session", () => {
    for (const t of ["final", "no_speech", "cancel", "error"]) {
      expect(endsSession({ t, session: 4 }, 4)).toBe(true);
    }
    expect(endsSession({ t: "partial", session: 4 }, 4)).toBe(false);
    expect(endsSession({ t: "begin", session: 4 }, 4)).toBe(false);
    expect(endsSession({ t: "final", session: 5 }, 4)).toBe(false);
    // A connection-level error carries no session and must not end a recording.
    expect(endsSession({ t: "error" }, 4)).toBe(false);
    expect(endsSession({ t: "final", session: 4 }, undefined)).toBe(false);
  });
});

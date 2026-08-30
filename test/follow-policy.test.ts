import { describe, expect, test } from "bun:test";
import {
  EMPTY_PENDING_ATTACH_BUFFER,
  PENDING_ATTACH_BUFFER_CAP,
  decideFollow,
  endsSession,
  pushPendingAttachRecord,
} from "../src/follow-policy.js";
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

  test("does not warn about the app version for the plugin's own recording", () => {
    // The idle follower keeps listening during a capture this plugin itself just started
    // from the palette, and that recording's own `begin` reaches this function too. Before
    // the capability check moved after the eligibility checks, an older app's every
    // `begin` — including this one — produced "update Shorthand", drowning out the one
    // recording the notice actually exists for.
    const capturing = reducePluginState(
      reducePluginState(INITIAL_PLUGIN_STATE, { type: "capture-starting" }),
      { type: "capture-started" },
    );
    expect(decideFollow({ ...base, mode: undefined, appAdvertisesMode: false, state: capturing }))
      .toEqual({ kind: "ignore" });
    expect(decideFollow({ ...base, mode: undefined, appAdvertisesMode: false, hasActiveNote: false }))
      .toEqual({ kind: "ignore" });
    // The setting being off still wins over everything, capability included.
    expect(decideFollow({ ...base, mode: undefined, appAdvertisesMode: false, followEnabled: false }))
      .toEqual({ kind: "ignore" });
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

describe("pushPendingAttachRecord", () => {
  test("buffers a record belonging to the pending session", () => {
    const entry = { generation: 1, record: { t: "partial", session: 7 } };
    const buffer = pushPendingAttachRecord(EMPTY_PENDING_ATTACH_BUFFER, 7, entry);
    expect(buffer).toEqual({ records: [entry], droppedCount: 0 });
  });

  test("drops a record for any other session, silently", () => {
    const entry = { generation: 1, record: { t: "partial", session: 9 } };
    const buffer = pushPendingAttachRecord(EMPTY_PENDING_ATTACH_BUFFER, 7, entry);
    expect(buffer).toEqual(EMPTY_PENDING_ATTACH_BUFFER);
  });

  test("stops appending past the cap and counts what it drops", () => {
    let buffer = EMPTY_PENDING_ATTACH_BUFFER;
    for (let index = 0; index < PENDING_ATTACH_BUFFER_CAP; index += 1) {
      buffer = pushPendingAttachRecord(buffer, 7, { generation: 1, record: { t: "partial", session: 7 } });
    }
    expect(buffer.records.length).toBe(PENDING_ATTACH_BUFFER_CAP);
    expect(buffer.droppedCount).toBe(0);

    const overflowed = pushPendingAttachRecord(buffer, 7, { generation: 1, record: { t: "partial", session: 7 } });
    expect(overflowed.records.length).toBe(PENDING_ATTACH_BUFFER_CAP);
    expect(overflowed.droppedCount).toBe(1);

    const overflowedAgain = pushPendingAttachRecord(overflowed, 7, { generation: 1, record: { t: "partial", session: 7 } });
    expect(overflowedAgain.droppedCount).toBe(2);
  });
});

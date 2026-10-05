import { describe, expect, test } from "bun:test";
import type { EnhanceStatus, TranscriptUpdate } from "shorthand-core";
import {
  cleanReason,
  MEETING_END_COUNTDOWN_MS,
  MeetingEndWatch,
  meetingEndNoticeText,
  meetingEndStopFailedText,
  planMeetingEndStop,
  runMeetingEndStop,
  sendMeetingEndStop,
  SpeechMeter,
  type MeetingEndCancelCause,
  type MeetingEndCountdown,
} from "../src/meeting-end.js";
import type { CaptureMode } from "../src/follow-policy.js";

const started = { kind: "started", message: "", tier: "tick", passCount: 1 } as unknown as EnhanceStatus;
const finished = (ended: boolean, reason = "They said goodbye."): EnhanceStatus =>
  ({ kind: "finished", message: "", tier: "tick", passCount: 1, durationMs: 1, meetingStatus: { ended, reason } }) as unknown as EnhanceStatus;

function harness(options: { mode?: CaptureMode; enabled?: boolean } = {}) {
  let clock = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; run: () => void }>();
  const log: string[] = [];
  const changes: (MeetingEndCountdown | undefined)[] = [];
  const state = { enabled: options.enabled ?? true };
  const watch = new MeetingEndWatch({
    mode: options.mode ?? "meeting",
    enabled: () => state.enabled,
    minSpeechCharacters: 90,
    now: () => clock,
    timers: {
      setTimeout: (run, ms) => { const id = nextId++; pending.set(id, { at: clock + ms, run }); return id; },
      clearTimeout: (id) => { pending.delete(id as number); },
    },
    onChange: (countdown) => changes.push(countdown),
    onCancel: (cause: MeetingEndCancelCause) => log.push(`cancel:${cause}`),
    onExpire: () => log.push("expire"),
  });
  const advance = (ms: number): void => {
    clock += ms;
    for (const [id, timer] of [...pending]) {
      if (timer.at <= clock) { pending.delete(id); timer.run(); }
    }
  };
  /** A full pass: it starts, then reports. */
  const pass = (ended: boolean, reason?: string): void => {
    watch.noteStatus(started);
    watch.noteStatus(finished(ended, reason));
  };
  return { watch, advance, pass, log, changes, state, timers: pending };
}

describe("MeetingEndWatch", () => {
  test("ended=false does nothing", () => {
    const h = harness();
    h.pass(false);
    expect(h.watch.countdown).toBeUndefined();
    expect(h.changes).toEqual([]);
  });

  test("ended=true starts a 30 second countdown carrying the reason", () => {
    const h = harness();
    h.pass(true, "  Everyone\nsaid bye  ");
    expect(h.watch.countdown).toEqual({ reason: "Everyone said bye", remainingSeconds: 30 });
    h.advance(1_500);
    expect(h.watch.countdown?.remainingSeconds).toBe(29);
  });

  test("expiry calls onExpire once and the watch is finished", () => {
    const h = harness();
    h.pass(true);
    h.advance(MEETING_END_COUNTDOWN_MS - 1);
    expect(h.log).toEqual([]);
    h.advance(1);
    expect(h.log).toEqual(["expire"]);
    expect(h.watch.countdown).toBeUndefined();
    h.pass(true);
    expect(h.watch.countdown).toBeUndefined();
  });

  test("a second ended report during the countdown does not restart it", () => {
    const h = harness();
    h.pass(true);
    h.advance(10_000);
    h.pass(true, "again");
    expect(h.watch.countdown?.remainingSeconds).toBe(20);
    expect(h.watch.countdown?.reason).toBe("They said goodbye.");
  });

  test("ended=false during the countdown leaves it running", () => {
    const h = harness();
    h.pass(true);
    h.pass(false);
    expect(h.watch.countdown).toBeDefined();
  });

  test("speech of the gate size cancels, in pieces", () => {
    const h = harness();
    h.pass(true);
    h.watch.noteSpeech(50);
    expect(h.watch.countdown).toBeDefined();
    h.watch.noteSpeech(39);
    expect(h.watch.countdown).toBeDefined();
    h.watch.noteSpeech(1);
    expect(h.watch.countdown).toBeUndefined();
    expect(h.log).toEqual(["cancel:speech"]);
    expect(h.timers.size).toBe(0);
  });

  test("a single long utterance cancels", () => {
    const h = harness();
    h.pass(true);
    h.watch.noteSpeech(90);
    expect(h.log).toEqual(["cancel:speech"]);
  });

  test("speech before the countdown does not count toward it", () => {
    const h = harness();
    h.watch.noteSpeech(500);
    h.pass(true);
    h.watch.noteSpeech(10);
    expect(h.watch.countdown).toBeDefined();
  });

  test("user cancel clears the timer and reports it", () => {
    const h = harness();
    h.pass(true);
    h.watch.cancel();
    expect(h.log).toEqual(["cancel:user"]);
    h.advance(60_000);
    expect(h.log).toEqual(["cancel:user"]);
  });

  test("after a user cancel, a pass with no new speech cannot restart it", () => {
    const h = harness();
    h.pass(true);
    h.watch.cancel();
    h.pass(true);
    expect(h.watch.countdown).toBeUndefined();
  });

  test("after a user cancel, new speech then a later pass restarts it", () => {
    const h = harness();
    h.pass(true);
    h.watch.cancel();
    h.watch.noteSpeech(5);
    h.pass(true);
    expect(h.watch.countdown).toBeDefined();
  });

  test("a pass that started before the new speech cannot restart it", () => {
    const h = harness();
    h.pass(true);
    h.watch.cancel();
    h.watch.noteStatus(started);
    h.watch.noteSpeech(5);
    h.watch.noteStatus(finished(true));
    expect(h.watch.countdown).toBeUndefined();
    h.pass(true);
    expect(h.watch.countdown).toBeDefined();
  });

  test("after a speech cancel, a pass started on that speech may restart it", () => {
    const h = harness();
    h.pass(true);
    h.watch.noteSpeech(100);
    expect(h.watch.countdown).toBeUndefined();
    h.pass(true);
    expect(h.watch.countdown).toBeDefined();
  });

  test("after a speech cancel, the pass that was already running cannot restart it", () => {
    const h = harness();
    h.pass(true);
    h.watch.noteStatus(started);
    h.watch.noteSpeech(100);
    h.watch.noteStatus(finished(true));
    expect(h.watch.countdown).toBeUndefined();
  });

  test("a pass that started before the cancelling speech cannot restart the countdown", () => {
    const h = harness();
    h.pass(true);
    h.watch.noteSpeech(20);
    h.watch.noteStatus(started);
    h.watch.noteSpeech(100);
    expect(h.log).toEqual(["cancel:speech"]);
    h.watch.noteStatus(finished(true));
    expect(h.watch.countdown).toBeUndefined();
    h.watch.noteSpeech(5);
    h.pass(true);
    expect(h.watch.countdown).toBeDefined();
  });

  test("switching the setting off drops a running countdown quietly", () => {
    const h = harness();
    h.pass(true);
    h.state.enabled = false;
    h.watch.refresh();
    expect(h.watch.countdown).toBeUndefined();
    expect(h.log).toEqual([]);
    expect(h.changes.at(-1)).toBeUndefined();
  });

  test("never in Assisted Notes", () => {
    const h = harness({ mode: "assisted-notes" });
    h.pass(true);
    expect(h.watch.countdown).toBeUndefined();
    expect(h.changes).toEqual([]);
  });

  test("ignored entirely when the setting is off", () => {
    const h = harness({ enabled: false });
    h.pass(true);
    expect(h.watch.countdown).toBeUndefined();
    expect(h.changes).toEqual([]);
  });

  test("switching the setting off mid-countdown cancels at expiry instead of stopping", () => {
    const h = harness();
    h.pass(true);
    h.state.enabled = false;
    h.advance(MEETING_END_COUNTDOWN_MS);
    expect(h.log).toEqual([]);
    expect(h.watch.countdown).toBeUndefined();
  });

  test("dispose clears the timer silently and ignores later signals", () => {
    const h = harness();
    h.pass(true);
    h.watch.dispose();
    expect(h.timers.size).toBe(0);
    expect(h.changes.at(-1)).toBeUndefined();
    expect(h.log).toEqual([]);
    h.advance(60_000);
    h.pass(true);
    expect(h.watch.countdown).toBeUndefined();
    expect(h.log).toEqual([]);
  });

  test("dispose with no countdown reports no change", () => {
    const h = harness();
    h.watch.dispose();
    expect(h.changes).toEqual([]);
  });
});

describe("cleanReason", () => {
  test("flattens whitespace and control characters", () => {
    expect(cleanReason("a\u0000b\n\n c\td")).toBe("a b c d");
  });

  test("caps length with an ellipsis", () => {
    const cleaned = cleanReason("x".repeat(500));
    expect(cleaned.length).toBe(160);
    expect(cleaned.endsWith("…")).toBe(true);
  });
});

describe("meetingEndNoticeText", () => {
  test("is worded as a detection", () => {
    expect(meetingEndNoticeText(30)).toBe("Meeting looks like it has ended — stopping in 30s");
  });
});

describe("SpeechMeter", () => {
  const update = (action: string, extra: object = {}) =>
    ({ action, speaker: "Alice", delta: "hello there", snapshot: { session: "s", commits: [] }, ...extra }) as unknown as TranscriptUpdate;

  test("counts an append, speaker label included", () => {
    expect(new SpeechMeter().measure(update("append"))).toBe("Alice: hello there".length);
  });

  test("a rewrite-tail that only revises the tail is not new speech", () => {
    const meter = new SpeechMeter();
    meter.measure(update("append", { delta: "see you tomorrow" }));
    // "tomorrow" (8) replaced by "tomorrew" (8): same length, preserved prefix is 8 characters.
    expect(meter.measure(update("rewrite-tail", { delta: "tomorrew", preservedPrefixLength: 8 }))).toBe(0);
  });

  test("a rewrite-tail that also adds speech counts only its net growth", () => {
    const meter = new SpeechMeter();
    meter.measure(update("append", { delta: "see you tomorrow" }));
    const added = "x".repeat(100);
    expect(meter.measure(update("rewrite-tail", { delta: `tomorrew${added}`, preservedPrefixLength: 8 }))).toBe(100);
  });

  test("a rewrite-tail that shortens the tail counts nothing and lowers the baseline", () => {
    const meter = new SpeechMeter();
    meter.measure(update("append", { delta: "see you tomorrow" }));
    expect(meter.measure(update("rewrite-tail", { delta: "", preservedPrefixLength: 4 }))).toBe(0);
    expect(meter.measure(update("append", { delta: "abcdef" }))).toBe("Alice: abcdef".length);
  });

  test("a replace-session correction is not new speech", () => {
    expect(new SpeechMeter().measure(update("replace-session", { snapshot: { session: "s", commits: [], final: { text: "x".repeat(200) } } }))).toBe(0);
  });
});

describe("meeting-end stop decision", () => {
  test("plans a send without a recorder and leaves it to the recorder with one", () => {
    // Adopted from Shorthand's hotkey, or control off: no recorder, so the plugin must send.
    expect(planMeetingEndStop({ hasRecorder: false, shorthandDown: false })).toBe("send");
    // Control on: the recorder's own stop path sends it.
    expect(planMeetingEndStop({ hasRecorder: true, shorthandDown: false })).toBe("recorder");
  });

  test("does not send when Shorthand is known to be down", () => {
    expect(planMeetingEndStop({ hasRecorder: false, shorthandDown: true })).toBe("skip");
    expect(planMeetingEndStop({ hasRecorder: true, shorthandDown: true })).toBe("skip");
  });

  test("sends the given stop signal and reports success", async () => {
    const sent: string[] = [];
    const outcome = await sendMeetingEndStop(
      { send: async (signal) => { sent.push(signal); return { status: "sent" }; } },
      "stop-transcription",
    );
    expect(sent).toEqual(["stop-transcription"]);
    expect(outcome).toEqual({ sent: true });
  });

  test("reports a refused, errored or thrown stop instead of throwing", async () => {
    const notRunning = await sendMeetingEndStop({ send: async () => ({ status: "not-running" }) }, "stop-transcription");
    expect(notRunning).toEqual({ sent: false, message: "Shorthand did not answer within 5 seconds" });
    const errored = await sendMeetingEndStop({ send: async () => ({ status: "error", message: "boom" }) }, "stop-transcription");
    expect(errored).toEqual({ sent: false, message: "boom" });
    const thrown = await sendMeetingEndStop({ send: async () => { throw new Error("spawn failed"); } }, "stop-transcription");
    expect(thrown).toEqual({ sent: false, message: "spawn failed" });
  });

  test("failure text says Shorthand may still be recording", () => {
    expect(meetingEndStopFailedText("boom")).toContain("may still be recording");
  });

  test("failure text for not-running has no doubled punctuation", () => {
    const text = meetingEndStopFailedText("Shorthand did not answer within 5 seconds");
    expect(text).toContain("(Shorthand did not answer within 5 seconds).");
    expect(meetingEndStopFailedText("boom.")).toContain("(boom).");
  });
});

describe("runMeetingEndStop", () => {
  const sentOutcome = { sent: true } as const;

  test("sends, then reports, in that order", async () => {
    const log: string[] = [];
    await runMeetingEndStop({
      plan: "send",
      send: async () => { log.push("send"); return sentOutcome; },
      report: () => log.push("report"),
      warn: () => log.push("warn"),
    });
    expect(log).toEqual(["send", "report"]);
  });

  test("returns normally and warns when the send fails", async () => {
    const warned: string[] = [];
    await runMeetingEndStop({
      plan: "send",
      send: async () => ({ sent: false, message: "boom" }),
      report: () => {},
      warn: (text) => warned.push(text),
    });
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("boom");
    expect(warned[0]).toContain("may still be recording");
  });

  test("does nothing for the recorder and skip plans", async () => {
    for (const plan of ["recorder", "skip"] as const) {
      let called = false;
      await runMeetingEndStop({
        plan,
        send: async () => { called = true; return sentOutcome; },
        report: () => { called = true; },
        warn: () => { called = true; },
      });
      expect(called).toBe(false);
    }
  });
});

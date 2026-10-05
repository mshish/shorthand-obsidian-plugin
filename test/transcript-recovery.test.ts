import { describe, expect, test } from "bun:test";
import type { EnhanceStatus } from "shorthand-core";
import {
  CaptureRecord,
  describeRecoveryCards,
  RecoveryStore,
  reprocessResult,
} from "../src/transcript-recovery.js";

const base = { tier: "tick", durationMs: 1, passCount: 1 } as const;
const status = (kind: string, message = "boom"): EnhanceStatus =>
  ({ kind, message, ...base }) as unknown as EnhanceStatus;

function failedRecord(error = "Not signed in"): CaptureRecord {
  const record = new CaptureRecord("meeting");
  record.appendDelta("me: hello");
  record.noteStatus(status("error", error));
  return record;
}

describe("CaptureRecord", () => {
  test("joins deltas the way core's runner does", () => {
    const record = new CaptureRecord("meeting");
    record.appendDelta("me: one");
    record.appendDelta("");
    record.appendDelta("them: two");
    expect(record.transcript()).toBe("me: one\nthem: two");
    expect(record.hasTranscript).toBe(true);
  });

  test("a capture with no failure reports none", () => {
    const record = new CaptureRecord("meeting");
    record.appendDelta("me: hi");
    for (const kind of ["started", "finished", "requeued", "timed-out", "declined"]) {
      record.noteStatus(status(kind));
    }
    expect(record.failed).toBe(false);
    expect(record.lastError).toBeUndefined();
  });

  test.each(["error", "skipped", "disabled-for-read-failures", "expired"])(
    "%s is a failure and keeps its message",
    (kind) => {
      const record = new CaptureRecord("meeting");
      record.noteStatus(status(kind, `msg-${kind}`));
      expect(record.failed).toBe(true);
      expect(record.lastError).toBe(`msg-${kind}`);
    },
  );

  test("keeps the most recent error", () => {
    const record = new CaptureRecord("meeting");
    record.noteStatus(status("error", "first"));
    record.noteStatus(status("skipped", "second"));
    expect(record.lastError).toBe("second");
  });

  test("a later healthy pass does not clear a failure", () => {
    // Core's error status cannot say whether the transcript was dropped.
    const record = new CaptureRecord("meeting");
    record.noteStatus(status("error", "dropped"));
    record.noteStatus(status("finished"));
    record.noteOutcome({ status: "completed", tier: "tick", sections: [], written: true, meetingStatus: { ended: false, reason: "" } });
    expect(record.failed).toBe(true);
    expect(record.lastError).toBe("dropped");
  });

  test("records an enhancer that never started", () => {
    const record = new CaptureRecord("assisted-notes");
    record.noteFailure("claude.exe was not found.");
    expect(record.failed).toBe(true);
    expect(record.lastError).toBe("claude.exe was not found.");
  });

  test("a failed closing pass is a failure with its own text", () => {
    const record = new CaptureRecord("meeting");
    record.noteOutcome({ status: "failed", error: "token expired" });
    expect(record.lastError).toBe("token expired");
  });

  test("silent non-completing outcomes fall back without overwriting a specific message", () => {
    const withMessage = new CaptureRecord("meeting");
    withMessage.noteStatus(status("skipped", "agent said no"));
    withMessage.noteOutcome({ status: "skipped", reason: "agent-error" });
    expect(withMessage.lastError).toBe("agent said no");

    for (const outcome of [
      { status: "timed-out" },
      { status: "requeued", reason: "busy" },
      { status: "skipped", reason: "invalid-output" },
    ] as const) {
      const silent = new CaptureRecord("meeting");
      silent.noteOutcome(outcome);
      expect(silent.failed).toBe(true);
      expect(silent.lastError?.length).toBeGreaterThan(0);
    }
  });

  test("outcomes that mean nothing was waiting are not failures", () => {
    const record = new CaptureRecord("meeting");
    record.noteOutcome({ status: "not-ready", reason: "characters" });
    record.noteOutcome({ status: "in-flight" });
    record.noteOutcome({ status: "expired" });
    expect(record.failed).toBe(false);
  });
});

describe("reprocessResult", () => {
  test("only a completed pass succeeds, written or not", () => {
    expect(reprocessResult({ status: "completed", tier: "tick", sections: [], written: false, meetingStatus: { ended: false, reason: "" } }, undefined))
      .toEqual({ ok: true, written: false });
  });

  test("prefers the status message that names the cause", () => {
    expect(reprocessResult({ status: "skipped", reason: "agent-error" }, "Not signed in"))
      .toEqual({ ok: false, error: "Not signed in" });
    expect(reprocessResult({ status: "failed", error: "own text" }, "other"))
      .toEqual({ ok: false, error: "own text" });
  });

  test("every other outcome fails with some text", () => {
    for (const outcome of [
      { status: "skipped", reason: "invalid-output" },
      { status: "requeued", reason: "stale" },
      { status: "timed-out" },
      { status: "expired" },
      { status: "not-ready", reason: "interval" },
      { status: "in-flight" },
    ] as const) {
      const result = reprocessResult(outcome, undefined);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
    }
  });
});

describe("RecoveryStore", () => {
  const noteA = { name: "A" };
  const noteB = { name: "B" };

  test("keeps nothing for a clean capture", () => {
    const store = new RecoveryStore<object>();
    const clean = new CaptureRecord("meeting");
    clean.appendDelta("me: fine");
    expect(store.keep(noteA, clean)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  test("keeps nothing when the failure lost no transcript", () => {
    const store = new RecoveryStore<object>();
    const record = new CaptureRecord("meeting");
    record.noteFailure("no agent");
    expect(store.keep(noteA, record)).toBeUndefined();
  });

  test("keeps the transcript, mode and last error for a failed capture", () => {
    const store = new RecoveryStore<object>();
    const entry = store.keep(noteA, failedRecord("Not signed in"));
    expect(entry).toMatchObject({ mode: "meeting", transcript: "me: hello", error: "Not signed in", busy: false });
    expect(store.get(noteA)).toBe(entry);
  });

  test("a capture elsewhere leaves another note's slot alone", () => {
    const store = new RecoveryStore<object>();
    store.keep(noteA, failedRecord("a"));
    store.keep(noteB, failedRecord("b"));
    expect(store.entries().map((entry) => entry.error)).toEqual(["a", "b"]);
    const cleanElsewhere = new CaptureRecord("meeting");
    cleanElsewhere.appendDelta("me: ok");
    store.keep(noteB, cleanElsewhere);
    expect(store.get(noteA)?.error).toBe("a");
    expect(store.get(noteB)).toBeUndefined();
  });

  test("a new capture on the same note replaces its slot", () => {
    const store = new RecoveryStore<object>();
    store.keep(noteA, failedRecord("old"));
    store.release(noteA);
    expect(store.get(noteA)).toBeUndefined();
    store.keep(noteA, failedRecord("old"));
    store.keep(noteA, failedRecord("new"));
    expect(store.size).toBe(1);
    expect(store.get(noteA)?.error).toBe("new");
  });

  test("success releases the transcript", () => {
    const store = new RecoveryStore<object>();
    store.keep(noteA, failedRecord());
    expect(store.beginReprocess(noteA)).toBe("started");
    store.finishReprocess(noteA, { ok: true, written: true });
    expect(store.get(noteA)).toBeUndefined();
  });

  test("failure keeps the transcript, shows the new error and allows a retry", () => {
    const store = new RecoveryStore<object>();
    store.keep(noteA, failedRecord("old"));
    store.beginReprocess(noteA);
    expect(store.isBusy(noteA)).toBe(true);
    store.finishReprocess(noteA, { ok: false, error: "still signed out" });
    expect(store.get(noteA)).toMatchObject({
      transcript: "me: hello", error: "still signed out", busy: false, retried: true,
    });
    expect(store.beginReprocess(noteA)).toBe("started");
  });

  test("refuses a second reprocess while one runs, and one for a missing slot", () => {
    const store = new RecoveryStore<object>();
    store.keep(noteA, failedRecord());
    expect(store.beginReprocess(noteA)).toBe("started");
    expect(store.beginReprocess(noteA)).toBe("busy");
    expect(store.beginReprocess(noteB)).toBe("none");
  });

  test("a slot dismissed mid-attempt stays gone", () => {
    const store = new RecoveryStore<object>();
    store.keep(noteA, failedRecord());
    store.beginReprocess(noteA);
    store.release(noteA);
    store.finishReprocess(noteA, { ok: false, error: "late" });
    expect(store.get(noteA)).toBeUndefined();
  });

  test("releaseAll empties every slot", () => {
    const store = new RecoveryStore<object>();
    store.keep(noteA, failedRecord());
    store.keep(noteB, failedRecord());
    store.releaseAll();
    expect(store.size).toBe(0);
  });

  test("pick prefers the active note's slot, otherwise the oldest", () => {
    const store = new RecoveryStore<object>();
    store.keep(noteA, failedRecord("a"));
    store.keep(noteB, failedRecord("b"));
    expect(store.pick(noteB)?.error).toBe("b");
    expect(store.pick(undefined)?.error).toBe("a");
    expect(store.pick({})?.error).toBe("a");
    expect(new RecoveryStore<object>().pick(noteA)).toBeUndefined();
  });

  test("the slot follows the file object across a rename", () => {
    const store = new RecoveryStore<{ path: string }>();
    const file = { path: "Meetings/A.md" };
    store.keep(file, failedRecord());
    file.path = "Archive/A.md";
    expect(store.get(file)).toBeDefined();
  });
});

describe("describeRecoveryCards", () => {
  const file = { path: "Meetings/Sync.md" };
  const info = (exists: boolean) => () => ({ basename: "Sync", path: file.path, exists });

  test("shows no cards when there is nothing to recover", () => {
    expect(describeRecoveryCards([], info(true))).toEqual([]);
  });

  test("names the error, the retry action and the disk-copy setting", () => {
    const store = new RecoveryStore<object>();
    store.keep(file, failedRecord("Not signed in"));
    const [card] = describeRecoveryCards(store.entries(), info(true));
    expect(card?.error).toBe("Not signed in");
    expect(card?.action).toEqual({ id: "reprocess", label: "Reprocess transcript", enabled: true });
    expect(card?.guidance).toContain("sign-in");
    expect(card?.diskNote).toContain("Transcript notes");
    expect(card?.notePath).toBe("Meetings/Sync.md");
  });

  test("disables the action and shows progress while reprocessing", () => {
    const store = new RecoveryStore<object>();
    store.keep(file, failedRecord());
    store.beginReprocess(file);
    const [card] = describeRecoveryCards(store.entries(), info(true));
    expect(card?.progress).toBe("Reprocessing transcript…");
    expect(card?.action.enabled).toBe(false);
    expect(card?.guidance).toBeUndefined();
  });

  test("a failed retry shows the new error as such", () => {
    const store = new RecoveryStore<object>();
    store.keep(file, failedRecord("old"));
    store.beginReprocess(file);
    store.finishReprocess(file, { ok: false, error: "still out" });
    const [card] = describeRecoveryCards(store.entries(), info(true));
    expect(card?.error).toBe("Reprocessing failed: still out");
    expect(card?.action.enabled).toBe(true);
  });

  test("a deleted note offers a clipboard copy instead", () => {
    const store = new RecoveryStore<object>();
    store.keep(file, failedRecord());
    const [card] = describeRecoveryCards(store.entries(), info(false));
    expect(card?.headline).toBe("The note was deleted");
    expect(card?.action).toEqual({ id: "copy", label: "Copy transcript", enabled: true });
    expect(card?.notePath).toBeUndefined();
  });

  test("the key changes when the slot is replaced but not on a repaint", () => {
    const store = new RecoveryStore<object>();
    store.keep(file, failedRecord());
    const first = describeRecoveryCards(store.entries(), info(true))[0]?.key;
    expect(describeRecoveryCards(store.entries(), info(true))[0]?.key).toBe(first);
    store.keep(file, failedRecord("again"));
    expect(describeRecoveryCards(store.entries(), info(true))[0]?.key).not.toBe(first);
  });
});

import { describe, expect, test } from "bun:test";
import {
  describeControl,
  describeRecord,
  describeStart,
  describeStop,
  isLoggableRecord,
} from "../src/capture-log.js";

/**
 * These lines are the only account of a capture's control sequence anyone gets after the
 * fact. What they must not do is either bury the lifecycle in transcript traffic or print the
 * transcript itself, so both of those are asserted rather than left to review.
 */
describe("which records are worth a line", () => {
  test("every lifecycle record is", () => {
    for (const t of ["hello", "capture_state", "begin", "refused", "start_failed", "final", "no_speech", "cancel", "error"]) {
      expect(isLoggableRecord({ t })).toBe(true);
    }
  });

  test("the transcript traffic is not", () => {
    // Several a second, and already written to the note and the sidecar.
    expect(isLoggableRecord({ t: "partial" })).toBe(false);
  });
});

describe("a record as one line", () => {
  test("names the fields that decide behaviour", () => {
    expect(describeRecord({ t: "capture_state", phase: "recording", mode: "meeting", publishing: true, session: 42 }))
      .toBe("capture_state session=42 mode=meeting phase=recording publishing=true");
    expect(describeRecord({ t: "begin", session: 1, mode: "assisted-notes" }))
      .toBe("begin session=1 mode=assisted-notes");
    expect(describeRecord({ t: "refused", mode: "meeting", reason: "busy" }))
      .toBe("refused mode=meeting reason=busy");
    expect(describeRecord({ t: "start_failed", mode: "meeting", code: "no-input-device", message: "No input device found" }))
      .toBe('start_failed mode=meeting code=no-input-device message="No input device found"');
  });

  test("a record with nothing to say is just its type", () => {
    expect(describeRecord({ t: "hello" })).toBe("hello");
  });

  test("never prints the transcript itself", () => {
    // `final` carries the whole corrected transcript. The note is where that belongs; a log
    // line that copied it would put a meeting's contents in the developer console.
    const line = describeRecord({ t: "final", session: 7 } as { t: string; session: number });
    expect(line).toBe("final session=7");
  });
});

describe("control results", () => {
  test("name the sequence the signal belonged to", () => {
    expect(describeControl("start", { status: "sent" })).toBe("control start: sent");
    expect(describeControl("finalize", { status: "not-running" })).toBe("control finalize: not-running");
    expect(describeControl("backstop", { status: "error", message: "spawn exploded" }))
      .toBe('control backstop: error "spawn exploded"');
  });
});

/**
 * The distinction a notice alone could not preserve: "did not start" says nothing about
 * whether the app refused it, failed to open the microphone, or never answered at all.
 */
describe("start outcomes", () => {
  test("a plain outcome carries no failure", () => {
    expect(describeStart("started", undefined)).toBe("start: started");
  });

  test("a refusal keeps its reason", () => {
    expect(describeStart("not-started", { kind: "refused", reason: "publication-disabled" }))
      .toBe("start: not-started (refused, reason=publication-disabled)");
  });

  test("a failed start keeps its code and message, and says so when there is no code", () => {
    expect(describeStart("not-started", { kind: "start-failed", code: "no-input-device", message: "No input device found" }))
      .toBe('start: not-started (start-failed, code=no-input-device, message="No input device found")');
    expect(describeStart("not-started", { kind: "start-failed", message: "No input device found" }))
      .toBe('start: not-started (start-failed, code=none, message="No input device found")');
  });

  test("the remaining kinds are named as themselves", () => {
    expect(describeStart("not-started", { kind: "no-hello" })).toBe("start: not-started (no-hello)");
    expect(describeStart("not-started", { kind: "unsupported" })).toBe("start: not-started (unsupported)");
    expect(describeStart("not-started", { kind: "start-timeout" })).toBe("start: not-started (start-timeout)");
  });
});

describe("stop outcomes", () => {
  test("are named as themselves", () => {
    expect(describeStop("finalized")).toBe("stop: finalized");
    expect(describeStop("no-session")).toBe("stop: no-session");
  });
});

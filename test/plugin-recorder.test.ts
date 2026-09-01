import { describe, expect, test } from "bun:test";
import type { ControlResult, ControlSignal } from "shorthand-core";
import {
  ShorthandRecorder,
  shorthandProvenDown,
  type ControlLike,
  type HelloInfo,
  type RecorderOptions,
  type RecorderPhase,
} from "../src/recorder.js";

/**
 * These tests exist because two shipped defects were both orderings, not values: a start
 * sequence whose spawned signal could not be recalled once a stop overtook it, and a stop
 * that tore the follower down while Shorthand was still computing the `final`. Nothing that
 * asserts on settings booleans can see either one, so every test here asserts on the
 * *sequence* of control signals and on when `stop()` is allowed to resolve.
 *
 * `ShorthandControl` is replaced by a fake that can hold a send in flight, which is the only
 * way to reproduce an interleaving deterministically.
 */

type Pending = { signal: ControlSignal; settle: (result: ControlResult) => void };

class FakeControl implements ControlLike {
  /** Every event, in order: `send:x`, `done:x`, `detached:x`. */
  readonly log: string[] = [];
  readonly pending: Pending[] = [];
  /** When false, sends stay in flight until `release()`. */
  auto = true;
  inFlight = 0;
  maxInFlight = 0;
  nextResult: ControlResult = { status: "sent" };
  throwOnSend = false;
  rejectOnSend = false;

  send(signal: ControlSignal): Promise<ControlResult> {
    if (this.throwOnSend) throw new Error("spawn exploded");
    this.log.push(`send:${signal}`);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    if (this.rejectOnSend) {
      this.inFlight -= 1;
      return Promise.reject(new Error("spawn rejected"));
    }
    return new Promise<ControlResult>((resolve) => {
      const settle = (result: ControlResult): void => {
        this.inFlight -= 1;
        this.log.push(`done:${signal}`);
        resolve(result);
      };
      if (this.auto) queueMicrotask(() => settle(this.nextResult));
      else this.pending.push({ signal, settle });
    });
  }

  sendDetached(signal: ControlSignal): void {
    this.log.push(`detached:${signal}`);
  }

  /** Settles the oldest send still in flight and reports which signal it was. */
  release(result: ControlResult = { status: "sent" }): ControlSignal {
    const next = this.pending.shift();
    if (next === undefined) throw new Error("no control send is in flight");
    next.settle(result);
    return next.signal;
  }

  /** Signals in the order Shorthand received them, detached ones included. */
  signals(): string[] {
    return this.log
      .filter((entry) => entry.startsWith("send:") || entry.startsWith("detached:"))
      .map((entry) => entry.replace(/^detached:/, ""))
      .map((entry) => entry.replace(/^send:/, ""));
  }
}

class FakeClock {
  readonly waits: Array<{ ms: number; fire: () => void }> = [];

  readonly delay = (ms: number): Promise<void> => new Promise<void>((resolveWait) => {
    this.waits.push({ ms, fire: resolveWait });
  });

  /** Expires the oldest outstanding wait of exactly this duration. */
  fire(ms: number): void {
    const index = this.waits.findIndex((wait) => wait.ms === ms);
    if (index < 0) throw new Error(`no pending wait of ${ms}ms`);
    const [wait] = this.waits.splice(index, 1);
    wait?.fire();
  }

  pending(ms: number): boolean {
    return this.waits.some((wait) => wait.ms === ms);
  }
}

const ATTACH_GRACE_MS = 2_000;
const BEGIN_GRACE_MS = 1_500;
const FINALIZE_TIMEOUT_MS = 45_000;
const START_ACK_MS = 3_000;
const MEETING_START: ControlSignal = "start-transcription";
const MEETING_STOP: ControlSignal = "stop-transcription";
const MEETING_CAPABILITIES: string[] = [MEETING_START, MEETING_STOP];
const ASSISTED_START: ControlSignal = "start-assisted-notes";
const ASSISTED_STOP: ControlSignal = "stop-assisted-notes";
const ASSISTED_CAPABILITIES: string[] = [ASSISTED_START, ASSISTED_STOP];

/** The `hello` a Meeting recorder needs before it will send anything at all. */
function meetingHello(): Promise<HelloInfo> {
  return Promise.resolve<HelloInfo>({ capabilities: MEETING_CAPABILITIES });
}

function build(overrides: Partial<RecorderOptions> = {}) {
  const control = new FakeControl();
  const clock = new FakeClock();
  const reports: Array<{ phase: RecorderPhase; result: ControlResult }> = [];
  const recorder = new ShorthandRecorder({
    control,
    signals: {
      mode: "meeting",
      start: MEETING_START,
      stop: MEETING_STOP,
      requiredCapabilities: MEETING_CAPABILITIES,
      startAcknowledgementMs: START_ACK_MS,
    },
    report: (phase, result) => { reports.push({ phase, result }); },
    finalizeTimeoutMs: FINALIZE_TIMEOUT_MS,
    attachGraceMs: ATTACH_GRACE_MS,
    beginGraceMs: BEGIN_GRACE_MS,
    delay: clock.delay,
    ...overrides,
  });
  return { control, clock, reports, recorder };
}

/** Assisted Notes' recorder, built with the same fakes; `build()` is Meeting's. */
function buildExplicit(overrides: Partial<RecorderOptions> = {}, signalsOverrides: Record<string, unknown> = {}) {
  return build({
    signals: {
      mode: "assisted-notes",
      start: ASSISTED_START,
      stop: ASSISTED_STOP,
      requiredCapabilities: ASSISTED_CAPABILITIES,
      startAcknowledgementMs: START_ACK_MS,
      ...signalsOverrides,
    } as RecorderOptions["signals"],
    ...overrides,
  });
}

/**
 * The ordinary opening of a capture: the start signal goes out, and Shorthand answers with the
 * `begin` that resolves the start sequence. Unlike the toggle path this replaced, a start does
 * not settle on the signal being delivered — a `sent` flag is not proof a recording began, so
 * the sequence waits for `begin`, `refused` or `start_failed`.
 */
async function startCapture(recorder: ShorthandRecorder, session = 1): Promise<void> {
  const started = recorder.start(meetingHello());
  await flush();
  recorder.observe({ t: "begin", session, mode: "meeting" });
  expect(await outcomeOf(started)).toBe("started");
}

/**
 * A start that has been delivered but not yet answered: the `begin` gap. The start sequence
 * is deliberately left unsettled — the recorder retains it, and `stop()` awaits it — so this
 * returns nothing for a caller to accidentally await.
 */
async function startPending(recorder: ShorthandRecorder): Promise<void> {
  void recorder.start(meetingHello());
  await flush();
}

/** Lets every queued microtask and continuation run. */
function flush(): Promise<void> {
  return new Promise((resolveFlush) => setTimeout(resolveFlush, 0));
}

/**
 * The outcome, or the literal `"still-waiting"` if the sequence has not settled by the
 * next turn of the loop. Every wait in this module is either satisfied by a record or
 * bounded by the injected clock, so a sequence that is still pending here is a defect —
 * and this reports it as a failed assertion instead of hanging the suite until the runner
 * gives up, which is what a plain `await` does to a mutant.
 */
function outcomeOf<T>(pending: Promise<T>): Promise<T | "still-waiting"> {
  return Promise.race([pending, flush().then(() => "still-waiting" as const)]);
}

/** Asserts a sequence has finished rather than parking forever. */
async function expectSettled(pending: Promise<unknown>): Promise<void> {
  expect(await outcomeOf(pending.then(() => "settled" as const))).toBe("settled");
}

/**
 * The follower's exit code 2 was read as "Shorthand is not running", and that reading skipped
 * the `--cancel` backstop. But the follower reports the same code for a live, *recording*
 * Shorthand whose live transcript streaming was switched off or whose follower slot was taken —
 * its own message says both — so minutes into a meeting the stream could die with code 2
 * against a Shorthand that was still recording, the backstop be skipped, and the microphone be
 * left hot while the user was told Shorthand was not running.
 */
describe("what the follower's exit proves about Shorthand", () => {
  const nothing = { helloEver: false, observedSession: false, controlConfirmed: false };

  test("exit 2 with nothing ever heard from Shorthand is proof it is down", () => {
    expect(shorthandProvenDown({ exitCode: 2, ...nothing })).toBe(true);
  });

  test("exit 2 after the follower connected proves nothing — cancel anyway", () => {
    // `hello` arrived, so the follower really did reach a running Shorthand. Whatever killed the
    // stream later, Shorthand may well still be recording.
    expect(shorthandProvenDown({ exitCode: 2, ...nothing, helloEver: true })).toBe(false);
  });

  test("exit 2 after Shorthand narrated a session proves nothing — cancel anyway", () => {
    expect(shorthandProvenDown({ exitCode: 2, ...nothing, observedSession: true })).toBe(false);
  });

  // The reproduced hot mic. With live transcript streaming switched off (or the follower slot
  // already taken) the follower never says `hello`, never sees a session, and exits 2 — while
  // the start sequence has meanwhile driven a very much running Shorthand into recording. Every
  // follower-derived signal says "down"; the only witness that Shorthand was up is that Shorthand
  // itself acknowledged the control signals.
  test("exit 2 proves nothing once Shorthand confirmed a control signal — cancel anyway", () => {
    expect(shorthandProvenDown({ exitCode: 2, ...nothing, controlConfirmed: true })).toBe(false);
  });

  test("no other exit is proof of anything, clean or not", () => {
    for (const exitCode of [0, 1, 3, null]) {
      expect(shorthandProvenDown({ exitCode, ...nothing })).toBe(false);
    }
  });
});

/**
 * HIGH-1. `shorthandProvenDown`'s answer is only as good as the evidence handed to it, and the
 * recorder is where the control-side evidence lives. A start sequence that Shorthand acknowledged
 * *is* proof Shorthand was running, so the plugin must be able to see it at the moment the
 * follower's exit tempts it to conclude the opposite.
 */
describe("what the recorder knows about Shorthand having been reached", () => {
  test("nothing is claimed before any signal is confirmed", () => {
    const { recorder } = build();
    expect(recorder.controlConfirmed).toBe(false);
  });

  test("a confirmed start sequence records that Shorthand was up", async () => {
    const { recorder } = build();
    await startPending(recorder);
    expect(recorder.controlConfirmed).toBe(true);
  });

  test("a signal that never reached Shorthand claims nothing", async () => {
    const { control, recorder } = build();
    control.nextResult = { status: "not-running" };
    await startPending(recorder);
    expect(recorder.controlConfirmed).toBe(false);
  });

  test("a failed signal claims nothing", async () => {
    const { control, recorder } = build();
    control.rejectOnSend = true;
    await startPending(recorder);
    expect(recorder.controlConfirmed).toBe(false);
  });

  // The whole reproduced failure, end to end: the follower attaches, the start sequence puts
  // Shorthand into recording, and then the follower dies and exits 2 before any session record
  // arrives. Reading that exit as proof skipped the backstop and left the microphone hot; the
  // recorder's own evidence is what defeats it.
  test("a recording this capture started is not a down Shorthand, whatever the follower's exit says", async () => {
    const { control, recorder } = build();
    await startPending(recorder);
    expect(control.signals()).toEqual([MEETING_START]);
    expect(recorder.mayBeRecording).toBe(true);
    expect(recorder.observedSession).toBe(false);

    expect(shorthandProvenDown({
      exitCode: 2,
      helloEver: false,
      observedSession: recorder.observedSession,
      controlConfirmed: recorder.controlConfirmed,
    })).toBe(false);
  });
});

describe("the start sequence", () => {
  test("sends the mode's start signal once, and nothing else", async () => {
    const { control, recorder } = build();
    await startPending(recorder);
    expect(control.log).toEqual([
      `send:${MEETING_START}`,
      `done:${MEETING_START}`,
    ]);
    // No `--cancel` ahead of it. `start-transcription` is idempotent (FOLLOW_STREAM.md's
    // table), so unlike the toggle this path replaced it never needs a forced known state
    // to be safe — which is also what removed the second spawn.
    expect(control.maxInFlight).toBe(1);
  });

  test("waits for the follower to attach before signalling anything", async () => {
    const { control, recorder } = build();
    let attach = (info: HelloInfo): void => { void info; };
    const attached = new Promise<HelloInfo>((resolveAttach) => { attach = resolveAttach; });
    const started = recorder.start(attached);
    await flush();
    expect(control.signals()).toEqual([]);
    attach({ capabilities: MEETING_CAPABILITIES });
    await flush();
    expect(control.signals()).toEqual([MEETING_START]);
    // Still unsettled: delivery is not proof a recording began, so the sequence waits for
    // `begin`, `refused` or `start_failed`.
    expect(await outcomeOf(started.then(() => "settled" as const))).toBe("still-waiting");
  });

  /**
   * The one thing the toggle path did differently, and deliberately no longer does: it
   * signalled anyway once the attach grace expired, on the theory that a recording nobody is
   * following beats no recording. An explicit start cannot do that — the capability gate has
   * nothing to read without a `hello` — and the trade is the right way round now, because a
   * blind start is exactly what left the plugin unable to tell whether a stop would finalize
   * a recording or start one.
   */
  test("sends nothing at all when no hello arrives before the grace expires", async () => {
    const { control, clock, recorder } = build();
    const started = recorder.start(new Promise<HelloInfo>(() => {}));
    await flush();
    expect(control.signals()).toEqual([]);
    clock.fire(ATTACH_GRACE_MS);
    expect(await outcomeOf(started)).toBe("not-started");
    expect(recorder.startFailure).toEqual({ kind: "no-hello" });
    expect(control.signals()).toEqual([]);
  });

  test("sends nothing when the app is too old to advertise the pair", async () => {
    const { control, recorder } = build();
    const outcome = await recorder.start(Promise.resolve<HelloInfo>({ capabilities: ["toggle-transcription"] }));
    expect(outcome).toBe("not-started");
    expect(recorder.startFailure).toEqual({ kind: "unsupported" });
    expect(control.signals()).toEqual([]);
  });
});

describe("the stop sequence", () => {
  test("stops a live session and waits for the terminal record before returning", async () => {
    const { control, recorder } = build();
    await startCapture(recorder, 1);
    let settled = false;
    const stopping = recorder.stop().then((outcome) => { settled = true; return outcome; });
    await flush();
    expect(control.signals()).toEqual([MEETING_START, MEETING_STOP]);
    // The whole point: the follower may not be torn down while Shorthand is computing `final`.
    expect(settled).toBe(false);
    recorder.observe({ t: "final", session: 1 });
    expect(await outcomeOf(stopping)).toBe("finalized");
  });

  /**
   * The stop signal goes out even when nothing is believed to be live — it is idempotent, so
   * unlike a toggle it can never start a recording by mistake, and sending it is the safety
   * net for a belief this module could have got wrong (a missed `begin`). What must never
   * happen is a *start*.
   */
  test("still sends the stop signal when no session is live, and never a start", async () => {
    const { control, recorder } = build();
    await startCapture(recorder, 1);
    recorder.observe({ t: "final", session: 1 });
    expect(await outcomeOf(recorder.stop())).toBe("no-session");
    expect(control.signals()).toEqual([MEETING_START, MEETING_STOP]);
  });

  test("stops waiting once the transcript stream is gone", async () => {
    const { recorder } = build();
    await startCapture(recorder, 1);
    let abandon = (): void => {};
    const abandoned = new Promise<void>((resolveAbandon) => { abandon = resolveAbandon; });
    let settled = false;
    const stopping = recorder.stop({ abandoned }).then((outcome) => { settled = true; return outcome; });
    await flush();
    expect(settled).toBe(false);
    // The follower exited: no terminal record can arrive from anywhere now, and sitting out
    // the rest of the budget would only make the stop look hung.
    abandon();
    expect(await outcomeOf(stopping)).toBe("abandoned");
  });

  test("gives up on the terminal record when the finalize budget expires", async () => {
    const { clock, recorder } = build();
    await startCapture(recorder, 1);
    const stopping = recorder.stop();
    await flush();
    clock.fire(FINALIZE_TIMEOUT_MS);
    expect(await outcomeOf(stopping)).toBe("timed-out");
  });

  test("treats every session-ending record as terminal", async () => {
    for (const terminal of ["final", "no_speech", "cancel", "error"]) {
      const { recorder } = build();
      await startPending(recorder);
      recorder.observe({ t: "begin", session: 1, mode: "meeting" });
      expect(recorder.sessionLive).toBe(true);
      const stopping = recorder.stop();
      await flush();
      recorder.observe({ t: terminal, session: 1 });
      expect(await outcomeOf(stopping)).toBe("finalized");
      expect(recorder.sessionLive).toBe(false);
    }
  });
});

/**
 * C2. `StreamClient` clears its `#activeSessions` on every disconnect and repopulates it
 * only from a fresh `begin`, which Shorthand does not resend when it resumes a session after a
 * reattach. A stop that trusted that set asked Shorthand to finalize and then killed the child
 * in the same tick, because the set looked empty.
 */
describe("a mid-recording reconnect", () => {
  test("does not make the plugin forget the live session it just asked Shorthand to finalize", async () => {
    const { control, recorder } = build();
    await startCapture(recorder, 1);
    // The reconnect itself: the client's own bookkeeping is cleared here, and Shorthand resumes
    // partials for the same session without a new `begin`. The recorder is told nothing —
    // that is exactly the point, its state may not depend on the client's.
    recorder.observe({ t: "partial", session: 1 });
    expect(recorder.sessionLive).toBe(true);

    let settled = false;
    const stopping = recorder.stop().then((outcome) => { settled = true; return outcome; });
    await flush();
    expect(control.signals()).toEqual([MEETING_START, MEETING_STOP]);
    expect(settled).toBe(false);
    recorder.observe({ t: "final", session: 1 });
    expect(await outcomeOf(stopping)).toBe("finalized");
  });
});

/**
 * C1. A spawned control process cannot be recalled, so a boolean guard checked *before*
 * the spawn cannot decide anything. Both interleavings must end deterministically stopped —
 * which the idempotent pair makes cheap: the recall is the same `stop` signal any other path
 * would send, not a `--cancel` that discards what Shorthand had corrected.
 */
describe("a stop that overtakes the start sequence", () => {
  test("recalls a start that was already in flight, sequenced after it", async () => {
    const { control, recorder } = build();
    control.auto = false;
    const started = recorder.start(meetingHello());
    await flush();
    // The start is now a spawned process on its way to Shorthand. Nothing can take it back.
    expect(control.signals()).toEqual([MEETING_START]);

    recorder.requestStop();
    const stopping = recorder.stop();
    await flush();
    // The stop cannot fire its own signals while that start is unresolved.
    expect(control.signals()).toEqual([MEETING_START]);

    expect(control.release()).toBe(MEETING_START);
    await flush();
    while (control.pending.length > 0) {
      control.release();
      await flush();
    }
    await expectSettled(started);
    expect(await outcomeOf(stopping)).toBe("no-session");
    // Whichever way the timing fell, the last thing Shorthand heard drives it to idle — and
    // only one start was ever sent, so nothing here can have begun a second recording.
    expect(control.signals().at(-1)).toBe(MEETING_STOP);
    expect(control.signals().filter((signal) => signal === MEETING_START)).toEqual([MEETING_START]);
  });

  test("never spawns the start at all when the stop lands before it", async () => {
    const { control, recorder } = build();
    const started = recorder.start(meetingHello());
    recorder.requestStop();
    const stopping = recorder.stop();
    await expectSettled(started);
    expect(await outcomeOf(stopping)).toBe("no-session");
    expect(control.signals()).not.toContain(MEETING_START);
    expect(control.signals().at(-1)).toBe(MEETING_STOP);
  });

  test("does not overlap the two sequences", async () => {
    const { control, recorder } = build();
    control.auto = false;
    const started = recorder.start(meetingHello());
    await flush();
    recorder.requestStop();
    const stopping = recorder.stop();
    await flush();
    control.release();
    await flush();
    while (control.pending.length > 0) {
      control.release();
      await flush();
    }
    await expectSettled(started);
    await expectSettled(stopping);
    expect(control.maxInFlight).toBe(1);
  });
});

/**
 * The mirror of the reconnect case: Shorthand is recording but has not said `begin` yet, the
 * ~100ms between the start signal landing and the session being announced.
 */
describe("a stop inside the begin gap", () => {
  test("waits for the begin and then finalizes normally", async () => {
    const { control, recorder } = build();
    await startPending(recorder);
    expect(recorder.sessionLive).toBe(false);
    expect(recorder.mayBeRecording).toBe(true);

    const stopping = recorder.stop();
    await flush();
    // The start sequence was still waiting for its acknowledgement, so the stop wakes it and
    // it recalls itself with the same idempotent stop signal — no premature "nothing is
    // recording", and nothing that could start anything.
    expect(control.signals()).toEqual([MEETING_START, MEETING_STOP]);
    recorder.observe({ t: "begin", session: 1, mode: "meeting" });
    await flush();
    // The recording announced itself after all, so the stop finalizes it properly rather
    // than leaving it to the caller's backstop.
    expect(control.signals()).toEqual([MEETING_START, MEETING_STOP, MEETING_STOP]);
    recorder.observe({ t: "final", session: 1 });
    expect(await outcomeOf(stopping)).toBe("finalized");
  });

  test("still sends the stop when the begin never arrives", async () => {
    const { control, clock, recorder } = build();
    await startPending(recorder);
    const stopping = recorder.stop();
    await flush();
    expect(clock.pending(BEGIN_GRACE_MS)).toBe(true);
    clock.fire(BEGIN_GRACE_MS);
    expect(await outcomeOf(stopping)).toBe("no-session");
    // Best-effort, and safe: the stop signal cannot itself start anything, so there is
    // nothing to lose by sending it against a belief that may simply be wrong — once as the
    // start sequence's own recall, once as the stop itself.
    expect(control.signals()).toEqual([MEETING_START, MEETING_STOP, MEETING_STOP]);
    expect(control.signals().filter((signal) => signal === MEETING_START)).toEqual([MEETING_START]);
  });
});

/**
 * Shorthand does not resend `begin` to a follower that reattached, so a whole meeting can
 * stream in as partials with its `begin` never observed by anyone. Trusting only `begin` lost
 * whole meetings: partials filled the sidecar while the recorder believed nothing was
 * recording, so the stop sent no finalize and the backstop threw the corrected `final` away.
 */
describe("a `begin` nobody was there to see", () => {
  test("finalizes on the strength of partials alone", async () => {
    const { control, recorder } = build();
    await startPending(recorder);
    // The follower reconnects and Shorthand resumes the session it never re-announces.
    recorder.noteAttached();
    recorder.observe({ t: "partial", session: 4 });
    expect(recorder.sessionLive).toBe(true);

    const stopping = recorder.stop();
    await flush();
    expect(control.signals()).toEqual([MEETING_START, MEETING_STOP]);
    recorder.observe({ t: "final", session: 4 });
    expect(await outcomeOf(stopping)).toBe("finalized");
  });
});

/**
 * A recording Shorthand was already running when this capture's start signal arrived emits
 * its own terminal record, and that record can land after the start was already sent. Without
 * the session id it is indistinguishable from this capture's recording ending — and reading
 * it that way discarded the recording that had only just begun.
 */
describe("records from the previous recording", () => {
  test("the previous recording ending is not this capture's session ending", async () => {
    const { control, recorder } = build();
    await startPending(recorder);
    expect(recorder.mayBeRecording).toBe(true);

    recorder.observe({ t: "cancel", session: 7 });
    expect(recorder.mayBeRecording).toBe(true);

    recorder.observe({ t: "begin", session: 8, mode: "meeting" });
    const stopping = recorder.stop();
    await flush();
    expect(control.signals()).toEqual([MEETING_START, MEETING_STOP]);
    recorder.observe({ t: "final", session: 8 });
    expect(await outcomeOf(stopping)).toBe("finalized");
  });

  test("a stop waiting for its session is not released by the previous one ending", async () => {
    const { control, recorder } = build();
    await startPending(recorder);
    const stopping = recorder.stop();
    await flush();
    // One stop so far: the start sequence's own recall, woken by the stop request.
    expect(control.signals()).toEqual([MEETING_START, MEETING_STOP]);

    // The previous recording, ended by Shorthand's own hotkey moments earlier, reported back
    // late. Taking it for this capture's session ends the stop with no finalize — and the
    // recording it just started is then left to the backstop unfinished.
    recorder.observe({ t: "cancel", session: 7 });
    await flush();
    expect(control.signals()).toEqual([MEETING_START, MEETING_STOP]);

    recorder.observe({ t: "begin", session: 8, mode: "meeting" });
    await flush();
    expect(control.signals()).toEqual([MEETING_START, MEETING_STOP, MEETING_STOP]);
    recorder.observe({ t: "final", session: 8 });
    expect(await outcomeOf(stopping)).toBe("finalized");
  });

  test("a terminal record for another session does not end the live one", async () => {
    const { recorder } = build();
    await startCapture(recorder, 8);
    recorder.observe({ t: "cancel", session: 7 });
    expect(recorder.sessionLive).toBe(true);
  });

  test("are still proof that Shorthand was up and narrating", async () => {
    const { recorder } = build();
    expect(recorder.observedSession).toBe(false);
    await startPending(recorder);
    expect(recorder.observedSession).toBe(false);
    // Ignored as the previous recording's, but the caller needs it for a different question:
    // the follower's exit code 2 means "Shorthand is not running" *or* "streaming is off / the
    // follower slot was taken", and having heard Shorthand narrate a session rules out the first.
    recorder.observe({ t: "cancel", session: 7 });
    expect(recorder.observedSession).toBe(true);
  });
});

/**
 * Shorthand quitting mid-capture can beat the stream's own settled handler to the user's Stop
 * press. A stop signal spawned then has no Shorthand to forward to, so it *becomes* Shorthand
 * starting up — a dead-Shorthand stop that launches the app.
 */
describe("a stop with Shorthand known to be gone", () => {
  test("sends no stop signal even though a session looks live", async () => {
    const { control, recorder } = build();
    await startCapture(recorder, 1);
    const before = control.signals().length;
    expect(await outcomeOf(recorder.stop({ shorthandDown: true }))).toBe("shorthand-down");
    expect(control.signals().length).toBe(before);
  });

  test("still waits for the start sequence to finish first", async () => {
    const { control, recorder } = build();
    control.auto = false;
    const started = recorder.start(meetingHello());
    await flush();
    const stopping = recorder.stop({ shorthandDown: true });
    // Suppressing the stop must not also drop the guarantee that the two sequences never
    // overlap: the start already spawned is still on its way to Shorthand.
    expect(await outcomeOf(stopping)).toBe("still-waiting");
    expect(control.release()).toBe(MEETING_START);
    await flush();
    while (control.pending.length > 0) control.release();
    await expectSettled(started);
    expect(await outcomeOf(stopping)).toBe("shorthand-down");
  });
});

/**
 * `requestStop()` is the whole stop on the stream-death path — `captureSettled` calls it and
 * never reaches `stop()`. Every other test here pairs the two, and `stop()` sets the same
 * flag, so the two setters covered for each other and a broken `requestStop` left a green
 * suite with a hot mic.
 */
describe("requestStop on its own", () => {
  test("recalls an in-flight start with no stop() to back it up", async () => {
    const { control, recorder } = build();
    control.auto = false;
    const started = recorder.start(meetingHello());
    await flush();
    // The start is a spawned process now; nothing can take it back.
    expect(control.signals()).toEqual([MEETING_START]);

    recorder.requestStop();
    expect(control.release()).toBe(MEETING_START);
    await flush();
    expect(control.release()).toBe(MEETING_STOP);
    await expectSettled(started);
    expect(control.signals()).toEqual([MEETING_START, MEETING_STOP]);
  });

  test("takes effect synchronously, in the same tick the start settles", async () => {
    const { control, recorder } = build();
    control.auto = false;
    const started = recorder.start(meetingHello());
    await flush();
    // The tightest interleaving: the start settles and the stop request lands before the
    // start sequence has resumed. A flag that took even one microtask to become visible
    // would let the sequence finish believing nothing had asked it to stop.
    expect(control.release()).toBe(MEETING_START);
    recorder.requestStop();
    await flush();
    expect(control.release()).toBe(MEETING_STOP);
    await expectSettled(started);
    expect(control.signals()).toEqual([MEETING_START, MEETING_STOP]);
  });

  test("sends no recall when the start it would recall never reached Shorthand", async () => {
    const { control, recorder } = build();
    control.auto = false;
    const started = recorder.start(meetingHello());
    await flush();
    recorder.requestStop();
    control.release({ status: "not-running" }); // the start never got there
    await expectSettled(started);
    // Nothing was started, so there is nothing to recall — and against a Shorthand that is
    // not running, another spawn *is* the app starting up.
    expect(control.signals()).toEqual([MEETING_START]);
  });

  /**
   * MEDIUM-1. The flag write must be synchronous *with the call site*, not merely "visible a
   * couple of hops after the promise that triggered it". This pins the stream-death ordering
   * exactly: `decoder.end()` flushes the buffered `hello` — so `markAttached()` — before
   * `#emitSettled`, which queues the attach race's reaction ahead of the `settled` handler
   * that calls `requestStop()`. So `requestStop()` runs one hop after the resolution, and the
   * start sequence's await-resumption is queued behind it. Deferring the write by a single
   * microtask (`queueMicrotask(() => { this.#stopping = true; })`) inverts that: the
   * resumption reads `false`, and the sequence starts a recording on a follower that is
   * already dead. `stop()` cannot see this — it sets the same flag itself and heals it.
   */
  test("is visible to a start sequence unblocked by the very resolution that led here", async () => {
    const { control, recorder } = build();
    let attach = (info: HelloInfo): void => { void info; };
    const attached = new Promise<HelloInfo>((resolveAttach) => { attach = resolveAttach; });
    const started = recorder.start(attached);
    await flush();
    expect(control.signals()).toEqual([]);

    // The `close` handler: the buffered `hello` is flushed synchronously...
    attach({ capabilities: MEETING_CAPABILITIES });
    // ...and `settled`'s own reaction, one hop later, is where `captureSettled` calls this.
    void Promise.resolve().then(() => { recorder.requestStop(); });

    await expectSettled(started);
    // Nothing was ever sent. Before the first spawn there is nothing to recall, so a stop seen
    // at the first checkpoint means the capture ends with Shorthand untouched.
    expect(control.signals()).toEqual([]);
  });

  test("stop() sets the same flag itself, with no separate request", async () => {
    const { control, recorder } = build();
    control.auto = false;
    const started = recorder.start(meetingHello());
    await flush();
    const stopping = recorder.stop();
    expect(control.release()).toBe(MEETING_START);
    await flush();
    while (control.pending.length > 0) {
      control.release();
      await flush();
    }
    await expectSettled(started);
    expect(await outcomeOf(stopping)).toBe("no-session");
    expect(control.signals().at(-1)).toBe(MEETING_STOP);
  });
});

/**
 * MEDIUM-2. `whenStartSettled()` is the whole of the stream-death path's wait: `captureSettled`
 * does not call `stop()`, so nothing else there holds the runtime open. Without it, a dead
 * capture's recall could still be in flight when the user starts the next capture — and land
 * on the recording *that* capture had just started.
 */
describe("waiting for the start sequence on its own", () => {
  test("does not resolve until the recall sequenced behind the start has landed", async () => {
    const { control, recorder } = build();
    control.auto = false;
    const started = recorder.start(meetingHello());
    await flush();
    // The start is spawned and unrecallable; the stream has just died.
    recorder.requestStop();
    const waiting = recorder.whenStartSettled();
    expect(await outcomeOf(waiting.then(() => "settled" as const))).toBe("still-waiting");

    expect(control.release()).toBe(MEETING_START);
    await flush();
    // Still not settled: the recall this sequence owes has not even been answered yet.
    expect(await outcomeOf(waiting.then(() => "settled" as const))).toBe("still-waiting");
    expect(control.release()).toBe(MEETING_STOP);

    await expectSettled(waiting);
    await expectSettled(started);
    expect(control.signals()).toEqual([MEETING_START, MEETING_STOP]);
  });

  test("resolves immediately when no start sequence was ever run", async () => {
    const { recorder } = build();
    await expectSettled(recorder.whenStartSettled());
  });
});

/**
 * The recall is what makes a recalled start sequence *known* idle, and that belief is what
 * decides whether the caller tells the user a recording in progress was cancelled. Leaving
 * `#expectingSession` set afterwards produced that notice for a capture that had already been
 * driven to idle by its own recall.
 */
describe("what the recorder believes after its own recall", () => {
  test("a recalled start sequence leaves nothing believed to be recording", async () => {
    const { control, recorder } = build();
    control.auto = false;
    const started = recorder.start(meetingHello());
    await flush();
    expect(control.release()).toBe(MEETING_START); // the start lands: Shorthand is recording
    recorder.requestStop();
    await flush();
    expect(control.release()).toBe(MEETING_STOP);  // ...and the recall lands: it is not any more
    await expectSettled(started);
    expect(recorder.mayBeRecording).toBe(false);
    expect(recorder.sessionLive).toBe(false);
  });
});

/**
 * MEDIUM-3. Shorthand's session counter is process-local and restarts at 1, so a session id is
 * only a name within one Shorthand process. A capture that followed session 5 and then lost
 * Shorthand to a restart kept believing session 5 was live.
 */
describe("a Shorthand restart in the middle of a capture", () => {
  test("a different session beginning during the finalize wait ends it at once", async () => {
    const { control, recorder } = build();
    recorder.noteAttached();                    // the follower's first `hello`
    await startCapture(recorder, 5);
    // Shorthand is killed. The recording dies with it and no terminal record reaches anyone; the
    // follower reconnects on its own and says `hello` to the *new* Shorthand, which is idle.
    recorder.noteAttached();

    const stopping = recorder.stop();
    await flush();
    // Nothing contradicted the belief, so the stop signal is sent — harmlessly, since it is a
    // documented no-op against an idle app.
    expect(control.signals()).toEqual([MEETING_START, MEETING_STOP]);
    expect(await outcomeOf(stopping)).toBe("still-waiting");
    // A recording starting now — the user's own hotkey on the restarted app — proves the
    // session being waited on is gone. Said at once rather than after the whole 45s budget
    // with a live microphone.
    recorder.observe({ t: "begin", session: 1, mode: "meeting" });
    expect(await outcomeOf(stopping)).toBe("restarted");
  });

  test("a lower session id after a reconnect ends the belief instead of carrying it across", async () => {
    const { control, recorder } = build();
    recorder.noteAttached();                    // the follower's first `hello`
    await startCapture(recorder, 5);
    recorder.noteAttached();                    // ...and the reconnect's, to a restarted Shorthand
    // The restarted Shorthand's own first recording, started and ended by the user's hotkey. Id 1
    // cannot belong to the process that numbered ours 5.
    recorder.observe({ t: "cancel", session: 1 });
    expect(recorder.sessionLive).toBe(false);

    expect(await outcomeOf(recorder.stop())).toBe("no-session");
    // Best-effort and idempotent; never a start.
    expect(control.signals()).toEqual([MEETING_START, MEETING_STOP]);
  });

  test("without a reconnect a lower id is just another session of the same Shorthand", async () => {
    const { recorder } = build();
    recorder.noteAttached();
    await startCapture(recorder, 5);
    // The previous recording's terminal record, reported late. Same Shorthand, so ids are
    // comparable and this one simply is not ours.
    recorder.observe({ t: "cancel", session: 4 });
    expect(recorder.sessionLive).toBe(true);
  });

  test("a plain mid-recording reconnect does not forget the live session", async () => {
    const { control, recorder } = build();
    recorder.noteAttached();
    await startCapture(recorder, 5);
    // The same Shorthand, still recording: a fresh follower, a fresh `hello`, and Shorthand resumes
    // partials for session 5 without a new `begin`. Dropping the belief here is what used to
    // cancel a live meeting away unfinalized.
    recorder.noteAttached();
    recorder.observe({ t: "partial", session: 5 });
    expect(recorder.sessionLive).toBe(true);
    const stopping = recorder.stop();
    await flush();
    expect(control.signals()).toEqual([MEETING_START, MEETING_STOP]);
    recorder.observe({ t: "final", session: 5 });
    expect(await outcomeOf(stopping)).toBe("finalized");
  });
});

/**
 * MEDIUM-4. `observe()` takes session-scoped records only — `main.ts` routes `hello` to
 * `noteAttached()`, and a connection-level `error` never reaches the `event` stream at all.
 * The guard is a fail-safe for that routing, not a filter: a session-less record accepted here
 * would claim Shorthand had been heard narrating and could clear a live session, which is a
 * silently skipped finalize.
 */
describe("records that are not session-scoped", () => {
  test("a session-less record is ignored rather than trusted", async () => {
    const { control, recorder } = build();
    await startCapture(recorder, 3);

    // What a mis-routed connection-level error would look like.
    recorder.observe({ t: "error" });
    expect(recorder.sessionLive).toBe(true);

    const stopping = recorder.stop();
    await flush();
    expect(control.signals()).toEqual([MEETING_START, MEETING_STOP]);
    recorder.observe({ t: "final", session: 3 });
    expect(await outcomeOf(stopping)).toBe("finalized");
  });

  test("a session-less record is not evidence that Shorthand was up", () => {
    const { recorder } = build();
    recorder.observe({ t: "error" });
    // `observedSession` decides whether the follower's exit 2 gets read as proof Shorthand is
    // down. A record that names no session says nothing about Shorthand's recorder.
    expect(recorder.observedSession).toBe(false);
  });
});

/**
 * `capture_state` replaced the old `idle` record (FOLLOW_STREAM.md). `phase: "idle"` has to
 * keep doing exactly what `idle` did — clear session state on a reattach — since that is the
 * one case this module used to have no other way to learn for certain.
 */
describe("capture_state", () => {
  test("phase idle clears session state on reattach, as the old idle record did", async () => {
    const { recorder } = buildExplicit();
    recorder.noteAttached();
    const started = recorder.start(Promise.resolve<HelloInfo>({ capabilities: ASSISTED_CAPABILITIES }));
    await flush();
    recorder.observe({ t: "begin", session: 1, mode: "assisted-notes" });
    expect(await outcomeOf(started)).toBe("started");
    expect(recorder.sessionLive).toBe(true);

    // Shorthand restarted while the follower was away; the reattach's own capture_state says
    // idle, definitively — the same positive proof the old `idle` record gave, now carried by
    // the richer record.
    recorder.noteAttached();
    recorder.observe({ t: "capture_state", phase: "idle" });
    expect(recorder.sessionLive).toBe(false);
    expect(recorder.mayBeRecording).toBe(false);
  });

  test("phase idle on a fresh connection is merely confirmatory", () => {
    const { recorder } = buildExplicit();
    recorder.observe({ t: "capture_state", phase: "idle" });
    expect(recorder.sessionLive).toBe(false);
    expect(recorder.mayBeRecording).toBe(false);
  });
});

describe("teardown and backstop", () => {
  test("teardown sends the mode's stop signal, detached", () => {
    const { control, recorder } = build();
    recorder.teardown();
    expect(control.log).toEqual([`detached:${MEETING_STOP}`]);
  });

  test("teardown during an in-flight start still ends idle", async () => {
    const { control, recorder } = build();
    control.auto = false;
    const started = recorder.start(meetingHello());
    await flush();
    // Obsidian is quitting; nothing here can await the start that is already in flight.
    recorder.teardown();
    expect(control.release()).toBe(MEETING_START);
    await flush();
    while (control.pending.length > 0) {
      control.release();
      await flush();
    }
    await expectSettled(started);
    expect(control.signals().at(-1)).toBe(MEETING_STOP);
    expect(control.signals().filter((signal) => signal === MEETING_START)).toEqual([MEETING_START]);
  });

  test("the backstop is a single stop signal", () => {
    const { control, reports, recorder } = build();
    recorder.backstop();
    expect(control.signals()).toEqual([MEETING_STOP]);
    expect(reports.every(({ phase }) => phase === "backstop")).toBe(true);
  });
});

/**
 * The start signal never reached Shorthand, so this capture started nothing — and then the
 * user pressed Shorthand's own hotkey. A stop that concluded "nothing of mine is running"
 * would finalize nothing and lose a live recording the capture is already ingesting.
 */
describe("a recording that started outside the start sequence", () => {
  test("is finalized even though this capture's own start never landed", async () => {
    const { control, recorder } = build();
    control.nextResult = { status: "not-running" };
    await startPending(recorder);
    expect(control.signals()).toEqual([MEETING_START]);

    control.nextResult = { status: "sent" };
    recorder.observe({ t: "begin", session: 1, mode: "meeting" });
    const stopping = recorder.stop();
    await flush();
    expect(control.signals()).toEqual([MEETING_START, MEETING_STOP]);
    recorder.observe({ t: "final", session: 1 });
    expect(await outcomeOf(stopping)).toBe("finalized");
  });
});

describe("control failures", () => {
  test("a rejected send neither throws nor unwinds the sequence", async () => {
    const { control, reports, recorder } = build();
    control.rejectOnSend = true;
    await startPending(recorder);
    expect(await outcomeOf(recorder.stop())).toBe("no-session");
    expect(reports[0]).toEqual({ phase: "start", result: { status: "error", message: "spawn rejected" } });
  });

  test("a rejected finalize resolves the stop rather than rejecting it", async () => {
    const { control, recorder } = build();
    await startCapture(recorder, 1);
    control.rejectOnSend = true;
    // `start()` has its own catch; `stop()` has none, so a rejection here would propagate
    // out of Stop capture and unwind a capture that is otherwise perfectly healthy.
    expect(await outcomeOf(recorder.stop())).toBe("not-finalized");
  });

  test("a send that throws synchronously is reported, not propagated", async () => {
    const { control, reports, recorder } = build();
    control.throwOnSend = true;
    await startPending(recorder);
    expect(reports.map(({ phase }) => phase)).toEqual(["start"]);
    expect(reports[0]?.result).toEqual({ status: "error", message: "spawn exploded" });
  });
});

/**
 * Assisted Notes' explicit start contract. Unlike Meeting, `ShorthandControl.send()` reporting
 * `sent` is not proof the recording actually began: the forwarding child exits 0 as soon as
 * `tauri_plugin_single_instance` hands the flag to a running Shorthand, before Shorthand has
 * evaluated it — so a `begin`, a `refused`, or a `start_failed` are all still to come on the
 * wire. `requiredCapabilities` and `startAcknowledgementMs` exist to fail an unsupported app
 * clearly and early, and to give a genuinely silent one a bound, while a real refusal or
 * failure is reported the moment its own record arrives rather than waited out.
 */
describe("the explicit start/stop contract", () => {
  test("capability present: starts directly (no cancel), and a begin resolves started", async () => {
    const { control, recorder } = buildExplicit();
    const started = recorder.start(Promise.resolve<HelloInfo>({ capabilities: ASSISTED_CAPABILITIES }));
    await flush();
    // No `--cancel`: `start-assisted-notes` is idempotent, so unlike Meeting's toggle it never
    // needs a forced known state to be safe.
    expect(control.signals()).toEqual([ASSISTED_START]);
    recorder.observe({ t: "begin", session: 1 });
    expect(await outcomeOf(started)).toBe("started");
    expect(recorder.startFailure).toBeUndefined();
  });

  /**
   * Shorthand can act on the flag and announce the session before the forwarding child it was
   * sent through actually exits — and on Windows the gap runs the wrong way: `begin` was
   * observed ~20ms before the child's exit. The wait loop only registers with `#beginWaiters`
   * after `send()` resolves on that exit, so a record landing in this exact gap would
   * otherwise have its wakeup silently dropped (`resolveAll` on an empty set) and sit out the
   * whole acknowledgement budget for a session that had already started.
   */
  test("a begin that arrives while the start child is still exiting still counts as started", async () => {
    const { control, recorder } = buildExplicit();
    control.auto = false;
    const started = recorder.start(Promise.resolve<HelloInfo>({ capabilities: ASSISTED_CAPABILITIES }));
    await flush();
    // The start signal has been spawned and is still in flight. Shorthand has already acted on it.
    recorder.observe({ t: "begin", session: 1 });
    expect(control.release()).toBe(ASSISTED_START);
    expect(await outcomeOf(started)).toBe("started");
    expect(recorder.startFailure).toBeUndefined();
  });

  /**
   * P1. A start issued while Assisted Notes is already recording — from Shorthand's own
   * hotkey, say — is the documented success no-op (FOLLOW_STREAM.md's table): Shorthand
   * answers with silence, no `begin`, because nothing began. Before this fix, this case was
   * only ever recognized by inferring it from an observed `begin`; a mismatched inference
   * (`!wasLiveBeforeSend`) let the race run to its deadline and the timeout backstop send
   * `stop`, ending the very recording this idempotent command was supposed to leave untouched.
   * `capture_state` now reports the fact directly, so this asserts the adoption is driven by
   * that report rather than by observing a `begin` at all.
   */
  test("a start issued while this mode is already recording, per capture_state, resolves started and stop is never sent", async () => {
    const { control, recorder } = buildExplicit();
    // Already recording before this capture's start sequence ever ran, reported directly —
    // FOLLOW_STREAM.md's own example of an already-active, published capture.
    recorder.observe({ t: "capture_state", phase: "recording", mode: "assisted-notes", publishing: true, session: 1 });
    const started = recorder.start(Promise.resolve<HelloInfo>({ capabilities: ASSISTED_CAPABILITIES }));
    expect(await outcomeOf(started)).toBe("started");
    expect(recorder.startFailure).toBeUndefined();
    // The start signal still goes out once — idempotent, so it needs no forced known state —
    // but nothing beyond that, and in particular no `stop-assisted-notes`.
    expect(control.signals()).toEqual([ASSISTED_START]);
    expect(control.signals()).not.toContain(ASSISTED_STOP);
  });

  /**
   * The gap capture_state closes that no observed `begin` ever could: a capture that is not
   * publishing never emits a `begin` this follower will see at all (FOLLOW_STREAM.md), so the
   * old `begin`-based inference could not tell "already recording, silently" apart from
   * "nothing running" — which is exactly what let the P1 backstop fire against a pre-existing,
   * non-publishing capture.
   */
  test("a start issued while this mode is already recording but not publishing still resolves started, and expects no transcript", async () => {
    const { control, recorder } = buildExplicit();
    // No `session` at all: a non-publishing capture has no hub session and no `begin` ever
    // reaches this follower for it (FOLLOW_STREAM.md).
    recorder.observe({ t: "capture_state", phase: "recording", mode: "assisted-notes", publishing: false });
    const started = recorder.start(Promise.resolve<HelloInfo>({ capabilities: ASSISTED_CAPABILITIES }));
    expect(await outcomeOf(started)).toBe("started");
    expect(recorder.startFailure).toBeUndefined();
    expect(control.signals()).toEqual([ASSISTED_START]);
    expect(control.signals()).not.toContain(ASSISTED_STOP);
    // Nothing will ever announce this capture on this connection, so the recorder must not
    // believe it is waiting for one: `mayBeRecording` reads false even though the capture is
    // genuinely, remotely still running. Honest about what this connection can and cannot
    // prove, rather than parking a stop() behind a `begin` grace that can never resolve.
    expect(recorder.mayBeRecording).toBe(false);
    expect(recorder.sessionLive).toBe(false);
  });

  /**
   * `#reportedRecordingMode`/`#followedMode` are separate signals for the same question, and
   * this is the fallback path: a session that began *after* this connection's one-time
   * capture_state already reported idle can only be known from an observed `begin`, exactly
   * as before capture_state existed. Kept working, not deleted, for that reason.
   */
  test("a session that began after an idle capture_state is still adopted, via the observed begin", async () => {
    const { control, recorder } = buildExplicit();
    recorder.observe({ t: "capture_state", phase: "idle" });
    // Began later, on the strength of a `begin` capture_state's one-time snapshot could not
    // have carried.
    recorder.observe({ t: "begin", session: 1, mode: "assisted-notes" });
    const started = recorder.start(Promise.resolve<HelloInfo>({ capabilities: ASSISTED_CAPABILITIES }));
    expect(await outcomeOf(started)).toBe("started");
    expect(recorder.startFailure).toBeUndefined();
    expect(control.signals()).toEqual([ASSISTED_START]);
    expect(control.signals()).not.toContain(ASSISTED_STOP);
  });

  test("a start while a different mode is recording is refused, not adopted", async () => {
    const { control, recorder } = buildExplicit();
    // A different mode is already recording; this is exactly the "busy" row of
    // FOLLOW_STREAM.md's table, not a success no-op, and must not be adopted as one.
    recorder.observe({ t: "begin", session: 1, mode: "meeting" });
    const started = recorder.start(Promise.resolve<HelloInfo>({ capabilities: ASSISTED_CAPABILITIES }));
    await flush();
    recorder.observe({ t: "refused", mode: "assisted-notes", reason: "busy" });
    expect(await outcomeOf(started)).toBe("not-started");
    expect(recorder.startFailure).toEqual({ kind: "refused", reason: "busy" });
    expect(control.signals()).toEqual([ASSISTED_START]);
  });

  /**
   * Same "busy" scenario, driven by capture_state instead of an observed `begin`: reported
   * state for a *different* mode must never satisfy this recorder's own adoption check.
   */
  test("attach reporting a different mode recording, per capture_state, is refused, not adopted", async () => {
    const { control, recorder } = buildExplicit();
    recorder.observe({ t: "capture_state", phase: "recording", mode: "meeting", publishing: true, session: 1 });
    const started = recorder.start(Promise.resolve<HelloInfo>({ capabilities: ASSISTED_CAPABILITIES }));
    await flush();
    recorder.observe({ t: "refused", mode: "assisted-notes", reason: "busy" });
    expect(await outcomeOf(started)).toBe("not-started");
    expect(recorder.startFailure).toEqual({ kind: "refused", reason: "busy" });
    expect(control.signals()).toEqual([ASSISTED_START]);
    expect(control.signals()).not.toContain(ASSISTED_STOP);
  });

  /**
   * `#followedMode` is `undefined` both for an app old enough to predate `begin-mode` and for
   * a mode core does not recognize — the second of those is a genuinely different, unrelated
   * capture, so an unknown mode must not be adopted the way a freshly-arrived `begin` is. The
   * cost of that caution is only a slower, misreported `start-timeout` instead of `"started"`;
   * it must never be a stopped recording, which the timeout fix below still guarantees.
   */
  test("a pre-existing session with unknown mode is not adopted, and still ends safely", async () => {
    const { control, clock, recorder } = buildExplicit();
    recorder.observe({ t: "begin", session: 1 }); // no `mode` field at all
    const started = recorder.start(Promise.resolve<HelloInfo>({ capabilities: ASSISTED_CAPABILITIES }));
    await flush();
    expect(await outcomeOf(started.then(() => "settled" as const))).toBe("still-waiting");
    clock.fire(START_ACK_MS);
    expect(await outcomeOf(started)).toBe("not-started");
    expect(recorder.startFailure).toEqual({ kind: "start-timeout" });
    // The point of the timeout fix: a session that predates this call, of any mode including
    // an unrecognized one, is never stopped by the backstop.
    expect(control.signals()).toEqual([ASSISTED_START]);
    expect(control.signals()).not.toContain(ASSISTED_STOP);
  });

  test("capability missing: not-started, with no control signal sent", async () => {
    for (const capabilities of [[], [ASSISTED_START], [ASSISTED_STOP]]) {
      const { control, recorder } = buildExplicit();
      const outcome = await recorder.start(Promise.resolve<HelloInfo>({ capabilities }));
      expect(outcome).toBe("not-started");
      expect(recorder.startFailure).toEqual({ kind: "unsupported" });
      expect(control.signals()).toEqual([]);
    }
  });

  test("a hello with no capabilities field at all is also unsupported, never a crash", async () => {
    const { control, recorder } = buildExplicit();
    const outcome = await recorder.start(Promise.resolve<HelloInfo>({}));
    expect(outcome).toBe("not-started");
    expect(recorder.startFailure).toEqual({ kind: "unsupported" });
    expect(control.signals()).toEqual([]);
  });

  test("no hello by the attach deadline: not-started, no control signals", async () => {
    const { control, clock, recorder } = buildExplicit();
    const started = recorder.start(new Promise<HelloInfo>(() => {}));
    await flush();
    expect(control.signals()).toEqual([]);
    clock.fire(ATTACH_GRACE_MS);
    expect(await outcomeOf(started)).toBe("not-started");
    expect(recorder.startFailure).toEqual({ kind: "no-hello" });
    expect(control.signals()).toEqual([]);
  });

  test("an ordinary control error is reported verbatim and the outcome is not-started", async () => {
    const { control, reports, recorder } = buildExplicit();
    control.auto = false;
    const started = recorder.start(Promise.resolve<HelloInfo>({ capabilities: ASSISTED_CAPABILITIES }));
    await flush();
    const controlError = { status: "error" as const, message: "shorthand exited unexpectedly" };
    expect(control.release(controlError)).toBe(ASSISTED_START);
    expect(await outcomeOf(started)).toBe("not-started");
    // Not a synthesized reason: the ordinary control-failure report already said exactly what
    // went wrong, and a second, generic notice on top of that would only be noise.
    expect(recorder.startFailure).toBeUndefined();
    expect(reports.at(-1)).toEqual({ phase: "start", result: controlError });
  });

  /**
   * A `refused` record gives the real reason instead of leaving it to a timeout to guess at.
   * Covers all three of `shorthand-core`'s `KNOWN_REFUSAL_REASONS`, plus a value this build
   * does not recognize — FOLLOW_STREAM.md is explicit that `reason` is not a closed union, so
   * an unrecognized value must still surface, verbatim, rather than fail to parse.
   */
  test("a refusal surfaces as a distinguishable not-started, whatever its reason", async () => {
    for (const reason of ["busy", "mode-disabled", "publication-disabled", "some-future-reason"]) {
      const { control, recorder } = buildExplicit();
      const started = recorder.start(Promise.resolve<HelloInfo>({ capabilities: ASSISTED_CAPABILITIES }));
      await flush();
      recorder.observe({ t: "refused", mode: "assisted-notes", reason });
      expect(await outcomeOf(started)).toBe("not-started");
      expect(recorder.startFailure).toEqual({ kind: "refused", reason });
      // A refusal is definitive; nothing more is sent chasing it.
      expect(control.signals()).toEqual([ASSISTED_START]);
    }
  });

  test("a refusal for a different mode is not evidence about this recorder's own start", async () => {
    const { control, recorder } = buildExplicit();
    const started = recorder.start(Promise.resolve<HelloInfo>({ capabilities: ASSISTED_CAPABILITIES }));
    await flush();
    // Some other caller's meeting start was refused; ours is still pending.
    recorder.observe({ t: "refused", mode: "meeting", reason: "busy" });
    expect(await outcomeOf(started.then(() => "settled" as const))).toBe("still-waiting");
    recorder.observe({ t: "refused", mode: "assisted-notes", reason: "busy" });
    expect(await outcomeOf(started)).toBe("not-started");
    expect(recorder.startFailure).toEqual({ kind: "refused", reason: "busy" });
    expect(control.signals()).toEqual([ASSISTED_START]);
  });

  test("start_failed surfaces both its code and message", async () => {
    const { control, recorder } = buildExplicit();
    const started = recorder.start(Promise.resolve<HelloInfo>({ capabilities: ASSISTED_CAPABILITIES }));
    await flush();
    recorder.observe({
      t: "start_failed",
      mode: "assisted-notes",
      code: "no-input-device",
      message: "No input device found",
    });
    expect(await outcomeOf(started)).toBe("not-started");
    expect(recorder.startFailure).toEqual({
      kind: "start-failed",
      code: "no-input-device",
      message: "No input device found",
    });
    expect(control.signals()).toEqual([ASSISTED_START]);
  });

  // An app old enough to predate the `start-failed-code` capability sends `start_failed` with
  // no `code` at all (FOLLOW_STREAM.md) — that absence must reach `RecorderStartFailure` as
  // `undefined`, not a guessed or defaulted value.
  test("start_failed with no code still surfaces its message", async () => {
    const { control, recorder } = buildExplicit();
    const started = recorder.start(Promise.resolve<HelloInfo>({ capabilities: ASSISTED_CAPABILITIES }));
    await flush();
    recorder.observe({ t: "start_failed", mode: "assisted-notes", message: "no input device" });
    expect(await outcomeOf(started)).toBe("not-started");
    expect(recorder.startFailure).toEqual({ kind: "start-failed", message: "no input device" });
    expect(control.signals()).toEqual([ASSISTED_START]);
  });

  /**
   * P2. The same silent-drop gap `#beginWaiters` has (see "a begin that arrives while the
   * start child is still exiting" above): `#send()` only resolves on the forwarding child's
   * exit, and Shorthand can refuse the request before that exit. `#refusalWaiters` is not
   * registered until the race loop starts, so a `refused` landing in this window used to have
   * nowhere to land — the caller was told `start-timeout` ("Shorthand never explained why")
   * instead of the real, actionable reason.
   */
  test("a refusal that arrives while the start child is still exiting still surfaces its reason", async () => {
    for (const reason of ["busy", "mode-disabled", "publication-disabled"]) {
      const { control, recorder } = buildExplicit();
      control.auto = false;
      const started = recorder.start(Promise.resolve<HelloInfo>({ capabilities: ASSISTED_CAPABILITIES }));
      await flush();
      // The start signal is spawned and still in flight; Shorthand has already refused it.
      recorder.observe({ t: "refused", mode: "assisted-notes", reason });
      expect(control.release()).toBe(ASSISTED_START);
      expect(await outcomeOf(started)).toBe("not-started");
      expect(recorder.startFailure).toEqual({ kind: "refused", reason });
      expect(control.signals()).toEqual([ASSISTED_START]);
    }
  });

  test("a start_failed that arrives while the start child is still exiting still surfaces its message", async () => {
    const { control, recorder } = buildExplicit();
    control.auto = false;
    const started = recorder.start(Promise.resolve<HelloInfo>({ capabilities: ASSISTED_CAPABILITIES }));
    await flush();
    recorder.observe({ t: "start_failed", mode: "assisted-notes", message: "no input device" });
    expect(control.release()).toBe(ASSISTED_START);
    expect(await outcomeOf(started)).toBe("not-started");
    expect(recorder.startFailure).toEqual({ kind: "start-failed", message: "no input device" });
    expect(control.signals()).toEqual([ASSISTED_START]);
  });

  /**
   * The staleness trap the sequence-number guard exists for: a reason recorded during an
   * earlier capture on this same recorder must not be replayed as a later capture's answer.
   * Without the snapshot-and-compare, checking `#lastRefusalReason` directly would find the
   * leftover value from the first attempt and report the second as refused before it was ever
   * given a chance to be answered.
   */
  test("a refusal recorded during an earlier capture is not consumed by a later one", async () => {
    const { recorder } = buildExplicit();
    const firstStart = recorder.start(Promise.resolve<HelloInfo>({ capabilities: ASSISTED_CAPABILITIES }));
    await flush();
    recorder.observe({ t: "refused", mode: "assisted-notes", reason: "busy" });
    expect(await outcomeOf(firstStart)).toBe("not-started");
    expect(recorder.startFailure).toEqual({ kind: "refused", reason: "busy" });

    // A later capture, with nothing refusing it this time. The stale reason above must not
    // leak in as an immediate, false refusal.
    const secondStart = recorder.start(Promise.resolve<HelloInfo>({ capabilities: ASSISTED_CAPABILITIES }));
    await flush();
    expect(await outcomeOf(secondStart.then(() => "settled" as const))).toBe("still-waiting");
    recorder.observe({ t: "begin", session: 9, mode: "assisted-notes" });
    expect(await outcomeOf(secondStart)).toBe("started");
    expect(recorder.startFailure).toBeUndefined();
  });

  test("a start_failed recorded during an earlier capture is not consumed by a later one", async () => {
    const { recorder } = buildExplicit();
    const firstStart = recorder.start(Promise.resolve<HelloInfo>({ capabilities: ASSISTED_CAPABILITIES }));
    await flush();
    recorder.observe({ t: "start_failed", mode: "assisted-notes", message: "no input device" });
    expect(await outcomeOf(firstStart)).toBe("not-started");
    expect(recorder.startFailure).toEqual({ kind: "start-failed", message: "no input device" });

    const secondStart = recorder.start(Promise.resolve<HelloInfo>({ capabilities: ASSISTED_CAPABILITIES }));
    await flush();
    expect(await outcomeOf(secondStart.then(() => "settled" as const))).toBe("still-waiting");
    recorder.observe({ t: "begin", session: 9, mode: "assisted-notes" });
    expect(await outcomeOf(secondStart)).toBe("started");
    expect(recorder.startFailure).toBeUndefined();
  });

  test("the backstop timeout still fires when the app says nothing at all", async () => {
    const { control, clock, recorder } = buildExplicit();
    const started = recorder.start(Promise.resolve<HelloInfo>({ capabilities: ASSISTED_CAPABILITIES }));
    await flush();
    expect(control.signals()).toEqual([ASSISTED_START]);
    clock.fire(START_ACK_MS);
    expect(await outcomeOf(started)).toBe("not-started");
    expect(recorder.startFailure).toEqual({ kind: "start-timeout" });
    // A stop backstop, idempotent and harmless either way — never a second start, which could
    // race a merely-late reply to the first.
    expect(control.signals()).toEqual([ASSISTED_START, ASSISTED_STOP]);
    expect(recorder.mayBeRecording).toBe(false);
  });

  test("a begin just before the deadline resolves started, with no backstop stop", async () => {
    const { control, recorder } = buildExplicit();
    const started = recorder.start(Promise.resolve<HelloInfo>({ capabilities: ASSISTED_CAPABILITIES }));
    await flush();
    recorder.observe({ t: "begin", session: 1 });
    expect(await outcomeOf(started)).toBe("started");
    expect(control.signals()).toEqual([ASSISTED_START]);
  });

  test("a stop during the acknowledgement wait recalls at once via the stop signal and resolves stopped", async () => {
    const { control, recorder } = buildExplicit();
    const started = recorder.start(Promise.resolve<HelloInfo>({ capabilities: ASSISTED_CAPABILITIES }));
    await flush();
    expect(control.signals()).toEqual([ASSISTED_START]);
    // Reacts immediately rather than waiting out the whole acknowledgement budget: this is the
    // one wait `requestStop()` has to interrupt directly, because it is what is being awaited.
    recorder.requestStop();
    expect(await outcomeOf(started)).toBe("stopped");
    expect(control.signals()).toEqual([ASSISTED_START, ASSISTED_STOP]);
  });

  /**
   * `stop-assisted-notes` is documented idempotent (FOLLOW_STREAM.md's table): a no-op against
   * an idle Shorthand, never able to start one by mistake the way a toggle could. Calling
   * `stop()` on a recorder that never started must therefore be safe without ever sending the
   * start signal.
   */
  test("a stop against an idle app is a safe no-op that does not start a recording", async () => {
    const { control, recorder } = buildExplicit();
    const outcome = await recorder.stop();
    expect(outcome).toBe("no-session");
    expect(control.signals()).toEqual([ASSISTED_STOP]);
    expect(control.signals()).not.toContain(ASSISTED_START);
  });

  test("Meeting takes the same contract, with its own signals", async () => {
    const { control, recorder } = build();
    const started = recorder.start(meetingHello());
    await flush();
    expect(control.signals()).toEqual([MEETING_START]);
    recorder.observe({ t: "begin", session: 1, mode: "meeting" });
    expect(await outcomeOf(started)).toBe("started");
    expect(recorder.startFailure).toBeUndefined();
  });
});

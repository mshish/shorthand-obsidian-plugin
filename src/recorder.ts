import type { ControlResult, ControlSignal } from "shorthand-core";

/**
 * The recorder-driving policy, extracted from the plugin so it can be tested without
 * Obsidian and without spawning anything. It owns three things main.ts must not have to
 * reason about at each call site:
 *
 * - the *order* control signals reach Handy, including recalling a start sequence that a
 *   stop request overtook (a spawned process cannot be un-spawned, so the only cure is to
 *   sequence a `--cancel` after it);
 * - what the plugin believes Handy's recorder is doing, derived only from records the
 *   plugin itself observed — never from `StreamClient`'s private session bookkeeping,
 *   which a reconnect silently clears;
 * - waiting for the record that proves a requested finalize actually landed, before
 *   anything tears the follower down.
 *
 * It deliberately depends on nothing concrete: a control-shaped object, a delay function,
 * and a report callback.
 */

/** The `HandyControl` surface this module uses, and all of it. */
export type ControlLike = {
  send(signal: ControlSignal): Promise<ControlResult>;
  sendDetached(signal: ControlSignal): void;
};

/**
 * Which sequence a control signal belonged to. The same `not-running` result means
 * something different on each of them, so the phrasing is the caller's decision, not
 * this module's.
 */
export type RecorderPhase = "start" | "recall" | "finalize" | "backstop";

export type RecorderReport = (phase: RecorderPhase, result: ControlResult) => void;

export type RecorderStopOutcome =
  /** Handy was driven to idle by the start sequence's own recall; nothing left to do. */
  | "idle"
  /** Handy is known not to be running, so no signal was sent at all. */
  | "handy-down"
  /** Nothing was believed to be recording, so no toggle was sent. */
  | "no-session"
  /** The finalize toggle never reached Handy. */
  | "not-finalized"
  /** The finalize toggle landed and Handy's terminal record arrived. */
  | "finalized"
  /** The finalize toggle landed but the stream ended before any record could arrive. */
  | "abandoned"
  /** The finalize toggle landed but no terminal record arrived within the budget. */
  | "timed-out"
  /**
   * The finalize toggle landed and Handy answered it by *starting* a recording: it was idle,
   * so the recording this capture was following was already gone. Nothing will finalize.
   */
  | "restarted";

export type RecorderStopOptions = {
  /**
   * Resolves when the transcript stream is gone for good. Without it a follower that died
   * during the finalize wait would still cost the caller the whole budget waiting for a
   * record nobody can deliver any more.
   */
  abandoned?: Promise<unknown>;
  /**
   * True only when Handy is *known* not to be running — never merely suspected. A control
   * spawn with no Handy to forward to becomes the Handy app starting up, so this suppresses
   * the finalize toggle entirely.
   */
  handyDown?: boolean;
};

export type RecorderOptions = {
  control: ControlLike;
  /** Captured once per capture: which toggle this capture started the recording with. */
  recordingSignal: ControlSignal;
  report: RecorderReport;
  /**
   * How long to wait for Handy's terminal record after asking it to finalize. Should match
   * the follower's own drain budget — this wait replaces it, it does not precede it.
   */
  finalizeTimeoutMs: number;
  /**
   * How long the start sequence waits for the follower to attach before signalling anyway.
   * A late recording beats a recording whose `begin` nobody saw.
   */
  attachGraceMs: number;
  /**
   * How long a stop waits for the `begin` of a recording this capture just started. Covers
   * only the gap between the start toggle landing and Handy announcing the session.
   */
  beginGraceMs: number;
  /** Injectable clock; the default is the real one. */
  delay?: (ms: number) => Promise<void>;
};

/**
 * The subset of a wire record this module cares about. `session` is what makes the previous
 * recording's records distinguishable from this capture's — without it, the `cancel` Handy
 * emits for the recording the start sequence's own `--cancel` just ended reads exactly like
 * this capture's recording ending.
 */
type ObservedRecord = { t: string; session?: number };

/** Records that end a session. Handy sends exactly one of these per recording. */
const TERMINAL_RECORDS = new Set(["final", "no_speech", "cancel", "error"]);

export class HandyRecorder {
  readonly #control: ControlLike;
  readonly #recordingSignal: ControlSignal;
  readonly #report: RecorderReport;
  readonly #finalizeTimeoutMs: number;
  readonly #attachGraceMs: number;
  readonly #beginGraceMs: number;
  readonly #delay: (ms: number) => Promise<void>;

  /** True between the first record of a session and whichever terminal record ends it. */
  #sessionLive = false;
  /**
   * Handy's id for the session `#sessionLive` refers to, so a terminal record can be matched
   * to the session it actually ends. `undefined` while no session is identified.
   */
  #followedSession: number | undefined = undefined;
  /**
   * True once any session-scoped record has been observed, ever. Only meaningful as
   * evidence that Handy was up and running at some point during this capture.
   */
  #observedSession = false;
  /**
   * True once this capture's start toggle reached Handy and until the session it started
   * announces itself. Handy is recording during that window even though no record says so
   * yet, and a stop landing inside it must not conclude "nothing to finalize". Only a
   * session-scoped record from the new session, or a confirmed `--cancel`, clears it — a
   * terminal record arriving inside the window is the *previous* recording ending.
   */
  #expectingSession = false;
  /** True only while the last signal Handy received was a `--cancel` that reached it. */
  #idleGuaranteed = false;
  /**
   * True once any control signal was confirmed `sent`. `HandyControl.send()` reports `sent`
   * only when the control child exited 0, and it only exits at all because
   * `tauri_plugin_single_instance` forwarded the flag to an *already running* Handy — a spawn
   * with no Handy to forward to becomes the app starting up and never reports `sent`. So this
   * is the strongest evidence the plugin ever gets that Handy was up: stronger than the
   * follower's `hello`, which only proves the follower reached it.
   */
  #controlConfirmed = false;
  /** True once the follower has said `hello` at least once. */
  #attachedEver = false;
  /**
   * True once the follower has said `hello` a *second* time, i.e. its connection to Handy was
   * replaced. See `noteAttached()` for why that makes session ids untrustworthy.
   */
  #reattached = false;
  #stopping = false;
  #startSequence: Promise<void> = Promise.resolve();
  /** The session `stop()` is waiting on a terminal record for, while it is waiting. */
  #finalizingSession: number | undefined = undefined;
  readonly #beginWaiters = new Set<() => void>();
  readonly #terminalWaiters = new Set<() => void>();
  readonly #usurpedWaiters = new Set<() => void>();

  constructor(options: RecorderOptions) {
    this.#control = options.control;
    this.#recordingSignal = options.recordingSignal;
    this.#report = options.report;
    this.#finalizeTimeoutMs = options.finalizeTimeoutMs;
    this.#attachGraceMs = options.attachGraceMs;
    this.#beginGraceMs = options.beginGraceMs;
    this.#delay = options.delay ?? realDelay;
  }

  /** True while a recording this capture started is believed to be running. */
  get mayBeRecording(): boolean {
    return this.#sessionLive || this.#expectingSession;
  }

  /** Exposed for the plugin's status reporting and for tests; never written from outside. */
  get sessionLive(): boolean {
    return this.#sessionLive;
  }

  /**
   * True once any session-scoped record has been seen. The follower's exit code 2 means
   * *either* "Handy is not running" *or* "live transcript streaming is off / the follower
   * slot was taken" — indistinguishable by the code alone. Having seen Handy narrate a
   * session rules out the first reading, and the caller needs that to decide whether a
   * control spawn would end a recording or launch the app.
   */
  get observedSession(): boolean {
    return this.#observedSession;
  }

  /**
   * Whether any control signal was ever confirmed delivered to a running Handy. Exposed
   * because it is the caller's strongest evidence that Handy was up — see the field, and
   * `handyProvenDown()`, which consumes it.
   */
  get controlConfirmed(): boolean {
    return this.#controlConfirmed;
  }

  /**
   * The follower's `hello`, i.e. it has just connected to Handy. Called for every one,
   * reconnects included: `StreamClient` spawns a fresh follower per reconnect attempt and
   * each one says `hello` again.
   *
   * A *second* `hello` means the previous connection to Handy died, and one of the ways that
   * happens is Handy itself exiting. Handy's session counter is process-local and restarts at
   * 1, so from that point on an id is no longer a stable name for a recording: a restarted
   * Handy will happily reuse ids this capture has already followed. The rule that matters is
   * the one-directional one — an id *below* the one being followed can only come from a
   * different Handy process, which means the recording this capture was following died with
   * the old one.
   *
   * `hello` deliberately does not clear `#sessionLive` on its own. An ordinary mid-recording
   * reconnect produces exactly the same `hello`, and Handy does not resend `begin` on
   * reattach; dropping the belief there is what previously made the plugin skip the finalize
   * and cancel away a live meeting's corrected transcript.
   */
  noteAttached(): void {
    if (this.#attachedEver) this.#reattached = true;
    this.#attachedEver = true;
  }

  /**
   * Every *session-scoped* record the follower delivers, in order. This is the only source of
   * session state: `StreamClient` clears its own `#activeSessions` on every disconnect and
   * repopulates it only from a fresh `begin`, which Handy does not resend when it resumes
   * a session after a reattach. A plugin that trusted that bookkeeping would conclude
   * "nothing is recording" moments after asking Handy to finalize.
   *
   * Session-scoped is a precondition, not a filter: `hello` belongs to `noteAttached()`, and
   * a connection-level `error` (the only other session-less record Handy emits) is a fault of
   * the transcript channel, not a statement about the recorder — `StreamClient` routes it to
   * `connectionError`, never to `event`. The guard below fails safe rather than trusting that
   * routing to stay put: a session-less record reaching here would otherwise claim "Handy was
   * heard narrating a session" and, if it happened to be an `error`, clear a live session —
   * a silently skipped finalize, which is precisely the bug class this module exists for.
   */
  observe(record: ObservedRecord): void {
    if (record.session === undefined) return;
    const terminal = TERMINAL_RECORDS.has(record.t);
    this.#observedSession = true;

    if (!terminal) {
      // *Any* non-terminal session record proves a recording is running right now, `partial`
      // as much as `begin`. That matters because the start sequence deliberately proceeds
      // when the follower has not attached within the grace, and Handy does not resend
      // `begin` to a follower that attached late or reattached — so a whole meeting can
      // stream in as partials with its `begin` never observed by anyone. Trusting only
      // `begin` made the plugin conclude "nothing is recording" while it was ingesting that
      // very recording's text, send no finalize, and cancel away its `final`.
      if (this.#finalizingSession !== undefined && record.session !== this.#finalizingSession) {
        // A different session starting while this one is being finalized is Handy answering
        // the finalize toggle by *starting* a recording rather than ending one: it was idle
        // when the toggle landed, because it restarted while the follower was away and the
        // recording being followed died with the old process. The terminal record being
        // waited for can never arrive now, and sitting out the whole finalize budget with a
        // live microphone is the failure this module exists to prevent — so stop waiting and
        // let the caller's `--cancel` backstop end it.
        resolveAll(this.#usurpedWaiters);
      }
      this.#sessionLive = true;
      this.#followedSession = record.session;
      this.#expectingSession = false;
      // A recording is running, so whatever cancel preceded it no longer describes Handy.
      this.#idleGuaranteed = false;
      resolveAll(this.#beginWaiters);
      return;
    }
    if (!this.#endsFollowedSession(record)) return;
    this.#sessionLive = false;
    this.#followedSession = undefined;
    // A stop waiting for the session to announce itself must not outlive that session.
    resolveAll(this.#beginWaiters);
    resolveAll(this.#terminalWaiters);
  }

  /**
   * Whether a terminal record ends the recording this capture is responsible for.
   *
   * While `#expectingSession` is set the answer is always no: the start sequence's own
   * `--cancel` makes Handy emit a terminal record for the recording it just ended, and that
   * record can land *after* the start toggle was sent. This capture's own session announces
   * itself first — with `begin`, or with a `partial` when `begin` was missed — so a terminal
   * record arriving before any of that belongs to the previous recording. Erring the other
   * way discarded a live recording; erring this way at worst leaves the caller believing
   * something might still be running, which its `--cancel` backstop settles safely.
   *
   * `#followedSession` is set exactly when `#sessionLive` is, so the second guard is an
   * invariant check: with nothing followed there is no session of ours for a terminal record
   * to end, and the answer cannot be observed either way.
   */
  #endsFollowedSession(record: ObservedRecord): boolean {
    if (this.#expectingSession) return false;
    if (this.#followedSession === undefined || record.session === undefined) return false;
    if (record.session === this.#followedSession) return true;
    // Session ids are process-local and restart at 1. Before any reattach a mismatched id is
    // simply another session of the same Handy (typically the previous recording ending late)
    // and means nothing about ours. Once the follower has reconnected, a *lower* id can only
    // have come from a different Handy process — so the recording we were following went with
    // the one that exited, and the belief must not carry across. Ending the belief is the safe
    // direction: it suppresses the finalize toggle, and a toggle against an idle Handy would
    // start a recording rather than end one.
    return this.#reattached && record.session < this.#followedSession;
  }

  /**
   * Drives Handy into recording from any prior state: `--cancel` always lands it in idle
   * and is a no-op when it already is, so the toggle that follows can only ever turn
   * recording *on*. The two must be sequential — fired together, the cancel could undo the
   * toggle it raced.
   *
   * `attached` resolves on the follower's `hello`. `client.start()` returns as soon as the
   * child process object exists, long before it has connected to Handy, and a `begin`
   * emitted before that attach is never observed by anyone.
   *
   * The returned promise is what makes a stop safe: it is stored, awaited by `stop()`, and
   * never rejects.
   */
  start(attached: Promise<void>): Promise<void> {
    this.#startSequence = this.#runStart(attached).catch((error: unknown) => {
      this.#report("start", { status: "error", message: errorMessage(error) });
    });
    return this.#startSequence;
  }

  async #runStart(attached: Promise<void>): Promise<void> {
    await Promise.race([attached, this.#delay(this.#attachGraceMs)]);
    // Before the first spawn a plain check is enough: nothing has been sent, so there is
    // nothing to recall and no state of Handy's this capture is responsible for.
    if (this.#stopping) return;
    if (!await this.#send("cancel", "start")) return;
    this.#markIdle();
    if (this.#stopping) return;
    if (await this.#send(this.#recordingSignal, "start")) {
      this.#expectingSession = true;
      this.#idleGuaranteed = false;
    }
    // The one check that cannot be a guard. A stop that arrived while that toggle was in
    // flight could not stop the spawn — the process was already on its way to Handy — so
    // the only way to end deterministically idle is to sequence a cancel *after* it. This
    // is also what heals the teardown paths, which cannot await anything.
    if (this.#stopping) await this.#recall();
  }

  /**
   * Flips the stop flag synchronously, so a start sequence already in flight sees it at
   * its next checkpoint even if the caller has not reached `stop()` yet.
   *
   * Synchronous *with the call site*, not merely "soon": on the stream-death path this runs
   * one microtask after the very resolution that unblocks the start sequence's attach race,
   * because `decoder.end()` flushes a buffered `hello` — and so `markAttached()` — before
   * `#emitSettled`. The race reaction is therefore queued ahead of `captureSettled`, and its
   * await-resumption reads this flag on the next hop. Deferring the write by even one
   * microtask lets that resumption see `false` and start a recording on a dead follower.
   */
  requestStop(): void {
    this.#stopping = true;
  }

  /**
   * Resolves once any in-flight start sequence has finished, including a recall it
   * sequenced behind its own toggle. Teardown paths that do not finalize still have to wait
   * for this before dropping the recorder: a start sequence whose recall is still in flight
   * outlives the capture that owns it, and its `--cancel` would otherwise land on whatever
   * the *next* capture had just started.
   */
  async whenStartSettled(): Promise<void> {
    await this.#startSequence;
  }

  /**
   * The full stop sequence. Never overlaps the start sequence: it awaits it first, which
   * is bounded (an attach grace plus at most two control timeouts) and cannot deadlock —
   * the start sequence awaits only the clock and the control channel, never this.
   *
   * `abandoned` resolves when the transcript stream is gone for good. Without it, a
   * follower that died during the wait would still cost the caller the whole budget
   * waiting for a record that can no longer be delivered by anyone.
   */
  async stop(options: RecorderStopOptions = {}): Promise<RecorderStopOutcome> {
    this.#stopping = true;
    await this.#startSequence;
    // Handy is gone, so there is no recording left to finalize and no signal worth sending:
    // a control spawn with nothing to forward to *becomes* the Handy app starting up, which
    // would answer a dead-Handy stop by launching Handy.
    if (options.handyDown === true) return "handy-down";
    // The start sequence recalled itself; Handy is idle and there is nothing to finalize.
    if (this.#idleGuaranteed) return "idle";
    if (!this.#sessionLive && this.#expectingSession) {
      // Mirror of the reconnect case: the start toggle landed but `begin` has not arrived
      // yet (~100ms). Waiting turns the race into an ordinary stop. If `begin` never comes
      // no toggle is sent — a toggle against an idle Handy would *start* a recording —
      // and the caller's cancel backstop is what still guarantees idle.
      await Promise.race([this.#waitFor(this.#beginWaiters), this.#delay(this.#beginGraceMs)]);
    }
    if (!this.#sessionLive) return "no-session";
    if (!await this.#send(this.#recordingSignal, "finalize")) return "not-finalized";
    // Handy has been asked to finalize; the `final` it is computing is the whole point of
    // the capture. Nothing may tear the follower down until the record that ends the
    // session arrives or the budget expires.
    this.#finalizingSession = this.#followedSession;
    const waits: Array<Promise<RecorderStopOutcome>> = [
      this.#waitFor(this.#terminalWaiters).then(() => "finalized" as const),
      this.#delay(this.#finalizeTimeoutMs).then(() => "timed-out" as const),
      // A recording *starting* is Handy's answer that it had nothing to finalize — see
      // `observe()`. Waiting out the full budget with a live microphone is strictly worse
      // than saying so at once.
      this.#waitFor(this.#usurpedWaiters).then(() => "restarted" as const),
    ];
    const { abandoned } = options;
    if (abandoned !== undefined) waits.push(abandoned.then(() => "abandoned" as const, () => "abandoned" as const));
    try {
      return await Promise.race(waits);
    } finally {
      this.#finalizingSession = undefined;
    }
  }

  /**
   * Synchronous teardown, for Obsidian's shutdown hooks, which do not await. `--cancel`
   * and never a toggle: a toggle would *start* a recording if Handy happened to be idle.
   * Detached because there is no result anyone could still act on.
   */
  teardown(): void {
    this.#stopping = true;
    this.#control.sendDetached("cancel");
  }

  /**
   * Last-resort cancel once nothing is left to finalize. It is fire-and-forget on purpose:
   * guaranteeing Handy is not left recording outranks everything else here, and `--cancel`
   * against an idle Handy is a no-op.
   */
  backstop(): void {
    void this.#send("cancel", "backstop");
  }

  async #recall(): Promise<void> {
    if (this.#idleGuaranteed) return;
    if (await this.#send("cancel", "recall")) this.#markIdle();
  }

  #markIdle(): void {
    this.#sessionLive = false;
    this.#followedSession = undefined;
    this.#expectingSession = false;
    this.#idleGuaranteed = true;
  }

  /**
   * Reports the outcome and answers only whether the signal reached Handy. The two-arm
   * `then` is load-bearing: a control failure must never throw out of, and so unwind, a
   * capture that is otherwise healthy — capture still works with Handy's own hotkey.
   */
  #send(signal: ControlSignal, phase: RecorderPhase): Promise<boolean> {
    let sending: Promise<ControlResult>;
    try {
      sending = this.#control.send(signal);
    } catch (error) {
      this.#report(phase, { status: "error", message: errorMessage(error) });
      return Promise.resolve(false);
    }
    return sending.then(
      (result) => {
        this.#report(phase, result);
        // `sent` is the one thing that proves Handy was running: the control child only
        // exits 0 because single-instance forwarding handed the flag to a live Handy.
        if (result.status === "sent") this.#controlConfirmed = true;
        return result.status === "sent";
      },
      (error: unknown) => {
        this.#report(phase, { status: "error", message: errorMessage(error) });
        return false;
      },
    );
  }

  #waitFor(waiters: Set<() => void>): Promise<void> {
    return new Promise<void>((resolveWaiter) => { waiters.add(resolveWaiter); });
  }
}

/** Everything the plugin knows about whether Handy was ever actually reached. */
export type HandyDownEvidence = {
  /** The follower's exit code, as the stream's own diagnosis reported it. */
  exitCode: number | null;
  /** Whether the follower's `hello` ever arrived, i.e. it really did connect to Handy. */
  helloEver: boolean;
  /** `HandyRecorder.observedSession` — whether Handy was ever heard narrating a session. */
  observedSession: boolean;
  /**
   * `HandyRecorder.controlConfirmed` — whether any control signal was ever confirmed
   * delivered to a *running* Handy. Unlike the other three this is not follower-derived.
   */
  controlConfirmed: boolean;
};

/**
 * Whether the follower's exit *proves* Handy is not running. Only that proof makes it safe
 * to suppress a control signal, because a control spawn with no Handy to forward to becomes
 * the Handy app starting up.
 *
 * Exit 2 alone proves nothing. The follower reports it both for "Handy is not running" and
 * for a live, recording Handy whose live transcript streaming was switched off, whose
 * follower slot was taken, or whose endpoint faulted — its own message says as much, and
 * connection-level failures are indistinguishable by the code. Reading exit 2 as proof
 * skipped the `--cancel` backstop against a Handy that was still recording, minutes into a
 * meeting: a hot mic, with the user told Handy was not running.
 *
 * So exit 2 counts only when *nothing* the plugin ever saw contradicts it. Three of the four
 * pieces of evidence are follower-derived — no `hello` ever, nothing heard from a session —
 * and those alone were not enough. A confirmed control signal is the fourth and the strongest:
 * `HandyControl.send()` reports `sent` only when the control child exited 0, which it does
 * only because single-instance forwarding handed the flag to an already-running Handy. That
 * reproduced as a hot mic: with live-transcript streaming switched off (or the follower slot
 * taken) the follower never says `hello`, never sees a session, and exits 2 — while the start
 * sequence has meanwhile driven a very much running Handy into recording, both signals
 * confirmed `sent`. Reading that exit as proof skipped the `--cancel` backstop and told the
 * user Handy was not running.
 *
 * Deliberate bias: any evidence at all that Handy was reached defeats exit 2. When in doubt,
 * fire the cancel — a redundant `--cancel` against a Handy that is down costs an unwanted app
 * launch; a skipped one against a live Handy leaves the microphone recording with nobody
 * following it.
 */
export function handyProvenDown(evidence: HandyDownEvidence): boolean {
  if (evidence.exitCode !== 2) return false;
  return !evidence.helloEver && !evidence.observedSession && !evidence.controlConfirmed;
}

function resolveAll(waiters: Set<() => void>): void {
  const pending = [...waiters];
  waiters.clear();
  for (const waiter of pending) waiter();
}

function realDelay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import type { ControlResult, ControlSignal } from "shorthand-core";

/**
 * The recorder-driving policy, extracted from the plugin so it can be tested without
 * Obsidian and without spawning anything. It owns three things main.ts must not have to
 * reason about at each call site:
 *
 * - the *order* control signals reach Shorthand, including recalling a start sequence that a
 *   stop request overtook (a spawned process cannot be un-spawned, so the only cure is to
 *   sequence a `--cancel` after it);
 * - what the plugin believes Shorthand's recorder is doing, derived only from records the
 *   plugin itself observed — never from `StreamClient`'s private session bookkeeping,
 *   which a reconnect silently clears;
 * - waiting for the record that proves a requested finalize actually landed, before
 *   anything tears the follower down.
 *
 * It deliberately depends on nothing concrete: a control-shaped object, a delay function,
 * and a report callback.
 */

/** The `ShorthandControl` surface this module uses, and all of it. */
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

/**
 * The outcome of a capture start. Meeting's call site ignores it, exactly as it ignored the
 * `void` this replaced. Assisted Notes awaits it, because a `sent` toggle is not proof of a
 * live recording the way it is for Meeting: Shorthand's disabled-mode refusal still exits the
 * forwarding process 0, and only the primary instance knows it declined.
 */
export type RecorderStartOutcome = "started" | "not-started" | "stopped";

/**
 * Why a capability-gated start resolved `"not-started"`, queried through `startFailure` after
 * `start()` settles. `start()`'s own return stays the plain three-value union above — Meeting
 * reads the same type and must not have to widen anything it does not use — so a caller that
 * needs to choose between three different remediation notices reads this instead.
 *
 * - `no-hello`: the follower never attached within the grace window, so there is no `hello` to
 *   check a capability against at all.
 * - `unsupported`: a `hello` arrived, but its `capabilities` did not name the one required —
 *   an app old enough to predate capability negotiation, most likely.
 * - `start-timeout`: the toggle was confirmed delivered, but no session it started ever
 *   announced itself within the acknowledgement budget — Shorthand's disabled-mode refusal,
 *   most likely, which still exits the forwarding process 0.
 *
 * Left `undefined` when `start()` returns `"not-started"` for an ordinary control failure
 * (`ShorthandControl.send()` itself reporting `not-running` or `error`): that case already has
 * a complete, specific message via the ordinary `report()` channel, and does not need a second.
 */
export type RecorderStartFailure = "no-hello" | "unsupported" | "start-timeout";

/** The subset of a `hello` record the capability gate cares about. */
export type HelloInfo = { capabilities?: string[] };

export type RecorderStopOutcome =
  /** Shorthand was driven to idle by the start sequence's own recall; nothing left to do. */
  | "idle"
  /** Shorthand is known not to be running, so no signal was sent at all. */
  | "shorthand-down"
  /** Nothing was believed to be recording, so no toggle was sent. */
  | "no-session"
  /** The finalize toggle never reached Shorthand. */
  | "not-finalized"
  /** The finalize toggle landed and Shorthand's terminal record arrived. */
  | "finalized"
  /** The finalize toggle landed but the stream ended before any record could arrive. */
  | "abandoned"
  /** The finalize toggle landed but no terminal record arrived within the budget. */
  | "timed-out"
  /**
   * The finalize toggle landed and Shorthand answered it by *starting* a recording: it was idle,
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
   * True only when Shorthand is *known* not to be running — never merely suspected. A control
   * spawn with no Shorthand to forward to becomes the Shorthand app starting up, so this suppresses
   * the finalize toggle entirely.
   */
  shorthandDown?: boolean;
};

export type RecorderOptions = {
  control: ControlLike;
  /** Captured once per capture: which toggle this capture started the recording with. */
  recordingSignal: ControlSignal;
  report: RecorderReport;
  /**
   * How long to wait for Shorthand's terminal record after asking it to finalize. Should match
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
   * only the gap between the start toggle landing and Shorthand announcing the session.
   */
  beginGraceMs: number;
  /**
   * A capability the attached Shorthand must have advertised in its `hello` before this
   * capture's `recordingSignal` is sent at all. Unset for Meeting, which any protocol-1 app
   * can serve. Set for Assisted Notes: an older app would otherwise parse-fail the flag with a
   * clap error the user sees mid-capture, which this turns into an upfront refusal instead —
   * see `RecorderStartFailure`.
   */
  requiredCapability?: string;
  /**
   * Only consulted when `requiredCapability` is set. How long to wait, once the toggle is
   * confirmed delivered, for the session it should have started to actually announce itself,
   * before concluding Shorthand refused the mode. Unset for Meeting: `ShorthandControl.send()`
   * reporting `sent` has always been treated as proof enough there, and this option exists
   * precisely because that proof is weaker for a mode Shorthand's primary instance can itself
   * decline after forwarding already succeeded.
   */
  startAcknowledgementMs?: number;
  /** Injectable clock; the default is the real one. */
  delay?: (ms: number) => Promise<void>;
};

/**
 * The subset of a wire record this module cares about. `session` is what makes the previous
 * recording's records distinguishable from this capture's — without it, the `cancel` Shorthand
 * emits for the recording the start sequence's own `--cancel` just ended reads exactly like
 * this capture's recording ending.
 */
type ObservedRecord = { t: string; session?: number };

/** Records that end a session. Shorthand sends exactly one of these per recording. */
const TERMINAL_RECORDS = new Set(["final", "no_speech", "cancel", "error"]);

export class ShorthandRecorder {
  readonly #control: ControlLike;
  readonly #recordingSignal: ControlSignal;
  readonly #report: RecorderReport;
  readonly #finalizeTimeoutMs: number;
  readonly #attachGraceMs: number;
  readonly #beginGraceMs: number;
  readonly #requiredCapability: string | undefined;
  readonly #startAcknowledgementMs: number | undefined;
  readonly #delay: (ms: number) => Promise<void>;

  /** True between the first record of a session and whichever terminal record ends it. */
  #sessionLive = false;
  /**
   * Shorthand's id for the session `#sessionLive` refers to, so a terminal record can be matched
   * to the session it actually ends. `undefined` while no session is identified.
   */
  #followedSession: number | undefined = undefined;
  /**
   * True once any session-scoped record has been observed, ever. Only meaningful as
   * evidence that Shorthand was up and running at some point during this capture.
   */
  #observedSession = false;
  /**
   * True once this capture's start toggle reached Shorthand and until the session it started
   * announces itself. Shorthand is recording during that window even though no record says so
   * yet, and a stop landing inside it must not conclude "nothing to finalize". Only a
   * session-scoped record from the new session, or a confirmed `--cancel`, clears it — a
   * terminal record arriving inside the window is the *previous* recording ending.
   */
  #expectingSession = false;
  /** True only while the last signal Shorthand received was a `--cancel` that reached it. */
  #idleGuaranteed = false;
  /**
   * True once any control signal was confirmed `sent`. `ShorthandControl.send()` reports `sent`
   * only when the control child exited 0, and it only exits at all because
   * `tauri_plugin_single_instance` forwarded the flag to an *already running* Shorthand — a spawn
   * with no Shorthand to forward to becomes the app starting up and never reports `sent`. So this
   * is the strongest evidence the plugin ever gets that Shorthand was up: stronger than the
   * follower's `hello`, which only proves the follower reached it.
   */
  #controlConfirmed = false;
  /** True once the follower has said `hello` at least once. */
  #attachedEver = false;
  /**
   * True once the follower has said `hello` a *second* time, i.e. its connection to Shorthand was
   * replaced. See `noteAttached()` for why that makes session ids untrustworthy.
   */
  #reattached = false;
  #stopping = false;
  #startSequence: Promise<void> = Promise.resolve();
  /** Set only by the capability-gated path, and only when its outcome is `"not-started"`. */
  #startFailure: RecorderStartFailure | undefined = undefined;
  /** The session `stop()` is waiting on a terminal record for, while it is waiting. */
  #finalizingSession: number | undefined = undefined;
  readonly #beginWaiters = new Set<() => void>();
  readonly #terminalWaiters = new Set<() => void>();
  readonly #usurpedWaiters = new Set<() => void>();
  /**
   * Resolved by `requestStop()`, so a start sequence blocked on the acknowledgement wait can
   * react to a stop immediately instead of only at its next `await`. Nothing else here needs
   * this: every other checkpoint is a synchronous flag read right before an `await`, but the
   * acknowledgement wait is itself the thing being awaited, so it has to be a race participant.
   */
  readonly #stopRequestWaiters = new Set<() => void>();

  constructor(options: RecorderOptions) {
    this.#control = options.control;
    this.#recordingSignal = options.recordingSignal;
    this.#report = options.report;
    this.#finalizeTimeoutMs = options.finalizeTimeoutMs;
    this.#attachGraceMs = options.attachGraceMs;
    this.#beginGraceMs = options.beginGraceMs;
    this.#requiredCapability = options.requiredCapability;
    this.#startAcknowledgementMs = options.startAcknowledgementMs;
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
   * *either* "Shorthand is not running" *or* "live transcript streaming is off / the follower
   * slot was taken" — indistinguishable by the code alone. Having seen Shorthand narrate a
   * session rules out the first reading, and the caller needs that to decide whether a
   * control spawn would end a recording or launch the app.
   */
  get observedSession(): boolean {
    return this.#observedSession;
  }

  /**
   * Whether any control signal was ever confirmed delivered to a running Shorthand. Exposed
   * because it is the caller's strongest evidence that Shorthand was up — see the field, and
   * `shorthandProvenDown()`, which consumes it.
   */
  get controlConfirmed(): boolean {
    return this.#controlConfirmed;
  }

  /**
   * Why the most recent capability-gated `start()` returned `"not-started"`, or `undefined` if
   * it did not, or resolved that way for an ordinary control failure instead. See
   * `RecorderStartFailure`.
   */
  get startFailure(): RecorderStartFailure | undefined {
    return this.#startFailure;
  }

  /**
   * The follower's `hello`, i.e. it has just connected to Shorthand. Called for every one,
   * reconnects included: `StreamClient` spawns a fresh follower per reconnect attempt and
   * each one says `hello` again.
   *
   * A *second* `hello` means the previous connection to Shorthand died, and one of the ways that
   * happens is Shorthand itself exiting. Shorthand's session counter is process-local and restarts at
   * 1, so from that point on an id is no longer a stable name for a recording: a restarted
   * Shorthand will happily reuse ids this capture has already followed. The rule that matters is
   * the one-directional one — an id *below* the one being followed can only come from a
   * different Shorthand process, which means the recording this capture was following died with
   * the old one.
   *
   * `hello` deliberately does not clear `#sessionLive` on its own. An ordinary mid-recording
   * reconnect produces exactly the same `hello`, and Shorthand does not resend `begin` on
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
   * repopulates it only from a fresh `begin`, which Shorthand does not resend when it resumes
   * a session after a reattach. A plugin that trusted that bookkeeping would conclude
   * "nothing is recording" moments after asking Shorthand to finalize.
   *
   * Session-scoped is a precondition, not a filter: `hello` belongs to `noteAttached()`, and
   * a connection-level `error` (the only other session-less record Shorthand emits) is a fault of
   * the transcript channel, not a statement about the recorder — `StreamClient` routes it to
   * `connectionError`, never to `event`. The guard below fails safe rather than trusting that
   * routing to stay put: a session-less record reaching here would otherwise claim "Shorthand was
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
      // when the follower has not attached within the grace, and Shorthand does not resend
      // `begin` to a follower that attached late or reattached — so a whole meeting can
      // stream in as partials with its `begin` never observed by anyone. Trusting only
      // `begin` made the plugin conclude "nothing is recording" while it was ingesting that
      // very recording's text, send no finalize, and cancel away its `final`.
      if (this.#finalizingSession !== undefined && record.session !== this.#finalizingSession) {
        // A different session starting while this one is being finalized is Shorthand answering
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
      // A recording is running, so whatever cancel preceded it no longer describes Shorthand.
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
   * `--cancel` makes Shorthand emit a terminal record for the recording it just ended, and that
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
    // simply another session of the same Shorthand (typically the previous recording ending late)
    // and means nothing about ours. Once the follower has reconnected, a *lower* id can only
    // have come from a different Shorthand process — so the recording we were following went with
    // the one that exited, and the belief must not carry across. Ending the belief is the safe
    // direction: it suppresses the finalize toggle, and a toggle against an idle Shorthand would
    // start a recording rather than end one.
    return this.#reattached && record.session < this.#followedSession;
  }

  /**
   * Drives Shorthand into recording from any prior state: `--cancel` always lands it in idle
   * and is a no-op when it already is, so the toggle that follows can only ever turn
   * recording *on*. The two must be sequential — fired together, the cancel could undo the
   * toggle it raced.
   *
   * `attached` resolves on the follower's `hello`. `client.start()` returns as soon as the
   * child process object exists, long before it has connected to Shorthand, and a `begin`
   * emitted before that attach is never observed by anyone.
   *
   * The returned promise is what makes a stop safe: it is stored, awaited by `stop()`, and
   * never rejects.
   */
  start(attached: Promise<HelloInfo | void>): Promise<RecorderStartOutcome> {
    const outcome = this.#runStart(attached).catch((error: unknown): RecorderStartOutcome => {
      this.#report("start", { status: "error", message: errorMessage(error) });
      return "not-started";
    });
    this.#startSequence = outcome.then(() => {});
    return outcome;
  }

  async #runStart(attached: Promise<HelloInfo | void>): Promise<RecorderStartOutcome> {
    this.#startFailure = undefined;
    let hello: HelloInfo | undefined;
    let gotHello = false;
    await Promise.race([
      attached.then((info) => { hello = info ?? undefined; gotHello = true; }),
      this.#delay(this.#attachGraceMs),
    ]);
    // Before the first spawn a plain check is enough: nothing has been sent, so there is
    // nothing to recall and no state of Shorthand's this capture is responsible for.
    if (this.#stopping) return "stopped";

    const requiredCapability = this.#requiredCapability;
    if (requiredCapability !== undefined) {
      // Unlike Meeting, which proceeds anyway on the theory that a recording nobody is
      // following still beats no recording, a capability-gated signal must not go out blind:
      // an older app that predates negotiation would refuse it with a clap error surfaced only
      // after the plugin had already entered capturing state — see AGENTS.md on install order.
      if (!gotHello) {
        this.#startFailure = "no-hello";
        return "not-started";
      }
      if (!(hello?.capabilities ?? []).includes(requiredCapability)) {
        this.#startFailure = "unsupported";
        return "not-started";
      }
    }

    if (!await this.#send("cancel", "start")) return "not-started";
    this.#markIdle();
    if (this.#stopping) return "stopped";
    const toggled = await this.#send(this.#recordingSignal, "start");
    if (toggled) {
      // Not unconditionally true. Shorthand announces the session when it acts on the toggle,
      // not when the forwarding process carrying it exits, so a `begin` can already have
      // arrived during the await above and set this false. Overwriting it here would claim a
      // session is still pending when the recorder is already following one.
      this.#expectingSession = !this.#sessionLive;
      this.#idleGuaranteed = false;
    }
    // The one check that cannot be a guard. A stop that arrived while that toggle was in
    // flight could not stop the spawn — the process was already on its way to Shorthand — so
    // the only way to end deterministically idle is to sequence a cancel *after* it. This
    // is also what heals the teardown paths, which cannot await anything.
    if (this.#stopping) {
      await this.#recall();
      return "stopped";
    }
    if (!toggled) return "not-started";
    if (this.#startAcknowledgementMs === undefined) return "started";

    // The session can announce itself before the toggle's forwarding process exits, and
    // `#send()` above only resolves on that exit. `#beginWaiters` was therefore still empty
    // when the record arrived, and `resolveAll` on an empty set drops the wakeup — so waiting
    // now would sit out the whole budget for a `begin` that has already gone by, then report
    // `start-timeout` and tell the user to enable a mode that was never disabled.
    // `#markIdle()` cleared this a few lines above, so a live session here is this toggle's.
    if (this.#sessionLive) return "started";

    // The toggle landed, but for a capability-gated signal that only proves delivery, not
    // acceptance: Shorthand's disabled-mode refusal still exits the forwarding process 0, and
    // only the primary instance knows it declined. Wait for the session it should have started
    // to actually announce itself before believing it.
    const acknowledgement = await Promise.race([
      this.#waitFor(this.#beginWaiters).then(() => "ack" as const),
      this.#waitFor(this.#stopRequestWaiters).then(() => "stop" as const),
      this.#delay(this.#startAcknowledgementMs).then(() => "timeout" as const),
    ]);
    if (acknowledgement === "ack") return "started";
    if (acknowledgement === "stop") {
      await this.#recall();
      return "stopped";
    }
    // Timed out. Never a second toggle: if Shorthand started slowly after all, a toggle here
    // could turn that late recording off or on ambiguously, while cancel has only the one safe
    // direction.
    await this.#recall();
    this.#startFailure = "start-timeout";
    return "not-started";
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
    resolveAll(this.#stopRequestWaiters);
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
    // Shorthand is gone, so there is no recording left to finalize and no signal worth sending:
    // a control spawn with nothing to forward to *becomes* the Shorthand app starting up, which
    // would answer a dead-Shorthand stop by launching Shorthand.
    if (options.shorthandDown === true) return "shorthand-down";
    // The start sequence recalled itself; Shorthand is idle and there is nothing to finalize.
    if (this.#idleGuaranteed) return "idle";
    if (!this.#sessionLive && this.#expectingSession) {
      // Mirror of the reconnect case: the start toggle landed but `begin` has not arrived
      // yet (~100ms). Waiting turns the race into an ordinary stop. If `begin` never comes
      // no toggle is sent — a toggle against an idle Shorthand would *start* a recording —
      // and the caller's cancel backstop is what still guarantees idle.
      await Promise.race([this.#waitFor(this.#beginWaiters), this.#delay(this.#beginGraceMs)]);
    }
    if (!this.#sessionLive) return "no-session";
    if (!await this.#send(this.#recordingSignal, "finalize")) return "not-finalized";
    // Shorthand has been asked to finalize; the `final` it is computing is the whole point of
    // the capture. Nothing may tear the follower down until the record that ends the
    // session arrives or the budget expires.
    this.#finalizingSession = this.#followedSession;
    const waits: Array<Promise<RecorderStopOutcome>> = [
      this.#waitFor(this.#terminalWaiters).then(() => "finalized" as const),
      this.#delay(this.#finalizeTimeoutMs).then(() => "timed-out" as const),
      // A recording *starting* is Shorthand's answer that it had nothing to finalize — see
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
   * and never a toggle: a toggle would *start* a recording if Shorthand happened to be idle.
   * Detached because there is no result anyone could still act on.
   */
  teardown(): void {
    this.#stopping = true;
    this.#control.sendDetached("cancel");
  }

  /**
   * Last-resort cancel once nothing is left to finalize. It is fire-and-forget on purpose:
   * guaranteeing Shorthand is not left recording outranks everything else here, and `--cancel`
   * against an idle Shorthand is a no-op.
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
   * Reports the outcome and answers only whether the signal reached Shorthand. The two-arm
   * `then` is load-bearing: a control failure must never throw out of, and so unwind, a
   * capture that is otherwise healthy — capture still works with Shorthand's own hotkey.
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
        // `sent` is the one thing that proves Shorthand was running: the control child only
        // exits 0 because single-instance forwarding handed the flag to a live Shorthand.
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

/** Everything the plugin knows about whether Shorthand was ever actually reached. */
export type ShorthandDownEvidence = {
  /** The follower's exit code, as the stream's own diagnosis reported it. */
  exitCode: number | null;
  /** Whether the follower's `hello` ever arrived, i.e. it really did connect to Shorthand. */
  helloEver: boolean;
  /** `ShorthandRecorder.observedSession` — whether Shorthand was ever heard narrating a session. */
  observedSession: boolean;
  /**
   * `ShorthandRecorder.controlConfirmed` — whether any control signal was ever confirmed
   * delivered to a *running* Shorthand. Unlike the other three this is not follower-derived.
   */
  controlConfirmed: boolean;
};

/**
 * Whether the follower's exit *proves* Shorthand is not running. Only that proof makes it safe
 * to suppress a control signal, because a control spawn with no Shorthand to forward to becomes
 * the Shorthand app starting up.
 *
 * Exit 2 alone proves nothing. The follower reports it both for "Shorthand is not running" and
 * for a live, recording Shorthand whose live transcript streaming was switched off, whose
 * follower slot was taken, or whose endpoint faulted — its own message says as much, and
 * connection-level failures are indistinguishable by the code. Reading exit 2 as proof
 * skipped the `--cancel` backstop against a Shorthand that was still recording, minutes into a
 * meeting: a hot mic, with the user told Shorthand was not running.
 *
 * So exit 2 counts only when *nothing* the plugin ever saw contradicts it. Three of the four
 * pieces of evidence are follower-derived — no `hello` ever, nothing heard from a session —
 * and those alone were not enough. A confirmed control signal is the fourth and the strongest:
 * `ShorthandControl.send()` reports `sent` only when the control child exited 0, which it does
 * only because single-instance forwarding handed the flag to an already-running Shorthand. That
 * reproduced as a hot mic: with live-transcript streaming switched off (or the follower slot
 * taken) the follower never says `hello`, never sees a session, and exits 2 — while the start
 * sequence has meanwhile driven a very much running Shorthand into recording, both signals
 * confirmed `sent`. Reading that exit as proof skipped the `--cancel` backstop and told the
 * user Shorthand was not running.
 *
 * Deliberate bias: any evidence at all that Shorthand was reached defeats exit 2. When in doubt,
 * fire the cancel — a redundant `--cancel` against a Shorthand that is down costs an unwanted app
 * launch; a skipped one against a live Shorthand leaves the microphone recording with nobody
 * following it.
 */
export function shorthandProvenDown(evidence: ShorthandDownEvidence): boolean {
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

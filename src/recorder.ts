import type { BeginMode, CapturePhase, ControlResult, ControlSignal } from "shorthand-core";

/**
 * The recorder-driving policy, extracted from the plugin so it can be tested without
 * Obsidian and without spawning anything. It owns three things main.ts must not have to
 * reason about at each call site:
 *
 * - the *order* control signals reach Shorthand. Meeting's `toggle-transcription` has no
 *   explicit start/stop pair, so it still needs the disambiguating `--cancel`-then-toggle
 *   dance, including recalling a start sequence that a stop request overtook (a spawned
 *   process cannot be un-spawned, so the only cure is to sequence a `--cancel` after it).
 *   Assisted Notes' `start-assisted-notes`/`stop-assisted-notes` need none of that: both are
 *   idempotent (FOLLOW_STREAM.md), so a stop that overtakes a start simply sends the stop
 *   signal, and a retry of either can never fire the wrong edge — see `#runExplicitStart`;
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
 * `void` this replaced. Assisted Notes awaits it, because a `sent` signal is not proof of a
 * live recording the way it is for Meeting: the forwarding process exits 0 as soon as
 * `tauri_plugin_single_instance` hands the flag to a running Shorthand, before Shorthand has
 * evaluated it at all — so a live recording, a refusal (`refused`), and an accepted-but-failed
 * start (`start_failed`) are all still to come on the wire. See `RecorderStartFailure` for how
 * the caller tells those apart.
 */
export type RecorderStartOutcome = "started" | "not-started" | "stopped";

/**
 * How this recorder starts and stops a recording, and whether that is a toggle needing
 * disambiguation or the newer explicit pair that does not.
 *
 * - `toggle`: Meeting's `toggle-transcription`. No explicit start/stop pair exists for
 *   Meeting, so this still needs the `--cancel`-first dance (`#runToggleStart`) and
 *   proceeds without any capability gate — any protocol-1 app can serve it, on the theory
 *   that a recording nobody is following still beats no recording.
 * - `explicit`: Assisted Notes' `start-assisted-notes`/`stop-assisted-notes`. Both
 *   idempotent, so a stop that overtakes a start — or a retry of either — can never fire
 *   the wrong edge (`#runExplicitStart`). Gated on every one of `requiredCapabilities`
 *   before anything is sent; `mode` is what tells this recorder's own
 *   `refused`/`start_failed`/`begin` records apart from another mode's, on the one
 *   connection both can arrive on.
 */
export type RecorderSignals =
  | Readonly<{ kind: "toggle"; signal: ControlSignal }>
  | Readonly<{
      kind: "explicit";
      mode: BeginMode;
      start: ControlSignal;
      stop: ControlSignal;
      requiredCapabilities: readonly string[];
      /**
       * How long to wait, once `start` is confirmed delivered, for a `begin`, `refused` or
       * `start_failed` naming this recorder's own `mode` to arrive — see
       * `RecorderStartFailure`'s `start-timeout`. Only consulted when nothing at all shows
       * up in time; a real refusal or failure is reported the moment its record arrives,
       * never held for this budget to expire.
       */
      startAcknowledgementMs: number;
    }>;

type ExplicitSignals = Extract<RecorderSignals, { kind: "explicit" }>;

/**
 * Why a capability-gated (Assisted Notes only) `start()` resolved `"not-started"`, queried
 * through `startFailure` after `start()` settles. `start()`'s own return stays the plain
 * three-value union above — Meeting reads the same type and must not have to widen anything
 * it does not use — so a caller that needs to distinguish *why* reads this instead.
 *
 * - `no-hello`: the follower never attached within the grace window, so there is no `hello`
 *   to check a capability against at all.
 * - `unsupported`: a `hello` arrived, but its `capabilities` did not name every one of
 *   `requiredCapabilities` — an app old enough to predate the explicit start/stop pair,
 *   most likely.
 * - `refused`: Shorthand accepted delivery of `start-assisted-notes` and declined to act on
 *   it, and said why. `reason` is one of `shorthand-core`'s `KNOWN_REFUSAL_REASONS`
 *   (`busy`, `mode-disabled`, `publication-disabled`) when it is one of those, and a plain,
 *   unrecognized string otherwise — FOLLOW_STREAM.md is explicit that `reason` is not a
 *   closed union, and a caller must show an unrecognized value rather than fail to parse it.
 * - `start-failed`: the command was accepted and acted on, but the capture did not actually
 *   start — no input device, a denied microphone permission — with Shorthand's own
 *   explanation in `message` and, when the connected app supports `start-failed-code`
 *   (FOLLOW_STREAM.md), a stable machine-readable `code` a caller can branch on instead of
 *   matching the English text. `code` is one of `shorthand-core`'s `KNOWN_START_FAILURE_CODES`
 *   when it is one of those, and a plain, unrecognized string otherwise — same open-set
 *   handling as `refused`'s `reason` above — or `undefined` for an app old enough to predate
 *   the capability.
 * - `start-timeout`: Shorthand accepted delivery and then said nothing at all — no `begin`,
 *   no `refused`, no `start_failed` — within the acknowledgement budget. A backstop only:
 *   unlike before the explicit pair, this is no longer the primary way a refusal is
 *   detected, because a real refusal now arrives as its own record instead.
 *
 * Left `undefined` when `start()` returns `"not-started"` for an ordinary control failure
 * (`ShorthandControl.send()` itself reporting `not-running` or `error`): that case already has
 * a complete, specific message via the ordinary `report()` channel, and does not need a second.
 */
export type RecorderStartFailure =
  | Readonly<{ kind: "no-hello" }>
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{ kind: "refused"; reason: string }>
  | Readonly<{ kind: "start-failed"; message: string; code?: string }>
  | Readonly<{ kind: "start-timeout" }>;

/** The subset of a `hello` record the capability gate cares about. */
export type HelloInfo = { capabilities?: string[] };

export type RecorderStopOutcome =
  /** Shorthand was driven to idle by the start sequence's own recall; nothing left to do. */
  | "idle"
  /** Shorthand is known not to be running, so no signal was sent at all. */
  | "shorthand-down"
  /** Nothing was believed to be recording, so no finalize signal was sent. */
  | "no-session"
  /** The finalize signal never reached Shorthand. */
  | "not-finalized"
  /** The finalize signal landed and Shorthand's terminal record arrived. */
  | "finalized"
  /** The finalize signal landed but the stream ended before any record could arrive. */
  | "abandoned"
  /** The finalize signal landed but no terminal record arrived within the budget. */
  | "timed-out"
  /**
   * The finalize signal landed and Shorthand answered it by *starting* a recording: it was
   * idle, so the recording this capture was following was already gone. Nothing will finalize.
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
   * the finalize signal entirely.
   */
  shorthandDown?: boolean;
};

export type RecorderOptions = {
  control: ControlLike;
  /** Which signals this capture starts and stops the recording with — see `RecorderSignals`. */
  signals: RecorderSignals;
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
   * only the gap between the start signal landing and Shorthand announcing the session.
   */
  beginGraceMs: number;
  /** Injectable clock; the default is the real one. */
  delay?: (ms: number) => Promise<void>;
};

/**
 * The subset of a wire record this module cares about. `session` is what makes the previous
 * recording's records distinguishable from this capture's — without it, the `cancel` Shorthand
 * emits for the recording the toggle start sequence's own `--cancel` just ended reads exactly
 * like this capture's recording ending. `mode`, `reason`, `message` and `code` are only ever
 * present on `begin`/`refused`/`start_failed` (`code` on `start_failed` alone), and `phase`
 * only on `capture_state` — core's own parsing has already validated them by the time they
 * reach here.
 *
 * `publishing` is accepted for the same reason `session` is even where this module does not
 * read it: so a caller (a test, most concretely) can pass a faithful `capture_state` record.
 * This module does not branch on it directly — whether a `begin` for a reported session
 * actually arrives is what distinguishes a publishing capture from a non-publishing one in
 * practice, and that arrives, or never does, as its own separate record.
 */
type ObservedRecord = {
  t: string;
  session?: number;
  mode?: BeginMode;
  reason?: string;
  message?: string;
  code?: string;
  phase?: CapturePhase;
  publishing?: boolean;
};

/** Records that end a session. Shorthand sends exactly one of these per recording. */
const TERMINAL_RECORDS = new Set(["final", "no_speech", "cancel", "error"]);

export class ShorthandRecorder {
  readonly #control: ControlLike;
  readonly #signals: RecorderSignals;
  readonly #report: RecorderReport;
  readonly #finalizeTimeoutMs: number;
  readonly #attachGraceMs: number;
  readonly #beginGraceMs: number;
  readonly #delay: (ms: number) => Promise<void>;

  /** True between the first record of a session and whichever terminal record ends it. */
  #sessionLive = false;
  /**
   * Shorthand's id for the session `#sessionLive` refers to, so a terminal record can be matched
   * to the session it actually ends. `undefined` while no session is identified.
   */
  #followedSession: number | undefined = undefined;
  /**
   * The mode of the session `#followedSession` names, when known. Only ever set from a
   * `begin` record's own `mode` field, which is itself gated by its own capability
   * (`begin-mode`) — independent of anything an explicit-kind recorder requires — so this
   * can stay `undefined` even against a fully explicit-capable app. Exists to tell an
   * unrelated mode's `begin` apart from this recorder's own, on the one connection both can
   * arrive on; see `#runExplicitStart`.
   */
  #followedMode: BeginMode | undefined = undefined;
  /**
   * The mode `capture_state` most recently reported as recording or processing on this
   * connection, or `undefined` while it reported idle (or before any `capture_state` has
   * been observed at all — the two are indistinguishable and treated the same, since neither
   * is evidence of anything). `capture_state` is sent exactly once per connection, always
   * immediately after `hello` (FOLLOW_STREAM.md), so this is a single snapshot taken at
   * attach — not updated again until a reconnect's own fresh `hello` brings a fresh one.
   *
   * This is what `#runExplicitStart` reads to know, *before ever sending anything*, whether
   * its own mode is already recording — replacing an inference (`wasLiveBeforeSend` +
   * `#followedMode`) that existed only because the app had no way to report the state
   * directly, and that had a real gap: a non-publishing capture never emits a `begin` this
   * follower will ever see, so `#sessionLive`/`#followedMode` could never observe one at all.
   * A pre-existing, non-publishing capture of this recorder's own mode was therefore
   * indistinguishable from nothing running, which let the timeout backstop stop a recording
   * this call never started (P1) whenever that pre-existing capture happened not to be
   * publishing. `#sessionLive`/`#followedMode` remain the fallback for anything that changed
   * *after* this snapshot — see `#runExplicitStart`.
   */
  #reportedRecordingMode: BeginMode | undefined = undefined;
  /**
   * True once any session-scoped record has been observed, ever. Only meaningful as
   * evidence that Shorthand was up and running at some point during this capture.
   */
  #observedSession = false;
  /**
   * True once this capture's start signal reached Shorthand and until the session it started
   * announces itself. Shorthand is recording during that window even though no record says so
   * yet, and a stop landing inside it must not conclude "nothing to finalize". Only a
   * session-scoped record from the new session, or (toggle kind) a confirmed `--cancel`,
   * clears it — a terminal record arriving inside the window is the *previous* recording
   * ending.
   */
  #expectingSession = false;
  /**
   * True only while the last signal Shorthand received was a `--cancel` that reached it.
   * Toggle kind only: the explicit pair has no equivalent, because unlike `--cancel` neither
   * of its signals is a blind, unconditional "make this true" — `stop-assisted-notes` is safe
   * to send again on every `stop()` instead, so nothing needs to remember that it already ran
   * once. Always `false` for an explicit-kind recorder.
   */
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
  /** Set only by the capability-gated (explicit-kind) path, and only when its outcome is `"not-started"`. */
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
  /** Explicit kind only: resolved when a `refused` matching this recorder's own mode arrives. */
  readonly #refusalWaiters = new Set<() => void>();
  /** The `reason` off the `refused` record that last resolved `#refusalWaiters`. */
  #lastRefusalReason: string | undefined = undefined;
  /**
   * Incremented every time a `refused` matching this recorder's own mode arrives. `#send()`
   * resolves only on the forwarding child's exit, not on Shorthand's own reaction to the flag
   * it forwarded, so a refusal can land while a send is still in flight — before
   * `#refusalWaiters` has any waiter registered with it (that only happens once the wait loop
   * in `#runExplicitStart` starts) and before there is any other way to notice. `#runExplicitStart`
   * snapshots this count immediately before its own send and compares it after, so only a
   * refusal that arrived *during that exact send* trips the check — one recorded by an earlier
   * capture already advanced the count before the snapshot was taken, so it cannot be replayed
   * as this call's own answer.
   */
  #refusalSeq = 0;
  /** Explicit kind only: resolved when a `start_failed` matching this recorder's own mode arrives. */
  readonly #startFailedWaiters = new Set<() => void>();
  /** The `message` off the `start_failed` record that last resolved `#startFailedWaiters`. */
  #lastStartFailedMessage: string | undefined = undefined;
  /**
   * The `code` off that same record, when it carried one. Optional even when
   * `#lastStartFailedMessage` is set: an app old enough to predate `start-failed-code`
   * (FOLLOW_STREAM.md) sends `start_failed` with no `code` at all, and that absence must
   * reach `RecorderStartFailure` as `undefined` rather than a guessed value.
   */
  #lastStartFailedCode: string | undefined = undefined;
  /** Same purpose as `#refusalSeq`, for `start_failed`. */
  #startFailedSeq = 0;

  constructor(options: RecorderOptions) {
    this.#control = options.control;
    this.#signals = options.signals;
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
   * and cancel away a live meeting's corrected transcript. `capture_state`, on the other hand
   * — see `observe()` — is new information on a reattach and is trusted outright, because it
   * is a positive statement rather than an absence to interpret.
   */
  noteAttached(): void {
    if (this.#attachedEver) this.#reattached = true;
    this.#attachedEver = true;
  }

  /**
   * Every record the follower delivers, in order, except `hello` (routed to `noteAttached()`
   * instead) and a connection-level `error` (routed to `connectionError`, never here — see the
   * session-scoped guard below).
   *
   * Session-scoped records are the only source of session state: `StreamClient` clears its own
   * `#activeSessions` on every disconnect and repopulates it only from a fresh `begin`, which
   * Shorthand does not resend when it resumes a session after a reattach. A plugin that trusted
   * that bookkeeping would conclude "nothing is recording" moments after asking Shorthand to
   * finalize. `capture_state`, `refused` and `start_failed` are handled first, before the
   * session guard, because none of the three carries a plain, always-present `session` the way
   * `begin`/`partial`/etc. do — see FOLLOW_STREAM.md.
   */
  observe(record: ObservedRecord): void {
    if (record.t === "capture_state") {
      // capture_state supersedes the old `idle` record (FOLLOW_STREAM.md): still always the
      // first thing after `hello`, still never sent mid-connection, so it can still never
      // race a start this capture has already sent — the guarantee the old `idle` comment
      // relied on still holds, just for a richer record.
      if (record.phase === "idle") {
        // Positive proof nothing is capturing, as of *this* attach. On a fresh connection
        // this is merely confirmatory (`#sessionLive` already starts `false`); on a
        // *reattach* mid-capture it is new information this module used to have to
        // approximate from a session-id comparison (`#endsFollowedSession` below) — this
        // settles it outright for the one case it can: nothing at all is running right now.
        this.#sessionLive = false;
        this.#followedSession = undefined;
        this.#followedMode = undefined;
        this.#expectingSession = false;
        this.#reportedRecordingMode = undefined;
      } else {
        // New information `idle` never carried: which mode is already recording, reported
        // directly rather than left for `#runExplicitStart` to infer from an observed
        // `begin` — see `#reportedRecordingMode`'s own comment for why that inference had a
        // real gap. Recorded regardless of `publishing`: a non-publishing capture is still a
        // real one, even though no `begin` for it will ever reach this follower.
        this.#reportedRecordingMode = record.mode;
      }
      return;
    }
    if (record.t === "refused") {
      // Only this recorder's own mode: `refused` carries no request id (FOLLOW_STREAM.md),
      // so a refusal for some other mode, or some other caller's command, is not evidence
      // about this recorder's own outstanding start.
      if (this.#signals.kind === "explicit" && record.mode === this.#signals.mode && record.reason !== undefined) {
        this.#lastRefusalReason = record.reason;
        this.#refusalSeq += 1;
        resolveAll(this.#refusalWaiters);
      }
      return;
    }
    if (record.t === "start_failed") {
      if (this.#signals.kind === "explicit" && record.mode === this.#signals.mode && record.message !== undefined) {
        this.#lastStartFailedMessage = record.message;
        this.#lastStartFailedCode = record.code;
        this.#startFailedSeq += 1;
        resolveAll(this.#startFailedWaiters);
      }
      return;
    }
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
        // the finalize signal by *starting* a recording rather than ending one: it was idle
        // when the signal landed, because it restarted while the follower was away and the
        // recording being followed died with the old process. The terminal record being
        // waited for can never arrive now, and sitting out the whole finalize budget with a
        // live microphone is the failure this module exists to prevent — so stop waiting and
        // let the caller's backstop end it.
        resolveAll(this.#usurpedWaiters);
      }
      this.#sessionLive = true;
      this.#followedSession = record.session;
      if (record.t === "begin") this.#followedMode = record.mode;
      this.#expectingSession = false;
      // A recording is running, so whatever cancel preceded it no longer describes Shorthand.
      this.#idleGuaranteed = false;
      resolveAll(this.#beginWaiters);
      return;
    }
    if (!this.#endsFollowedSession(record)) return;
    this.#sessionLive = false;
    this.#followedSession = undefined;
    this.#followedMode = undefined;
    // A stop waiting for the session to announce itself must not outlive that session.
    resolveAll(this.#beginWaiters);
    resolveAll(this.#terminalWaiters);
  }

  /**
   * Whether a terminal record ends the recording this capture is responsible for.
   *
   * While `#expectingSession` is set the answer is always no: a toggle-kind start sequence's
   * own `--cancel` makes Shorthand emit a terminal record for the recording it just ended, and
   * that record can land *after* the start signal was sent. This capture's own session
   * announces itself first — with `begin`, or with a `partial` when `begin` was missed — so a
   * terminal record arriving before any of that belongs to the previous recording. Erring the
   * other way discarded a live recording; erring this way at worst leaves the caller believing
   * something might still be running, which its backstop settles safely.
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
    // direction: a toggle-kind finalize against an idle Shorthand would start a recording rather
    // than end one, and it suppresses that signal for exactly this reason.
    return this.#reattached && record.session < this.#followedSession;
  }

  /**
   * Drives Shorthand into recording from any prior state. `attached` resolves on the
   * follower's `hello`. `client.start()` returns as soon as the child process object exists,
   * long before it has connected to Shorthand, and a `begin` emitted before that attach is
   * never observed by anyone.
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

    const signals = this.#signals;
    if (signals.kind === "toggle") return this.#runToggleStart(signals.signal);

    // Explicit kind must not go out blind, unlike toggle kind above: an older app that
    // predates the pair would otherwise refuse the flag itself with a clap error surfaced
    // only after the plugin had already entered capturing state.
    if (!gotHello) {
      this.#startFailure = { kind: "no-hello" };
      return "not-started";
    }
    const capabilities = hello?.capabilities ?? [];
    if (!signals.requiredCapabilities.every((capability) => capabilities.includes(capability))) {
      this.#startFailure = { kind: "unsupported" };
      return "not-started";
    }
    return this.#runExplicitStart(signals);
  }

  /**
   * Meeting's path. `--cancel` always lands Shorthand in idle and is a no-op when it already
   * is, so the toggle that follows can only ever turn recording *on*. The two must be
   * sequential — fired together, the cancel could undo the toggle it raced.
   *
   * This whole dance exists only because `signal` is a genuine toggle: no explicit
   * start/stop pair exists for Meeting. See `#runExplicitStart` for the path that does not
   * need it.
   */
  async #runToggleStart(signal: ControlSignal): Promise<RecorderStartOutcome> {
    if (!await this.#send("cancel", "start")) return "not-started";
    this.#markIdle();
    if (this.#stopping) return "stopped";
    const toggled = await this.#send(signal, "start");
    if (toggled) {
      // Not unconditionally true. Shorthand announces the session when it acts on the
      // toggle, not when the forwarding process carrying it exits, so a `begin` can already
      // have arrived during the await above and set this false. Overwriting it here would
      // claim a session is still pending when the recorder is already following one.
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
    return "started";
  }

  /**
   * Assisted Notes' path. `start-assisted-notes` is idempotent (FOLLOW_STREAM.md's table),
   * so unlike the toggle above it never needs a forced known state to be safe: sending it
   * against an idle, already-capturing, or busy Shorthand each converge on the right answer
   * without help. Nothing here sends a `--cancel`.
   *
   * "Already capturing" is read from `#reportedRecordingMode` — capture_state's own report,
   * taken at attach — rather than inferred from an observed `begin`; see that field's own
   * comment for why the inference it replaces had a real gap.
   */
  async #runExplicitStart(signals: ExplicitSignals): Promise<RecorderStartOutcome> {
    // Whether *any* session — of any mode — was already live before this call sent
    // anything, observed via a `begin`/`partial` this module saw directly (as opposed to
    // reported by capture_state, checked separately below). Deliberately mode-agnostic: the
    // timeout backstop further down needs the conservative answer "was anything at all live"
    // rather than "was ours live", because a session that predates this call was never this
    // command's to end regardless of whose it is.
    const wasLiveBeforeSend = this.#sessionLive;
    const refusalSeqBeforeSend = this.#refusalSeq;
    const startFailedSeqBeforeSend = this.#startFailedSeq;
    const sent = await this.#send(signals.start, "start");
    if (this.#stopping) {
      // Nothing to recall if the start was never delivered; `stop-assisted-notes` is
      // idempotent, so sending it unconditionally otherwise costs nothing even if the start
      // turns out to have been refused a moment later.
      if (sent) await this.#send(signals.stop, "recall");
      return "stopped";
    }
    if (!sent) return "not-started";
    // Not unconditionally true. Shorthand can act on the flag and announce the session
    // before the forwarding child (what `#send()` above awaits) actually exits, setting this
    // false already. Overwriting it here would claim a session is still pending when one is
    // already known to be running.
    this.#expectingSession = !this.#sessionLive;

    // Authoritative, not inferred: capture_state told this recorder, at attach — before this
    // call ever sent anything — whether `signals.mode` was already recording. See
    // `#reportedRecordingMode`'s own comment for the P1 gap this closes.
    if (this.#reportedRecordingMode === signals.mode) {
      // The documented success no-op (FOLLOW_STREAM.md's table): already recording, so
      // Shorthand answers this call with silence — no `begin`, because nothing began.
      // Forced false rather than left at the general `!sessionLive` set above: when this
      // capture is not publishing, no `begin` for it is ever coming (FOLLOW_STREAM.md), so
      // there is nothing left for this recorder to wait for or finalize on this connection.
      this.#expectingSession = false;
      return "started";
    }

    // Shorthand can announce, refuse or fail the start before the await above resolves —
    // `#send()` only resolves on the forwarding child's exit, not on Shorthand's own reaction
    // to the flag it forwarded. The waiter sets consulted below (and in the race loop further
    // down) are only populated once that loop registers with them, so a record landing in this
    // exact gap would otherwise have its wakeup silently dropped (`resolveAll` on an empty set)
    // and sit out the whole acknowledgement budget. Everything from here to the loop is closing
    // that gap for each record type that can arrive in it.
    //
    // capture_state already covered the "already recording" fast path above; everything from
    // here down is the fallback for a session that only became knowable *after* that one-time
    // snapshot — either because it actually began after it, or because the connected app
    // predates the `begin-mode` capability that would have named it on a `begin`.
    if (wasLiveBeforeSend) {
      // Only when the live session's mode is *known* to be ours, though — unlike the freshly-
      // arrived-`begin` branch below, `undefined` is not treated as a match here.
      // `#followedMode` is `undefined` both for an app old enough to predate the `begin-mode`
      // capability *and* for a mode core does not recognize at all, and that second case is
      // definitely not us — it is some other, unrelated capture, and misreporting it as this
      // command's own success would tell the plugin a note is being taken when it is not. The
      // cost of not adopting here is only a slower, misreported `start-timeout` instead of
      // `"started"`; the timeout fix (see the `"timeout"` case below) makes sure it is never
      // a stopped recording either way.
      if (this.#followedMode === signals.mode) return "started";
    } else if (this.#sessionLive
      && (this.#followedMode === undefined || this.#followedMode === signals.mode)) {
      // Became live *during this call*, unlike the branch above: a `begin` arriving in direct
      // response to the start just sent is far likelier to be it than a coincidental, unrelated
      // capture racing the exact same window, so an unknown mode is treated as a match here.
      return "started";
    }
    // A `refused` or `start_failed` for our own mode landing in the same send-in-flight gap.
    // The sequence numbers were snapshotted immediately before the send above, so a reason
    // recorded by an *earlier* capture — which would already have advanced the count before
    // this call ever started — cannot be mistaken for this one's answer; only a change that
    // happened during this exact window trips these.
    if (this.#refusalSeq !== refusalSeqBeforeSend) {
      this.#expectingSession = false;
      this.#startFailure = { kind: "refused", reason: this.#lastRefusalReason ?? "" };
      return "not-started";
    }
    if (this.#startFailedSeq !== startFailedSeqBeforeSend) {
      this.#expectingSession = false;
      this.#startFailure = this.#startFailureFromLast();
      return "not-started";
    }

    // Backstop only, from here down: a real refusal or failure is caught by the race below
    // the moment its record arrives, and only a Shorthand that says nothing at all falls
    // through to the deadline. See `RecorderStartFailure`'s `start-timeout`.
    const deadline = this.#delay(signals.startAcknowledgementMs).then(() => "timeout" as const);
    for (;;) {
      if (this.#stopping) {
        await this.#send(signals.stop, "recall");
        return "stopped";
      }
      const outcome = await Promise.race([
        this.#waitFor(this.#beginWaiters).then(() => "begin" as const),
        this.#waitFor(this.#refusalWaiters).then(() => "refused" as const),
        this.#waitFor(this.#startFailedWaiters).then(() => "start-failed" as const),
        this.#waitFor(this.#stopRequestWaiters).then(() => "stop" as const),
        deadline,
      ]);
      switch (outcome) {
        case "begin":
          // `#beginWaiters` is shared with the "usurped" detection during finalize and is
          // not itself mode-filtered, because every non-terminal session record resolves it
          // regardless of mode. A different mode's session beginning on this same connection
          // while ours is still pending is not evidence about our own request — keep waiting
          // for the real answer instead of reporting a false "started".
          if (this.#followedMode !== undefined && this.#followedMode !== signals.mode) continue;
          return "started";
        case "refused":
          // Definitive: Shorthand said no, so nothing is pending from this request any more.
          this.#expectingSession = false;
          this.#startFailure = { kind: "refused", reason: this.#lastRefusalReason ?? "" };
          return "not-started";
        case "start-failed":
          this.#expectingSession = false;
          this.#startFailure = this.#startFailureFromLast();
          return "not-started";
        case "stop":
          await this.#send(signals.stop, "recall");
          return "stopped";
        case "timeout":
          // Never a second start: Shorthand accepted delivery and simply never replied — a
          // genuinely silent app, not a refusal (those arrive as their own record) — so
          // retrying here would only risk a second identical command racing the first's own
          // eventual, merely-late reply. `stop` is sent as a backstop instead, but only when
          // nothing was already live *before this call's own send* (`wasLiveBeforeSend`):
          // only then can the silence be hiding a start this call itself might have caused,
          // which is what the backstop exists to guarantee idle against. A session that
          // predates this call was never this command's to end — sending `stop` for one is
          // exactly the bug this module exists to prevent, a retry-safe idempotent command
          // tearing down a capture it was never asked to touch. `#reportedRecordingMode`
          // matching this mode already returned `"started"` above without ever reaching here,
          // so the only way to still be here with something pre-existing is `wasLiveBeforeSend`
          // itself — the same guard as before capture_state existed. When it does apply,
          // sending `stop` is otherwise harmless: idempotent, so a no-op if nothing is
          // actually running.
          if (!wasLiveBeforeSend) await this.#send(signals.stop, "backstop");
          this.#expectingSession = false;
          this.#startFailure = { kind: "start-timeout" };
          return "not-started";
      }
    }
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
   * sequenced behind its own start signal. Teardown paths that do not finalize still have to
   * wait for this before dropping the recorder: a start sequence whose recall is still in
   * flight outlives the capture that owns it, and its recall would otherwise land on whatever
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
    return this.#signals.kind === "toggle"
      ? this.#stopToggle(this.#signals.signal, options)
      : this.#stopExplicit(this.#signals, options);
  }

  async #stopToggle(signal: ControlSignal, options: RecorderStopOptions): Promise<RecorderStopOutcome> {
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
    if (!await this.#send(signal, "finalize")) return "not-finalized";
    return this.#waitForFinalize(options);
  }

  async #stopExplicit(signals: ExplicitSignals, options: RecorderStopOptions): Promise<RecorderStopOutcome> {
    if (!this.#sessionLive && this.#expectingSession) {
      // Same gap as the toggle path above: the start signal landed but `begin` has not
      // arrived yet. Waiting turns the race into an ordinary stop.
      await Promise.race([this.#waitFor(this.#beginWaiters), this.#delay(this.#beginGraceMs)]);
    }
    if (!this.#sessionLive) {
      // Sent anyway, best-effort: `stop-assisted-notes` is documented idempotent against an
      // idle Shorthand (FOLLOW_STREAM.md's table) — unlike a toggle it can never itself
      // start something by mistake — so there is nothing to lose by sending it as a safety
      // net for a belief this module could have gotten wrong (a missed `begin`), and no
      // reason to make the caller wait for a terminal record that will never arrive.
      await this.#send(signals.stop, "finalize");
      return "no-session";
    }
    if (!await this.#send(signals.stop, "finalize")) return "not-finalized";
    return this.#waitForFinalize(options);
  }

  /**
   * Shared tail of both stop paths, once a finalize signal has been confirmed delivered.
   * Shorthand has been asked to finalize; the `final` it is computing is the whole point of
   * the capture. Nothing may tear the follower down until the record that ends the session
   * arrives or the budget expires.
   */
  async #waitForFinalize(options: RecorderStopOptions): Promise<RecorderStopOutcome> {
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
   * Synchronous teardown, for Obsidian's shutdown hooks, which do not await. Detached because
   * there is no result anyone could still act on.
   *
   * Toggle kind sends `--cancel`, never the toggle itself: the toggle would *start* a
   * recording if Shorthand happened to be idle. Explicit kind sends its own `stop` signal
   * instead — idempotent, so equally safe against an idle Shorthand, and scoped to this mode
   * rather than cancelling whatever else might be running.
   */
  teardown(): void {
    this.#stopping = true;
    this.#control.sendDetached(this.#signals.kind === "toggle" ? "cancel" : this.#signals.stop);
  }

  /**
   * Last-resort stop once nothing is left to finalize. Fire-and-forget on purpose:
   * guaranteeing Shorthand is not left recording outranks everything else here. Toggle kind
   * sends `--cancel` (a no-op against an idle Shorthand); explicit kind sends its own
   * idempotent `stop`, for the same reason `teardown()` prefers it — see that method.
   */
  backstop(): void {
    void this.#send(this.#signals.kind === "toggle" ? "cancel" : this.#signals.stop, "backstop");
  }

  /** Toggle kind only: sends the disambiguating cancel that ends a recalled start sequence idle. */
  async #recall(): Promise<void> {
    if (this.#idleGuaranteed) return;
    if (await this.#send("cancel", "recall")) this.#markIdle();
  }

  #markIdle(): void {
    this.#sessionLive = false;
    this.#followedSession = undefined;
    this.#followedMode = undefined;
    this.#expectingSession = false;
    this.#idleGuaranteed = true;
  }

  /**
   * Builds the `start-failed` variant of `RecorderStartFailure` from whatever
   * `#lastStartFailedMessage`/`#lastStartFailedCode` currently hold. Shared by both places
   * `#runExplicitStart` can observe a `start_failed` (the send-in-flight gap and the wait
   * loop below it) so the `exactOptionalPropertyTypes`-safe conditional spread for the
   * optional `code` is not duplicated.
   */
  #startFailureFromLast(): RecorderStartFailure {
    const code = this.#lastStartFailedCode;
    return {
      kind: "start-failed",
      message: this.#lastStartFailedMessage ?? "",
      ...(code === undefined ? {} : { code }),
    };
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

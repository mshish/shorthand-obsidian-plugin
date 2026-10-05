import {
  enhancementDelta,
  type ControlResult,
  type ControlSignal,
  type EnhanceStatus,
  type TranscriptUpdate,
} from "shorthand-core";
import type { CaptureMode } from "./follow-policy.js";

/**
 * Turns the enhancement agent's "the meeting looks over" report into a cancellable countdown.
 *
 * The agent only reports; this module decides. The transcript it reads is untrusted, so a
 * spoken or injected "this meeting is over" must be able to do no worse than start a
 * countdown the user can cancel, and further speech cancels it by itself. Nothing here stops
 * a capture directly: expiry calls `onExpire`, and the plugin routes that through the same
 * `stopCapture()` a manual stop uses, so the final pass and the transcript-recovery cards
 * behave identically.
 *
 * Plain data and rules with injectable timers and clock. `main.ts` cannot be imported under
 * `bun test` (`node_modules/obsidian` ships types only), so it only forwards events here.
 */

export const MEETING_END_COUNTDOWN_MS = 30_000;

/** Longest reason shown. The text is model output derived from untrusted speech. */
const MAX_REASON_LENGTH = 160;

export type MeetingEndTimers = Readonly<{
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}>;

export type MeetingEndCountdown = Readonly<{
  /** The agent's one-line reason, cleaned for display. */
  reason: string;
  /** Whole seconds left, rounded up so the display reads 30 first and never shows 0 early. */
  remainingSeconds: number;
}>;

export type MeetingEndCancelCause = "user" | "speech";

export type MeetingEndWatchOptions = Readonly<{
  mode: CaptureMode;
  /** Read at each decision, so toggling the setting mid-capture takes effect. */
  enabled: () => boolean;
  /** Speech of at least this many characters during a countdown cancels it. */
  minSpeechCharacters: number;
  now: () => number;
  timers: MeetingEndTimers;
  countdownMs?: number;
  /** A countdown started, or ended for any reason (`undefined`). Drives the Notice. */
  onChange: (countdown: MeetingEndCountdown | undefined) => void;
  /** A countdown was cancelled by the user or by speech; not called for `dispose`. */
  onCancel: (cause: MeetingEndCancelCause) => void;
  /** The countdown reached zero. */
  onExpire: () => void;
}>;

/** Strips control characters and caps the length of text that is not ours. */
export function cleanReason(reason: string): string {
  const flat = reason.replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_REASON_LENGTH) return flat;
  return `${flat.slice(0, MAX_REASON_LENGTH - 1).trimEnd()}…`;
}

/**
 * Counts characters of genuinely new speech in transcript updates. `replace-session`
 * re-decodes speech that was already heard, so counting it would let a recognizer revising
 * the farewell cancel the countdown with "the conversation continued" and would satisfy the
 * rearm rule with no one speaking. A `rewrite-tail` delta is the revised tail plus any words
 * the same coalesced snapshot added, so only its net growth over what that speaker had
 * already committed counts; that needs the per-speaker length, which is why this is stateful.
 * An append is measured the way core's own gate measures it, speaker label included.
 * Create one per capture.
 */
export class SpeechMeter {
  readonly #committed = new Map<string, number>();

  measure(update: TranscriptUpdate): number {
    if (update.action === "append") {
      const key = this.#key(update);
      if (key !== undefined) this.#committed.set(key, (this.#committed.get(key) ?? 0) + (update.delta?.length ?? 0));
      return enhancementDelta(update).length;
    }
    if (update.action !== "rewrite-tail") return 0;
    const key = this.#key(update);
    if (key === undefined || update.delta === undefined || update.preservedPrefixLength === undefined) return 0;
    const next = update.preservedPrefixLength + update.delta.length;
    const growth = Math.max(0, next - (this.#committed.get(key) ?? next));
    this.#committed.set(key, next);
    return growth;
  }

  #key(update: TranscriptUpdate): string | undefined {
    return update.speaker === undefined ? undefined : `${update.snapshot.session}\u0000${update.speaker}`;
  }
}

export function meetingEndNoticeText(seconds: number): string {
  return `Meeting looks like it has ended — stopping in ${seconds}s`;
}

/** One capture's watch. Create one per capture and `dispose()` it when the capture ends. */
export class MeetingEndWatch {
  readonly #options: MeetingEndWatchOptions;
  readonly #countdownMs: number;
  #disposed = false;
  #timer: unknown = undefined;
  #deadline = 0;
  #reason = "";
  #speechInCountdown = 0;
  /** Counts speech deltas; a pass is judged by the speech that existed when it started. */
  #speechSeq = 0;
  /**
   * After a cancel, only a pass that started after this much speech may start another
   * countdown. Without it a pass already running at cancel time reports `ended` about the
   * transcript the user just overruled, and the countdown restarts at once.
   */
  #rearmAfterSeq = -1;
  /**
   * Speech count when core reported the pass `started`. Core emits that after reading the
   * note, but fixes the pass's transcript earlier, so speech arriving during that read is
   * counted as "before the pass" although the pass never saw it. The window is narrow and
   * closing it needs core to report acceptance or expose the transcript cutoff.
   */
  #passStartSeq: number | undefined = undefined;

  constructor(options: MeetingEndWatchOptions) {
    this.#options = options;
    this.#countdownMs = options.countdownMs ?? MEETING_END_COUNTDOWN_MS;
  }

  get countdown(): MeetingEndCountdown | undefined {
    if (this.#timer === undefined) return undefined;
    const remaining = Math.max(0, this.#deadline - this.#options.now());
    return { reason: this.#reason, remainingSeconds: Math.ceil(remaining / 1000) };
  }

  /** New transcript text reached the capture. */
  noteSpeech(characters: number): void {
    if (this.#disposed || characters <= 0) return;
    this.#speechSeq += 1;
    if (this.#timer === undefined) return;
    this.#speechInCountdown += characters;
    if (this.#speechInCountdown >= this.#options.minSpeechCharacters) this.#cancel("speech");
  }

  /**
   * Called on the plugin's one-second tick. The setting can be switched off mid-countdown;
   * "off" means the signal has no effect, so the countdown is dropped at once rather than
   * left showing a stop that will not happen.
   */
  refresh(): void {
    if (this.#disposed || this.#timer === undefined || this.#options.enabled()) return;
    this.#cancel("user", false);
  }

  /** Every enhancement status of the capture; only pass start and finish matter here. */
  noteStatus(status: EnhanceStatus): void {
    if (this.#disposed) return;
    if (status.kind === "started") {
      this.#passStartSeq = this.#speechSeq;
      return;
    }
    if (status.kind !== "finished") return;
    const startSeq = this.#passStartSeq ?? this.#speechSeq;
    this.#passStartSeq = undefined;
    if (!status.meetingStatus.ended) return;
    if (this.#options.mode !== "meeting" || !this.#options.enabled()) return;
    if (this.#timer !== undefined || startSeq <= this.#rearmAfterSeq) return;
    this.#start(cleanReason(status.meetingStatus.reason));
  }

  /** The user pressed Cancel. */
  cancel(): void {
    if (this.#disposed || this.#timer === undefined) return;
    this.#cancel("user");
  }

  /** The capture is over or stopping: clear everything, silently, for good. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#timer === undefined) return;
    this.#clear();
    this.#options.onChange(undefined);
  }

  #start(reason: string): void {
    this.#reason = reason;
    this.#speechInCountdown = 0;
    this.#deadline = this.#options.now() + this.#countdownMs;
    this.#timer = this.#options.timers.setTimeout(() => this.#expire(), this.#countdownMs);
    this.#options.onChange(this.countdown);
  }

  #expire(): void {
    if (this.#disposed || this.#timer === undefined) return;
    // The setting can be switched off while the countdown runs; "off" means the signal has
    // no effect, and an already-running countdown is an effect.
    if (!this.#options.enabled()) {
      this.#cancel("user", false);
      return;
    }
    this.#clear();
    this.#disposed = true;
    this.#options.onChange(undefined);
    this.#options.onExpire();
  }

  #cancel(cause: MeetingEndCancelCause, notify = true): void {
    // A pass already running judges a transcript the cancel (a click, or speech that arrived
    // after the pass began) has just overruled, and would otherwise restart the countdown at
    // once. A user cancel needs speech after the click. A speech cancel's own delta is new
    // speech, so a pass that started after it may restart; one that started before it may not.
    this.#rearmAfterSeq = cause === "speech" ? this.#speechSeq - 1 : this.#speechSeq;
    this.#clear();
    this.#options.onChange(undefined);
    if (notify) this.#options.onCancel(cause);
  }

  #clear(): void {
    if (this.#timer !== undefined) this.#options.timers.clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#speechInCountdown = 0;
  }
}

/**
 * What the countdown's expiry does about Shorthand's own recording, decided without regard to
 * how the capture began. "Detect meeting end" is independent of "Control Shorthand
 * transcription": a capture adopted from Shorthand's hotkey, or one with control switched off,
 * has no recorder, and without this its expiry would finish the capture in Obsidian and leave
 * the microphone recording.
 *
 * - `recorder`: the capture's recorder sends the stop itself as part of the normal stop path,
 *   and sending it here too would race the recorder's wait for the terminal record.
 * - `send`: no recorder, so the stop signal must be sent here.
 * - `skip`: Shorthand is known not to be running, so there is nothing to stop, and a control
 *   spawn with no Shorthand to forward to would start the app instead.
 */
export type MeetingEndStopPlan = "recorder" | "send" | "skip";

export function planMeetingEndStop(capture: Readonly<{ hasRecorder: boolean; shorthandDown: boolean }>): MeetingEndStopPlan {
  if (capture.shorthandDown) return "skip";
  return capture.hasRecorder ? "recorder" : "send";
}

export type MeetingEndStopOutcome = Readonly<{ sent: true } | { sent: false; message: string }>;

/**
 * Sends the mode's idempotent stop signal, the same one `ShorthandRecorder` uses. Never
 * throws: the capture still has to be finished whether or not Shorthand heard the signal.
 */
export async function sendMeetingEndStop(
  control: Readonly<{ send: (signal: ControlSignal) => Promise<ControlResult> }>,
  signal: ControlSignal,
): Promise<MeetingEndStopOutcome> {
  let result: ControlResult;
  try {
    result = await control.send(signal);
  } catch (error) {
    return { sent: false, message: error instanceof Error ? error.message : String(error) };
  }
  if (result.status === "sent") return { sent: true };
  return {
    sent: false,
    message: result.status === "not-running" ? "Shorthand did not answer within 5 seconds" : result.message,
  };
}

/** Plain wording for a stop that did not reach Shorthand: it may still be recording. */
export function meetingEndStopFailedText(message: string): string {
  const reason = message.trim().replace(/[.\s]+$/u, "");
  return `Shorthand: the meeting looked like it had ended, but Shorthand did not confirm the stop (${reason}). Shorthand may still be recording, so check it and stop it there if so.`;
}

/**
 * The send step of a meeting-end stop for a capture with no recorder. The caller runs it after
 * marking the capture stopping and before asking the follower to drain, so the drain waits for
 * the terminal record the signal produces. A failed send is reported and then returned from
 * normally: the capture must still finish whether or not Shorthand heard the signal.
 */
export async function runMeetingEndStop(steps: Readonly<{
  plan: MeetingEndStopPlan;
  send: () => Promise<MeetingEndStopOutcome>;
  report: (outcome: MeetingEndStopOutcome) => void;
  warn: (text: string) => void;
}>): Promise<void> {
  if (steps.plan !== "send") return;
  const outcome = await steps.send();
  steps.report(outcome);
  if (!outcome.sent) steps.warn(meetingEndStopFailedText(outcome.message));
}

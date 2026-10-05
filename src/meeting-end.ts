import type { EnhanceStatus } from "shorthand-core";
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
  #countdownStartSeq = 0;
  /** Counts speech deltas; a pass is judged by the speech that existed when it started. */
  #speechSeq = 0;
  /**
   * After a cancel, only a pass that started after this much speech may start another
   * countdown. Without it a pass already running at cancel time reports `ended` about the
   * transcript the user just overruled, and the countdown restarts at once.
   */
  #rearmAfterSeq = -1;
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
    this.#countdownStartSeq = this.#speechSeq;
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
    // Speech inside the countdown already counts as new speech, so a speech cancel re-arms
    // from where the countdown began; a user cancel needs speech after the click.
    this.#rearmAfterSeq = cause === "speech" ? this.#countdownStartSeq : this.#speechSeq;
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

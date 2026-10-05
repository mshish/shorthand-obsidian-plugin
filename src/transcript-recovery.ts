import type { EnhanceStatus, PassOutcome } from "shorthand-core";
import type { CaptureMode } from "./follow-policy.js";

/**
 * Keeps a capture's transcript recoverable when enhancement fails.
 *
 * With "Transcript notes" off (the default) the raw transcript exists only in core's
 * `EnhanceRunner` buffer. A failed pass re-queues it a bounded number of times and then
 * drops it, so an agent whose sign-in expired mid-meeting loses the meeting. The plugin
 * therefore keeps its own copy of every delta it feeds the runner, and holds it past the
 * capture only when something went wrong.
 *
 * Everything here is plain data and rules. `main.ts` cannot be imported under `bun test`
 * (`node_modules/obsidian` ships types only), so the lifecycle lives here and `main.ts`
 * only forwards events to it.
 */

/**
 * One capture's in-memory transcript and its enhancement failures.
 *
 * The transcript is kept whether or not passes succeed, because success is only known after
 * the fact and a dropped delta cannot be reconstructed from the runner. The cost is roughly
 * 50-100 KB per hour of meeting, which is accepted.
 *
 * A failure is sticky for the capture. Core's `error` status is emitted both for a pass that
 * will be retried and for one that dropped its transcript at the re-queue limit, with no
 * field to tell them apart, so a later successful pass cannot prove nothing was lost.
 */
export class CaptureRecord {
  readonly mode: CaptureMode;
  #chunks: string[] = [];
  #failed = false;
  #lastError: string | undefined = undefined;

  constructor(mode: CaptureMode) {
    this.mode = mode;
  }

  /** Same joining as core's runner (`\n` between deltas), so a replay reads like the original. */
  appendDelta(delta: string): void {
    if (delta.length > 0) this.#chunks.push(delta);
  }

  transcript(): string {
    return this.#chunks.join("\n");
  }

  get hasTranscript(): boolean {
    return this.#chunks.length > 0;
  }

  get failed(): boolean {
    return this.#failed;
  }

  /** The most recent failure's own text, not a summary of all of them. */
  get lastError(): string | undefined {
    return this.#lastError;
  }

  /**
   * `error` and `skipped` are failed passes. `disabled-for-read-failures` and `expired` end
   * enhancement for the rest of the capture, so everything said after them is never
   * enhanced.
   *
   * `requeued` and `timed-out` are failures too, though both usually heal on the next pass.
   * Core's `EnhanceRunner` re-queues the pass's input on either one, and once the re-queued
   * text exceeds `maxRequeuedCharacters` (20000 by default) it keeps only a tail behind a
   * "[...earlier transcript dropped...]" marker, emitting no status for the truncation. A
   * later `finished` therefore cannot prove nothing was lost, and a capture whose notes are
   * missing material must always show the recovery card. The cost is a card after a
   * transient busy read that did heal; reprocessing then is harmless, whereas a silently
   * truncated meeting is not recoverable.
   */
  noteStatus(status: EnhanceStatus): void {
    switch (status.kind) {
      case "error":
      case "skipped":
      case "requeued":
      case "timed-out":
      case "disabled-for-read-failures":
      case "expired":
        this.#fail(status.message);
        return;
      case "started":
      case "finished":
      case "declined":
        return;
      default: {
        const unhandled: never = status;
        throw new Error(`Unhandled enhancement status: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  /**
   * For a pass the plugin awaits itself (the closing pass, a reprocess). Its status events
   * already carried the specific message for `failed` and `skipped`; the outcome only
   * supplies the fallback, and for the ones that emit no failure status at all.
   */
  noteOutcome(outcome: PassOutcome): void {
    switch (outcome.status) {
      // `not-ready` and `in-flight` mean nothing was waiting (no transcript, or another pass
      // owns it); `expired` already emitted its own status.
      case "completed":
      case "not-ready":
      case "in-flight":
      case "expired":
        return;
      case "failed":
        this.#fail(outcome.error);
        return;
      case "skipped":
        this.#failIfSilent(`Enhancement did not complete (${outcome.reason}).`);
        return;
      case "requeued":
        this.#failIfSilent(`Enhancement was re-queued (${outcome.reason}) and did not finish.`);
        return;
      case "timed-out":
        this.#failIfSilent("Enhancement did not complete (timed-out).");
        return;
      default: {
        const unhandled: never = outcome;
        throw new Error(`Unhandled pass outcome: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  /**
   * A failure that arrives as an exception rather than a status: `createEnhancer` throwing at
   * start (capture goes on with transcript only), or the closing pass rejecting.
   */
  noteFailure(message: string): void {
    this.#fail(message);
  }

  #fail(message: string): void {
    this.#failed = true;
    this.#lastError = message;
  }

  #failIfSilent(fallback: string): void {
    this.#failed = true;
    this.#lastError ??= fallback;
  }
}

/** What a reprocess attempt came to. */
export type ReprocessResult =
  | Readonly<{ ok: true; written: boolean }>
  | Readonly<{ ok: false; error: string }>;

/**
 * Only a completed pass releases the transcript. `statusError` is the last message the
 * attempt's status events carried; it is preferred over the outcome's generic text because
 * it names the cause (an expired sign-in, say).
 */
export function reprocessResult(outcome: PassOutcome, statusError: string | undefined): ReprocessResult {
  switch (outcome.status) {
    case "completed":
      return { ok: true, written: outcome.written };
    case "failed":
      return { ok: false, error: outcome.error };
    case "skipped":
      return { ok: false, error: statusError ?? `Enhancement did not complete (${outcome.reason}).` };
    case "requeued":
      return { ok: false, error: statusError ?? `The note was busy (${outcome.reason}). Try again in a moment.` };
    case "timed-out":
      return { ok: false, error: statusError ?? "Enhancement timed out." };
    case "expired":
      return { ok: false, error: statusError ?? "Enhancement expired before it could run." };
    case "not-ready":
    case "in-flight":
      return { ok: false, error: statusError ?? "Enhancement did not run." };
    default: {
      const unhandled: never = outcome;
      throw new Error(`Unhandled pass outcome: ${JSON.stringify(unhandled)}`);
    }
  }
}

export type RecoveryEntry<F> = Readonly<{
  /** The vault file, held by identity: Obsidian keeps one `TFile` across a rename. */
  file: F;
  mode: CaptureMode;
  transcript: string;
  error: string;
  /** A reprocess is running; a second would write the same note twice. */
  busy: boolean;
  /** True once a reprocess has failed, so the card says so instead of repeating the old text. */
  retried: boolean;
  seq: number;
}>;

type MutableEntry<F> = { -readonly [K in keyof RecoveryEntry<F>]: RecoveryEntry<F>[K] };

/**
 * The recovery slots, one per meeting note. Keyed by the file object rather than its path so
 * that a rename, which keeps the object and changes the path, keeps the slot.
 *
 * Slots outlive the capture that made them and are released only by: a successful reprocess,
 * the user dismissing the card, a new capture on the same note, or plugin unload. A capture
 * on a different note leaves them alone, because discarding a stranger's transcript to make
 * room is the data loss this exists to prevent.
 */
export class RecoveryStore<F extends object> {
  #slots = new Map<F, MutableEntry<F>>();
  #seq = 0;

  get size(): number {
    return this.#slots.size;
  }

  /**
   * Called when a capture ends. Keeps the record only when enhancement failed and there is
   * something to reprocess; otherwise the slot for this note is cleared, since a clean
   * capture has superseded whatever an earlier failed one left.
   */
  keep(file: F, record: CaptureRecord): RecoveryEntry<F> | undefined {
    if (!record.failed || !record.hasTranscript) {
      this.release(file);
      return undefined;
    }
    const entry: MutableEntry<F> = {
      file,
      mode: record.mode,
      transcript: record.transcript(),
      error: record.lastError ?? "Enhancement did not complete.",
      busy: false,
      retried: false,
      seq: ++this.#seq,
    };
    this.#slots.set(file, entry);
    return entry;
  }

  get(file: F): RecoveryEntry<F> | undefined {
    return this.#slots.get(file);
  }

  /** Oldest first, which is the order cards are listed in. */
  entries(): readonly RecoveryEntry<F>[] {
    return [...this.#slots.values()].sort((a, b) => a.seq - b.seq);
  }

  release(file: F): void {
    this.#slots.delete(file);
  }

  releaseAll(): void {
    this.#slots.clear();
  }

  isBusy(file: F): boolean {
    return this.#slots.get(file)?.busy === true;
  }

  /** `none` when the slot is gone, `busy` when an attempt is already running. */
  beginReprocess(file: F): "started" | "busy" | "none" {
    const entry = this.#slots.get(file);
    if (entry === undefined) return "none";
    if (entry.busy) return "busy";
    entry.busy = true;
    return "started";
  }

  /**
   * Success releases the transcript. Failure keeps it, replaces the error with the new one
   * and frees the slot for another try. A slot dismissed or released mid-attempt stays gone.
   */
  finishReprocess(file: F, result: ReprocessResult): void {
    const entry = this.#slots.get(file);
    if (entry === undefined) return;
    if (result.ok) {
      this.#slots.delete(file);
      return;
    }
    entry.busy = false;
    entry.retried = true;
    entry.error = result.error;
  }

  /**
   * The slot a command acts on: the active note's own, otherwise the oldest. Oldest because
   * it has waited longest for a fix, and the card list shows the same order.
   */
  pick(active: F | undefined): RecoveryEntry<F> | undefined {
    if (active !== undefined) {
      const own = this.#slots.get(active);
      if (own !== undefined) return own;
    }
    return this.entries()[0];
  }
}

export type RecoveryCardAction = "reprocess" | "copy";

export type RecoveryCardModel = Readonly<{
  /** Stable across repaints of the same slot, so the view can tell a change from a repaint. */
  key: string;
  noteName: string;
  notePath: string | undefined;
  headline: string;
  /** What went wrong, verbatim from the failure that stopped the notes. */
  error: string;
  /** What to do about it; absent while an attempt is running. */
  guidance: string | undefined;
  /** Why the copy in memory is the only one, and the setting that changes that. */
  diskNote: string;
  progress: string | undefined;
  action: Readonly<{ id: RecoveryCardAction; label: string; enabled: boolean }>;
  dismissLabel: string;
  /**
   * False while a reprocess runs. Dismissing then would release the slot under the attempt, and
   * a failure would be reported as "the transcript is still held" when it is gone.
   */
  dismissEnabled: boolean;
}>;

export type RecoveryNoteInfo = Readonly<{
  basename: string;
  path: string;
  /** False once the note is deleted: nothing is left to write into. */
  exists: boolean;
}>;

const DISK_NOTE = "This copy is held in memory and is lost if Obsidian closes. Turn on Transcript notes in settings to keep a copy on disk.";

/** The recovery cards for the panel. Empty when there is nothing to recover. */
export function describeRecoveryCards<F extends object>(
  entries: readonly RecoveryEntry<F>[],
  noteInfo: (file: F) => RecoveryNoteInfo,
): readonly RecoveryCardModel[] {
  return entries.map((entry) => {
    const note = noteInfo(entry.file);
    const key = `${note.path}\0${entry.seq}`;
    const error = entry.retried ? `Reprocessing failed: ${entry.error}` : entry.error;
    if (!note.exists) {
      return {
        key,
        noteName: note.basename,
        notePath: undefined,
        headline: "The note was deleted",
        error,
        guidance: `"${note.basename}" no longer exists, so there is nowhere to write the notes. Copy the transcript to keep it.`,
        diskNote: DISK_NOTE,
        progress: undefined,
        action: { id: "copy", label: "Copy transcript", enabled: true },
        dismissLabel: "Dismiss",
        dismissEnabled: true,
      };
    }
    return {
      key,
      noteName: note.basename,
      notePath: note.path,
      headline: "Notes may be incomplete",
      error,
      guidance: entry.busy
        ? undefined
        : "Check the agent and its sign-in below, switch agent if needed, then reprocess the transcript.",
      diskNote: DISK_NOTE,
      progress: entry.busy ? "Reprocessing transcript…" : undefined,
      action: { id: "reprocess", label: entry.busy ? "Reprocessing…" : "Reprocess transcript", enabled: !entry.busy },
      dismissLabel: "Dismiss",
      dismissEnabled: !entry.busy,
    };
  });
}

import { BEGIN_MODES, type BeginMode, type WireEvent } from "shorthand-core";
import { canStartCapture, type PluginUiState } from "./state.js";

/**
 * The two modes this plugin can drive a capture with. `BeginMode` also names `dictation`,
 * which is never a follow or a manual-start target — see `decideFollow`'s `default` arm —
 * so this is its own, narrower type rather than a re-export.
 */
export type CaptureMode = "meeting" | "assisted-notes";

export type FollowDecision =
  | Readonly<{ kind: "attach"; mode: CaptureMode }>
  | Readonly<{ kind: "ignore" }>
  /** The connected Shorthand predates `begin.mode`, so nothing can be decided. Tell the user once. */
  | Readonly<{ kind: "needs-newer-app" }>;

export type FollowInput = Readonly<{
  /**
   * The `mode` field off the `begin` record, **unvalidated**.
   *
   * `unknown`, not `BeginMode | undefined`, and still deliberately. `StreamClient`'s `event`
   * channel is typed now, so a `begin` record's `mode` narrows to `BeginMode | undefined` at
   * the call site — core's own `beginModeField` has already dropped anything it does not
   * recognize. But that narrowing is a promise from another package's parser, relied on inside
   * `main.ts`, which is never exercised under `bun test` (see `AGENTS.md`): nothing would fail
   * if a future refactor there read `mode` off the wrong record variant, or off a build of
   * core that stopped validating it. Keeping this field `unknown` and re-validating below,
   * against core's own `BEGIN_MODES`, means the one module with tests for this decision does
   * not depend on `main.ts` getting that right forever.
   */
  mode: unknown;
  state: PluginUiState;
  hasActiveNote: boolean;
  followEnabled: boolean;
  /** Whether the connected app's `hello` listed `begin-mode`. */
  appAdvertisesMode: boolean;
}>;

const IGNORE: FollowDecision = Object.freeze({ kind: "ignore" });

/**
 * Whether a recording Shorthand announced on its own is one this plugin should follow.
 *
 * The hard case is the one that decides the shape: a `begin` with no mode. It means
 * either "this app predates the field" or "this app sent a mode this build does not
 * know", and those are the same bytes. The `begin-mode` capability on `hello` is what
 * separates them, which is the whole reason it was added — and when it is absent the
 * answer is to attach nothing and say so, never to assume meeting. Guessing wrong here
 * writes a dictated sentence into someone's meeting note.
 */
export function decideFollow(input: FollowInput): FollowDecision {
  const { mode, state, hasActiveNote, followEnabled, appAdvertisesMode } = input;
  if (!followEnabled) return IGNORE;
  if (!hasActiveNote) return IGNORE;
  // Includes the case where this plugin's own start sequence caused the recording being
  // announced: `starting` is not a state to attach a second capture from.
  if (!canStartCapture(state)) return IGNORE;
  // After both eligibility checks, deliberately: the idle follower keeps listening during
  // a capture this plugin itself just started from the palette, and that recording's own
  // `begin` reaches this function too. Checking the capability first meant an older app's
  // "update Shorthand" notice fired for the plugin's *own* recording — the one case this
  // check has nothing useful to say about, since nothing here was ever going to attach to
  // it regardless of what the app advertises.
  if (!appAdvertisesMode) return { kind: "needs-newer-app" };
  switch (beginMode(mode)) {
    case "meeting":
      return { kind: "attach", mode: "meeting" };
    case "assisted-notes":
      return { kind: "attach", mode: "assisted-notes" };
    default:
      // `dictation`, absent, or anything the wire produced that this build does not know.
      return IGNORE;
  }
}

/**
 * The trust boundary for `record.mode`. Core's own parser already narrows this to
 * `BeginMode | undefined` before it reaches `main.ts`, so in practice this only ever sees a
 * valid value or nothing — but "in practice" is not a check, and the cost of being wrong here
 * is a dictated sentence written into someone's meeting note. See `FollowInput.mode`'s own
 * comment for why that makes this function worth keeping rather than trusting the type.
 */
function beginMode(value: unknown): BeginMode | undefined {
  return (BEGIN_MODES as readonly unknown[]).includes(value) ? (value as BeginMode) : undefined;
}

/**
 * Records that end a session. Shorthand sends exactly one per recording.
 *
 * Deliberately its own copy rather than shared with `recorder.ts`'s private set: the two
 * answer different questions. The recorder asks "did the finalize I requested land"; this
 * asks "is the recording I attached to over". A capture that attaches has no recorder at
 * all, which is exactly why it needs its own.
 */
export const TERMINAL_RECORD_TYPES: ReadonlySet<string> = new Set(["final", "no_speech", "cancel", "error"]);

/** Whether `record` ends `session`. A session-less record ends nothing. */
export function endsSession(record: Readonly<{ t: string; session?: number }>, session: number | undefined): boolean {
  if (session === undefined || record.session !== session) return false;
  return TERMINAL_RECORD_TYPES.has(record.t);
}

/**
 * How many records `main.ts` buffers for a session it has decided to attach to but has not
 * yet built a capture for. Audio for a followed recording is already running through the
 * whole of capture setup — marker preflight, an unbounded confirmation modal, sidecar
 * setup, `createEnhancer` — and every `partial`/`final` that arrives in that window would
 * otherwise be silently lost, seconds' worth on an ordinary start and unbounded if the
 * modal sits open. The cap exists because "unbounded" cuts both ways: a modal left open
 * all day must not turn an idle follower into an unbounded memory leak. Far larger than any
 * real meeting's setup window produces, so hitting it at all means something is stuck, not
 * that a real meeting opened.
 */
export const PENDING_ATTACH_BUFFER_CAP = 4_000;

/** One buffered wire event, exactly as `StreamClient` emitted it. Replayed verbatim later. */
export type PendingAttachRecord = Readonly<{ generation: number; record: WireEvent }>;

export type PendingAttachBuffer = Readonly<{
  records: readonly PendingAttachRecord[];
  /** How many records were refused because the buffer was already at `PENDING_ATTACH_BUFFER_CAP`. */
  droppedCount: number;
}>;

export const EMPTY_PENDING_ATTACH_BUFFER: PendingAttachBuffer = Object.freeze({ records: [], droppedCount: 0 });

/**
 * Appends `entry` if it belongs to `session` and the buffer has room; otherwise drops it
 * (silently here — the caller is what reports `droppedCount`, once, rather than on every
 * dropped record). A record for a different session is not this attach's business at all,
 * the same boundary `endsSession` draws.
 */
export function pushPendingAttachRecord(
  buffer: PendingAttachBuffer,
  session: number,
  entry: PendingAttachRecord,
): PendingAttachBuffer {
  const recordSession = (entry.record as Readonly<{ session?: number }>).session;
  if (recordSession !== session) return buffer;
  if (buffer.records.length >= PENDING_ATTACH_BUFFER_CAP) {
    return { records: buffer.records, droppedCount: buffer.droppedCount + 1 };
  }
  return { records: [...buffer.records, entry], droppedCount: buffer.droppedCount };
}

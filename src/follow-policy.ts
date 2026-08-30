import { BEGIN_MODES, type BeginMode, type ControlSignal } from "shorthand-core";
import { canStartCapture, type PluginUiState } from "./state.js";

export type FollowDecision =
  | Readonly<{ kind: "attach"; signal: Extract<ControlSignal, "toggle-transcription" | "toggle-assisted-notes"> }>
  | Readonly<{ kind: "ignore" }>
  /** The connected Shorthand predates `begin.mode`, so nothing can be decided. Tell the user once. */
  | Readonly<{ kind: "needs-newer-app" }>;

export type FollowInput = Readonly<{
  /**
   * The `mode` field off the `begin` record, **unvalidated**.
   *
   * `unknown`, not `BeginMode | undefined`, and deliberately. `StreamClient` extends a
   * bare `EventEmitter` with no typed event map, so `client.on("event", ({ record }) => …)`
   * hands `main.ts` a contextual `any`: `record.mode` compiles whatever core does, and a
   * signature promising `BeginMode` here would be a promise nothing checks. Validation
   * happens below, against core's own `BEGIN_MODES`, in the module that has tests.
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
  if (!appAdvertisesMode) return { kind: "needs-newer-app" };
  if (!hasActiveNote) return IGNORE;
  // Includes the case where this plugin's own start sequence caused the recording being
  // announced: `starting` is not a state to attach a second capture from.
  if (!canStartCapture(state)) return IGNORE;
  switch (beginMode(mode)) {
    case "meeting":
      return { kind: "attach", signal: "toggle-transcription" };
    case "assisted-notes":
      return { kind: "attach", signal: "toggle-assisted-notes" };
    default:
      // `dictation`, absent, or anything the wire produced that this build does not know.
      return IGNORE;
  }
}

/**
 * The trust boundary for `record.mode`, which arrives as `any` from an untyped
 * `EventEmitter` listener. Core already drops a mode it does not recognize, so in practice
 * this only ever sees a valid value or nothing — but "in practice" is not a check, and the
 * cost of being wrong here is a dictated sentence written into someone's meeting note.
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

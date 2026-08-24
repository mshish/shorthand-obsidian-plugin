/**
 * Which enhancement a command should run on the active note.
 *
 * This lives here rather than in `main.ts` because `node_modules/obsidian` has `"main": ""`
 * and ships only type declarations: nothing in `main.ts` can be imported under `bun test`,
 * so a rule written there is a rule with no test. `main.ts` keeps the wiring; the choice
 * between the three sources of text lives here.
 */

export type EnhanceCommandId = "enhance-now" | "clean-up-this-note";

export type EnhanceRequest = Readonly<{
  command: EnhanceCommandId;
  /**
   * A capture is running on *this* note. Deliberately separate from `captureEnhancerReady`:
   * `startCaptureOnActiveNote` keeps a capture alive when `createEnhancer` throws, recording
   * the reason in `enhancementUnavailable` (main.ts:267–276). Deriving this from
   * `capture.enhancer !== undefined` would read that capture as absent and let a second,
   * standalone enhancer start writing the note the live capture already owns.
   */
  captureOnThisNote: boolean;
  /** Whether that capture actually has a runner. False when enhancer construction failed. */
  captureEnhancerReady: boolean;
  /** The vault-relative `shorthand-transcript` target, or undefined when the note has none. */
  transcriptLink: string | undefined;
  writeTranscriptNote: boolean;
}>;

const ENHANCE_COMMAND_NAMES: Readonly<Record<EnhanceCommandId, string>> = {
  "enhance-now": "Enhance now",
  "clean-up-this-note": "Clean up this note",
};

/**
 * The command palette name for an `EnhanceCommandId`, exactly as `main.ts` registers it.
 * A `Record`, not a ternary, so a third command id is a compile error here rather than a
 * silently wrong name — the same reason `onEnhanceStatus` in `main.ts` switches on `never`.
 */
export function enhanceCommandName(command: EnhanceCommandId): string {
  return ENHANCE_COMMAND_NAMES[command];
}

export type EnhanceMode =
  /** Reuse the capture's own runner: its buffered transcript is newer than any sidecar on disk. */
  | Readonly<{ kind: "live-capture" }>
  | Readonly<{ kind: "transcript"; transcriptLink: string }>
  /** No transcript, on purpose: enhance the note's own prose. */
  | Readonly<{ kind: "notes-only" }>
  | Readonly<{ kind: "unavailable"; message: string }>;

export function resolveEnhanceMode(request: EnhanceRequest): EnhanceMode {
  if (request.command === "clean-up-this-note") {
    // Both refusals name the other command instead of quietly doing something else: a
    // notes-only pass over a note that has a transcript would drop text the user recorded.
    if (request.captureOnThisNote) {
      // Two refusals, not one. Pointing the user at "Enhance now" when this capture has no
      // runner sends them to a command that refuses for the same reason — a dead end dressed
      // up as guidance. Name the action that actually unblocks them.
      return {
        kind: "unavailable",
        message: request.captureEnhancerReady
          ? "Shorthand is capturing this note. Run \"Enhance now\" to fold in the transcript so far."
          : "Shorthand is capturing this note but could not start enhancement. Stop the capture, then run this command again.",
      };
    }
    if (request.transcriptLink !== undefined) {
      return {
        kind: "unavailable",
        message: "This note has a transcript. Run \"Enhance now\" so the transcript is used.",
      };
    }
    return { kind: "notes-only" };
  }
  if (request.captureOnThisNote) {
    if (request.captureEnhancerReady) return { kind: "live-capture" };
    // A capture with no runner. Refusing is the only safe answer: falling through would start
    // a second enhancer against a note the capture is still writing, and the two would race.
    // The user's route out is to stop the capture, which is what the message says.
    return {
      kind: "unavailable",
      message: "Shorthand is capturing this note but could not start enhancement. Stop the capture, then run this command again.",
    };
  }
  if (request.transcriptLink !== undefined) {
    return { kind: "transcript", transcriptLink: request.transcriptLink };
  }
  return {
    kind: "unavailable",
    message: request.writeTranscriptNote
      ? "This note has no shorthand-transcript wikilink. Start capture once to create and link a sidecar, or run \"Clean up this note\" to enhance the note as written."
      : "This note has no shorthand-transcript wikilink, and \"Transcript notes\" is off. Turn it on in Shorthand settings and start capture once, or run \"Clean up this note\" to enhance the note as written.",
  };
}

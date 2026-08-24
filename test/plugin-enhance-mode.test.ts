import { describe, expect, test } from "bun:test";
import { resolveEnhanceMode } from "../src/enhance-mode.js";

describe("enhancement mode selection", () => {
  test("a live capture on this note outranks the sidecar that capture is writing", () => {
    expect(resolveEnhanceMode({
      command: "enhance-now",
      captureOnThisNote: true,
      captureEnhancerReady: true,
      transcriptLink: "Transcripts/2026-08-24-1200",
      writeTranscriptNote: true,
    })).toEqual({ kind: "live-capture" });
  });

  // A capture survives a failed createEnhancer (main.ts:267–276), so this state is reachable.
  // Both commands must refuse it. Falling through would run a standalone enhancer against a
  // note the live capture is still writing, and nothing downstream arbitrates between them.
  test("a capture whose enhancer failed refuses Enhance now rather than starting a second one", () => {
    const mode = resolveEnhanceMode({
      command: "enhance-now",
      captureOnThisNote: true,
      captureEnhancerReady: false,
      transcriptLink: "Transcripts/2026-08-24-1200",
      writeTranscriptNote: true,
    });
    expect(mode.kind).toBe("unavailable");
    expect(mode).toHaveProperty("message", expect.stringContaining("Stop the capture"));
  });

  test("a capture whose enhancer failed refuses Clean up this note without a dead-end pointer", () => {
    const mode = resolveEnhanceMode({
      command: "clean-up-this-note",
      captureOnThisNote: true,
      captureEnhancerReady: false,
      transcriptLink: undefined,
      writeTranscriptNote: false,
    });
    expect(mode.kind).toBe("unavailable");
    expect(mode).not.toEqual({ kind: "notes-only" });
    // Must not send the user to a command that refuses for the same reason.
    expect(mode).toHaveProperty("message", expect.stringContaining("Stop the capture"));
    expect(mode).toHaveProperty("message", expect.not.stringContaining("Enhance now"));
  });

  test("a healthy capture still points Clean up this note at Enhance now", () => {
    const mode = resolveEnhanceMode({
      command: "clean-up-this-note",
      captureOnThisNote: true,
      captureEnhancerReady: true,
      transcriptLink: undefined,
      writeTranscriptNote: false,
    });
    expect(mode.kind).toBe("unavailable");
    expect(mode).toHaveProperty("message", expect.stringContaining("Enhance now"));
  });

  test("without a capture, a linked transcript is the source", () => {
    expect(resolveEnhanceMode({
      command: "enhance-now",
      captureOnThisNote: false,
      captureEnhancerReady: false,
      transcriptLink: "Transcripts/2026-08-24-1200",
      writeTranscriptNote: true,
    })).toEqual({ kind: "transcript", transcriptLink: "Transcripts/2026-08-24-1200" });
  });

  test("Enhance now on a note with no transcript names the command that does work", () => {
    const mode = resolveEnhanceMode({
      command: "enhance-now",
      captureOnThisNote: false,
      captureEnhancerReady: false,
      transcriptLink: undefined,
      writeTranscriptNote: true,
    });
    expect(mode.kind).toBe("unavailable");
    expect(mode).toHaveProperty("message", expect.stringContaining("Clean up this note"));
  });

  // The setting is off, so "start capture once" alone would send the user in a circle:
  // no sidecar would be written and the same message would come back.
  test("Enhance now says which setting is off when transcript notes are disabled", () => {
    const mode = resolveEnhanceMode({
      command: "enhance-now",
      captureOnThisNote: false,
      captureEnhancerReady: false,
      transcriptLink: undefined,
      writeTranscriptNote: false,
    });
    expect(mode.kind).toBe("unavailable");
    expect(mode).toHaveProperty("message", expect.stringContaining("Transcript notes"));
    expect(mode).toHaveProperty("message", expect.stringContaining("Clean up this note"));
  });

  test("Clean up this note enhances a hand-written note with no transcript", () => {
    expect(resolveEnhanceMode({
      command: "clean-up-this-note",
      captureOnThisNote: false,
      captureEnhancerReady: false,
      transcriptLink: undefined,
      writeTranscriptNote: true,
    })).toEqual({ kind: "notes-only" });
  });

  // "Transcript notes" governs what a future capture writes. It says nothing about
  // whether this note can be cleaned up right now, so it must not reach this decision.
  test("Clean up this note ignores the transcript-note setting entirely", () => {
    expect(resolveEnhanceMode({
      command: "clean-up-this-note",
      captureOnThisNote: false,
      captureEnhancerReady: false,
      transcriptLink: undefined,
      writeTranscriptNote: false,
    })).toEqual({ kind: "notes-only" });
  });

  // Silently discarding a transcript the user already has is the failure this prevents.
  test("Clean up this note refuses a note that has a transcript, and names Enhance now", () => {
    const mode = resolveEnhanceMode({
      command: "clean-up-this-note",
      captureOnThisNote: false,
      captureEnhancerReady: false,
      transcriptLink: "Transcripts/2026-08-24-1200",
      writeTranscriptNote: true,
    });
    expect(mode.kind).toBe("unavailable");
    expect(mode).toHaveProperty("message", expect.stringContaining("Enhance now"));
  });

  test("Clean up this note refuses a note that is being captured, and names Enhance now", () => {
    const mode = resolveEnhanceMode({
      command: "clean-up-this-note",
      captureOnThisNote: true,
      captureEnhancerReady: true,
      transcriptLink: undefined,
      writeTranscriptNote: true,
    });
    expect(mode.kind).toBe("unavailable");
    expect(mode).toHaveProperty("message", expect.stringContaining("Enhance now"));
  });
});

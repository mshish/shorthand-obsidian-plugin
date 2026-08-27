import { describe, expect, test } from "bun:test";
import type { TFile } from "obsidian";
import { ensureTranscriptLink, preflightMarkers, type TranscriptLinkApi } from "../src/obsidian-note-setup.js";
import type { ObsidianNoteSink } from "../src/obsidian-note-sink.js";

const START = "<!-- shorthand:ai:start -->";
const END = "<!-- shorthand:ai:end -->";
const CANDIDATE = "Transcripts/2026-08-27 100000";

describe("preflightMarkers", () => {
  test("reports a well-formed note as ready", async () => {
    expect(await preflightMarkers(sink(`# Meeting\n\n${START}\n## Summary\n${END}\n`)))
      .toEqual({ status: "ready" });
  });

  test("asks for scaffolding when the note has no markers", async () => {
    expect(await preflightMarkers(sink("# Meeting\n\nJust prose.\n")))
      .toEqual({ status: "needs-scaffold" });
  });

  test("fails on a malformed marker pair rather than repairing it", async () => {
    const result = await preflightMarkers(sink(`# Meeting\n\n${END}\n${START}\n`));
    expect(result.status).toBe("error");
  });

  test("passes a read failure through untouched", async () => {
    const result = await preflightMarkers({
      readContent: async () => ({ ok: false, message: "The meeting note was deleted." }),
    } as unknown as ObsidianNoteSink);
    expect(result).toEqual({ status: "error", message: "The meeting note was deleted." });
  });
});

describe("ensureTranscriptLink", () => {
  test("writes the generated candidate when the property is absent", async () => {
    const note = fakeFile("Meeting.md");
    const frontmatter: Record<string, unknown> = {};
    const result = await ensureTranscriptLink(api(frontmatter), note, CANDIDATE);

    expect(result).toMatchObject({ status: "linked", linkPath: CANDIDATE });
    expect(frontmatter["shorthand-transcript"]).toBe(`[[${CANDIDATE}]]`);
  });

  test("adopts an existing link, including an aliased one", async () => {
    const note = fakeFile("Meeting.md");
    const frontmatter: Record<string, unknown> = { "shorthand-transcript": "[[Transcripts/Older|Last week]]" };
    const result = await ensureTranscriptLink(api(frontmatter), note, CANDIDATE);

    expect(result).toMatchObject({ status: "linked", linkPath: "Transcripts/Older" });
    expect(frontmatter["shorthand-transcript"]).toBe("[[Transcripts/Older|Last week]]");
  });

  test("lets a concurrently written link win", async () => {
    const note = fakeFile("Meeting.md");
    const frontmatter: Record<string, unknown> = {};
    // Obsidian may run the callback more than once; the second run sees what the
    // other writer committed, and that value is the one that must be kept.
    const result = await ensureTranscriptLink({
      ...api(frontmatter),
      fileManager: {
        processFrontMatter: async (_file, transform) => {
          transform(frontmatter);
          frontmatter["shorthand-transcript"] = "[[Transcripts/Someone else]]";
          transform(frontmatter);
        },
      },
    }, note, CANDIDATE);

    expect(result).toMatchObject({ status: "linked", linkPath: "Transcripts/Someone else" });
    expect(frontmatter["shorthand-transcript"]).toBe("[[Transcripts/Someone else]]");
  });

  test.each([
    ["a list", ["[[Transcripts/Older]]"]],
    ["a bare path", "Transcripts/Older.md"],
    ["a nested value", { link: "[[Transcripts/Older]]" }],
    ["a number", 42],
  ])("refuses to overwrite %s already in the property", async (_label, value) => {
    const note = fakeFile("Meeting.md");
    const frontmatter: Record<string, unknown> = { "shorthand-transcript": value };
    const result = await ensureTranscriptLink(api(frontmatter), note, CANDIDATE);

    expect(result.status).toBe("error");
    // Whatever it is, it points somewhere. Replacing it would orphan that note.
    expect(frontmatter["shorthand-transcript"]).toEqual(value);
  });

  test("treats an empty property as absent", async () => {
    const note = fakeFile("Meeting.md");
    const frontmatter: Record<string, unknown> = { "shorthand-transcript": "  " };
    const result = await ensureTranscriptLink(api(frontmatter), note, CANDIDATE);

    expect(result).toMatchObject({ status: "linked", linkPath: CANDIDATE });
    expect(frontmatter["shorthand-transcript"]).toBe(`[[${CANDIDATE}]]`);
  });

  test("reports malformed YAML instead of writing through it", async () => {
    const note = fakeFile("Meeting.md");
    const result = await ensureTranscriptLink({
      fileManager: {
        processFrontMatter: async () => { throw new Error("YAMLParseError: bad indentation"); },
      },
      metadataCache: { getFirstLinkpathDest: () => null },
    } as unknown as TranscriptLinkApi, note, CANDIDATE);

    expect(result).toMatchObject({ status: "error" });
    if (result.status !== "error") return;
    expect(result.message).toContain("bad indentation");
  });

  test("resolves the chosen link through the metadata cache", async () => {
    const note = fakeFile("Meeting.md");
    const resolved = fakeFile("Transcripts/Older.md");
    const frontmatter: Record<string, unknown> = { "shorthand-transcript": "[[Older]]" };
    const asked: string[] = [];
    const result = await ensureTranscriptLink({
      fileManager: {
        processFrontMatter: async (_file: TFile, transform: (value: Record<string, unknown>) => void) => {
          transform(frontmatter);
        },
      },
      metadataCache: {
        getFirstLinkpathDest: (link: string) => {
          asked.push(link);
          return resolved;
        },
      },
    } as unknown as TranscriptLinkApi, note, CANDIDATE);

    expect(asked).toEqual(["Older"]);
    expect(result).toMatchObject({ status: "linked", linkPath: "Older", target: resolved });
  });
});

function api(frontmatter: Record<string, unknown>): TranscriptLinkApi {
  return {
    fileManager: {
      processFrontMatter: async (_file: TFile, transform: (value: Record<string, unknown>) => void) => {
        transform(frontmatter);
      },
    },
    metadataCache: { getFirstLinkpathDest: () => null },
  } as unknown as TranscriptLinkApi;
}

function sink(content: string): ObsidianNoteSink {
  return { readContent: async () => ({ ok: true, content }) } as unknown as ObsidianNoteSink;
}

function fakeFile(path: string): TFile {
  return { path } as unknown as TFile;
}

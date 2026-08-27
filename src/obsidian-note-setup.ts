import type { MetadataCache, TFile } from "obsidian";
import { locateAiBlock } from "shorthand-core/markdown";
import type { Section } from "shorthand-core";
import type { ObsidianNoteSink } from "./obsidian-note-sink.js";

export type TranscriptLinkApi = Readonly<{
  fileManager: Readonly<{
    processFrontMatter(file: TFile, transform: (frontmatter: Record<string, unknown>) => void): Promise<void>;
  }>;
  metadataCache: Pick<MetadataCache, "getFirstLinkpathDest">;
}>;

export type MarkerPreflight =
  | Readonly<{ status: "ready" | "needs-scaffold" }>
  | Readonly<{ status: "error"; message: string }>;

export type TranscriptLinkResult =
  | Readonly<{ status: "linked"; linkPath: string; target: TFile | null }>
  | Readonly<{ status: "error"; message: string }>;

/**
 * Inspect markers before the confirmation, frontmatter, or scaffold writes.
 * A malformed ownership boundary is never repaired implicitly.
 */
export async function preflightMarkers(sink: ObsidianNoteSink): Promise<MarkerPreflight> {
  const source = await sink.readContent();
  if (!source.ok) return { status: "error", message: source.message };
  const located = locateAiBlock(source.content);
  if (located.ok) return { status: "ready" };
  if (located.error.code === "markers-missing") return { status: "needs-scaffold" };
  return { status: "error", message: located.error.message };
}

export async function scaffoldAfterPreflight(
  sink: ObsidianNoteSink,
  sections: readonly Section[],
): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; message: string }>> {
  const result = await sink.scaffold(sections);
  return result.status === "error" ? { ok: false, message: result.message } : { ok: true };
}

/**
 * Add the generated candidate only when the property is absent. `processFrontMatter`
 * serializes this atomically with concurrent metadata writers; the callback's observed
 * value means a concurrent valid link always wins.
 *
 * A property that is present but not a wikilink is left exactly as the user wrote it.
 * Unparseable is not the same as absent: a list of links, a bare path, or a link with a
 * `#section` subpath are all things a person may reasonably have put there, and each of
 * them points somewhere. Overwriting one would orphan the transcript it names.
 */
export async function ensureTranscriptLink(
  api: TranscriptLinkApi,
  file: TFile,
  candidate: string,
): Promise<TranscriptLinkResult> {
  let chosen: string | undefined;
  let occupied: unknown;
  try {
    await api.fileManager.processFrontMatter(file, (frontmatter) => {
      // Reset per invocation: Obsidian may run this callback more than once.
      chosen = undefined;
      occupied = undefined;
      const existing = readFrontmatterLink(frontmatter["shorthand-transcript"]);
      if (existing.kind === "link") {
        chosen = existing.link;
        return;
      }
      if (existing.kind === "occupied") {
        occupied = frontmatter["shorthand-transcript"];
        return;
      }
      chosen = candidate;
      frontmatter["shorthand-transcript"] = `[[${candidate}]]`;
    });
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
  if (occupied !== undefined) {
    return {
      status: "error",
      message: `This note's shorthand-transcript property is not a wikilink (${describe(occupied)}). `
        + "Point it at a transcript note as [[Folder/Note]], or clear it, then start capture again.",
    };
  }
  if (chosen === undefined) return { status: "error", message: "Obsidian did not return a transcript link." };
  // Link resolution belongs to MetadataCache: a link may be aliased or point at
  // a renamed note, neither of which can be resolved by filesystem path joins.
  return {
    status: "linked",
    linkPath: chosen,
    target: api.metadataCache.getFirstLinkpathDest(chosen, file.path),
  };
}

type FrontmatterLink =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "link"; link: string }>
  /** Present, but nothing we may safely replace. */
  | Readonly<{ kind: "occupied" }>;

function readFrontmatterLink(value: unknown): FrontmatterLink {
  if (value === undefined || value === null) return { kind: "absent" };
  if (typeof value !== "string") return { kind: "occupied" };
  if (value.trim().length === 0) return { kind: "absent" };
  const parsed = /^\s*\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*$/.exec(value)?.[1]?.trim();
  return parsed === undefined || parsed.length === 0 ? { kind: "occupied" } : { kind: "link", link: parsed };
}

function describe(value: unknown): string {
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "a nested value";
  return `"${String(value)}"`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

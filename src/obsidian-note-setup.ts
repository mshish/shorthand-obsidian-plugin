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
 */
export async function ensureTranscriptLink(
  api: TranscriptLinkApi,
  file: TFile,
  candidate: string,
): Promise<TranscriptLinkResult> {
  let chosen: string | undefined;
  try {
    await api.fileManager.processFrontMatter(file, (frontmatter) => {
      const existing = frontmatterLink(frontmatter["shorthand-transcript"]);
      if (existing !== undefined) {
        chosen = existing;
        return;
      }
      chosen = candidate;
      frontmatter["shorthand-transcript"] = `[[${candidate}]]`;
    });
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
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

function frontmatterLink(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = /^\s*\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*$/.exec(value)?.[1]?.trim();
  return parsed === undefined || parsed.length === 0 ? undefined : parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Every settings-tab string computed from a stored value, and nothing else.
 *
 * These live here rather than beside their `Setting` in `main.ts` because
 * `node_modules/obsidian` has `"main": ""` and ships only type declarations, so nothing in
 * `main.ts` can be imported under `bun test`. A string built there is a string with no test.
 *
 * See `docs/settings-copy-style.md` § rule 4 for when a row shows its value instead of
 * describing itself, and § rule 2 for why several of these return `""`.
 */

/**
 * Empty normalizes to the bare command `shorthand`, which resolves only through PATH — the
 * one thing the text field cannot show. A full path needs no description: it is already on
 * screen in the field.
 */
export function shorthandExecutableDescription(stored: string): string {
  const trimmed = stored.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.includes("/") || trimmed.includes("\\")) return "";
  return `${trimmed} is looked up on your PATH.`;
}

/** Empty means core detects the CLI itself, and the path it finds is shown nowhere. */
export function claudeExecutableDescription(stored: string): string {
  return stored.trim().length === 0 ? "Claude is found automatically." : "";
}

/**
 * Rendered from the stored folder, not the typed one: `normalizePluginSettings` rejects
 * absolute, drive-letter and traversing paths back to the default, so the field and the
 * folder in force can legitimately disagree.
 */
export function transcriptFolderDescription(folder: string): string {
  return `New transcript notes go in ${folder}.`;
}

export function newCharacterThresholdDescription(characters: number): string {
  const safe = Number.isFinite(characters) && characters >= 1 ? Math.floor(characters) : 1;
  return safe === 1
    ? "A live pass waits until 1 new character of transcript has arrived."
    : `A live pass waits until ${safe} new characters of transcript have arrived.`;
}

/**
 * The field holds milliseconds, so the sentence has to say so; `25000` on its own is not a
 * duration anyone reads. Zero is a legal stored value and gets its own sentence rather than
 * "once every 0 seconds".
 */
export function passIntervalDescription(milliseconds: number): string {
  const unit = "The value is in milliseconds.";
  const safe = Number.isFinite(milliseconds) && milliseconds >= 1 ? Math.floor(milliseconds) : 0;
  return safe === 0
    ? `Live passes run with no minimum gap between them. ${unit}`
    : `Live passes run no more often than once every ${formatDuration(safe)}. ${unit}`;
}

export function baseUrlDescription(provider: string): string {
  return provider === "openai-compatible"
    ? "Required. The provider name alone does not identify an endpoint."
    : "Optional. Leave it blank unless you route through a gateway or proxy.";
}

export type StoredKeyState = "stored" | "absent" | "unknown";

export function apiKeyDescription(state: StoredKeyState): string {
  // The blank/replace/clear tail answers "what happens if I leave this blank", which is a real
  // question only while a key exists that the password field cannot show. With nothing stored,
  // blank keeps nothing and Clear key removes nothing, so the tail would offer three actions
  // the state does not have and contradict the sentence in front of it.
  if (state === "absent") return "No key is stored.";
  const stored = state === "stored" ? "A key is stored." : "The stored key cannot be read.";
  return `${stored} Blank keeps the stored key, a new value replaces it, and Clear key removes it.`;
}

/** Callers clamp to >= 1 first, so this never has to render a zero duration. */
function formatDuration(milliseconds: number): string {
  // countOf, not a bare template. 1 is reachable — the field's floor is 1ms, not 1000 — and
  // "1 milliseconds" is the sort of thing a user reads as sloppiness in the whole plugin.
  if (milliseconds < 1000) return countOf(milliseconds, "millisecond");
  const totalSeconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return countOf(seconds, "second");
  if (seconds === 0) return countOf(minutes, "minute");
  return `${countOf(minutes, "minute")} ${countOf(seconds, "second")}`;
}

function countOf(count: number, unit: string): string {
  return count === 1 ? `1 ${unit}` : `${count} ${unit}s`;
}

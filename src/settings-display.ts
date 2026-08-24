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
 * `normalizePluginSettings` never stores a blank `shorthandExecutable` — a cleared field
 * normalizes back to the bare command `shorthand` — so `shorthandCommand()` in `main.ts`
 * always passes an explicit override to `detectShorthandExecutable`, and a bare command name
 * resolves relative to Obsidian's working directory, never through PATH. That resolution is
 * tracked as a separate bug; until it's fixed, this row has no true, useful sentence to show,
 * so it gets none (settings-copy-style.md rule 2) rather than one that documents the bug.
 */
export function shorthandExecutableDescription(_stored: string): string {
  return "";
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
  // The blank/replace/clear tail belongs to exactly one state. It answers "what happens if I
  // leave this blank", which is a real question only where a key exists that the password field
  // cannot show and all three actions can be taken. With nothing stored, blank keeps nothing and
  // Clear key removes nothing. When the profile cannot be read, the caller disables the field
  // and the Clear key button before this renders, so none of the three is available while the
  // sentence is on screen — and Discard file, the one action that state does offer, is described
  // on the row that owns the button.
  if (state === "absent") return "No key is stored.";
  if (state === "unknown") return "The stored key cannot be read.";
  return "A key is stored. Blank keeps the stored key, a new value replaces it, and Clear key removes it.";
}

/** Callers clamp to >= 1 first, so this never has to render a zero duration. */
function formatDuration(milliseconds: number): string {
  // countOf, not a bare template. 1 is reachable — the field's floor is 1ms, not 1000 — and
  // "1 milliseconds" is the sort of thing a user reads as sloppiness in the whole plugin.
  //
  // Milliseconds are also the fallback for anything that is not a whole number of seconds.
  // Seconds and minutes are only reached where the conversion is exact, so the sentence can
  // never name a number the user did not enter: rounding 1500 to "2 seconds" reports a
  // different value than the one in force, which is the opposite of what rule 4 is for. The
  // round values people actually type still read as seconds and minutes.
  if (milliseconds % 1000 !== 0) return countOf(milliseconds, "millisecond");
  const totalSeconds = milliseconds / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return countOf(seconds, "second");
  if (seconds === 0) return countOf(minutes, "minute");
  return `${countOf(minutes, "minute")} ${countOf(seconds, "second")}`;
}

function countOf(count: number, unit: string): string {
  return count === 1 ? `1 ${unit}` : `${count} ${unit}s`;
}

/**
 * Formats an elapsed duration (in milliseconds) for display in the status bar.
 *
 * Under one hour: `m:ss` (minutes not padded, seconds zero-padded to 2 digits).
 * One hour or more: `h:mm:ss` (hours not padded, minutes and seconds zero-padded to 2 digits).
 * Negative or non-finite input is clamped to `0` — a clock reading should never look broken
 * even if a caller passes a bad value.
 */
export function formatElapsed(ms: number): string {
  const safeMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSeconds = Math.floor(safeMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  const pad = (value: number): string => value.toString().padStart(2, "0");

  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${minutes}:${pad(seconds)}`;
}

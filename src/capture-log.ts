import type { ControlResult } from "shorthand-core";
import type { RecorderPhase, RecorderStartFailure, RecorderStopOutcome } from "./recorder.js";

/**
 * One-line renderings of everything the capture's recorder-driving half does, for the
 * developer console when Debug logging is on.
 *
 * It exists because the capture state machine had exactly one observable channel — a notice,
 * shown only for a control signal that failed — so every ordinary transition was invisible.
 * When a stop misbehaved, the only evidence was the user's recollection of which notice
 * appeared, which is not enough to tell a refused start from a silent one, or a finalize that
 * landed from one that was never sent.
 *
 * Deliberately in its own module rather than inline in `main.ts`: `node_modules/obsidian`
 * ships types only, so nothing in `main.ts` can be imported under `bun test` (AGENTS.md), and
 * a rendering nobody can test is exactly the kind of thing that goes stale.
 */

/**
 * The subset of a wire record this renders. Structural rather than `shorthand-core`'s own
 * record union, for the same reason `ShorthandRecorder`'s `ObservedRecord` is: this module
 * must not have to widen every time the protocol grows a field it does not print.
 */
export type LoggableRecord = {
  t: string;
  session?: number | undefined;
  mode?: string | undefined;
  phase?: string | undefined;
  publishing?: boolean | undefined;
  reason?: string | undefined;
  code?: string | undefined;
  message?: string | undefined;
  speaker?: string | undefined;
};

/**
 * `partial` is the transcript itself, arriving several times a second; logging it would bury
 * the lifecycle records this exists to make visible, and the transcript is already written to
 * the note and the sidecar. Everything else is a lifecycle event and is worth a line.
 */
const HIGH_FREQUENCY_RECORDS: ReadonlySet<string> = new Set(["partial"]);

export function isLoggableRecord(record: LoggableRecord): boolean {
  return !HIGH_FREQUENCY_RECORDS.has(record.t);
}

/**
 * A record as one line, with the fields that decide behaviour and none of the transcript
 * text. `final` carries the whole corrected transcript and `partial` a running prefix of it;
 * neither belongs in a log line, and the note is where that text is meant to end up.
 */
export function describeRecord(record: LoggableRecord): string {
  const fields: string[] = [];
  if (record.session !== undefined) fields.push(`session=${record.session}`);
  if (record.mode !== undefined) fields.push(`mode=${record.mode}`);
  if (record.phase !== undefined) fields.push(`phase=${record.phase}`);
  if (record.publishing !== undefined) fields.push(`publishing=${record.publishing}`);
  if (record.speaker !== undefined) fields.push(`speaker=${record.speaker}`);
  if (record.reason !== undefined) fields.push(`reason=${record.reason}`);
  if (record.code !== undefined) fields.push(`code=${record.code}`);
  if (record.message !== undefined) fields.push(`message=${JSON.stringify(record.message)}`);
  return fields.length === 0 ? record.t : `${record.t} ${fields.join(" ")}`;
}

/** A control signal's outcome, named by the sequence it belonged to. */
export function describeControl(phase: RecorderPhase | "manual", result: ControlResult): string {
  return result.status === "error"
    ? `control ${phase}: error ${JSON.stringify(result.message)}`
    : `control ${phase}: ${result.status}`;
}

/**
 * How a start sequence ended. `failure` is what tells an unsupported app, a refusal and a
 * silent one apart, and it is exactly the distinction a notice alone could not preserve.
 */
export function describeStart(outcome: string, failure: RecorderStartFailure | undefined): string {
  if (failure === undefined) return `start: ${outcome}`;
  switch (failure.kind) {
    case "refused":
      return `start: ${outcome} (refused, reason=${failure.reason})`;
    case "start-failed":
      return `start: ${outcome} (start-failed, code=${failure.code ?? "none"}, message=${JSON.stringify(failure.message)})`;
    default:
      return `start: ${outcome} (${failure.kind})`;
  }
}

export function describeStop(outcome: RecorderStopOutcome): string {
  return `stop: ${outcome}`;
}

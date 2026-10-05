import type { CatalogFailureReason } from "shorthand-core";
import type { EnhancementBackend, ShorthandPluginSettings } from "./settings.js";

/**
 * The check behind the panel's note-taker line: whether the program behind the selected backend
 * is signed in and reachable. The state machine lives here rather than in `main.ts` (which
 * `bun test` cannot import) so it has tests; what the panel says about each state is in
 * `note-taker-view.ts`.
 *
 * The probe is core's catalog fetch (`listClaudeModels`, `listCodexModels`, `listAcpModels`),
 * the same one the settings tab runs. It spawns a subprocess and takes up to
 * `CATALOG_TIMEOUT_MS`, so it is cached here and re-run only on an explicit trigger, never per
 * render, and nothing in capture waits on it.
 */

/**
 * The choices as a person reads them, in the order they are offered. One list for the panel's
 * menu and the settings tab's dropdown, so a new backend cannot reach one and not the other.
 * Each name says what the user gets, not the protocol behind it: "Claude" is the Claude Code
 * program signed in to a Claude account; "ChatGPT (Codex)" is the Codex program signed in to a
 * ChatGPT account; "Another app (ACP)" is any program that speaks the Agent Client Protocol;
 * "Your own API key" is a model provider reached with a key the user supplies.
 */
export const BACKEND_DISPLAY_NAMES: Record<EnhancementBackend, string> = {
  "claude-agent-sdk": "Claude",
  codex: "ChatGPT (Codex)",
  cursor: "Cursor",
  acp: "Another app (ACP)",
  llm: "Your own API key",
};

type ProbeSettings = Pick<
  ShorthandPluginSettings,
  | "backend" | "claudeExecutable" | "codexExecutable" | "cursorExecutable"
  | "acpTransport" | "acpExecutable" | "acpArgs"
>;

type ModelSettings = Pick<
  ShorthandPluginSettings,
  "backend" | "claudeModel" | "codexModel" | "cursorModel" | "acpModel" | "acpTransport" | "llmModel"
>;

/**
 * Identifies one probe: the backend plus the settings that change which program is asked.
 * `undefined` means there is nothing to ask. The LLM backend has no CLI to sign in to (its
 * credentials are checked where they are stored, see the settings tab), and an ACP network
 * endpoint or an ACP row with no executable has no subprocess to spawn.
 *
 * A model change is not part of the key: the catalog does not depend on which model is chosen.
 */
export function probeKey(settings: ProbeSettings): string | undefined {
  switch (settings.backend) {
    case "claude-agent-sdk":
      return `claude-agent-sdk\0${settings.claudeExecutable}`;
    case "codex":
      return `codex\0${settings.codexExecutable}`;
    case "cursor":
      return `cursor\0${settings.cursorExecutable}`;
    case "acp":
      if (settings.acpTransport === "network" || settings.acpExecutable.trim().length === 0) return undefined;
      return `acp\0${settings.acpExecutable.trim()}\0${settings.acpArgs.trim()}`;
    case "llm":
      return undefined;
  }
}

export type ProbeState =
  | Readonly<{ kind: "unprobed" }>
  | Readonly<{ kind: "checking"; key: string; token: number }>
  | Readonly<{ kind: "signed-in"; key: string; account: string | undefined }>
  | Readonly<{ kind: "signed-out"; key: string }>
  | Readonly<{ kind: "failed"; key: string; reason: CatalogFailureReason; message: string | undefined }>;

export const INITIAL_PROBE_STATE: ProbeState = { kind: "unprobed" };

export type ProbeEvent =
  | Readonly<{ type: "probe-started"; key: string; token: number }>
  | Readonly<{ type: "probe-succeeded"; token: number; signedIn: boolean; account: string | undefined }>
  | Readonly<{ type: "probe-failed"; token: number; reason: CatalogFailureReason; message: string | undefined }>
  /** The selection no longer has anything to probe. */
  | Readonly<{ type: "probe-cleared" }>;

/**
 * Results carry the token of the probe that produced them and apply only to the probe still
 * checking. Without that, a slow Claude probe that resolves after the user switched to Codex
 * would overwrite Codex's state with Claude's sign-in answer.
 */
export function reduceProbeState(state: ProbeState, event: ProbeEvent): ProbeState {
  switch (event.type) {
    case "probe-started":
      return { kind: "checking", key: event.key, token: event.token };
    case "probe-cleared":
      return INITIAL_PROBE_STATE;
    case "probe-succeeded":
      if (state.kind !== "checking" || state.token !== event.token) return state;
      return event.signedIn
        ? { kind: "signed-in", key: state.key, account: event.account }
        : { kind: "signed-out", key: state.key };
    case "probe-failed":
      if (state.kind !== "checking" || state.token !== event.token) return state;
      return { kind: "failed", key: state.key, reason: event.reason, message: event.message };
  }
}

/**
 * Whether the cached state already answers for these settings. "Check connection" bypasses this;
 * everything else (panel open, plugin load, a settings change) goes through it, so repeated
 * triggers for an unchanged selection do not respawn the CLI.
 */
export function needsProbe(state: ProbeState, settings: ProbeSettings): boolean {
  const key = probeKey(settings);
  if (key === undefined) return state.kind !== "unprobed";
  return state.kind === "unprobed" || state.key !== key;
}

/**
 * Whether opening the panel should ask again. Everything `needsProbe` asks for, plus a cached
 * signed-out or failed answer for the current selection: the user fixes those outside the
 * plugin (`claude login`, a reinstall), so the cache only ever goes stale in the direction
 * that keeps showing the warning, and without this the panel would keep saying the note taker
 * cannot take notes until the user found "Check again". A signed-in answer is not
 * re-asked, so opening the panel stays free of a subprocess in the healthy case.
 */
export function needsProbeOnOpen(state: ProbeState, settings: ProbeSettings): boolean {
  if (needsProbe(state, settings)) return true;
  return state.kind === "signed-out" || state.kind === "failed";
}

/**
 * Whether a capture start should re-ask in the background: the cached answer says signed out
 * for the current selection, which is the answer the start Notice would act on, and the user
 * may have signed in since. The start itself does not wait for it.
 */
export function shouldReprobeAtCaptureStart(state: ProbeState, settings: ProbeSettings): boolean {
  const key = probeKey(settings);
  return key !== undefined && state.kind === "signed-out" && state.key === key;
}

/** The stored model id for the selected backend; empty when none is chosen. */
export function selectedModelId(settings: ModelSettings): string {
  switch (settings.backend) {
    case "claude-agent-sdk": return settings.claudeModel;
    case "codex": return settings.codexModel;
    case "cursor": return settings.cursorModel;
    case "acp": return settings.acpTransport === "network" ? "" : settings.acpModel;
    case "llm": return settings.llmModel;
  }
}

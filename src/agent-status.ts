import type { CatalogFailureReason } from "shorthand-core";
import type { EnhancementBackend, ShorthandPluginSettings } from "./settings.js";
import { catalogFetchFailedDescription, type AgentBackendLabel } from "./settings-display.js";

/**
 * The panel's agent line: which backend and model are selected, and whether the CLI behind
 * them is signed in. Everything that decides what to show or say lives here rather than in
 * `main.ts` (which `bun test` cannot import), so the probe's state machine and every warning
 * string have tests.
 *
 * The probe is core's catalog fetch (`listClaudeModels`, `listCodexModels`, `listAcpModels`),
 * the same one the settings tab runs. It spawns a subprocess and takes up to
 * `CATALOG_TIMEOUT_MS`, so it is cached here and re-run only on an explicit trigger, never per
 * render, and nothing in capture waits on it.
 */

export const BACKEND_DISPLAY_NAMES: Record<EnhancementBackend, string> = {
  "claude-agent-sdk": "Claude Code",
  codex: "Codex",
  cursor: "Cursor CLI",
  acp: "Agent Client Protocol (ACP)",
  llm: "LLM provider",
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
 * Whether the cached state already answers for these settings. A refresh control bypasses this;
 * everything else (panel open, plugin load, a settings change) goes through it, so repeated
 * triggers for an unchanged selection do not respawn the CLI.
 */
export function needsProbe(state: ProbeState, settings: ProbeSettings): boolean {
  const key = probeKey(settings);
  if (key === undefined) return state.kind !== "unprobed";
  return state.kind === "unprobed" || state.key !== key;
}

function probeLabel(backend: EnhancementBackend): AgentBackendLabel | undefined {
  switch (backend) {
    case "claude-agent-sdk": return "Claude";
    case "codex": return "Codex";
    case "cursor": return "Cursor CLI";
    case "acp": return "ACP";
    case "llm": return undefined;
  }
}

function loginCommand(backend: EnhancementBackend): string | undefined {
  if (backend === "claude-agent-sdk") return "claude login";
  if (backend === "codex") return "codex login";
  return undefined;
}

/** The stored model id, or the words the settings tab uses for "no override". */
export function selectedModelLabel(settings: ModelSettings): string {
  const stored = (() => {
    switch (settings.backend) {
      case "claude-agent-sdk": return settings.claudeModel;
      case "codex": return settings.codexModel;
      case "cursor": return settings.cursorModel;
      case "acp": return settings.acpTransport === "network" ? "" : settings.acpModel;
      case "llm": return settings.llmModel;
    }
  })();
  return stored.length > 0 ? stored : "Provider default";
}

function signedOutText(backend: EnhancementBackend): string {
  const name = BACKEND_DISPLAY_NAMES[backend];
  const command = loginCommand(backend);
  return command === undefined
    ? `${name} is not signed in. Sign in with its own tool.`
    : `${name} is not signed in. Run ${command} in a terminal, then refresh.`;
}

export type AgentStatusTone = "neutral" | "checking" | "ok" | "warning";

export type AgentStatusModel = Readonly<{
  backendValue: EnhancementBackend;
  backendLabel: string;
  modelLabel: string;
  /** One short line: "Checking…", "Signed in as …", or nothing when no probe applies. */
  statusText: string | undefined;
  tone: AgentStatusTone;
  /** Names the problem and how to fix it. Absent while healthy, checking or not probed. */
  warning: string | undefined;
  /** Shown beside the switcher while a capture is running. */
  switchNote: string | undefined;
  /** Whether a refresh would do anything; false when no probe applies to this selection. */
  canRefresh: boolean;
}>;

export type AgentStatusInput = Readonly<{
  settings: ModelSettings & ProbeSettings;
  probe: ProbeState;
  captureInFlight: boolean;
}>;

export function describeAgentStatus(input: AgentStatusInput): AgentStatusModel {
  const { settings, probe, captureInFlight } = input;
  const backend = settings.backend;
  const key = probeKey(settings);
  // A cached answer for a different selection is not this selection's answer; treat it as
  // not yet probed rather than show another agent's sign-in state under this one's name.
  const current = key !== undefined && probe.kind !== "unprobed" && probe.key === key ? probe : undefined;

  let statusText: string | undefined;
  let tone: AgentStatusTone = "neutral";
  let warning: string | undefined;
  if (key === undefined) {
    statusText = undefined;
  } else if (current === undefined || current.kind === "checking") {
    statusText = "Checking sign-in…";
    tone = "checking";
  } else if (current.kind === "signed-in") {
    statusText = current.account === undefined ? "Signed in" : `Signed in as ${current.account}`;
    tone = "ok";
  } else if (current.kind === "signed-out") {
    statusText = "Not signed in";
    tone = "warning";
    warning = `${signedOutText(backend)} Notes will not be enhanced until then.`;
  } else {
    statusText = "Sign-in check failed";
    tone = "warning";
    const label = probeLabel(backend);
    const reason = label === undefined ? "" : catalogFetchFailedDescription(label, current.reason);
    // The probe's own text names the cause; the fixed sentence names the class of failure.
    const detail = current.message !== undefined && current.message.length > 0 ? ` ${current.message}` : "";
    warning = `${reason}${detail}`.trim();
  }

  return {
    backendValue: backend,
    backendLabel: BACKEND_DISPLAY_NAMES[backend],
    modelLabel: selectedModelLabel(settings),
    statusText,
    tone,
    warning,
    // A running capture built its enhancer from the settings at its start (`createEnhancer`
    // reads them once), so a switch cannot reach it.
    switchNote: captureInFlight ? "Applies to the next capture. The current one keeps its agent." : undefined,
    canRefresh: key !== undefined,
  };
}

/**
 * The Notice shown when a capture starts after the probe said signed out. Only a definite
 * signed-out answer warns: a failed or still-running probe says nothing about the account, and
 * a false alarm at every start would teach users to ignore it. Capture proceeds either way.
 */
export function captureStartNotice(state: ProbeState, settings: ProbeSettings): string | undefined {
  const key = probeKey(settings);
  if (key === undefined || state.kind !== "signed-out" || state.key !== key) return undefined;
  return `Shorthand: ${signedOutText(settings.backend)} Notes will not be enhanced.`;
}

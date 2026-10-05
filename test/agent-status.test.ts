import { describe, expect, test } from "bun:test";
import {
  BACKEND_DISPLAY_NAMES,
  INITIAL_PROBE_STATE,
  needsProbe,
  needsProbeOnOpen,
  shouldReprobeAtCaptureStart,
  probeKey,
  reduceProbeState,
  selectedModelId,
  type ProbeState,
} from "../src/agent-status.js";
import { DEFAULT_PLUGIN_SETTINGS } from "../src/settings.js";

const claude = DEFAULT_PLUGIN_SETTINGS;
const codex = { ...DEFAULT_PLUGIN_SETTINGS, backend: "codex" as const };
const llm = { ...DEFAULT_PLUGIN_SETTINGS, backend: "llm" as const };
const claudeKey = probeKey(claude) ?? "";

// The key is required: a default would silently stand in for Claude's key in a test about
// another selection, and the test would pass for the wrong reason.
const checking = (token: number, key: string): ProbeState => ({ kind: "checking", key, token });
const codexKey = probeKey(codex) ?? "";

describe("reduceProbeState", () => {
  test("moves from checking to the probe's answer", () => {
    expect(reduceProbeState(checking(1, claudeKey), { type: "probe-succeeded", token: 1, signedIn: true, account: "a@b.c" }))
      .toEqual({ kind: "signed-in", key: claudeKey, account: "a@b.c" });
    expect(reduceProbeState(checking(1, claudeKey), { type: "probe-succeeded", token: 1, signedIn: false, account: undefined }))
      .toEqual({ kind: "signed-out", key: claudeKey });
    expect(reduceProbeState(checking(1, claudeKey), { type: "probe-failed", token: 1, reason: "timeout", message: "slow" }))
      .toEqual({ kind: "failed", key: claudeKey, reason: "timeout", message: "slow" });
  });

  test("ignores a result from a probe that has been superseded", () => {
    const now = checking(2, codexKey);
    expect(reduceProbeState(now, { type: "probe-succeeded", token: 1, signedIn: true, account: undefined })).toBe(now);
    expect(reduceProbeState(now, { type: "probe-failed", token: 1, reason: "spawn-failed", message: undefined })).toBe(now);
  });

  test("ignores a result when nothing is checking", () => {
    expect(reduceProbeState(INITIAL_PROBE_STATE, { type: "probe-succeeded", token: 1, signedIn: true, account: undefined }))
      .toBe(INITIAL_PROBE_STATE);
  });

  test("a new start replaces whatever was cached; clearing returns to unprobed", () => {
    const signedOut: ProbeState = { kind: "signed-out", key: claudeKey };
    expect(reduceProbeState(signedOut, { type: "probe-started", key: claudeKey, token: 3 })).toEqual(checking(3, claudeKey));
    expect(reduceProbeState(signedOut, { type: "probe-cleared" })).toEqual(INITIAL_PROBE_STATE);
  });
});

describe("probeKey and needsProbe", () => {
  test("has no key for backends with nothing to ask", () => {
    expect(probeKey(llm)).toBeUndefined();
    expect(probeKey({ ...claude, backend: "acp", acpTransport: "network" })).toBeUndefined();
    expect(probeKey({ ...claude, backend: "acp", acpTransport: "stdio", acpExecutable: " " })).toBeUndefined();
  });

  test("a cached answer for the same selection is reused, a different one is not", () => {
    const cached: ProbeState = { kind: "signed-in", key: claudeKey, account: undefined };
    expect(needsProbe(cached, claude)).toBe(false);
    expect(needsProbe(cached, codex)).toBe(true);
    expect(needsProbe(cached, { ...claude, claudeExecutable: "C:/other/claude.exe" })).toBe(true);
    expect(needsProbe(INITIAL_PROBE_STATE, claude)).toBe(true);
  });

  test("a model change does not invalidate the cache", () => {
    const cached: ProbeState = { kind: "signed-in", key: claudeKey, account: undefined };
    const withModel = { ...claude, claudeModel: "opus" };
    expect(needsProbe(cached, withModel)).toBe(false);
  });

  test("a stale answer is dropped once the selection has nothing to probe", () => {
    expect(needsProbe({ kind: "signed-in", key: claudeKey, account: undefined }, llm)).toBe(true);
    expect(needsProbe(INITIAL_PROBE_STATE, llm)).toBe(false);
  });
});

describe("needsProbeOnOpen", () => {
  test("re-asks a cached signed-out or failed answer, which the user fixes outside the plugin", () => {
    expect(needsProbeOnOpen({ kind: "signed-out", key: claudeKey }, claude)).toBe(true);
    expect(needsProbeOnOpen({ kind: "failed", key: claudeKey, reason: "timeout", message: undefined }, claude)).toBe(true);
    // The ordinary cache hit does not move: a probe spawns a CLI.
    expect(needsProbe({ kind: "signed-out", key: claudeKey }, claude)).toBe(false);
  });

  test("leaves a signed-in or running probe alone, and asks when the selection changed", () => {
    expect(needsProbeOnOpen({ kind: "signed-in", key: claudeKey, account: undefined }, claude)).toBe(false);
    expect(needsProbeOnOpen(checking(1, claudeKey), claude)).toBe(false);
    expect(needsProbeOnOpen({ kind: "signed-in", key: claudeKey, account: undefined }, codex)).toBe(true);
    expect(needsProbeOnOpen(INITIAL_PROBE_STATE, claude)).toBe(true);
  });

  test("never asks when the selection has nothing to probe", () => {
    expect(needsProbeOnOpen(INITIAL_PROBE_STATE, llm)).toBe(false);
  });
});

describe("shouldReprobeAtCaptureStart", () => {
  test("only for a signed-out answer about the current selection", () => {
    expect(shouldReprobeAtCaptureStart({ kind: "signed-out", key: claudeKey }, claude)).toBe(true);
    expect(shouldReprobeAtCaptureStart({ kind: "signed-out", key: claudeKey }, codex)).toBe(false);
    expect(shouldReprobeAtCaptureStart({ kind: "failed", key: claudeKey, reason: "timeout", message: undefined }, claude)).toBe(false);
    expect(shouldReprobeAtCaptureStart({ kind: "signed-in", key: claudeKey, account: undefined }, claude)).toBe(false);
    expect(shouldReprobeAtCaptureStart({ kind: "signed-out", key: "x" }, llm)).toBe(false);
  });
});

describe("selectedModelId", () => {
  test("is the stored id for the selected backend, or empty when none is set", () => {
    expect(selectedModelId(claude)).toBe("");
    expect(selectedModelId({ ...claude, claudeModel: "opus" })).toBe("opus");
    expect(selectedModelId({ ...codex, codexModel: "gpt-5.4" })).toBe("gpt-5.4");
    expect(selectedModelId({ ...claude, backend: "acp", acpTransport: "network", acpModel: "x" })).toBe("");
  });
});

describe("BACKEND_DISPLAY_NAMES", () => {
  test("names every choice as a person would, one list for the panel and the settings tab", () => {
    expect(BACKEND_DISPLAY_NAMES).toEqual({
      "claude-agent-sdk": "Claude",
      codex: "ChatGPT (Codex)",
      cursor: "Cursor",
      acp: "Another app (ACP)",
      llm: "Your own API key",
    });
  });
});

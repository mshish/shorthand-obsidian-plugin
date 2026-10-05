import { describe, expect, test } from "bun:test";
import {
  captureStartNotice,
  describeAgentStatus,
  INITIAL_PROBE_STATE,
  needsProbe,
  needsProbeOnOpen,
  shouldReprobeAtCaptureStart,
  probeKey,
  reduceProbeState,
  selectedModelLabel,
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

describe("describeAgentStatus", () => {
  const describeWith = (probe: ProbeState, settings = claude, captureInFlight = false) =>
    describeAgentStatus({ settings, probe, captureInFlight });

  test("shows checking before any answer, and for another selection's answer", () => {
    expect(describeWith(INITIAL_PROBE_STATE).statusText).toBe("Checking sign-in…");
    expect(describeWith(checking(1, claudeKey)).tone).toBe("checking");
    const codexAnswer: ProbeState = { kind: "signed-out", key: codexKey };
    const model = describeWith(codexAnswer);
    expect(model.tone).toBe("checking");
    expect(model.warning).toBeUndefined();
  });

  test("names the account when signed in", () => {
    const model = describeWith({ kind: "signed-in", key: claudeKey, account: "me@example.com" });
    expect(model.statusText).toBe("Signed in as me@example.com");
    expect(model.tone).toBe("ok");
    expect(model.warning).toBeUndefined();
  });

  test("does not present an ACP or Cursor agent name as the signed-in account", () => {
    const cursor = { ...claude, backend: "cursor" as const };
    const model = describeWith({ kind: "signed-in", key: probeKey(cursor) ?? "", account: "Cursor CLI" }, cursor);
    expect(model.statusText).toBe("Agent responded");
    expect(model.statusText).not.toContain("Signed in as");
  });

  test("tells a signed-out Claude user the command to run", () => {
    const model = describeWith({ kind: "signed-out", key: claudeKey });
    expect(model.tone).toBe("warning");
    expect(model.warning).toContain("claude login");
    expect(model.warning).toContain("not be enhanced");
  });

  test("tells a signed-out Codex user the command to run", () => {
    const model = describeWith({ kind: "signed-out", key: codexKey }, codex);
    expect(model.warning).toContain("codex login");
  });

  test("a failed probe carries the probe's own message", () => {
    const model = describeWith({ kind: "failed", key: claudeKey, reason: "executable-not-found", message: "spawn claude ENOENT" });
    expect(model.warning).toContain("could not find Claude");
    expect(model.warning).toContain("spawn claude ENOENT");
  });

  test("a failed probe without a message still names the problem", () => {
    const model = describeWith({ kind: "failed", key: claudeKey, reason: "timeout", message: undefined });
    expect(model.warning).toBe("Shorthand did not hear back from Claude in time.");
  });

  test("the LLM backend has no probe, no status line and cannot refresh", () => {
    const model = describeWith(INITIAL_PROBE_STATE, llm);
    expect(model.statusText).toBeUndefined();
    expect(model.canRefresh).toBe(false);
  });

  test("says a switch applies to the next capture only while one is running", () => {
    expect(describeWith(INITIAL_PROBE_STATE, claude, false).switchNote).toBeUndefined();
    expect(describeWith(INITIAL_PROBE_STATE, claude, true).switchNote).toContain("next capture");
  });
});

describe("selectedModelLabel", () => {
  test("shows the stored model, or the default wording when none is set", () => {
    expect(selectedModelLabel(claude)).toBe("Provider default");
    expect(selectedModelLabel({ ...claude, claudeModel: "opus" })).toBe("opus");
    expect(selectedModelLabel({ ...codex, codexModel: "gpt-5.4" })).toBe("gpt-5.4");
    expect(selectedModelLabel({ ...claude, backend: "acp", acpTransport: "network", acpModel: "x" })).toBe("Provider default");
  });
});

describe("captureStartNotice", () => {
  test("warns only on a definite signed-out answer for the current selection", () => {
    expect(captureStartNotice({ kind: "signed-out", key: claudeKey }, claude)).toContain("claude login");
    expect(captureStartNotice({ kind: "signed-out", key: claudeKey }, claude)).toContain("will not be enhanced");
    expect(captureStartNotice({ kind: "signed-out", key: claudeKey }, codex)).toBeUndefined();
    expect(captureStartNotice(checking(1, claudeKey), claude)).toBeUndefined();
    expect(captureStartNotice({ kind: "failed", key: claudeKey, reason: "timeout", message: undefined }, claude)).toBeUndefined();
    expect(captureStartNotice({ kind: "signed-in", key: claudeKey, account: undefined }, claude)).toBeUndefined();
  });
});

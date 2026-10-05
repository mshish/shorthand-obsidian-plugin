import { describe, expect, test } from "bun:test";
import { INITIAL_PROBE_STATE, probeKey, type ProbeState } from "../src/agent-status.js";
import {
  captureStartNotice,
  SIGN_IN_COMMANDS,
  describeNoteTaker,
  friendlyModelName,
  NOTE_TAKER_CHECKING_TEXT,
  NOTE_TAKER_SWITCH_NOTE,
  type NoteTakerView,
} from "../src/note-taker-view.js";
import { DEFAULT_PLUGIN_SETTINGS } from "../src/settings.js";

const claude = { ...DEFAULT_PLUGIN_SETTINGS, claudeModel: "opus" };
const codex = { ...DEFAULT_PLUGIN_SETTINGS, backend: "codex" as const, codexModel: "gpt-5.4" };
const cursor = { ...DEFAULT_PLUGIN_SETTINGS, backend: "cursor" as const };
const acp = { ...DEFAULT_PLUGIN_SETTINGS, backend: "acp" as const, acpTransport: "stdio" as const, acpExecutable: "my-agent" };
const llm = { ...DEFAULT_PLUGIN_SETTINGS, backend: "llm" as const, llmModel: "gpt-4o" };
const key = (settings: Parameters<typeof probeKey>[0]): string => probeKey(settings) ?? "";

const view = (probe: ProbeState, settings = claude, captureBackend: Parameters<typeof describeNoteTaker>[0]["captureBackend"] = undefined): NoteTakerView =>
  describeNoteTaker({ settings, probe, captureBackend });

/** Words a note taker never reads in the panel. */
const BANNED = /\b(agent|model|backend|probe|sign-in check)\b/i;

function everyText(v: NoteTakerView): string[] {
  return [
    v.line,
    v.detail ?? "",
    v.tooltip ?? "",
    v.accessibleLabel,
    v.switchNote ?? "",
    v.menu.heading,
    v.menu.checkLabel,
    ...v.menu.choices.map((choice) => choice.label),
    ...(v.problem === undefined ? [] : [v.problem.headline, v.problem.body, v.problem.checkAgainLabel, v.problem.chooseAnotherLabel]),
  ];
}

describe("friendlyModelName", () => {
  test("maps known ids to readable names", () => {
    expect(friendlyModelName("opus")).toBe("Opus");
    expect(friendlyModelName("sonnet")).toBe("Sonnet");
    expect(friendlyModelName("claude-opus-4-5")).toBe("Opus 4.5");
    expect(friendlyModelName("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
    expect(friendlyModelName("claude-3-5-haiku-20241022")).toBe("Haiku 3.5");
    expect(friendlyModelName("opus[1m]")).toBe("Opus");
    expect(friendlyModelName("gpt-5.4")).toBe("GPT-5.4");
  });

  test("falls back to the raw id, capitalised", () => {
    expect(friendlyModelName("auto")).toBe("Auto");
    expect(friendlyModelName("o3-mini")).toBe("O3-mini");
  });

  test("says nothing when no model is chosen or the provider picks", () => {
    expect(friendlyModelName("")).toBeUndefined();
    expect(friendlyModelName("  ")).toBeUndefined();
    expect(friendlyModelName("default")).toBeUndefined();
  });
});

describe("describeNoteTaker: the healthy line", () => {
  test("names the provider, puts the model on its own line, and the account in the tooltip", () => {
    const v = view({ kind: "signed-in", key: key(claude), account: "you@example.com" });
    expect(v.line).toBe("Note taker: Claude");
    expect(v.detail).toBe("Opus");
    expect(v.tone).toBe("ready");
    expect(v.tooltip).toBe("Using you@example.com");
    expect(v.accessibleLabel).toBe("Note taker: Claude, Opus. Using you@example.com");
    expect(v.problem).toBeUndefined();
    expect(v.switchNote).toBeUndefined();
  });

  test("omits the model line when none is chosen", () => {
    const v = view({ kind: "signed-in", key: key(DEFAULT_PLUGIN_SETTINGS), account: undefined }, DEFAULT_PLUGIN_SETTINGS);
    expect(v.line).toBe("Note taker: Claude");
    expect(v.detail).toBeUndefined();
    expect(v.accessibleLabel).toBe("Note taker: Claude. Connected");
  });

  test("names a Codex user's provider as ChatGPT", () => {
    const v = view({ kind: "signed-in", key: key(codex), account: "me@example.com" }, codex);
    expect(v.line).toBe("Note taker: ChatGPT (Codex)");
    expect(v.detail).toBe("GPT-5.4");
    expect(v.tooltip).toBe("Using me@example.com");
  });

  test("says Connected where the backend reports no account, and never presents a program name as one", () => {
    const v = view({ kind: "signed-in", key: key(cursor), account: "Cursor CLI" }, cursor);
    expect(v.tooltip).toBe("Connected");
    expect(view({ kind: "signed-in", key: key(acp), account: "my-agent" }, acp).tooltip).toBe("Connected");
    expect(view({ kind: "signed-in", key: key(claude), account: undefined }).tooltip).toBe("Connected");
  });

  test("an API key has nothing to check: a neutral line, no tooltip, nothing to check", () => {
    const v = view(INITIAL_PROBE_STATE, llm);
    expect(v.line).toBe("Note taker: Your own API key");
    expect(v.detail).toBe("GPT-4o");
    expect(v.tone).toBe("unknown");
    expect(v.tooltip).toBeUndefined();
    expect(v.menu.canCheck).toBe(false);
  });
});

describe("describeNoteTaker: checking", () => {
  test("says so in the same line, before any answer and for another selection's answer", () => {
    for (const probe of [
      INITIAL_PROBE_STATE,
      { kind: "checking", key: key(claude), token: 1 } as ProbeState,
      { kind: "signed-out", key: key(codex) } as ProbeState,
    ]) {
      const v = view(probe);
      expect(v.line).toBe(NOTE_TAKER_CHECKING_TEXT);
      expect(v.detail).toBeUndefined();
      expect(v.tone).toBe("checking");
      expect(v.problem).toBeUndefined();
      expect(v.tooltip).toBeUndefined();
    }
    expect(NOTE_TAKER_CHECKING_TEXT).toBe("Checking the note taker…");
  });
});

describe("describeNoteTaker: signed out", () => {
  test("Claude: the line stays, with a callout that says what to do", () => {
    const v = view({ kind: "signed-out", key: key(claude) });
    expect(v.line).toBe("Note taker: Claude");
    expect(v.tone).toBe("problem");
    expect(v.problem).toEqual({
      headline: "Claude can't take notes for you yet.",
      body: "Sign in to Claude Code: open a terminal and run claude auth login.",
      details: undefined,
      checkAgainLabel: "Check again",
      chooseAnotherLabel: "Choose a different note taker",
    });
  });

  test("Codex: names its own command", () => {
    const v = view({ kind: "signed-out", key: key(codex) }, codex);
    expect(v.problem?.headline).toBe("ChatGPT can't take notes for you yet.");
    expect(v.problem?.body).toBe("Sign in to Codex: open a terminal and run codex login.");
  });

  test("the other choices get their own wording", () => {
    expect(view({ kind: "signed-out", key: key(cursor) }, cursor).problem?.body).toBe("Sign in to Cursor, then check again.");
    expect(view({ kind: "signed-out", key: key(acp) }, acp).problem?.headline).toBe("Your other app can't take notes for you yet.");
  });
});

describe("describeNoteTaker: the check failed", () => {
  const failed = (reason: "executable-not-found" | "spawn-failed" | "timeout" | "protocol", message?: string): ProbeState =>
    ({ kind: "failed", key: key(claude), reason, message });

  test("says Shorthand couldn't reach it, with the raw error for Details", () => {
    const v = view(failed("executable-not-found", "spawn claude ENOENT"));
    expect(v.tone).toBe("problem");
    expect(v.problem?.headline).toBe("Shorthand couldn't reach Claude.");
    expect(v.problem?.body).toBe("Claude Code isn't installed, or Shorthand can't find it. Install it, or set where it lives in Shorthand's settings.");
    expect(v.problem?.details).toBe("spawn claude ENOENT");
  });

  test("each reason has its own sentence", () => {
    expect(view(failed("spawn-failed")).problem?.body).toBe("Claude Code wouldn't start. Check that it runs in a terminal, then check again.");
    expect(view(failed("timeout")).problem?.body).toBe("Claude Code didn't answer in time. Check again in a moment.");
    expect(view(failed("protocol")).problem?.body).toBe("Claude Code answered in a way Shorthand didn't understand. Updating it may help.");
  });

  test("shows no Details when there is no error text", () => {
    expect(view(failed("timeout")).problem?.details).toBeUndefined();
    expect(view(failed("timeout", "   ")).problem?.details).toBeUndefined();
  });

  test("starts a sentence with a capital for a lower-case name", () => {
    const v = view({ kind: "failed", key: key(acp), reason: "timeout", message: undefined }, acp);
    expect(v.problem?.headline).toBe("Shorthand couldn't reach your other app.");
    expect(v.problem?.body).toBe("Your other app didn't answer in time. Check again in a moment.");
  });
});

describe("describeNoteTaker: switching during a capture", () => {
  const ok = (): ProbeState => ({ kind: "signed-in", key: key(codex), account: undefined });

  test("says a switch applies starting with the next meeting", () => {
    expect(view(ok(), codex, "claude-agent-sdk").switchNote).toBe("Applies starting with the next meeting.");
    expect(NOTE_TAKER_SWITCH_NOTE).toBe("Applies starting with the next meeting.");
  });

  test("says nothing until the choice has moved off what the capture is using", () => {
    expect(view(ok(), codex, "codex").switchNote).toBeUndefined();
    expect(view(ok(), codex, undefined).switchNote).toBeUndefined();
  });
});

describe("describeNoteTaker: the menu", () => {
  test("lists every choice by its friendly name with a check on the current one", () => {
    const v = view(INITIAL_PROBE_STATE, codex);
    expect(v.menu.heading).toBe("Note taker");
    expect(v.menu.checkLabel).toBe("Check connection");
    expect(v.menu.choices).toEqual([
      { backend: "claude-agent-sdk", label: "Claude", checked: false },
      { backend: "codex", label: "ChatGPT (Codex)", checked: true },
      { backend: "cursor", label: "Cursor", checked: false },
      { backend: "acp", label: "Another app (ACP)", checked: false },
      { backend: "llm", label: "Your own API key", checked: false },
    ]);
    expect(v.menu.canCheck).toBe(true);
  });
});

describe("developer words", () => {
  test("never reach the screen in any state", () => {
    const states: ProbeState[] = [
      INITIAL_PROBE_STATE,
      { kind: "checking", key: key(claude), token: 1 },
      { kind: "signed-in", key: key(claude), account: "a@b.c" },
      { kind: "signed-out", key: key(claude) },
      { kind: "failed", key: key(claude), reason: "executable-not-found", message: undefined },
      { kind: "failed", key: key(claude), reason: "spawn-failed", message: undefined },
      { kind: "failed", key: key(claude), reason: "timeout", message: undefined },
      { kind: "failed", key: key(claude), reason: "protocol", message: undefined },
    ];
    for (const settings of [claude, codex, cursor, acp, llm]) {
      for (const state of states) {
        for (const text of everyText(view(state, settings, "claude-agent-sdk"))) {
          expect(text).not.toMatch(BANNED);
        }
      }
    }
  });

  test("never says write your notes", () => {
    for (const text of everyText(view({ kind: "signed-out", key: key(claude) }))) {
      expect(text.toLowerCase()).not.toContain("write your notes");
    }
  });
});

describe("sign-in commands", () => {
  test("the panel names the same command the settings row shows", () => {
    expect(SIGN_IN_COMMANDS.claude).toBe("claude auth login");
    expect(view({ kind: "signed-out", key: key(claude) }).problem?.body).toContain(SIGN_IN_COMMANDS.claude);
    expect(view({ kind: "signed-out", key: key(codex) }, codex).problem?.body).toContain(SIGN_IN_COMMANDS.codex);
  });
  test("with no tooltip the accessible label is the line alone", () => {
    expect(view({ kind: "checking", key: key(claude), token: 1 }).accessibleLabel).toBe("Checking the note taker…");
  });
});

describe("captureStartNotice", () => {
  test("warns only on a definite signed-out answer for the current selection", () => {
    expect(captureStartNotice({ kind: "signed-out", key: key(claude) }, claude)).toBe(
      "Shorthand: Claude can't take notes for you yet — this meeting will be transcribed without notes. Sign in, then use Take notes again after the meeting.",
    );
    expect(captureStartNotice({ kind: "signed-out", key: key(claude) }, codex)).toBeUndefined();
    expect(captureStartNotice({ kind: "checking", key: key(claude), token: 1 }, claude)).toBeUndefined();
    expect(captureStartNotice({ kind: "failed", key: key(claude), reason: "timeout", message: undefined }, claude)).toBeUndefined();
    expect(captureStartNotice({ kind: "signed-in", key: key(claude), account: undefined }, claude)).toBeUndefined();
    expect(captureStartNotice({ kind: "signed-out", key: "x" }, llm)).toBeUndefined();
  });

  test("names the right note taker and fits an assisted-notes session", () => {
    expect(captureStartNotice({ kind: "signed-out", key: key(codex) }, codex)).toContain("ChatGPT can't take notes for you yet");
    expect(captureStartNotice({ kind: "signed-out", key: key(claude) }, claude, "assisted-notes")).toBe(
      "Shorthand: Claude can't take notes for you yet — this session will be transcribed without notes. Sign in, then use Take notes again afterwards.",
    );
  });
});

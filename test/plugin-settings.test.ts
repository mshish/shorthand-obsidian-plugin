import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PLUGIN_SETTINGS,
  claudeAgentOptions,
  choosePromptFieldMode,
  codexAgentOptions,
  defaultTemplateSectionText,
  initialPromptFieldState,
  isEnhancementBackend,
  normalizePluginSettings,
  resolveTemplateSections,
  storedPromptFieldValue,
  validatePromptSettings,
  type PromptFieldState,
} from "../src/settings.js";
import { DEFAULT_CONFIG, MAX_GUIDANCE_CHARACTERS } from "shorthand-core";

describe("plugin settings normalization", () => {
  test("debugLogging defaults to false when absent or malformed, independently of the other toggles", () => {
    // Asserting only debugLogging's own key cannot catch a guard that reads a neighbouring
    // boolean's value. controlShorthandRecording is the useful neighbour because it defaults
    // the other way, so a cross-wire to it surfaces even when it is left at its default.
    expect(normalizePluginSettings({}).debugLogging).toBe(false);
    expect(normalizePluginSettings({ debugLogging: "yes" }).debugLogging).toBe(false);
    expect(normalizePluginSettings({ controlShorthandRecording: true }).debugLogging).toBe(false);
    expect(normalizePluginSettings({ debugLogging: false }).controlShorthandRecording).toBe(true);
  });

  test("writeTranscriptNote defaults to false when absent or malformed, independently of the other toggles", () => {
    expect(normalizePluginSettings({}).writeTranscriptNote).toBe(false);
    expect(normalizePluginSettings({ writeTranscriptNote: "yes" }).writeTranscriptNote).toBe(false);
    expect(normalizePluginSettings({ debugLogging: true }).writeTranscriptNote).toBe(false);
    expect(normalizePluginSettings({ writeTranscriptNote: true }).debugLogging).toBe(false);
    expect(DEFAULT_PLUGIN_SETTINGS.writeTranscriptNote).toBe(false);
  });

  test("falls back for a non-boolean writeTranscriptNote", () => {
    for (const garbage of ["true", 1, null, {}, []]) {
      expect(normalizePluginSettings({ writeTranscriptNote: garbage }).writeTranscriptNote)
        .toBe(DEFAULT_PLUGIN_SETTINGS.writeTranscriptNote);
    }
  });

  test("normalizes valid persisted values", () => {
    expect(normalizePluginSettings({
      backend: "llm",
      shorthandExecutable: "  C:\\Apps\\shorthand.exe ",
      claudeExecutable: " C:\\Apps\\claude.exe ",
      claudeModel: " claude-opus-4-6 ",
      claudeEffort: "high",
      codexExecutable: "  C:\\Apps\\codex.exe\t",
      codexModel: " gpt-5.4 ",
      codexEffort: "xhigh",
      sidecarDirectory: "./Calls\\Transcripts/",
      minNewChars: 42.9,
      minIntervalMs: 0,
      enableLiveEnhancement: false,
      controlShorthandRecording: false,
      writeTranscriptNote: true,
      debugLogging: true,
      retainAgentSessionHistory: true,
      noteTakingGuidance: "  Write terse bullets.  ",
      templateSectionText: " Agenda \n\n Decisions ",
    })).toEqual({
      backend: "llm",
      shorthandExecutable: "C:\\Apps\\shorthand.exe",
      claudeExecutable: "C:\\Apps\\claude.exe",
      claudeModel: "claude-opus-4-6",
      claudeEffort: "high",
      codexExecutable: "C:\\Apps\\codex.exe",
      codexModel: "gpt-5.4",
      codexEffort: "xhigh",
      sidecarDirectory: "Calls/Transcripts",
      minNewChars: 42,
      minIntervalMs: 0,
      enableLiveEnhancement: false,
      controlShorthandRecording: false,
      writeTranscriptNote: true,
      debugLogging: true,
      retainAgentSessionHistory: true,
      noteTakingGuidance: "Write terse bullets.",
      templateSectionText: "Agenda \n\n Decisions",
    });
  });

  test("round-trips every note-enhancement backend", () => {
    expect(normalizePluginSettings({ backend: "llm" }).backend).toBe("llm");
    expect(normalizePluginSettings({ backend: "claude-agent-sdk" }).backend).toBe("claude-agent-sdk");
    expect(normalizePluginSettings({ backend: "codex" }).backend).toBe("codex");
  });

  test("agent model, effort, and history settings default without pinning provider choices", () => {
    expect(normalizePluginSettings({})).toMatchObject({
      claudeModel: "",
      claudeEffort: "",
      codexModel: "",
      codexEffort: "",
      retainAgentSessionHistory: false,
    });
  });

  test("rejects unsupported effort values from persisted data", () => {
    expect(normalizePluginSettings({ claudeEffort: "ultra", codexEffort: "maximum" }))
      .toMatchObject({ claudeEffort: "", codexEffort: "" });
    expect(normalizePluginSettings({ claudeEffort: "max", codexEffort: "ultra" }))
      .toMatchObject({ claudeEffort: "max", codexEffort: "ultra" });
  });

  test("maps blank choices to provider defaults and filled choices to SDK options", () => {
    expect(claudeAgentOptions(DEFAULT_PLUGIN_SETTINGS)).toEqual({ retainSessionHistory: false });
    expect(codexAgentOptions(DEFAULT_PLUGIN_SETTINGS)).toEqual({ retainSessionHistory: false });

    const settings = normalizePluginSettings({
      claudeModel: "claude-opus-4-6",
      claudeEffort: "high",
      codexModel: "gpt-5.4",
      codexEffort: "xhigh",
      retainAgentSessionHistory: true,
    });
    expect(claudeAgentOptions(settings)).toEqual({
      model: "claude-opus-4-6",
      effort: "high",
      retainSessionHistory: true,
    });
    expect(codexAgentOptions(settings)).toEqual({
      model: "gpt-5.4",
      modelReasoningEffort: "xhigh",
      retainSessionHistory: true,
    });
  });

  test("defaults an absent backend to Claude Agent SDK, preserving existing behavior", () => {
    expect(normalizePluginSettings({}).backend).toBe("claude-agent-sdk");
    expect(DEFAULT_PLUGIN_SETTINGS.backend).toBe("claude-agent-sdk");
  });

  test("falls back for malformed note-enhancement backends without throwing", () => {
    // "openai-codex" and "Codex" are here because the accepted spelling is neither: a
    // near-miss written by hand into data.json, or synced from a build that named it
    // differently, must land on the default rather than reaching createEnhancer as a
    // backend no branch matches.
    for (const backend of [42, "claude", null, { backend: "llm" }, "openai-codex", "Codex"]) {
      expect(normalizePluginSettings({ backend }).backend).toBe(DEFAULT_PLUGIN_SETTINGS.backend);
    }
  });

  test("isEnhancementBackend accepts exactly the stored backends", () => {
    // The settings tab's dropdown handler narrows through this rather than through
    // normalizePluginSettings, so it needs its own coverage: a member missing here is a
    // dropdown option that moves and never saves.
    for (const backend of ["claude-agent-sdk", "llm", "codex"]) {
      expect(isEnhancementBackend(backend)).toBe(true);
    }
    for (const garbage of ["", "claude", "openai-codex", 42, null, undefined, {}, ["codex"]]) {
      expect(isEnhancementBackend(garbage)).toBe(false);
    }
  });

  test("defaults the Shorthand control toggle", () => {
    expect(normalizePluginSettings({})).toMatchObject({ controlShorthandRecording: true });
    expect(DEFAULT_PLUGIN_SETTINGS.controlShorthandRecording).toBe(true);
  });

  test("falls back for non-boolean Shorthand toggles", () => {
    for (const garbage of ["true", 1, null, {}, []]) {
      expect(normalizePluginSettings({ controlShorthandRecording: garbage, debugLogging: garbage }))
        .toMatchObject({
          controlShorthandRecording: DEFAULT_PLUGIN_SETTINGS.controlShorthandRecording,
          debugLogging: DEFAULT_PLUGIN_SETTINGS.debugLogging,
        });
    }
  });

  // Every value here is non-default AND differs from the other key's value, which is what
  // makes a cross-wired guard die in both directions. Asserting a key's *default* proves
  // nothing: reading the wrong key and falling through to the default are indistinguishable
  // in that case, which is exactly how an earlier version of this test survived
  // `controlShorthandRecording` reading a neighbouring key's value.
  test("keeps each boolean toggle on its own key", () => {
    expect(normalizePluginSettings({ controlShorthandRecording: false, debugLogging: true }))
      .toMatchObject({ controlShorthandRecording: false, debugLogging: true });
    // And with garbage on one side, so a guard that reads the *other* key's type test is
    // caught too: here the surviving value is non-default on both sides in turn.
    expect(normalizePluginSettings({ controlShorthandRecording: false, debugLogging: "yes" }))
      .toMatchObject({ controlShorthandRecording: false, debugLogging: false });
    expect(normalizePluginSettings({ controlShorthandRecording: 0, debugLogging: true }))
      .toMatchObject({ controlShorthandRecording: true, debugLogging: true });
  });

  // normalizePluginSettings is the trust boundary for data.json, and every install that
  // predates this removal still has useShorthandPostProcessing on disk. The key must be
  // ignored rather than carried through: a stale key that survived normalization would be
  // written straight back out on the next save and never drop. There is no migration —
  // this test is what stands in for one.
  test("a data.json still holding the removed post-processing key normalizes without it", () => {
    const stored = { controlShorthandRecording: false, useShorthandPostProcessing: true, debugLogging: true };
    const normalized = normalizePluginSettings(stored);
    expect(normalized).not.toHaveProperty("useShorthandPostProcessing");
    expect(normalized).toMatchObject({ controlShorthandRecording: false, debugLogging: true });
    expect(normalized).toEqual(normalizePluginSettings({ controlShorthandRecording: false, debugLogging: true }));
  });

  test("rejects absolute and traversing sidecar directories", () => {
    for (const sidecarDirectory of ["C:\\outside", "/outside", "../outside", "inside/../outside", ""]) {
      expect(normalizePluginSettings({ sidecarDirectory }).sidecarDirectory)
        .toBe(DEFAULT_PLUGIN_SETTINGS.sidecarDirectory);
    }
  });

  test("falls back for malformed numeric values", () => {
    expect(normalizePluginSettings({ minNewChars: 0, minIntervalMs: -1 }))
      .toMatchObject({
        minNewChars: DEFAULT_PLUGIN_SETTINGS.minNewChars,
        minIntervalMs: DEFAULT_PLUGIN_SETTINGS.minIntervalMs,
      });
  });

  test("both new keys default to empty, which is what keeps a user inheriting core's defaults", () => {
    expect(DEFAULT_PLUGIN_SETTINGS.noteTakingGuidance).toBe("");
    expect(DEFAULT_PLUGIN_SETTINGS.templateSectionText).toBe("");
    expect(normalizePluginSettings({})).toMatchObject({ noteTakingGuidance: "", templateSectionText: "" });
  });

  test("a stored prompt and heading list survive a round trip", () => {
    const stored = { noteTakingGuidance: "Write in the present tense.", templateSectionText: "Agenda\nRisks" };
    expect(normalizePluginSettings(stored)).toMatchObject(stored);
    expect(normalizePluginSettings(normalizePluginSettings(stored))).toMatchObject(stored);
  });

  test("malformed stored values fall back to empty rather than throwing", () => {
    // data.json is untrusted: hand-edited, synced from another machine, or written by an
    // older build. Every one of these must degrade to the default, not take the plugin down.
    for (const garbage of [42, null, {}, [], true]) {
      expect(normalizePluginSettings({ noteTakingGuidance: garbage, templateSectionText: garbage }))
        .toMatchObject({ noteTakingGuidance: "", templateSectionText: "" });
    }
    expect(normalizePluginSettings({ noteTakingGuidance: "x".repeat(MAX_GUIDANCE_CHARACTERS + 1) }).noteTakingGuidance)
      .toBe("");
    expect(normalizePluginSettings({ noteTakingGuidance: "x".repeat(MAX_GUIDANCE_CHARACTERS) }).noteTakingGuidance)
      .toBe("x".repeat(MAX_GUIDANCE_CHARACTERS));
    for (const invalid of ["Agenda\nAgenda", "   ", `Notes <!-- shorthand:ai:end -->`]) {
      expect(normalizePluginSettings({ templateSectionText: invalid }).templateSectionText).toBe("");
    }
  });

  test("each new key stays on its own key", () => {
    // The same cross-wiring guard the Shorthand control toggles carry above, for the same
    // reason: reading the wrong key and falling through to the default look identical when
    // the default is what you assert.
    expect(normalizePluginSettings({ noteTakingGuidance: "voice", templateSectionText: "Agenda" }))
      .toMatchObject({ noteTakingGuidance: "voice", templateSectionText: "Agenda" });
    expect(normalizePluginSettings({ noteTakingGuidance: "voice", templateSectionText: "Agenda\nAgenda" }))
      .toMatchObject({ noteTakingGuidance: "voice", templateSectionText: "" });
  });
});

describe("shorthandExecutable normalization", () => {
  // The load-bearing property: shorthandCommand() in main.ts only reaches
  // detectShorthandExecutable's PATH search and conventional-location fallbacks when this
  // setting is blank. A default or a "cleared" field that comes back non-empty defeats
  // detection the same way the pre-fix bug did.
  test("defaults to blank", () => {
    expect(DEFAULT_PLUGIN_SETTINGS.shorthandExecutable).toBe("");
    expect(normalizePluginSettings({})).toMatchObject({ shorthandExecutable: "" });
  });

  test("a cleared field stays cleared", () => {
    expect(normalizePluginSettings({ shorthandExecutable: "" }).shorthandExecutable).toBe("");
    expect(normalizePluginSettings({ shorthandExecutable: "   " }).shorthandExecutable).toBe("");
  });

  // Every data.json written before this fix holds the literal "shorthand" — the pre-fix
  // shipped default, which Obsidian persisted into the file, not a value anyone chose.
  // Pinned to the literal, not DEFAULT_CONFIG.shorthandBinaryPath: comparing against core's
  // constant would stop protecting an upgrading user's stored "shorthand" the day core's own
  // default changes to a real path, because their data.json doesn't move with it.
  test('a stored legacy default ("shorthand") migrates to blank', () => {
    expect(normalizePluginSettings({ shorthandExecutable: "shorthand" }).shorthandExecutable)
      .toBe("");
  });

  // The migration is narrow on purpose: it clears the one specific string the old default
  // wrote, not "any bare command name". A user who deliberately types a different bare name
  // keeps it — the bare-name description (settings-display.ts) is what steers them back to
  // blank, not silent normalization.
  test("a different bare command name is preserved untouched", () => {
    expect(normalizePluginSettings({ shorthandExecutable: "shorthand-cli" }).shorthandExecutable)
      .toBe("shorthand-cli");
  });

  test("an explicit path is preserved untouched", () => {
    expect(normalizePluginSettings({ shorthandExecutable: "C:\\Apps\\shorthand.exe" }).shorthandExecutable)
      .toBe("C:\\Apps\\shorthand.exe");
    expect(normalizePluginSettings({ shorthandExecutable: "/usr/local/bin/shorthand" }).shorthandExecutable)
      .toBe("/usr/local/bin/shorthand");
  });

  test("malformed stored values fall back to blank rather than throwing", () => {
    for (const garbage of [42, null, {}, [], true]) {
      expect(normalizePluginSettings({ shorthandExecutable: garbage }).shorthandExecutable).toBe("");
    }
  });
});

describe("codexExecutable normalization", () => {
  // Blank is the shipped default and a working state, exactly as it is for claudeExecutable:
  // core's detectCodexExecutable searches PATH itself, so createEnhancer only fails when Codex
  // is genuinely absent. It stays stored as blank rather than as whatever path was detected once,
  // so a reinstalled or relocated Codex keeps being found instead of the field freezing on the
  // layout of one machine — see the field's comment in src/settings.ts.
  test("defaults to blank", () => {
    expect(DEFAULT_PLUGIN_SETTINGS.codexExecutable).toBe("");
    expect(normalizePluginSettings({})).toMatchObject({ codexExecutable: "" });
  });

  test("a cleared field stays cleared", () => {
    expect(normalizePluginSettings({ codexExecutable: "" }).codexExecutable).toBe("");
    expect(normalizePluginSettings({ codexExecutable: "   " }).codexExecutable).toBe("");
  });

  test("an explicit path round-trips, trimmed", () => {
    const vendored = "C:\\nvm4w\\nodejs\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe";
    expect(normalizePluginSettings({ codexExecutable: ` ${vendored} ` }).codexExecutable).toBe(vendored);
    expect(normalizePluginSettings({ codexExecutable: "/usr/local/bin/codex" }).codexExecutable)
      .toBe("/usr/local/bin/codex");
  });

  // Preserved rather than rewritten or rejected, because core accepts a bare name as an override
  // and searches PATH for it: `codex` typed here is a usable value, not a mistake to repair. No
  // migration either — shorthandExecutable's exists to undo a default an older build persisted,
  // and this key has never shipped a non-empty default.
  test("a bare command name round-trips, since core resolves an override through PATH too", () => {
    expect(normalizePluginSettings({ codexExecutable: "codex" }).codexExecutable).toBe("codex");
  });

  test("malformed stored values fall back to blank rather than throwing", () => {
    for (const garbage of [42, null, {}, [], true]) {
      expect(normalizePluginSettings({ codexExecutable: garbage }).codexExecutable).toBe("");
    }
  });

  test("stays on its own key, so filling one executable field cannot blank another", () => {
    const filled = normalizePluginSettings({ codexExecutable: "C:\\Apps\\codex.exe" });
    expect(filled.claudeExecutable).toBe("");
    expect(filled.shorthandExecutable).toBe("");
    expect(normalizePluginSettings({ claudeExecutable: "C:\\Apps\\claude.exe" }).codexExecutable).toBe("");
  });
});

describe("prompt setting resolution", () => {
  test("the default heading text matches core's own template sections", () => {
    expect(defaultTemplateSectionText()).toBe("Summary\nDecisions\nAction items");
    expect(defaultTemplateSectionText().split("\n"))
      .toEqual(DEFAULT_CONFIG.templateSections.map(({ heading }) => heading));
  });

  test("an empty heading list resolves to core's default sections, not to nothing", () => {
    expect(resolveTemplateSections("")).toEqual(DEFAULT_CONFIG.templateSections);
    expect(resolveTemplateSections("   \n  ")).toEqual(DEFAULT_CONFIG.templateSections);
  });

  test("an unparseable heading list resolves to core's default sections", () => {
    // Belt and braces with normalizePluginSettings: a note scaffolded with zero sections is
    // worse than one scaffolded with the standard three, so this must never throw.
    expect(resolveTemplateSections("Agenda\nAgenda")).toEqual(DEFAULT_CONFIG.templateSections);
  });

  test("a valid heading list resolves to those sections", () => {
    expect(resolveTemplateSections("Agenda\n\nRisks")).toEqual([
      { heading: "Agenda", markdown: "" },
      { heading: "Risks", markdown: "" },
    ]);
  });
});

describe("prompt modal validation", () => {
  test("accepts empty fields, because empty means follow the default", () => {
    expect(validatePromptSettings({ noteTakingGuidance: "", templateSectionText: "" }))
      .toEqual({ ok: true, settings: { noteTakingGuidance: "", templateSectionText: "" } });
    expect(validatePromptSettings({ noteTakingGuidance: "  \n ", templateSectionText: " \n\n " }))
      .toEqual({ ok: true, settings: { noteTakingGuidance: "", templateSectionText: "" } });
  });

  test("accepts and trims filled fields", () => {
    expect(validatePromptSettings({ noteTakingGuidance: "  Be terse.\n", templateSectionText: "\nAgenda\nRisks\n" }))
      .toEqual({ ok: true, settings: { noteTakingGuidance: "Be terse.", templateSectionText: "Agenda\nRisks" } });
  });

  test("rejects an over-long prompt and names the field, so the modal can focus it", () => {
    const result = validatePromptSettings({
      noteTakingGuidance: "x".repeat(MAX_GUIDANCE_CHARACTERS + 1),
      templateSectionText: "",
    });
    expect(result).toMatchObject({ ok: false, field: "noteTakingGuidance" });
    if (!result.ok) {
      expect(result.error).toContain(String(MAX_GUIDANCE_CHARACTERS + 1));
      expect(result.error).toContain(String(MAX_GUIDANCE_CHARACTERS));
    }
  });

  test("surfaces the core parser's own message for a bad heading list", () => {
    const result = validatePromptSettings({ noteTakingGuidance: "", templateSectionText: "Agenda\nAgenda" });
    expect(result).toMatchObject({ ok: false, field: "templateSectionText" });
    if (!result.ok) {
      expect(result.error).toContain("Agenda");
      expect(result.error).toContain("more than once");
    }
  });
});

describe("prompt field mode derivation", () => {
  test("an empty stored value derives the default mode, unseeded", () => {
    expect(initialPromptFieldState("")).toEqual({ mode: "default", editorText: "", seeded: false });
    expect(initialPromptFieldState("   \n  ")).toEqual({ mode: "default", editorText: "", seeded: false });
  });

  test("a stored value derives the custom mode, counts as seeded, and round-trips its text", () => {
    expect(initialPromptFieldState("Be terse.")).toEqual({ mode: "custom", editorText: "Be terse.", seeded: true });
    expect(storedPromptFieldValue(initialPromptFieldState("Be terse."))).toBe("Be terse.");
  });

  // The load-bearing property. Storing "" rather than a copy of the default is what keeps a
  // user inheriting improvements to core's guidance; storing the default's text freezes them
  // at whatever it said the day they opened the modal. A control that looks correct on screen
  // and stores the text anyway is the exact failure this test exists to catch.
  test("the default mode stores an empty string, never the default's text", () => {
    const defaultText = "You maintain the AI-owned section block of a meeting note.";
    const state: PromptFieldState = { mode: "default", editorText: defaultText, seeded: true };
    expect(storedPromptFieldValue(state)).toBe("");
    expect(storedPromptFieldValue(state)).not.toBe(defaultText);
  });

  test("the first switch to custom seeds the editor from the effective default", () => {
    const seeded = choosePromptFieldMode(initialPromptFieldState(""), "custom", "Write plainly.");
    expect(seeded).toEqual({ mode: "custom", editorText: "Write plainly.", seeded: true });
  });

  // The case an "is the box empty" guard gets wrong. Clearing the box is a deliberate act;
  // flipping to the default to re-read it and back must not undo that.
  test("a deliberately cleared editor is not re-seeded on a later switch to custom", () => {
    const seeded = choosePromptFieldMode(initialPromptFieldState(""), "custom", "Write plainly.");
    const cleared: PromptFieldState = { ...seeded, editorText: "" };
    const backedOut = choosePromptFieldMode(cleared, "default", "Write plainly.");
    const returned = choosePromptFieldMode(backedOut, "custom", "Write plainly.");
    expect(returned.editorText).toBe("");
    expect(storedPromptFieldValue(returned)).toBe("");
  });

  test("switching back to custom keeps the user's edit instead of re-seeding over it", () => {
    const seeded = choosePromptFieldMode(initialPromptFieldState(""), "custom", "Write plainly.");
    const edited: PromptFieldState = { ...seeded, editorText: "Write plainly. Name owners." };
    const backedOut = choosePromptFieldMode(edited, "default", "Write plainly.");
    const returned = choosePromptFieldMode(backedOut, "custom", "Write plainly.");
    expect(returned.editorText).toBe("Write plainly. Name owners.");
  });

  // Seeding is the risk in this design: it puts the default's text in an editable field, and
  // saving from there stores a frozen copy. That is correct once the user has chosen to
  // customise — but only while "Default" is still a one-click route back to "".
  test("choosing the default after a seeded edit stores an empty string", () => {
    const seeded = choosePromptFieldMode(initialPromptFieldState(""), "custom", "Write plainly.");
    const backedOut = choosePromptFieldMode(seeded, "default", "Write plainly.");
    expect(storedPromptFieldValue(backedOut)).toBe("");
    expect(storedPromptFieldValue(backedOut)).not.toBe("Write plainly.");
  });
});

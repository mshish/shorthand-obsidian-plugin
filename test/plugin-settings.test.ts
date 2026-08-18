import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PLUGIN_SETTINGS,
  defaultTemplateSectionText,
  normalizePluginSettings,
  resolveTemplateSections,
  validatePromptSettings,
} from "../src/settings.js";
import { DEFAULT_CONFIG, MAX_GUIDANCE_CHARACTERS } from "shorthand-core";

describe("plugin settings normalization", () => {
  test("normalizes valid persisted values", () => {
    expect(normalizePluginSettings({
      shorthandExecutable: "  C:\\Apps\\shorthand.exe ",
      claudeExecutable: " C:\\Apps\\claude.exe ",
      sidecarDirectory: "./Calls\\Transcripts/",
      minNewChars: 42.9,
      minIntervalMs: 0,
      enableLiveEnhancement: false,
      controlShorthandRecording: false,
      useShorthandPostProcessing: true,
      noteTakingGuidance: "  Write terse bullets.  ",
      templateSectionText: " Agenda \n\n Decisions ",
    })).toEqual({
      shorthandExecutable: "C:\\Apps\\shorthand.exe",
      claudeExecutable: "C:\\Apps\\claude.exe",
      sidecarDirectory: "Calls/Transcripts",
      minNewChars: 42,
      minIntervalMs: 0,
      enableLiveEnhancement: false,
      controlShorthandRecording: false,
      useShorthandPostProcessing: true,
      noteTakingGuidance: "Write terse bullets.",
      templateSectionText: "Agenda \n\n Decisions",
    });
  });

  test("defaults the Shorthand control toggles", () => {
    expect(normalizePluginSettings({})).toMatchObject({
      controlShorthandRecording: true,
      useShorthandPostProcessing: false,
    });
    expect(DEFAULT_PLUGIN_SETTINGS.controlShorthandRecording).toBe(true);
    expect(DEFAULT_PLUGIN_SETTINGS.useShorthandPostProcessing).toBe(false);
  });

  test("falls back for non-boolean Shorthand control toggles", () => {
    for (const garbage of ["true", 1, null, {}, []]) {
      expect(normalizePluginSettings({ controlShorthandRecording: garbage, useShorthandPostProcessing: garbage }))
        .toMatchObject({
          controlShorthandRecording: DEFAULT_PLUGIN_SETTINGS.controlShorthandRecording,
          useShorthandPostProcessing: DEFAULT_PLUGIN_SETTINGS.useShorthandPostProcessing,
        });
    }
  });

  // Every value here is non-default AND differs from the other key's value, which is what
  // makes a cross-wired guard die in both directions. Asserting a key's *default* proves
  // nothing: reading the wrong key and falling through to the default are indistinguishable
  // in that case, which is exactly how the earlier version of this test survived having
  // `controlShorthandRecording` read `value.useShorthandPostProcessing`.
  test("keeps each Shorthand control toggle on its own key", () => {
    expect(normalizePluginSettings({ controlShorthandRecording: false, useShorthandPostProcessing: true }))
      .toMatchObject({ controlShorthandRecording: false, useShorthandPostProcessing: true });
    // And with garbage on one side, so a guard that reads the *other* key's type test is
    // caught too: here the surviving value is non-default on both sides in turn.
    expect(normalizePluginSettings({ controlShorthandRecording: false, useShorthandPostProcessing: "yes" }))
      .toMatchObject({ controlShorthandRecording: false, useShorthandPostProcessing: false });
    expect(normalizePluginSettings({ controlShorthandRecording: 0, useShorthandPostProcessing: true }))
      .toMatchObject({ controlShorthandRecording: true, useShorthandPostProcessing: true });
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

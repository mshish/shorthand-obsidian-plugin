import { describe, expect, test } from "bun:test";
import { DEFAULT_PLUGIN_SETTINGS, normalizePluginSettings } from "../src/settings.js";

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
    })).toEqual({
      shorthandExecutable: "C:\\Apps\\shorthand.exe",
      claudeExecutable: "C:\\Apps\\claude.exe",
      sidecarDirectory: "Calls/Transcripts",
      minNewChars: 42,
      minIntervalMs: 0,
      enableLiveEnhancement: false,
      controlShorthandRecording: false,
      useShorthandPostProcessing: true,
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
});

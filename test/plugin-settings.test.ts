import { describe, expect, test } from "bun:test";
import { DEFAULT_PLUGIN_SETTINGS, normalizePluginSettings } from "../src/settings.js";

describe("plugin settings normalization", () => {
  test("normalizes valid persisted values", () => {
    expect(normalizePluginSettings({
      handyExecutable: "  C:\\Apps\\handy.exe ",
      claudeExecutable: " C:\\Apps\\claude.exe ",
      sidecarDirectory: "./Calls\\Transcripts/",
      minNewChars: 42.9,
      minIntervalMs: 0,
      maxPasses: 7.8,
      maxUsd: 2.5,
      enableLiveEnhancement: false,
      controlHandyRecording: false,
      useHandyPostProcessing: true,
    })).toEqual({
      handyExecutable: "C:\\Apps\\handy.exe",
      claudeExecutable: "C:\\Apps\\claude.exe",
      sidecarDirectory: "Calls/Transcripts",
      minNewChars: 42,
      minIntervalMs: 0,
      maxPasses: 7,
      maxUsd: 2.5,
      enableLiveEnhancement: false,
      controlHandyRecording: false,
      useHandyPostProcessing: true,
    });
  });

  test("defaults the Handy control toggles", () => {
    expect(normalizePluginSettings({})).toMatchObject({
      controlHandyRecording: true,
      useHandyPostProcessing: false,
    });
    expect(DEFAULT_PLUGIN_SETTINGS.controlHandyRecording).toBe(true);
    expect(DEFAULT_PLUGIN_SETTINGS.useHandyPostProcessing).toBe(false);
  });

  test("falls back for non-boolean Handy control toggles", () => {
    for (const garbage of ["true", 1, null, {}, []]) {
      expect(normalizePluginSettings({ controlHandyRecording: garbage, useHandyPostProcessing: garbage }))
        .toMatchObject({
          controlHandyRecording: DEFAULT_PLUGIN_SETTINGS.controlHandyRecording,
          useHandyPostProcessing: DEFAULT_PLUGIN_SETTINGS.useHandyPostProcessing,
        });
    }
  });

  // Every value here is non-default AND differs from the other key's value, which is what
  // makes a cross-wired guard die in both directions. Asserting a key's *default* proves
  // nothing: reading the wrong key and falling through to the default are indistinguishable
  // in that case, which is exactly how the earlier version of this test survived having
  // `controlHandyRecording` read `value.useHandyPostProcessing`.
  test("keeps each Handy control toggle on its own key", () => {
    expect(normalizePluginSettings({ controlHandyRecording: false, useHandyPostProcessing: true }))
      .toMatchObject({ controlHandyRecording: false, useHandyPostProcessing: true });
    // And with garbage on one side, so a guard that reads the *other* key's type test is
    // caught too: here the surviving value is non-default on both sides in turn.
    expect(normalizePluginSettings({ controlHandyRecording: false, useHandyPostProcessing: "yes" }))
      .toMatchObject({ controlHandyRecording: false, useHandyPostProcessing: false });
    expect(normalizePluginSettings({ controlHandyRecording: 0, useHandyPostProcessing: true }))
      .toMatchObject({ controlHandyRecording: true, useHandyPostProcessing: true });
  });

  test("rejects absolute and traversing sidecar directories", () => {
    for (const sidecarDirectory of ["C:\\outside", "/outside", "../outside", "inside/../outside", ""]) {
      expect(normalizePluginSettings({ sidecarDirectory }).sidecarDirectory)
        .toBe(DEFAULT_PLUGIN_SETTINGS.sidecarDirectory);
    }
  });

  test("falls back for malformed numeric values", () => {
    expect(normalizePluginSettings({ minNewChars: 0, minIntervalMs: -1, maxPasses: 0, maxUsd: -1 }))
      .toMatchObject({
        minNewChars: DEFAULT_PLUGIN_SETTINGS.minNewChars,
        minIntervalMs: DEFAULT_PLUGIN_SETTINGS.minIntervalMs,
        maxPasses: DEFAULT_PLUGIN_SETTINGS.maxPasses,
        maxUsd: DEFAULT_PLUGIN_SETTINGS.maxUsd,
      });
  });
});

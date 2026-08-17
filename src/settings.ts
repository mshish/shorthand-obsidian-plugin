import { DEFAULT_CONFIG } from "shorthand-core";

export type ShorthandPluginSettings = Readonly<{
  handyExecutable: string;
  claudeExecutable: string;
  sidecarDirectory: string;
  minNewChars: number;
  minIntervalMs: number;
  maxPasses: number;
  maxUsd: number;
  enableLiveEnhancement: boolean;
  controlHandyRecording: boolean;
  useHandyPostProcessing: boolean;
}>;

export const DEFAULT_PLUGIN_SETTINGS: ShorthandPluginSettings = Object.freeze({
  handyExecutable: DEFAULT_CONFIG.handyBinaryPath,
  claudeExecutable: "",
  sidecarDirectory: DEFAULT_CONFIG.sidecarDirectory.replaceAll("\\", "/"),
  minNewChars: DEFAULT_CONFIG.thresholds.enhancementNewCharacters,
  minIntervalMs: DEFAULT_CONFIG.thresholds.enhancementIntervalMs,
  maxPasses: DEFAULT_CONFIG.enhancement.maxPasses,
  maxUsd: DEFAULT_CONFIG.enhancement.maxUsd,
  enableLiveEnhancement: true,
  controlHandyRecording: true,
  useHandyPostProcessing: false,
});

export function normalizePluginSettings(input: unknown): ShorthandPluginSettings {
  const value = isRecord(input) ? input : {};
  return {
    handyExecutable: nonEmptyString(value.handyExecutable, DEFAULT_PLUGIN_SETTINGS.handyExecutable),
    claudeExecutable: stringValue(value.claudeExecutable, DEFAULT_PLUGIN_SETTINGS.claudeExecutable),
    sidecarDirectory: vaultRelativeDirectory(value.sidecarDirectory, DEFAULT_PLUGIN_SETTINGS.sidecarDirectory),
    minNewChars: finiteInteger(value.minNewChars, DEFAULT_PLUGIN_SETTINGS.minNewChars, 1),
    minIntervalMs: finiteInteger(value.minIntervalMs, DEFAULT_PLUGIN_SETTINGS.minIntervalMs, 0),
    maxPasses: finiteInteger(value.maxPasses, DEFAULT_PLUGIN_SETTINGS.maxPasses, 1),
    maxUsd: finiteNumber(value.maxUsd, DEFAULT_PLUGIN_SETTINGS.maxUsd, 0),
    enableLiveEnhancement: typeof value.enableLiveEnhancement === "boolean"
      ? value.enableLiveEnhancement
      : DEFAULT_PLUGIN_SETTINGS.enableLiveEnhancement,
    controlHandyRecording: typeof value.controlHandyRecording === "boolean"
      ? value.controlHandyRecording
      : DEFAULT_PLUGIN_SETTINGS.controlHandyRecording,
    useHandyPostProcessing: typeof value.useHandyPostProcessing === "boolean"
      ? value.useHandyPostProcessing
      : DEFAULT_PLUGIN_SETTINGS.useHandyPostProcessing,
  };
}

function vaultRelativeDirectory(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (normalized.length === 0 || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return fallback;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return fallback;
  return normalized;
}

function finiteInteger(value: unknown, fallback: number, minimum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum
    ? Math.floor(value)
    : fallback;
}

function finiteNumber(value: unknown, fallback: number, minimum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum ? value : fallback;
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { DEFAULT_CONFIG } from "shorthand-core";

export type ShorthandPluginSettings = Readonly<{
  shorthandExecutable: string;
  claudeExecutable: string;
  sidecarDirectory: string;
  minNewChars: number;
  minIntervalMs: number;
  enableLiveEnhancement: boolean;
  controlShorthandRecording: boolean;
  useShorthandPostProcessing: boolean;
}>;

export const DEFAULT_PLUGIN_SETTINGS: ShorthandPluginSettings = Object.freeze({
  shorthandExecutable: DEFAULT_CONFIG.shorthandBinaryPath,
  claudeExecutable: "",
  sidecarDirectory: DEFAULT_CONFIG.sidecarDirectory.replaceAll("\\", "/"),
  minNewChars: DEFAULT_CONFIG.thresholds.enhancementNewCharacters,
  minIntervalMs: DEFAULT_CONFIG.thresholds.enhancementIntervalMs,
  enableLiveEnhancement: true,
  controlShorthandRecording: true,
  useShorthandPostProcessing: false,
});

export function normalizePluginSettings(input: unknown): ShorthandPluginSettings {
  const value = isRecord(input) ? input : {};
  return {
    shorthandExecutable: nonEmptyString(value.shorthandExecutable, DEFAULT_PLUGIN_SETTINGS.shorthandExecutable),
    claudeExecutable: stringValue(value.claudeExecutable, DEFAULT_PLUGIN_SETTINGS.claudeExecutable),
    sidecarDirectory: vaultRelativeDirectory(value.sidecarDirectory, DEFAULT_PLUGIN_SETTINGS.sidecarDirectory),
    minNewChars: finiteInteger(value.minNewChars, DEFAULT_PLUGIN_SETTINGS.minNewChars, 1),
    minIntervalMs: finiteInteger(value.minIntervalMs, DEFAULT_PLUGIN_SETTINGS.minIntervalMs, 0),
    enableLiveEnhancement: typeof value.enableLiveEnhancement === "boolean"
      ? value.enableLiveEnhancement
      : DEFAULT_PLUGIN_SETTINGS.enableLiveEnhancement,
    controlShorthandRecording: typeof value.controlShorthandRecording === "boolean"
      ? value.controlShorthandRecording
      : DEFAULT_PLUGIN_SETTINGS.controlShorthandRecording,
    useShorthandPostProcessing: typeof value.useShorthandPostProcessing === "boolean"
      ? value.useShorthandPostProcessing
      : DEFAULT_PLUGIN_SETTINGS.useShorthandPostProcessing,
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

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

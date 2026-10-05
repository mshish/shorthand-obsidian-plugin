import type { CatalogFailureReason } from "shorthand-core";
import type { CaptureMode } from "./follow-policy.js";
import {
  BACKEND_DISPLAY_NAMES,
  probeKey,
  selectedModelId,
  type ProbeState,
} from "./agent-status.js";
import type { EnhancementBackend, ShorthandPluginSettings } from "./settings.js";

/**
 * Everything the panel's note-taker section says, and when. "Note taker" is the user's word
 * for what the code calls the enhancement backend or agent; none of those words, nor "model",
 * "probe" or "sign-in check", reach the screen. `main.ts` cannot be imported under `bun test`,
 * so every state's text is decided here and `main.ts` only renders the result.
 */

type ViewSettings = Pick<
  ShorthandPluginSettings,
  | "backend" | "claudeModel" | "codexModel" | "cursorModel" | "acpModel" | "acpTransport" | "llmModel"
  | "claudeExecutable" | "codexExecutable" | "cursorExecutable" | "acpExecutable" | "acpArgs"
>;

/** How each backend reads in the middle of a sentence ("can't reach Claude"). */
const SUBJECT_NAMES: Record<EnhancementBackend, string> = {
  "claude-agent-sdk": "Claude",
  codex: "ChatGPT",
  cursor: "Cursor",
  acp: "your other app",
  llm: "your API key",
};

/** The program a failed connection is about, as a user would name what they installed. */
const TOOL_NAMES: Record<EnhancementBackend, string> = {
  "claude-agent-sdk": "Claude Code",
  codex: "Codex",
  cursor: "The Cursor command line tool",
  acp: "Your other app",
  llm: "Your API key",
};

/** The subject of a sentence: "your other app" becomes "Your other app". */
export function sentenceSubject(backend: EnhancementBackend): string {
  return capitalizeFirst(SUBJECT_NAMES[backend]);
}

function capitalizeFirst(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A stored model id as a person would say it: `opus` is Opus, `claude-opus-4-5` is Opus 4.5,
 * `gpt-5.4` is GPT-5.4, anything else is its own id with a capital. `undefined` for no choice,
 * and for the id that means "whatever the provider picks".
 */
export function friendlyModelName(modelId: string): string | undefined {
  // `opus[1m]` selects a context window, not a different model.
  const id = modelId.trim().replace(/\[[^\]]*\]$/, "").trim();
  if (id.length === 0 || id.toLowerCase() === "default") return undefined;
  const family = /^(?:claude-)?(opus|sonnet|haiku)(?:-(\d+)(?:[-.](\d+))?)?(?:-\d{8})?$/i.exec(id);
  if (family?.[1] !== undefined) {
    const version = family[2] === undefined ? "" : ` ${family[2]}${family[3] === undefined ? "" : `.${family[3]}`}`;
    return `${capitalizeFirst(family[1].toLowerCase())}${version}`;
  }
  const oldFamily = /^claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku)(?:-\d{8})?$/i.exec(id);
  if (oldFamily?.[1] !== undefined && oldFamily[3] !== undefined) {
    const version = `${oldFamily[1]}${oldFamily[2] === undefined ? "" : `.${oldFamily[2]}`}`;
    return `${capitalizeFirst(oldFamily[3].toLowerCase())} ${version}`;
  }
  const gpt = /^gpt-(.+)$/i.exec(id);
  if (gpt?.[1] !== undefined) return `GPT-${gpt[1]}`;
  return capitalizeFirst(id);
}

export type NoteTakerTone = "ready" | "checking" | "problem" | "unknown";

export type NoteTakerChoice = Readonly<{ backend: EnhancementBackend; label: string; checked: boolean }>;

export type NoteTakerProblem = Readonly<{
  /** Shown bold. */
  headline: string;
  /** Why, and what to do about it. */
  body: string;
  /** The raw error, for the collapsed "Details"; absent when there is none to show. */
  details: string | undefined;
  checkAgainLabel: string;
  chooseAnotherLabel: string;
}>;

export type NoteTakerView = Readonly<{
  /** The one quiet line: "Note taker: Claude · Opus", or the checking text. */
  line: string;
  tone: NoteTakerTone;
  /** Hover text: whose account is in use. Absent when nothing is known about it. */
  tooltip: string | undefined;
  /** The line button's accessible name: the visible line, plus the tooltip when there is one. */
  accessibleLabel: string;
  problem: NoteTakerProblem | undefined;
  /** Shown beneath the line while a capture runs on the previous choice. */
  switchNote: string | undefined;
  menu: Readonly<{
    heading: string;
    choices: readonly NoteTakerChoice[];
    checkLabel: string;
    /** False when this choice has nothing to check, so the item is shown disabled. */
    canCheck: boolean;
  }>;
}>;

export type NoteTakerInput = Readonly<{
  settings: ViewSettings;
  probe: ProbeState;
  /**
   * The backend the running capture was started with, or undefined when none is running (or
   * its choice is still open to change). The note about the next meeting shows only when the
   * selection has since moved off it.
   */
  captureBackend: EnhancementBackend | undefined;
}>;

/**
 * The one sign-in instruction per program, shared by the panel and the settings row. Claude
 * Code has no top-level `claude login`; `claude auth login` is the command `claude auth --help`
 * lists. Codex's own `codex login` is the documented command.
 */
export const SIGN_IN_COMMANDS = {
  claude: "claude auth login",
  codex: "codex login",
} as const;

export const NOTE_TAKER_CHECKING_TEXT = "Checking the note taker…";
export const NOTE_TAKER_SWITCH_NOTE = "Applies starting with the next meeting.";

function signedOutBody(backend: EnhancementBackend): string {
  switch (backend) {
    case "claude-agent-sdk":
      return `Sign in to Claude Code: open a terminal and run ${SIGN_IN_COMMANDS.claude}.`;
    case "codex":
      return `Sign in to Codex: open a terminal and run ${SIGN_IN_COMMANDS.codex}.`;
    case "cursor":
      return "Sign in to Cursor, then check again.";
    case "acp":
      return "Sign in with the app itself, then check again.";
    case "llm":
      return "Add your API key in Shorthand's settings, then check again.";
  }
}

function unreachableBody(backend: EnhancementBackend, reason: CatalogFailureReason): string {
  const tool = TOOL_NAMES[backend];
  switch (reason) {
    case "executable-not-found":
      return `${tool} isn't installed, or Shorthand can't find it. Install it, or set where it lives in Shorthand's settings.`;
    case "spawn-failed":
      return `${tool} wouldn't start. Check that it runs in a terminal, then check again.`;
    case "timeout":
      return `${tool} didn't answer in time. Check again in a moment.`;
    case "protocol":
      return `${tool} answered in a way Shorthand didn't understand. Updating it may help.`;
  }
}

export function describeNoteTaker(input: NoteTakerInput): NoteTakerView {
  const { settings, probe, captureBackend } = input;
  const backend = settings.backend;
  const key = probeKey(settings);
  // A cached answer for a different selection is not this selection's answer; treat it as not
  // yet asked rather than show another note taker's state under this one's name.
  const current = key !== undefined && probe.kind !== "unprobed" && probe.key === key ? probe : undefined;

  const model = friendlyModelName(selectedModelId(settings));
  const summary = `Note taker: ${BACKEND_DISPLAY_NAMES[backend]}${model === undefined ? "" : ` · ${model}`}`;

  let line = summary;
  let tone: NoteTakerTone = "unknown";
  let tooltip: string | undefined;
  let problem: NoteTakerProblem | undefined;

  if (key === undefined) {
    tone = "unknown";
  } else if (current === undefined || current.kind === "checking") {
    line = NOTE_TAKER_CHECKING_TEXT;
    tone = "checking";
  } else if (current.kind === "signed-in") {
    tone = "ready";
    // Only Claude and Codex report a real account. For Cursor and ACP, core fills `account`
    // with the program's own name and always reports success, which only means it answered, so
    // naming it as the account would be false.
    const reportsAccount = backend === "claude-agent-sdk" || backend === "codex";
    tooltip = reportsAccount && current.account !== undefined && current.account.length > 0
      ? `Using ${current.account}`
      : "Connected";
  } else if (current.kind === "signed-out") {
    tone = "problem";
    problem = {
      headline: `${sentenceSubject(backend)} can't take notes for you yet.`,
      body: signedOutBody(backend),
      details: undefined,
      checkAgainLabel: "Check again",
      chooseAnotherLabel: "Choose a different note taker",
    };
  } else {
    tone = "problem";
    const message = current.message?.trim();
    problem = {
      headline: `Shorthand couldn't reach ${SUBJECT_NAMES[backend]}.`,
      body: unreachableBody(backend, current.reason),
      details: message === undefined || message.length === 0 ? undefined : message,
      checkAgainLabel: "Check again",
      chooseAnotherLabel: "Choose a different note taker",
    };
  }

  return {
    line,
    tone,
    tooltip,
    accessibleLabel: tooltip === undefined ? line : `${line}. ${tooltip}`,
    problem,
    // A running capture built its enhancer from the settings at its start, so a switch cannot
    // reach it.
    switchNote: captureBackend !== undefined && captureBackend !== backend ? NOTE_TAKER_SWITCH_NOTE : undefined,
    menu: {
      heading: "Note taker",
      choices: (Object.keys(BACKEND_DISPLAY_NAMES) as EnhancementBackend[]).map((value) => ({
        backend: value,
        label: BACKEND_DISPLAY_NAMES[value],
        checked: value === backend,
      })),
      checkLabel: "Check connection",
      canCheck: key !== undefined,
    },
  };
}

/**
 * The Notice shown when a capture starts after the check said signed out. Only a definite
 * signed-out answer warns: a failed or still-running check says nothing about the account, and
 * a false alarm at every start would teach users to ignore it. Capture proceeds either way,
 * and the transcript is held, so "Take notes again" on the panel's card can still produce the
 * notes once the user has signed in.
 */
export function captureStartNotice(
  state: ProbeState,
  settings: ViewSettings,
  mode: CaptureMode = "meeting",
): string | undefined {
  const key = probeKey(settings);
  if (key === undefined || state.kind !== "signed-out" || state.key !== key) return undefined;
  const what = mode === "assisted-notes" ? "this session" : "this meeting";
  const after = mode === "assisted-notes" ? "afterwards" : "after the meeting";
  return `Shorthand: ${sentenceSubject(settings.backend)} can't take notes for you yet — ${what} will be transcribed without notes. Sign in, then use Take notes again ${after}.`;
}

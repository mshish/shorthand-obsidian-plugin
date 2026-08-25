import {
  FileSystemAdapter,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  requestUrl,
  type App,
  type ButtonComponent,
  type DropdownComponent,
  type TFile,
  type TextComponent,
} from "obsidian";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
// Core is consumed by package name through its `exports` map — never a deep path.
// It is a separate repository (mshish/shorthand-core), pinned by tag in package.json.
import {
  ClaudeAgentClient,
  CodexAgentClient,
  DEFAULT_CONFIG,
  DEFAULT_EDITORIAL_GUIDANCE,
  detectClaudeExecutable,
  detectCodexExecutable,
  detectShorthandExecutable,
  EnhanceRunner,
  LlmAgentClient,
  llmCredentialsPath,
  readLlmCredentials,
  ShorthandControl,
  SidecarWriter,
  StreamClient,
  TranscriptStore,
  enhancementDelta,
  type ControlResult,
  type ControlSignal,
  type EnhanceStatus,
  type ExitDiagnosis,
  type PassOutcome,
} from "shorthand-core";
import {
  MarkdownNoteSink,
  ensureNoteScaffold,
  linkTranscriptFrontmatter,
  locateAiBlock,
  transcriptWikilink,
} from "shorthand-core/markdown";
import {
  enhanceCommandName,
  resolveEnhanceMode,
  type EnhanceCommandId,
} from "./src/enhance-mode.js";
import {
  DEFAULT_PLUGIN_SETTINGS,
  choosePromptFieldMode,
  defaultTemplateSectionText,
  initialPromptFieldState,
  isEnhancementBackend,
  normalizePluginSettings,
  resolveTemplateSections,
  storedPromptFieldValue,
  validatePromptSettings,
  type PromptFieldState,
  type ShorthandPluginSettings,
} from "./src/settings.js";
import {
  apiKeyDescription,
  baseUrlDescription,
  claudeExecutableDescription,
  codexExecutableDescription,
  newCharacterThresholdDescription,
  passIntervalDescription,
  shorthandExecutableDescription,
  transcriptFolderDescription,
  type StoredKeyState,
} from "./src/settings-display.js";
import {
  INITIAL_PLUGIN_STATE,
  reducePluginState,
  type PluginUiEvent,
  type PluginUiState,
} from "./src/state.js";
import { ShorthandRecorder, shorthandProvenDown, type RecorderPhase } from "./src/recorder.js";
import { formatElapsed } from "./src/elapsed.js";
import { createRequestUrlFetch } from "./src/request-url-fetch.js";
import { deleteLlmCredentials, writeLlmCredentials } from "./src/llm-credentials-writer.js";
import { LlmProfileCommitQueue } from "./src/llm-profile-commit-queue.js";
import {
  EMPTY_LLM_PROFILE_DRAFT,
  missingLlmProfileFields,
  resolveLlmProfileReadState,
  type LlmProfileDraft,
} from "./src/llm-profile-draft.js";

/**
 * Shorthand's follower needs a moment after spawn before Shorthand's events reach it, and the
 * start toggle must not be fired until then — see `ShorthandRecorder.start()`. Long enough to
 * cover a warm attach (measured control forwards land in 48-71ms; the follower's own
 * `hello` is the same order), short enough that a follower which never says `hello`
 * does not visibly delay the recording.
 */
const ATTACH_GRACE_MS = 2_000;

/**
 * How long a stop waits for the `begin` of a recording this capture just started but has
 * not seen announced yet. Sized off the same measurement as the attach grace: the gap is
 * one Shorthand round trip, not a user-visible wait.
 */
const BEGIN_GRACE_MS = 1_500;

type CaptureRuntime = {
  notePath: string;
  /** `undefined` when `writeTranscriptNote` is off: no sidecar file exists for this capture. */
  sidecarPath: string | undefined;
  client: StreamClient;
  control: ShorthandControl;
  /**
   * Present exactly when this capture drives Shorthand's recorder. Built once, at start, from
   * the settings as they were then: reading them live at each call site let a setting
   * flipped mid-capture send a stop signal that had no matching start.
   */
  recorder: ShorthandRecorder | undefined;
  /**
   * Set only when Shorthand is *known* not to be running: the follower's binary is missing, or
   * its exit said "not running" and nothing this capture saw contradicts that. Control
   * signals are then suppressed, because a control spawn with no Shorthand to forward to
   * *becomes* the Shorthand app starting up and a failed capture must not launch Shorthand unbidden.
   * Deliberately biased toward staying false — see `shorthandProvenDown()`.
   */
  shorthandDown: boolean;
  /**
   * True once the follower's `hello` arrived, i.e. it really did connect to a running
   * Shorthand. The follower's exit code cannot say this on its own.
   */
  helloEver: boolean;
  /** `undefined` when `writeTranscriptNote` is off: no sidecar file exists for this capture. */
  sidecar: SidecarWriter | undefined;
  enhancer: EnhanceRunner | undefined;
  settled: Promise<ExitDiagnosis>;
  stopping: boolean;
  /**
   * Set once, at capture start, and used to compute the elapsed-time display. Deliberately
   * not sourced from `enhancer?.state.elapsedMs`: `createEnhancer()` can throw, in which case
   * capture continues with `enhancer` left `undefined` (see `enhancementUnavailable` below) —
   * exactly the case where the user most needs reassurance that capture is still running. A
   * clock borrowed from the enhancer would vanish along with it. The plugin keeps its own
   * independent anchor so the status bar's timer survives an enhancer that never got built.
   */
  startedAt: number;
};

/**
 * A `not-running` result means something different on every path that can produce it, and
 * one shared sentence was wrong on three of them — it told the user to re-run a command
 * they had already finished, up to five seconds after being told the capture had stopped.
 */
const NOT_RUNNING_NOTICES: Record<RecorderPhase | "manual", string> = {
  start: "Shorthand was not running, so this capture did not start a recording; Shorthand is starting now. Once it is up, start the recording with Shorthand's hotkey or \"Toggle Shorthand recording\" — the capture is already running and will pick it up.",
  recall: "Shorthand did not confirm the cancel for the recording this capture had just started. Check that Shorthand is not still recording.",
  finalize: "Shorthand was not running, so there was no recording to finalize. The transcript keeps whatever Shorthand had already sent.",
  backstop: "Shorthand did not confirm the final cancel. Check that Shorthand is not still recording.",
  manual: "Shorthand was not running; it is starting now. Run the command again once it is up.",
};

export default class ShorthandPlugin extends Plugin {
  settings: ShorthandPluginSettings = DEFAULT_PLUGIN_SETTINGS;
  #state: PluginUiState = INITIAL_PLUGIN_STATE;
  // Declared `| undefined` rather than optional: `exactOptionalPropertyTypes` forbids
  // assigning `undefined` to an optional property, and both are cleared on teardown.
  #statusBar: HTMLElement | undefined = undefined;
  #capture: CaptureRuntime | undefined = undefined;

  async onload(): Promise<void> {
    this.settings = normalizePluginSettings(await this.loadData());
    this.#statusBar = this.addStatusBarItem();
    this.#renderStatus();
    // The elapsed-time display is otherwise only refreshed from a transcript-delta handler
    // and from dispatch(), so between utterances it would visibly freeze. A ticking interval
    // keeps it advancing during silence; registerInterval auto-clears it on unload.
    this.registerInterval(window.setInterval(() => this.#renderStatus(), 1_000));
    this.addSettingTab(new ShorthandSettingTab(this.app, this));

    // Command names carry no plugin prefix and are sentence case, per Obsidian's plugin
    // guidelines: the command palette already renders these as "Shorthand: Start capture
    // on this note". Spelling it out here produced "Shorthand: Shorthand: start capture…".
    // checkCallback, not callback: Obsidian hides a command whose check returns false, which
    // is its prescribed way to express "needs an open Markdown note". Matches the two
    // enhancement commands. The check runs on every palette render, so it must not fire a
    // Notice — hence hasActiveMarkdownFile rather than activeMarkdownFile.
    this.addCommand({
      id: "start-capture-this-note",
      name: "Start capture on this note",
      checkCallback: (checking: boolean) => {
        if (!this.hasActiveMarkdownFile()) return false;
        if (checking) return true;
        void this.startCaptureOnActiveNote();
        return true;
      },
    });
    this.addCommand({
      id: "stop-capture",
      name: "Stop capture",
      callback: () => { void this.stopCapture().catch((error: unknown) => this.fail(errorMessage(error))); },
    });
    this.addCommand({
      id: "enhance-now",
      name: "Enhance now",
      checkCallback: (checking: boolean) => {
        if (!this.hasActiveMarkdownFile()) return false;
        if (!checking) void this.enhanceActiveNote();
        return true;
      },
    });
    this.addCommand({
      id: "clean-up-this-note",
      name: "Clean up this note",
      checkCallback: (checking: boolean) => {
        if (!this.hasActiveMarkdownFile()) return false;
        if (!checking) void this.cleanUpActiveNote();
        return true;
      },
    });
    // The user's manual override of Shorthand's recorder, independent of capture: a plain
    // toggle and an unconditional cancel, neither of which touches the capture itself.
    this.addCommand({
      id: "toggle-shorthand-recording",
      name: "Toggle Shorthand recording",
      callback: () => { this.fireControl("toggle-transcription"); },
    });
    this.addCommand({
      id: "cancel-shorthand-recording",
      name: "Cancel Shorthand recording",
      callback: () => { this.fireControl("cancel"); },
    });

    // StreamClient owns the child process. These hooks synchronously signal it
    // before Obsidian tears down the plugin or application.
    this.registerDomEvent(window, "beforeunload", () => this.forceStopCapture());
    this.registerEvent(this.app.workspace.on("quit", () => this.forceStopCapture()));
  }

  onunload(): void {
    this.forceStopCapture();
  }

  async saveSettings(candidate: unknown): Promise<void> {
    this.settings = normalizePluginSettings(candidate);
    await this.saveData(this.settings);
  }

  async startCaptureOnActiveNote(): Promise<void> {
    if (this.#capture !== undefined) {
      new Notice("Shorthand is already capturing. Stop it before starting another note.");
      return;
    }
    const file = this.activeMarkdownFile();
    if (file === undefined) return;
    const vaultRoot = this.vaultRoot();
    if (vaultRoot === undefined) return;
    const notePath = resolve(vaultRoot, file.path);

    try {
      if (!await this.ensureScaffold(notePath)) return;
      let sidecarPath: string | undefined;
      let sidecar: SidecarWriter | undefined;
      if (this.settings.writeTranscriptNote) {
        const noteContent = await readFile(notePath, "utf8");
        const linked = transcriptWikilink(noteContent);
        const relativeSidecar = linked === undefined
          ? `${this.settings.sidecarDirectory}/${timestampName(new Date())}`
          : addMarkdownExtension(linked);
        const resolvedSidecarPath = resolve(vaultRoot, relativeSidecar);
        if (!isInside(vaultRoot, resolvedSidecarPath) || samePath(notePath, resolvedSidecarPath)) {
          this.fail("The configured transcript sidecar path is outside the vault or resolves to the meeting note.");
          return;
        }
        if (linked === undefined) {
          const link = relative(vaultRoot, resolvedSidecarPath).replaceAll("\\", "/").replace(/\.md$/i, "");
          const result = await linkTranscriptFrontmatter(notePath, link);
          if (result.status === "note-locked") {
            this.fail("The meeting note remained locked while adding its transcript link. Close competing file handles and retry.");
            return;
          }
          if (result.status === "retry") {
            this.fail("The meeting note kept changing while adding its transcript link. Let Obsidian finish saving and retry.");
            return;
          }
          if (result.status === "error") {
            this.fail(result.error.message);
            return;
          }
        }
        sidecarPath = resolvedSidecarPath;
        sidecar = new SidecarWriter(sidecarPath, { flushIntervalMs: DEFAULT_CONFIG.sidecarFlushIntervalMs });
      }

      const transcript = new TranscriptStore();
      let enhancer: EnhanceRunner | undefined;
      let enhancementUnavailable: string | undefined;
      try {
        enhancer = await this.createEnhancer(
          notePath,
          vaultRoot,
          DEFAULT_CONFIG.enhancement.timeoutMs,
        );
      } catch (error) {
        enhancementUnavailable = `${errorMessage(error)} Capture will continue with transcript only.`;
      }
      const command = this.shorthandCommand();
      const client = new StreamClient({
        command,
        args: DEFAULT_CONFIG.followStreamArgs,
        maxReconnectAttempts: DEFAULT_CONFIG.reconnect.maxAttempts,
        backoffMs: DEFAULT_CONFIG.reconnect.backoffMs,
        drainTimeoutMs: DEFAULT_CONFIG.drainTimeoutMs,
      });
      const settled = new Promise<ExitDiagnosis>((resolveSettled) => client.once("settled", resolveSettled));
      const control = new ShorthandControl({ command });
      // Resolved by the follower's own `hello` record; `ShorthandRecorder.start()` explains why
      // the start toggle waits on it.
      let markAttached = (): void => {};
      const attached = new Promise<void>((resolveAttached) => { markAttached = resolveAttached; });
      const recorder = this.settings.controlShorthandRecording
        ? new ShorthandRecorder({
          control,
          recordingSignal: "toggle-transcription",
          report: (phase, result) => this.reportControl(phase, result),
          // The recorder's wait for the terminal record replaces the follower's own drain
          // rather than preceding it, so it gets the same budget.
          finalizeTimeoutMs: DEFAULT_CONFIG.drainTimeoutMs,
          attachGraceMs: ATTACH_GRACE_MS,
          beginGraceMs: BEGIN_GRACE_MS,
        })
        : undefined;
      const runtime: CaptureRuntime = {
        notePath,
        sidecarPath,
        client,
        control,
        recorder,
        shorthandDown: false,
        helloEver: false,
        sidecar,
        enhancer,
        settled,
        stopping: false,
        startedAt: Date.now(),
      };
      this.#capture = runtime;
      this.dispatch({ type: "capture-started" });
      if (enhancementUnavailable !== undefined) this.fail(enhancementUnavailable);

      client.on("event", ({ generation, record }) => {
        // The recorder's whole view of Shorthand's session state comes from here — this
        // handler already sees every record Shorthand sends, and unlike StreamClient's own
        // session set it is never reset behind the plugin's back by a reconnect.
        // `observe()` takes session-scoped records only; `hello` is the sole session-less
        // record that reaches this event at all (a connection-level `error` is emitted as
        // `connectionError`, never here), and it has its own entry point.
        if (record.t === "hello") {
          runtime.helloEver = true;
          recorder?.noteAttached();
          markAttached();
        } else recorder?.observe(record);
        const update = transcript.ingest(generation, record);
        if (update === null) return;
        sidecar?.apply(update);
        const delta = enhancementDelta(update);
        if (delta.length === 0) return;
        enhancer?.appendTranscript(delta);
        if (enhancer !== undefined && this.settings.enableLiveEnhancement) {
          enhancer.requestTick();
          console.log(
            `[shorthand] transcript +${delta.length} chars; pending ${enhancer.state.pendingCharacters}/${this.settings.minNewChars} toward next pass`,
          );
        }
        this.#renderStatus();
      });
      client.on("disconnect", ({ generation }) => {
        for (const update of transcript.markConnectionEnded(generation)) sidecar?.apply(update);
      });
      client.on("reconnect", ({ generation, gap }) => {
        if (gap) sidecar?.addReconnectWarning(generation);
      });
      client.on("connectionError", ({ record }) => this.fail(`Shorthand connection error (${record.code}): ${record.message}`));
      client.on("protocolError", ({ error }) => this.fail(error.message));
      client.on("processError", ({ error, command: attempted, fatal }) => {
        // ENOENT is the follower telling us there is no Shorthand binary at all, which is also
        // the answer for every control spawn this capture might still make.
        if (fatal) runtime.shorthandDown = true;
        this.fail(`Could not start "${attempted}". Check the shorthand.exe path in Shorthand settings. ${error.message}`);
      });
      client.on("giveUp", ({ attempts }) => this.fail(`Shorthand stream disconnected repeatedly; gave up after ${attempts} reconnect attempts.`));
      client.on("drainTimeout", () => this.fail("Shorthand did not finish the active transcript before the drain timeout; the child was stopped."));
      sidecar?.on("writeError", ({ error }) => this.fail(`Transcript sidecar write failed: ${error.message}`));
      // Registered before anything else awaits `settled`, so `shorthandDown` is already set by
      // the time `stopCapture()` resumes and decides whether a control spawn is safe.
      void settled.then(
        (diagnosis) => {
          // Not `diagnosis.code === 2`: that code is ambiguous, and reading it as proof is
          // what left Shorthand recording with no follower. `shorthandProvenDown` says why.
          if (shorthandProvenDown({
            exitCode: diagnosis.code,
            helloEver: runtime.helloEver,
            observedSession: recorder?.observedSession ?? false,
            // The one piece of evidence that is not follower-derived, and the strongest:
            // a control signal Shorthand confirmed cannot have been forwarded to a Shorthand that
            // was not running. Without it, a capture whose follower was refused (streaming
            // off, slot taken) concluded "Shorthand is down" while its own start sequence had
            // just put that same Shorthand into recording.
            controlConfirmed: recorder?.controlConfirmed ?? false,
          })) runtime.shorthandDown = true;
          return this.captureSettled(runtime, diagnosis);
        },
      ).catch((error: unknown) => {
        // Nothing else is watching this chain; an unhandled rejection here would take the
        // failure out of the user's sight entirely.
        this.fail(`Capture shutdown failed: ${errorMessage(error)}`);
      });
      client.start();
      // Not awaited here — the capture is live either way — but the promise is retained by
      // the recorder itself, which is what lets a stop sequence wait for it.
      void recorder?.start(attached);
      new Notice(`Shorthand capture started: ${file.path}`);
    } catch (error) {
      this.fail(errorMessage(error));
      this.forceStopCapture();
    }
  }

  async stopCapture(): Promise<void> {
    const runtime = this.#capture;
    if (runtime === undefined) {
      new Notice("Shorthand is not capturing.");
      return;
    }
    // `#capture` is not cleared until finishRuntime(), which is up to a full drain timeout
    // away. Guarding on it alone let a second Stop press during that window send a second
    // control signal to Shorthand.
    if (runtime.stopping) {
      new Notice("Shorthand is already stopping.");
      return;
    }
    runtime.stopping = true;
    // Synchronous, before the first await: a start sequence still in flight has to see the
    // stop at its next checkpoint, and it is the only thing that can recall its own spawn.
    runtime.recorder?.requestStop();
    runtime.enhancer?.stopLiveTicks();
    // Stopping can spend a control timeout plus the whole drain budget. Without this the
    // status bar read "capturing" for all of it.
    this.dispatch({ type: "capture-stopping" });
    // The recorder owns the finalize signal *and* the wait for the record that proves it
    // landed. Tearing the follower down before that record arrives is what silently loses
    // the corrected transcript, and StreamClient cannot decide it for us: a reconnect
    // clears its session set, after which stopAfterDrain() kills the child instantly.
    // `settled` is handed in as the abandon signal: once the follower is gone, no terminal
    // record can arrive from anywhere, and waiting out the rest of the budget would only
    // make the stop look hung.
    // `shorthandDown` is threaded in rather than checked here: the recorder still has to await
    // its own start sequence before this returns, it just must not send the finalize toggle.
    // Shorthand quitting mid-capture can beat `captureSettled` to the user's Stop press, and a
    // toggle spawned with no Shorthand to forward to would *become* Shorthand starting up.
    const outcome = await (runtime.recorder?.stop({
      abandoned: runtime.settled,
      shorthandDown: runtime.shorthandDown,
    }) ?? Promise.resolve("no-session" as const));
    if (outcome === "timed-out") {
      this.fail("Shorthand did not deliver the final transcript in time; the transcript keeps whatever Shorthand had already sent.");
      runtime.client.forceStop();
    } else if (outcome === "restarted") {
      // Shorthand answered the finalize toggle by starting a recording, so it was idle: it had
      // restarted while the follower was away and the recording this capture followed died
      // with the old process. Draining would wait on that brand-new session; the backstop
      // below is what ends it.
      this.fail("Shorthand was restarted during this capture, so the recording it was following was already gone and the stop request started a new one. That new recording is being cancelled; the transcript keeps whatever Shorthand had already sent.");
      runtime.client.forceStop();
    } else {
      runtime.client.stopAfterDrain();
    }
    await runtime.settled;
    await this.finishRuntime(runtime, "stopped");
  }

  forceStopCapture(): void {
    const runtime = this.#capture;
    if (runtime === undefined) return;
    runtime.stopping = true;
    runtime.enhancer?.stopLiveTicks();
    runtime.client.forceStop();
    // `--cancel`, never a toggle: this runs during Obsidian's shutdown, where a toggle
    // would *start* a recording if Shorthand happened to be idle. `--cancel` can only ever
    // drive Shorthand toward idle. It is sent even though nothing here can await it: a start
    // sequence still in flight re-checks the stop flag after its own toggle and sequences
    // a second cancel behind it, which is what makes the outcome deterministic.
    runtime.recorder?.teardown();
    // Signal first so the child cannot be orphaned, then best-effort flush pending sidecar
    // bytes: Obsidian does not await onunload/beforeunload.
    void runtime.sidecar?.close().catch(() => {});
    this.#capture = undefined;
    this.dispatch({ type: "capture-stopped" });
  }

  async enhanceActiveNote(): Promise<void> {
    await this.runEnhancement("enhance-now");
  }

  async cleanUpActiveNote(): Promise<void> {
    await this.runEnhancement("clean-up-this-note");
  }

  /**
   * Both enhancement commands, which differ only in where the text comes from. The choice
   * itself is `resolveEnhanceMode` in src/, because nothing here can be imported under
   * bun test; what is left here is the file and vault plumbing that has to touch Obsidian.
   */
  private async runEnhancement(command: EnhanceCommandId): Promise<void> {
    const file = this.activeMarkdownFile();
    if (file === undefined) return;
    const vaultRoot = this.vaultRoot();
    if (vaultRoot === undefined) return;
    const notePath = resolve(vaultRoot, file.path);
    try {
      // Two separate facts, deliberately. A capture survives a failed createEnhancer, so
      // "is a capture running here" and "does it have a runner" are not the same question,
      // and collapsing them would let a second enhancer start on a note a capture still owns.
      const captureOnThisNote = this.#capture?.notePath === notePath;
      const liveEnhancer = captureOnThisNote ? this.#capture?.enhancer : undefined;
      const mode = resolveEnhanceMode({
        command,
        captureOnThisNote,
        captureEnhancerReady: liveEnhancer !== undefined,
        transcriptLink: transcriptWikilink(await readFile(notePath, "utf8")),
        writeTranscriptNote: this.settings.writeTranscriptNote,
      });
      // Resolved before scaffolding, and returned here on refusal, so that a command which
      // declines never has side effects to show for it: ensureScaffold can pop a confirmation
      // modal and write marker text into the note, and a refusal that did that first would have
      // silently changed the note on its way to telling the user it changed nothing.
      if (mode.kind === "unavailable") {
        this.fail(mode.message);
        return;
      }
      if (!await this.ensureScaffold(notePath)) return;
      switch (mode.kind) {
        case "live-capture":
          // `liveEnhancer` is what made this mode reachable; re-checking is for the compiler.
          if (liveEnhancer === undefined) return;
          this.reportOutcome(await liveEnhancer.enhanceNow("link"), command);
          return;
        case "transcript": {
          const sidecarPath = resolve(vaultRoot, addMarkdownExtension(mode.transcriptLink));
          if (!isInside(vaultRoot, sidecarPath)) {
            this.fail("The note's shorthand-transcript link resolves outside the vault.");
            return;
          }
          const enhancer = await this.createEnhancer(
            notePath,
            vaultRoot,
            DEFAULT_CONFIG.enhancement.standaloneTimeoutMs,
          );
          enhancer.appendTranscript(await readFile(sidecarPath, "utf8"));
          this.reportOutcome(await enhancer.enhanceNow("link"), command);
          return;
        }
        case "notes-only": {
          const enhancer = await this.createEnhancer(
            notePath,
            vaultRoot,
            DEFAULT_CONFIG.enhancement.standaloneTimeoutMs,
          );
          // No appendTranscript, and core's empty-transcript gate would decline forever
          // without the waiver. The note's own prose reaches the model as `user_notes`.
          this.reportOutcome(await enhancer.enhanceNow("link", { allowEmptyTranscript: true }), command);
          return;
        }
        default: {
          const unhandled: never = mode;
          throw new Error(`Unhandled enhancement mode: ${JSON.stringify(unhandled)}`);
        }
      }
    } catch (error) {
      this.fail(`Enhancement failed: ${errorMessage(error)}`);
    }
  }

  /**
   * One resolution for both the follower and every control child. Resolving twice would
   * let them land on different binaries once a setting changes mid-capture, and a control
   * signal delivered to a different Shorthand install than the one being followed is silent.
   */
  private shorthandCommand(): string {
    // detectShorthandExecutable defers to SHORTHAND_BIN only when its override argument is
    // nullish (`??`), not merely empty, so a blank setting has to become `undefined` here
    // rather than passing "" straight through: pass "" instead, and every user who leaves
    // this field blank would silently skip the SHORTHAND_BIN fallback and land straight in
    // the PATH search.
    return detectShorthandExecutable(this.settings.shorthandExecutable || undefined);
  }

  /**
   * The standalone commands: a one-off signal that belongs to no capture sequence, so the
   * outcome is only reported, never awaited. Capture works perfectly well with Shorthand's own
   * hotkey, so a missed toggle must never abort or unwind a capture that is otherwise
   * healthy.
   */
  private fireControl(signal: ControlSignal): void {
    const control = this.#capture?.control ?? new ShorthandControl({ command: this.shorthandCommand() });
    void control.send(signal).then(
      (result) => this.reportControl("manual", result),
      (error: unknown) => this.fail(`Shorthand control failed: ${errorMessage(error)}`),
    );
  }

  private reportControl(phase: RecorderPhase | "manual", result: ControlResult): void {
    if (result.status === "sent") return;
    if (result.status === "not-running") {
      new Notice(NOT_RUNNING_NOTICES[phase], 10_000);
      return;
    }
    this.fail(`Shorthand control failed: ${result.message}`);
  }

  private async createEnhancer(
    notePath: string,
    vaultRoot: string,
    timeoutMs: number,
  ): Promise<EnhanceRunner> {
    const backend = this.settings.backend;
    const configuredClaude = this.settings.claudeExecutable;
    const guidance = this.settings.noteTakingGuidance;
    let claudeExecutable: string | undefined;
    let agent: ClaudeAgentClient | CodexAgentClient | LlmAgentClient;
    if (backend === "claude-agent-sdk") {
      if (configuredClaude.length > 0 && !existsSync(configuredClaude)) {
        throw new Error(`claude.exe was not found at "${configuredClaude}". Update the path in Shorthand settings.`);
      }
      claudeExecutable = detectClaudeExecutable(configuredClaude.length === 0 ? undefined : configuredClaude);
      if (claudeExecutable === undefined && process.platform === "win32") {
        throw new Error("claude.exe was not found. Install and log in to Claude CLI, or configure its full path in Shorthand settings.");
      }
      agent = new ClaudeAgentClient();
    } else if (backend === "codex") {
      // A path is always passed, even when the user configured none, because the SDK's own
      // lookup cannot work here: left to itself it resolves `@openai/codex` relative to the file
      // it is running in, and that file is this bundle, installed at
      // `<vault>/.obsidian/plugins/shorthand/` with no `node_modules` at or above it. The SDK
      // defers that lookup to the first query(), so a bare client loads, saves and reports
      // healthy, then throws "Unable to locate Codex CLI binaries" mid-meeting.
      //
      // `detectCodexExecutable` is what makes the blank setting work: it searches PATH itself and
      // returns an absolute path the SDK can spawn. So blank is a working default here exactly as
      // it is for `claudeExecutable`, and only a genuinely absent Codex reaches the throw below.
      //
      // Both checks run on the resolved path rather than on the stored one, because
      // detectCodexExecutable also honours SHORTHAND_CODEX_EXE; testing the setting alone would
      // skip a path this plugin is about to spawn. A configured path is returned unverified —
      // core resolves it without stat'ing — so existsSync is still what makes a typo fail here,
      // naming the field, instead of failing inside the SDK on the first pass.
      const configuredCodex = this.settings.codexExecutable;
      const codexExecutable = detectCodexExecutable(configuredCodex.length === 0 ? undefined : configuredCodex);
      if (codexExecutable === undefined) {
        throw new Error("Codex was not found on PATH. Install the Codex CLI and run \"codex login\", or enter the full path to the codex program in \"Codex executable\" under Advanced in Shorthand settings.");
      }
      if (!existsSync(codexExecutable)) {
        throw new Error(`Codex was not found at "${codexExecutable}". Update "Codex executable" in Shorthand settings, or clear it to find Codex on PATH.`);
      }
      agent = new CodexAgentClient({ codexPathOverride: codexExecutable });
    } else {
      const credentialsPath = llmCredentialsPath();
      const credentials = await readLlmCredentials(credentialsPath);
      if (!credentials.ok) throw new Error(credentials.message);
      agent = new LlmAgentClient({
        credentials: credentials.value,
        credentialsPath,
        fetch: createRequestUrlFetch(requestUrl),
      });
    }
    // Snapshotted, not read live: core takes traceMachine once at construction, so reading
    // the setting live for statuses would let the two streams disagree mid-capture.
    const debugLogging = this.settings.debugLogging;
    return new EnhanceRunner({
      sink: new MarkdownNoteSink({ notePath, vaultRoot }),
      agent,
      minNewChars: this.settings.minNewChars,
      minIntervalMs: this.settings.minIntervalMs,
      // Conditional spread, like pathToClaudeCodeExecutable below: `exactOptionalPropertyTypes`
      // forbids handing over an explicit `undefined`, and an empty setting has to mean "core
      // picks the guidance", not "run with no editorial instruction at all".
      ...(guidance.length === 0 ? {} : { guidance }),
      maxDurationMs: DEFAULT_CONFIG.enhancement.maxDurationMs,
      // This bound belongs to the runner, not the individual call: there is one runner per
      // capture, so its closing pass inherits the live bound. Unlike the core CLI's retry ladder,
      // the plugin issues that pass once: if it exceeds the bound, only the closing summary is
      // lost. Standalone "Enhance now" builds its own runner and gets the longer one-shot bound.
      timeoutMs,
      maxTurns: DEFAULT_CONFIG.enhancement.maxTurns,
      ...(claudeExecutable === undefined ? {} : { pathToClaudeCodeExecutable: claudeExecutable }),
      // Both together, or neither: core routes its error log to `logger` only when no
      // `onStatus` is supplied, and we always supply one — so without `traceMachine` a
      // logger here would be silent. The trace is the whole point of the toggle.
      ...(debugLogging ? { logger: console, traceMachine: true } : {}),
      onStatus: (status) => this.onEnhanceStatus(status, debugLogging),
    });
  }

  private async ensureScaffold(notePath: string): Promise<boolean> {
    const located = locateAiBlock(await readFile(notePath, "utf8"));
    if (located.ok) return true;
    if (located.error.code !== "markers-missing") {
      this.fail(located.error.message);
      return false;
    }
    if (!await confirmScaffold(this.app)) return false;
    const result = await ensureNoteScaffold(notePath, resolveTemplateSections(this.settings.templateSectionText));
    if (result.status === "written" || result.status === "unchanged") return true;
    if (result.status === "note-locked") {
      this.fail("The meeting note remained locked while adding Shorthand markers. Let Obsidian finish saving and retry.");
    } else if (result.status === "retry") {
      this.fail("The meeting note changed repeatedly while adding Shorthand markers. Retry after it settles.");
    } else {
      this.fail(result.error.message);
    }
    return false;
  }

  private async finishRuntime(runtime: CaptureRuntime, reason: "stopped" | "died"): Promise<void> {
    if (this.#capture !== runtime) return;
    // Backstop, once nothing is left to finalize: `--cancel` is a no-op against an idle
    // Shorthand, so firing it costs nothing and is the only thing that guarantees a capture
    // cannot leave Shorthand recording when the belief about its state was wrong. Only for a
    // capture that drove the recorder in the first place — otherwise this would cancel a
    // recording the user started by hand.
    if (runtime.recorder !== undefined && !runtime.shorthandDown) {
      const cancelling = reason === "died" && runtime.recorder.mayBeRecording;
      runtime.recorder.backstop();
      if (cancelling) {
        // Deliberate: leaving the microphone hot is the failure this whole sequence exists
        // to prevent, and it outranks the corrections a `--cancel` throws away. Say so.
        new Notice(
          "The Shorthand recording in progress was cancelled: the transcript stream ended, so nothing was left to finalize it. Already-transcribed text is kept; Shorthand's corrected version is not.",
          10_000,
        );
      }
    }
    try {
      await runtime.sidecar?.close();
      await runtime.enhancer?.waitForIdle();
      if (reason === "stopped" && runtime.enhancer !== undefined) {
        // Not issued from either command: this is capture's own finishing pass. "Enhance now"
        // is still the right retry, since it is the command that resumes work on a note this
        // capture already owns.
        this.reportOutcome(await runtime.enhancer.enhanceNow("link"), "enhance-now");
      }
      new Notice("Shorthand capture stopped.");
    } catch (error) {
      this.fail(`Capture shutdown failed: ${errorMessage(error)}`);
    } finally {
      if (this.#capture === runtime) this.#capture = undefined;
      this.dispatch({ type: "capture-stopped" });
    }
  }

  private async captureSettled(runtime: CaptureRuntime, diagnosis: ExitDiagnosis): Promise<void> {
    if (runtime.stopping || this.#capture !== runtime) return;
    runtime.stopping = true;
    // The follower is gone, so nothing can observe a recording any more. Recall an in-
    // flight start sequence for the same reason a Stop press does.
    runtime.recorder?.requestStop();
    // And wait for that recall to actually land before the runtime is dropped. Unlike
    // `stopCapture`, nothing on this path awaits `stop()`, so without this the cancel of a
    // dead capture's start sequence could still be in flight when the user starts the next
    // capture — and land on the recording that capture had just started.
    await runtime.recorder?.whenStartSettled();
    if (!diagnosis.clean) this.fail(streamExitMessage(diagnosis));
    this.dispatch({ type: "capture-stopping" });
    await this.finishRuntime(runtime, "died");
  }

  /**
   * A `switch` with a `never` default, not an if/else chain. This handler previously
   * dropped statuses it did not name, and shorthand-core 0.10.0 added three kinds:
   * a silent fall-through would have hidden `disabled-for-read-failures`, after which
   * enhancement is off for the rest of the capture and the user is never told. The
   * default branch turns the next added kind into a compile error instead.
   */
  private onEnhanceStatus(status: EnhanceStatus, debugLogging = this.settings.debugLogging): void {
    // Before the switch, so the two intentionally silent outcomes are still observable.
    if (debugLogging) console.debug(`[shorthand:status] ${JSON.stringify(status)}`);
    switch (status.kind) {
      case "started":
        this.dispatch({ type: "enhancement-started" });
        return;
      case "finished":
        this.dispatch({ type: "enhancement-finished" });
        return;
      case "expired":
        this.dispatch({ type: "enhancement-stopped", message: status.message });
        new Notice(status.message, 8_000);
        return;
      case "disabled-for-read-failures":
        // Terminal for this capture: the note could not be read repeatedly and the
        // kill switch never resets. Before 0.10.0 this arrived as `error`, so losing
        // it here would silently strand enhancement for the rest of the meeting.
        this.dispatch({ type: "enhancement-stopped", message: status.message });
        new Notice(status.message, 8_000);
        return;
      case "error":
      case "skipped":
        this.fail(status.message);
        return;
      case "requeued":
        // Only a target that asked for a backoff is actionable. A plain re-queue means
        // the note kept changing under the writer — i.e. the user is typing during the
        // meeting — which self-heals on the next pass and must stay silent.
        if (status.retryAfterMs !== undefined) {
          this.fail(`${status.message} Close competing file handles; Shorthand will retry on the next pass.`);
        }
        return;
      case "timed-out":
        // Self-healing like a re-queue: the transcript is kept and retried. Only the
        // eventual drop at the re-queue limit loses data, and that arrives as `error`.
        return;
      case "declined":
        // Fires whenever a gate holds, which is most stream events. Never user-facing.
        return;
      default: {
        const unhandled: never = status;
        throw new Error(`Unhandled enhancement status: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  /**
   * `command` names the retry the requeued-with-backoff message points at. The three
   * `runEnhancement` call sites pass through the command that produced their route; the
   * automatic post-capture pass at `finishRuntime` names "enhance-now" itself, since it
   * belongs to no user command. Passing the wrong one would send a "notes-only" user (who can
   * only have run "Clean up this note") to "Enhance now", which then refuses for lack of a
   * transcript link — a dead end dressed up as guidance.
   */
  private reportOutcome(outcome: PassOutcome, command: EnhanceCommandId): void {
    if (outcome.status === "completed") {
      this.dispatch({ type: "enhancement-finished" });
      new Notice(outcome.written ? "Shorthand updated the AI block." : "The AI block was already up to date.");
    } else if (outcome.status === "expired") {
      const message = "Enhancement stopped after the maximum capture window; capture continues.";
      this.dispatch({ type: "enhancement-stopped", message });
      new Notice(message, 8_000);
    } else if (outcome.status === "requeued") {
      this.fail(outcome.retryAfterMs === undefined
        ? `Enhancement was safely re-queued (${outcome.reason}).`
        : `The meeting note was busy. Close competing file handles and run ${enhanceCommandName(command)} again.`);
    } else if (outcome.status === "failed") {
      this.fail(outcome.error);
    } else if (outcome.status === "timed-out") {
      this.fail(`Enhancement did not complete (${outcome.status}).`);
    }
  }

  private activeMarkdownFile(): TFile | undefined {
    const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
    if (file !== null && file !== undefined) return file;
    new Notice("Open a Markdown note before running Shorthand.");
    return undefined;
  }

  /**
   * The `checkCallback` predicate for both enhancement commands. Silent, unlike
   * `activeMarkdownFile`: Obsidian calls this while merely rendering the command palette,
   * so a Notice here would fire at a user who never chose the command.
   */
  private hasActiveMarkdownFile(): boolean {
    const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
    return file !== null && file !== undefined;
  }

  private vaultRoot(): string | undefined {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    this.fail("Shorthand requires a desktop filesystem-backed Obsidian vault.");
    return undefined;
  }

  private fail(message: string): void {
    this.dispatch({ type: "error", message });
    new Notice(`Shorthand: ${message}`, 10_000);
    console.error(`[shorthand] ${message}`);
  }

  private dispatch(event: PluginUiEvent): void {
    this.#state = reducePluginState(this.#state, event);
    this.#renderStatus();
  }

  #renderStatus(): void {
    if (this.#statusBar === undefined) return;
    // Show progress toward the next tick. Without this the plugin looks broken while it is
    // simply below the character gate — the exact confusion this feature was added to fix.
    const pending = this.#capture?.enhancer?.state.pendingCharacters;
    const progress = pending === undefined
      ? ""
      : ` · ${pending}/${this.settings.minNewChars} chars`;
    const elapsed = this.#capture === undefined
      ? ""
      : ` · ${formatElapsed(Date.now() - this.#capture.startedAt)}`;
    this.#statusBar.setText(`Shorthand: ${this.#state.mode}${elapsed}${progress}`);
    this.#statusBar.setAttribute(
      "title",
      this.#state.message ?? (pending === undefined
        ? "Shorthand status"
        : `${pending} of ${this.settings.minNewChars} characters toward the next enhancement pass. "Shorthand: Enhance now" runs one immediately.`),
    );
  }
}

class ShorthandSettingTab extends PluginSettingTab {
  #displayGeneration = 0;

  constructor(app: App, private readonly plugin: ShorthandPlugin) {
    super(app, plugin);
  }

  display(): void {
    const displayGeneration = ++this.#displayGeneration;
    const { containerEl } = this;
    containerEl.empty();
    // No plugin-name heading at the top: Obsidian already titles this pane "Shorthand", and
    // the guidelines reserve headings for separating multiple sections.
    this.displayBasic(containerEl, displayGeneration);
    this.displayAdvanced(containerEl);
  }

  private displayBasic(containerEl: HTMLElement, displayGeneration: number): void {
    new Setting(containerEl)
      .setName("Enhancement backend")
      .setDesc("Only the Claude Agent SDK backend can look things up elsewhere in your vault.")
      .addDropdown((dropdown) => dropdown
        .addOption("claude-agent-sdk", "Claude Agent SDK")
        .addOption("codex", "Codex")
        .addOption("llm", "LLM provider")
        .setValue(this.plugin.settings.backend)
        .onChange(async (value) => {
          // Narrowed through the same predicate `normalizePluginSettings` uses, not against
          // literals repeated here. The literals this replaced listed only the two backends
          // that existed when it was written, so adding a third made its option selectable
          // and unsaveable: the dropdown moved, this handler returned, and nothing anywhere
          // reported that the choice had been discarded.
          if (!isEnhancementBackend(value)) return;
          await this.plugin.saveSettings({ ...this.plugin.settings, backend: value });
          this.display();
        }));
    if (this.plugin.settings.backend === "codex") {
      // Codex authenticates through its own CLI and this plugin has no route into that flow.
      // Without a row saying so, a user who has never run `codex login` learns about it from a
      // failed enhancement pass mid-meeting, with nothing on this tab pointing at the cause.
      // The sign-in is now the only Codex prerequisite this row has to name: core finds the
      // binary on PATH, so the executable field in Advanced is an override like Claude's and
      // does not need pointing at from up here.
      new Setting(containerEl)
        .setName("Codex sign-in")
        .setDesc(createFragment((desc) => {
          desc.appendText("Sign in with ");
          desc.createEl("code", { text: "codex login" });
          desc.appendText(" in a terminal first. Shorthand uses that sign-in and cannot start it for you.");
        }));
    }
    // Each half of this pair names its own backend rather than being an if/else, and that is
    // what keeps a third backend from inheriting a block written for a different one: Codex
    // wants neither the LLM profile rows nor the Claude executable field in Advanced. Turning
    // either test back into an else silently hands whichever block sits on that branch to
    // every backend added after it.
    if (this.plugin.settings.backend === "llm") {
      this.displayLlmProfileControls(containerEl, displayGeneration);
    }
    new Setting(containerEl)
      .setName("Transcript notes")
      .setDesc("Each capture also saves the raw transcript in its own linked note.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.writeTranscriptNote)
        .onChange(async (value) => {
          await this.plugin.saveSettings({ ...this.plugin.settings, writeTranscriptNote: value });
          this.display();
        }));
    if (this.plugin.settings.writeTranscriptNote) {
      textSetting(containerEl, this.plugin, "Transcript folder", transcriptFolderDescription, "sidecarDirectory");
    }
    new Setting(containerEl)
      .setName("Control Shorthand recording")
      .setDesc(createFragment((desc) => {
        desc.appendText(
          "Starting and stopping a capture also starts and stops Shorthand's recording, so you don't need its hotkey. "
          + "Quitting Shorthand mid-capture normally relaunches the app — see ",
        );
        desc.createEl("a", {
          text: "Driving Shorthand's recorder",
          href: "https://github.com/mshish/obsidian-shorthand#driving-shorthands-recorder",
        });
        desc.appendText(".");
      }))
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.controlShorthandRecording)
        .onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, controlShorthandRecording: value })));

    // setHeading() rather than a raw <h3>: the guidelines call for it, and it inherits
    // Obsidian's own settings typography instead of hardcoding a heading level.
    new Setting(containerEl)
      .setName("Note writing")
      .setHeading()
      .setDesc("Shorthand's defaults change with each release. Anything you customize stays as you wrote it.");
    // Which of the two are overridden, so the pane answers "am I on the defaults?" without
    // opening the window. This is read at render time, which is why the modal re-renders the
    // pane on save — otherwise the row would keep reporting the state from before the edit.
    const overridden = [
      this.plugin.settings.noteTakingGuidance.length > 0 ? "prompt" : undefined,
      this.plugin.settings.templateSectionText.length > 0 ? "starting sections" : undefined,
    ].filter((label): label is string => label !== undefined);
    new Setting(containerEl)
      .setName("Note-taking prompt and starting sections")
      .setDesc(overridden.length === 0
        ? "Both follow Shorthand's defaults."
        : `Custom ${overridden.join(" and ")} in use.`)
      .addButton((button) => button
        .setButtonText("Edit…")
        .onClick(() => new NotePromptModal(this.app, this.plugin, () => this.display()).open()));
  }

  /**
   * Always visible, at the bottom, no expander. This is what Obsidian core's own General,
   * Editor, and Files and links tabs do.
   *
   * It is not a fallback for something better: the `visible` predicate that would hide these
   * rows behind a condition belongs to the declarative settings API, which requires app
   * version 1.13.0, and `manifest.json` declares `minAppVersion: 1.5.0`. `SettingGroup`
   * (1.11.0) is out for the same reason, and the pre-1.13 imperative API has no documented
   * collapsible primitive. Raising the floor to reach any of them means dropping users.
   */
  private displayAdvanced(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Advanced").setHeading();
    textSetting(containerEl, this.plugin, "Shorthand executable", shorthandExecutableDescription, "shorthandExecutable");
    // Both revealed by the backend dropdown in displayBasic, and each naming its own backend
    // rather than sharing an else, for the reason recorded there. Both are optional — blank
    // means automatic detection, of `claude` at its install location and of `codex` on PATH —
    // which is why they can sit this far from the dropdown that reveals them.
    if (this.plugin.settings.backend === "claude-agent-sdk") {
      textSetting(containerEl, this.plugin, "Claude executable", claudeExecutableDescription, "claudeExecutable");
    }
    if (this.plugin.settings.backend === "codex") {
      textSetting(containerEl, this.plugin, "Codex executable", codexExecutableDescription, "codexExecutable");
    }
    numberSetting(containerEl, this.plugin, "Minimum new characters", newCharacterThresholdDescription, "minNewChars");
    numberSetting(containerEl, this.plugin, "Minimum interval", passIntervalDescription, "minIntervalMs");
    new Setting(containerEl)
      .setName("Live enhancement")
      .setDesc("The note is rewritten while the meeting runs, instead of only when you stop or run Enhance now.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.enableLiveEnhancement)
        .onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, enableLiveEnhancement: value })));
    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc("Logs enhancement activity to the developer console. Turn this on if a note stops updating during capture.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.debugLogging)
        .onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, debugLogging: value })));
  }

  private displayLlmProfileControls(
    containerEl: HTMLElement,
    displayGeneration: number,
  ): void {
    const credentialsPath = llmCredentialsPath();
    const credentialsFileExisted = existsSync(credentialsPath);
    let draft: LlmProfileDraft = EMPTY_LLM_PROFILE_DRAFT;
    let storedKey = "";
    let ready = false;
    let commitQueue: LlmProfileCommitQueue | undefined;
    let clearKeyPointerDown = false;

    new Setting(containerEl)
      .setName("LLM provider profile")
      .setHeading()
      .setDesc("The API key is stored outside your vault, so it never syncs.");

    let startOverButton: ButtonComponent;
    const statusSetting = new Setting(containerEl)
      .setName("Profile status")
      .setDesc("Loading the provider profile…")
      .addButton((button) => {
        startOverButton = button
          .setButtonText("Discard file")
          .setWarning()
          .onClick(() => { void startOver(); });
        button.buttonEl.hide();
      });

    let providerInput: DropdownComponent;
    const providerSetting = new Setting(containerEl)
      .setName("Provider")
      .addDropdown((dropdown) => {
        providerInput = dropdown
          .addOption("", "No provider chosen")
          .addOption("openai", "OpenAI")
          .addOption("anthropic", "Anthropic")
          .addOption("openai-compatible", "OpenAI-compatible")
          .setDisabled(true)
          .onChange((value) => {
            if (value !== "" && value !== "openai" && value !== "anthropic" && value !== "openai-compatible") return;
            draft = { ...draft, provider: value };
            commitQueue?.acceptEdit(draft);
            showDraftStatus();
          });
        dropdown.selectEl.addEventListener("blur", () => { void commitDraft(); });
      });

    let modelInput: TextComponent;
    const modelSetting = new Setting(containerEl)
      .setName("Model")
      .setDesc("Model IDs are exact strings, not display names.")
      .addText((text) => {
        modelInput = text.setDisabled(true).onChange((value) => {
          draft = { ...draft, model: value };
          commitQueue?.acceptEdit(draft);
          showDraftStatus();
        });
        text.inputEl.addEventListener("blur", () => { void commitDraft(); });
      });

    let baseUrlInput: TextComponent;
    const baseUrlSetting = new Setting(containerEl)
      .setName("Base URL")
      .setDesc(baseUrlDescription(draft.provider))
      .addText((text) => {
        baseUrlInput = text.setDisabled(true).onChange((value) => {
          draft = { ...draft, base_url: value };
          commitQueue?.acceptEdit(draft);
          showDraftStatus();
        });
        text.inputEl.addEventListener("blur", () => { void commitDraft(); });
      });

    let apiKeyInput: TextComponent;
    let clearKeyButton: ButtonComponent;
    const apiKeySetting = new Setting(containerEl)
      .setName("API key")
      .addText((text) => {
        apiKeyInput = text.setDisabled(true).onChange((value) => {
          // The rendered field stays blank for a loaded secret. An empty edit therefore
          // restores the carried key; otherwise deleting masked text would clear it by accident.
          draft = { ...draft, api_key: value.length === 0 ? storedKey : value };
          commitQueue?.acceptEdit(draft);
          showDraftStatus();
        });
        text.inputEl.type = "password";
        text.inputEl.addEventListener("blur", () => {
          if (!clearKeyPointerDown) void commitDraft();
        });
      })
      .addButton((button) => {
        clearKeyButton = button
          .setButtonText("Clear key")
          .setDisabled(true)
          .onClick(() => {
            draft = { ...draft, api_key: "" };
            apiKeyInput.setValue("");
            commitQueue?.acceptEdit(draft);
            clearKeyPointerDown = false;
            showDraftStatus();
            void commitDraft();
          });
        button.buttonEl.addEventListener("pointerdown", () => {
          // Pointer-down precedes the password field's blur. Suppressing that blur prevents
          // Clear key from first writing a partially typed rotation and then writing a clear.
          clearKeyPointerDown = true;
          window.setTimeout(() => { clearKeyPointerDown = false; }, 0);
        });
      });

    const isCurrentDisplay = (): boolean => this.#displayGeneration === displayGeneration;

    const setFieldsDisabled = (disabled: boolean): void => {
      providerSetting.setDisabled(disabled);
      modelSetting.setDisabled(disabled);
      baseUrlSetting.setDisabled(disabled);
      apiKeySetting.setDisabled(disabled);
      clearKeyButton.setDisabled(disabled);
    };

    const setKeyDescription = (keyStatus: "known" | "unknown" = "known"): void => {
      const state: StoredKeyState = keyStatus === "unknown"
        ? "unknown"
        : storedKey.length > 0 ? "stored" : "absent";
      apiKeySetting.setDesc(apiKeyDescription(state));
    };

    const showDraftStatus = (): void => {
      if (!ready) return;
      baseUrlSetting.setDesc(baseUrlDescription(draft.provider));
      const missing = missingLlmProfileFields(draft);
      statusSetting.setDesc(missing.length > 0
        ? `Not saved yet. Still needed: ${missing.join(", ")}.`
        : "Saved when you leave the field you are editing.");
    };

    // This deliberately introduces commit-on-blur. The credentials file is an external,
    // whole-profile document validated as a unit: keystroke writes would emit profiles core
    // rejects wholesale and would put an API key on disk once for every character typed.
    const commitDraft = async (): Promise<void> => {
      if (!ready) return;
      await commitQueue?.commit();
    };

    const startOver = async (): Promise<void> => {
      startOverButton.setDisabled(true);
      statusSetting.setDesc(`Discarding the malformed profile at ${credentialsPath}…`);
      try {
        await deleteLlmCredentials();
        if (isCurrentDisplay()) this.display();
      } catch (error) {
        if (!isCurrentDisplay()) return;
        statusSetting.setDesc(`The profile could not be discarded: ${errorMessage(error)}`);
        startOverButton.setDisabled(false);
      }
    };

    const renderMalformed = (message: string): void => {
      ready = false;
      setFieldsDisabled(true);
      statusSetting.setDesc(`${message} Discard file deletes the existing profile, including any key that could still be recovered from it by hand.`);
      startOverButton.buttonEl.show();
      startOverButton.setDisabled(false);
      setKeyDescription("unknown");
    };

    void readLlmCredentials(credentialsPath).then((result) => {
      if (!isCurrentDisplay()) return;
      const state = resolveLlmProfileReadState(result, credentialsFileExisted);
      if (state.status === "malformed") {
        renderMalformed(state.message);
        return;
      }

      draft = state.draft;
      storedKey = state.hasStoredKey ? draft.api_key : "";
      commitQueue = new LlmProfileCommitQueue(draft, {
        write: writeLlmCredentials,
        onInvalid: (missing) => {
          // Same wording as showDraftStatus: one condition must not have two sentences.
          statusSetting.setDesc(`Not saved yet. Still needed: ${missing.join(", ")}.`);
        },
        onSaving: () => {
          statusSetting.setDesc(`Saving to ${credentialsPath}…`);
        },
        onSaved: (credentials, isLatestRevision) => {
          if (!isCurrentDisplay()) return;
          storedKey = credentials.api_key ?? "";
          if (isLatestRevision) apiKeyInput.setValue("");
          setKeyDescription();
          if (isLatestRevision) {
            statusSetting.setDesc(`Profile saved to ${credentialsPath}.`);
          } else {
            showDraftStatus();
          }
        },
        onSaveFailed: (error) => {
          if (!isCurrentDisplay()) return;
          statusSetting.setDesc(`The profile could not be saved: ${errorMessage(error)}`);
        },
      });
      providerInput.setValue(draft.provider);
      modelInput.setValue(draft.model);
      baseUrlInput.setValue(draft.base_url);
      apiKeyInput.setValue("");
      ready = true;
      // setValue() does not fire onChange, so nothing above recomputed the provider-dependent
      // copy. Without this, a loaded openai-compatible profile shows Base URL as optional.
      showDraftStatus();
      setFieldsDisabled(false);
      setKeyDescription();
      statusSetting.setDesc(state.status === "missing"
        ? "The profile is written once every required field has a value."
        : `Profile loaded from ${credentialsPath}.`);
    }).catch((error: unknown) => {
      if (isCurrentDisplay()) renderMalformed(`The provider profile could not be loaded: ${errorMessage(error)}`);
    });
  }
}

function textSetting(
  container: HTMLElement,
  plugin: ShorthandPlugin,
  name: string,
  describe: (value: string) => string,
  key: "shorthandExecutable" | "claudeExecutable" | "codexExecutable" | "sidecarDirectory",
): void {
  const setting = new Setting(container).setName(name).setDesc(describe(plugin.settings[key]));
  setting.addText((text) => text
    .setValue(plugin.settings[key])
    .onChange(async (value) => {
      await plugin.saveSettings({ ...plugin.settings, [key]: value });
      // Described from the stored value, never the typed one. normalizePluginSettings is the
      // trust boundary for data.json and rewrites what it rejects, so a description built
      // from the raw input would name a folder the plugin is not using.
      setting.setDesc(describe(plugin.settings[key]));
    }));
}

function numberSetting(
  container: HTMLElement,
  plugin: ShorthandPlugin,
  name: string,
  describe: (value: number) => string,
  key: "minNewChars" | "minIntervalMs",
): void {
  const setting = new Setting(container).setName(name).setDesc(describe(plugin.settings[key]));
  setting.addText((text) => {
    text.inputEl.type = "number";
    text.setValue(String(plugin.settings[key])).onChange(async (value) => {
      const parsed = Number(value);
      // Unchanged: a half-typed or non-numeric field keeps the previous value. The
      // description keeps the previous value with it, rather than flickering to a default.
      if (!Number.isFinite(parsed)) return;
      await plugin.saveSettings({ ...plugin.settings, [key]: parsed });
      setting.setDesc(describe(plugin.settings[key]));
    });
  });
}

class ScaffoldModal extends Modal {
  #settled = false;

  constructor(app: App, private readonly resolveChoice: (choice: boolean) => void) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Add Shorthand markers?");
    this.contentEl.createEl("p", {
      text: "This note has no Shorthand AI ownership block. Add the user-notes marker and seeded AI section scaffold without changing existing note text?",
    });
    const buttons = this.contentEl.createDiv();
    const add = buttons.createEl("button", { text: "Add scaffold" });
    add.addClass("mod-cta");
    add.onclick = () => { this.choose(true); this.close(); };
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.onclick = () => { this.choose(false); this.close(); };
  }

  onClose(): void {
    this.choose(false);
    this.contentEl.empty();
  }

  private choose(choice: boolean): void {
    if (this.#settled) return;
    this.#settled = true;
    this.resolveChoice(choice);
  }
}

/**
 * What the modal needs back from one field: the value to store, and a way to put the cursor
 * in it when validation rejects it. A bare textarea element cannot answer the first, because
 * "Default" stores "" no matter what text the textarea is holding.
 */
type PromptFieldHandle = Readonly<{ value: () => string; focus: () => void }>;

/**
 * Both multi-line settings live in a modal rather than in the settings tab.
 *
 * Obsidian's declarative settings API has a first-class textarea control and its docs say to
 * start there — but it requires Obsidian 1.13.0 and this plugin's `minAppVersion` is 1.5.0, so
 * adopting it would mean dropping every user below 1.13.0 to add one setting. For the
 * imperative `display()` API this plugin does use, the documented answer to multi-line input
 * is a form modal. `Setting.addTextArea` exists but is the undocumented path, so the fields
 * here are raw textareas built the way ScaffoldModal builds its own buttons, and the mode
 * control is a `Setting` dropdown because Obsidian's imperative API has no radio group.
 */
class NotePromptModal extends Modal {
  #settled = false;

  constructor(
    app: App,
    private readonly plugin: ShorthandPlugin,
    private readonly onSaved: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Note writing");
    const guidance = this.field(
      "Note-taking prompt",
      createFragment((desc) => {
        desc.appendText(
          "Your instructions replace Shorthand's own for the voice and shape of the sections it writes. "
          + "Its safety rules always apply as well — see ",
        );
        desc.createEl("a", {
          text: "Note writing",
          href: "https://github.com/mshish/obsidian-shorthand#note-writing",
        });
        desc.appendText(".");
      }),
      DEFAULT_EDITORIAL_GUIDANCE,
      this.plugin.settings.noteTakingGuidance,
    );
    const sections = this.field(
      "Starting section headings",
      "One heading per line, added when Shorthand first writes to a note.",
      defaultTemplateSectionText(),
      this.plugin.settings.templateSectionText,
    );
    // Inline and persistent, not a Notice: a validation message that fades after a few seconds
    // is unreadable next to the several hundred characters of text it is about.
    const error = this.contentEl.createDiv({ cls: "mod-warning" });
    const buttons = this.contentEl.createDiv();
    const save = buttons.createEl("button", { text: "Save" });
    save.addClass("mod-cta");
    save.onclick = () => { void this.save(guidance, sections, error); };
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  /**
   * One field: label, explanation, a Default / Custom control, and the body that
   * control switches between. The mode is derived from the stored string by
   * `initialPromptFieldState`, so there is no second key that could disagree with the text.
   */
  private field(
    name: string,
    // `DocumentFragment` as well as `string`, which is what `setDesc` itself accepts: a
    // description that links out to README cannot be a plain string.
    description: string | DocumentFragment,
    effectiveDefault: string,
    stored: string,
  ): PromptFieldHandle {
    let state = initialPromptFieldState(stored);
    let editor: HTMLTextAreaElement | undefined;
    const setting = new Setting(this.contentEl).setName(name).setDesc(description);
    const body = this.contentEl.createDiv();

    const render = (): void => {
      body.empty();
      editor = undefined;
      if (state.mode === "default") {
        // Read-only rather than hidden: the point of this control is that the text a user is
        // inheriting is legible without first agreeing to replace it. A placeholder was not,
        // because it vanished on the first keystroke.
        body.createEl("textarea", {
          text: effectiveDefault,
          cls: "shorthand-prompt-textarea",
          // aria-label because these textareas are siblings of the Setting rather than children
          // of a <label>, so a screen reader has nothing to announce them by. Obsidian's own
          // components carry this for you; hand-rolled elements do not, which is the trade this
          // modal accepts to get a multi-line field at all.
          attr: { readonly: "true", rows: 10, spellcheck: "false", "aria-label": `${name} (Shorthand's default, read-only)` },
        });
        return;
      }
      const area = body.createEl("textarea", {
        cls: "shorthand-prompt-textarea",
        attr: { rows: 10, spellcheck: "false", "aria-label": name },
      });
      area.value = state.editorText;
      // Mirrored into the state on every keystroke so `storedPromptFieldValue` stays the only
      // thing that decides what is written. Reading `area.value` at save time instead would
      // route around it and could store the seeded default after a switch back to Default.
      area.addEventListener("input", () => { state = { ...state, editorText: area.value }; });
      editor = area;
      area.focus();
    };

    setting.addDropdown((dropdown) => dropdown
      .addOption("default", "Default")
      .addOption("custom", "Custom")
      .setValue(state.mode)
      .onChange((value) => {
        state = choosePromptFieldMode(state, value === "custom" ? "custom" : "default", effectiveDefault);
        render();
      }));
    render();

    return {
      value: () => storedPromptFieldValue(state),
      focus: () => { editor?.focus(); },
    };
  }

  private async save(
    guidance: PromptFieldHandle,
    sections: PromptFieldHandle,
    error: HTMLElement,
  ): Promise<void> {
    // Guards a second click landing while the first save is still awaiting saveData(), the
    // same job #settled does in ScaffoldModal.
    if (this.#settled) return;
    const validated = validatePromptSettings({
      noteTakingGuidance: guidance.value(),
      templateSectionText: sections.value(),
    });
    if (!validated.ok) {
      // Invalid input is never saved and the window stays open, focused on the field that
      // failed, so the text being complained about is still on screen next to the complaint.
      error.setText(validated.error);
      (validated.field === "noteTakingGuidance" ? guidance : sections).focus();
      return;
    }
    this.#settled = true;
    await this.plugin.saveSettings({ ...this.plugin.settings, ...validated.settings });
    this.onSaved();
    this.close();
  }
}

function confirmScaffold(app: App): Promise<boolean> {
  return new Promise((resolveChoice) => new ScaffoldModal(app, resolveChoice).open());
}

function timestampName(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.md`;
}

function addMarkdownExtension(path: string): string {
  return /\.md$/i.test(path) ? path : `${path}.md`;
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function streamExitMessage(diagnosis: ExitDiagnosis): string {
  if (diagnosis.code === 2) {
    return "Shorthand is not running, or Follow Live Transcript Output is disabled in Shorthand's Advanced settings.";
  }
  return diagnosis.message || `Shorthand follow-stream exited with code ${String(diagnosis.code)}.`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

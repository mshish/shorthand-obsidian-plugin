import {
  FileSystemAdapter,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  type App,
  type TFile,
} from "obsidian";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
// Core is consumed by package name through its `exports` map — never a deep path.
// It is a separate repository (mshish/shorthand-core), pinned by tag in package.json.
import {
  ClaudeAgentClient,
  DEFAULT_CONFIG,
  detectClaudeExecutable,
  detectShorthandExecutable,
  EnhanceRunner,
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
  DEFAULT_PLUGIN_SETTINGS,
  normalizePluginSettings,
  type ShorthandPluginSettings,
} from "./src/settings.js";
import {
  INITIAL_PLUGIN_STATE,
  reducePluginState,
  type PluginUiEvent,
  type PluginUiState,
} from "./src/state.js";
import { ShorthandRecorder, shorthandProvenDown, type RecorderPhase } from "./src/recorder.js";
import { formatElapsed } from "./src/elapsed.js";

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

/**
 * Shorthand's post-processing runs an LLM pass between the recording ending and the `final`
 * event, and that pass now happens entirely inside the drain window — before this plugin
 * drove the recorder, the toggle was pressed by hand and most of that time had already
 * elapsed by the time Stop capture ran. A post-processed `final` that misses the window
 * is force-killed and lost, so the budget is raised rather than documented as a limit:
 * the timeout only ever costs time on a capture that already failed to finalize.
 */
const POST_PROCESS_DRAIN_TIMEOUT_MS = 45_000;

type CaptureRuntime = {
  notePath: string;
  sidecarPath: string;
  client: StreamClient;
  control: ShorthandControl;
  /**
   * Present exactly when this capture drives Shorthand's recorder. Built once, at start, from
   * the settings as they were then: reading them live at each call site let a setting
   * flipped mid-capture send a stop signal that had no matching start (or the stop toggle
   * for a different signal than the one that started the recording).
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
  sidecar: SidecarWriter;
  enhancer: EnhanceRunner | undefined;
  settled: Promise<ExitDiagnosis>;
  stopping: boolean;
  /**
   * Set once, at capture start, and used to compute the elapsed-time display. It has to be
   * captured once rather than read live: the status bar needs a fixed anchor for "when did
   * this capture begin" to subtract from `Date.now()` at render time, and that anchor point
   * does not change for the life of the capture — recomputing it on each render would not
   * make sense, since there is nothing later in the capture's life that should move it.
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
    this.addCommand({
      id: "start-capture-this-note",
      name: "Start capture on this note",
      callback: () => { void this.startCaptureOnActiveNote(); },
    });
    this.addCommand({
      id: "stop-capture",
      name: "Stop capture",
      callback: () => { void this.stopCapture().catch((error: unknown) => this.fail(errorMessage(error))); },
    });
    this.addCommand({
      id: "enhance-now",
      name: "Enhance now",
      callback: () => { void this.enhanceActiveNote(); },
    });
    // The user's manual override of Shorthand's recorder, independent of capture: a plain
    // toggle and an unconditional cancel, neither of which touches the capture itself.
    this.addCommand({
      id: "toggle-shorthand-recording",
      name: "Toggle Shorthand recording",
      callback: () => { this.fireControl(this.recordingSignal()); },
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
      const noteContent = await readFile(notePath, "utf8");
      const linked = transcriptWikilink(noteContent);
      const relativeSidecar = linked === undefined
        ? `${this.settings.sidecarDirectory}/${timestampName(new Date())}`
        : addMarkdownExtension(linked);
      const sidecarPath = resolve(vaultRoot, relativeSidecar);
      if (!isInside(vaultRoot, sidecarPath) || samePath(notePath, sidecarPath)) {
        this.fail("The configured transcript sidecar path is outside the vault or resolves to the meeting note.");
        return;
      }
      if (linked === undefined) {
        const link = relative(vaultRoot, sidecarPath).replaceAll("\\", "/").replace(/\.md$/i, "");
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

      const transcript = new TranscriptStore();
      const sidecar = new SidecarWriter(sidecarPath, { flushIntervalMs: DEFAULT_CONFIG.sidecarFlushIntervalMs });
      let enhancer: EnhanceRunner | undefined;
      let enhancementUnavailable: string | undefined;
      try {
        enhancer = this.createEnhancer(notePath, vaultRoot);
      } catch (error) {
        enhancementUnavailable = `${errorMessage(error)} Capture will continue with transcript only.`;
      }
      const command = this.shorthandCommand();
      const postProcessing = this.settings.useShorthandPostProcessing;
      const drainTimeoutMs = postProcessing ? POST_PROCESS_DRAIN_TIMEOUT_MS : DEFAULT_CONFIG.drainTimeoutMs;
      const client = new StreamClient({
        command,
        args: DEFAULT_CONFIG.followStreamArgs,
        maxReconnectAttempts: DEFAULT_CONFIG.reconnect.maxAttempts,
        backoffMs: DEFAULT_CONFIG.reconnect.backoffMs,
        drainTimeoutMs,
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
          // Captured from `postProcessing`, not read live: the recorder must stop the
          // recording with the same toggle it started it with, even if the setting flips.
          recordingSignal: recordingSignalFor(postProcessing),
          report: (phase, result) => this.reportControl(phase, result),
          // The recorder's wait for the terminal record replaces the follower's own drain
          // rather than preceding it, so it gets the same budget.
          finalizeTimeoutMs: drainTimeoutMs,
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
        sidecar.apply(update);
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
        for (const update of transcript.markConnectionEnded(generation)) sidecar.apply(update);
      });
      client.on("reconnect", ({ generation, gap }) => {
        if (gap) sidecar.addReconnectWarning(generation);
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
      sidecar.on("writeError", ({ error }) => this.fail(`Transcript sidecar write failed: ${error.message}`));
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
    // Stopping can spend a control timeout plus a whole post-processing drain. Without
    // this the status bar read "capturing" for all of it.
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
    void runtime.sidecar.close().catch(() => {});
    this.#capture = undefined;
    this.dispatch({ type: "capture-stopped" });
  }

  async enhanceActiveNote(): Promise<void> {
    const file = this.activeMarkdownFile();
    if (file === undefined) return;
    const vaultRoot = this.vaultRoot();
    if (vaultRoot === undefined) return;
    const notePath = resolve(vaultRoot, file.path);
    try {
      if (!await this.ensureScaffold(notePath)) return;
      if (this.#capture?.notePath === notePath && this.#capture.enhancer !== undefined) {
        const outcome = await this.#capture.enhancer.enhanceNow("link");
        this.reportOutcome(outcome);
        return;
      }
      const content = await readFile(notePath, "utf8");
      const linked = transcriptWikilink(content);
      if (linked === undefined) {
        this.fail("This note has no shorthand-transcript wikilink. Start capture once to create and link a sidecar.");
        return;
      }
      const sidecarPath = resolve(vaultRoot, addMarkdownExtension(linked));
      if (!isInside(vaultRoot, sidecarPath)) {
        this.fail("The note's shorthand-transcript link resolves outside the vault.");
        return;
      }
      const enhancer = this.createEnhancer(notePath, vaultRoot);
      enhancer.appendTranscript(await readFile(sidecarPath, "utf8"));
      const outcome = await enhancer.enhanceNow("link");
      this.reportOutcome(outcome);
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
    // Blank setting means "find it for me"; an explicit path always wins.
    return detectShorthandExecutable(this.settings.shorthandExecutable || undefined);
  }

  /**
   * The live setting, deliberately: this is the manual override, which belongs to the user
   * and not to any capture, so it must obey the switch as it is set right now.
   *
   * A capture snapshots its own copy at start instead of calling this, because it has to
   * finalize with the same toggle it started the recording with. The split is intentional
   * and has one visible consequence: flipping **Use Shorthand post-processing** mid-capture makes
   * "Toggle Shorthand recording" drive the *other* flag than the one the capture will finalize
   * with. Reconciling them would mean either a capture that stops with a toggle that has no
   * matching start, or a manual command that silently ignores the setting — both worse.
   */
  private recordingSignal(): ControlSignal {
    return recordingSignalFor(this.settings.useShorthandPostProcessing);
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

  private createEnhancer(notePath: string, vaultRoot: string): EnhanceRunner {
    const configuredClaude = this.settings.claudeExecutable;
    if (configuredClaude.length > 0 && !existsSync(configuredClaude)) {
      throw new Error(`claude.exe was not found at "${configuredClaude}". Update the path in Shorthand settings.`);
    }
    const claudeExecutable = detectClaudeExecutable(configuredClaude.length === 0 ? undefined : configuredClaude);
    if (claudeExecutable === undefined && process.platform === "win32") {
      throw new Error("claude.exe was not found. Install and log in to Claude CLI, or configure its full path in Shorthand settings.");
    }
    return new EnhanceRunner({
      sink: new MarkdownNoteSink({ notePath, vaultRoot }),
      agent: new ClaudeAgentClient(),
      minNewChars: this.settings.minNewChars,
      minIntervalMs: this.settings.minIntervalMs,
      maxDurationMs: DEFAULT_CONFIG.enhancement.maxDurationMs,
      timeoutMs: DEFAULT_CONFIG.enhancement.timeoutMs,
      maxTurns: DEFAULT_CONFIG.enhancement.maxTurns,
      ...(claudeExecutable === undefined ? {} : { pathToClaudeCodeExecutable: claudeExecutable }),
      onStatus: (status) => this.onEnhanceStatus(status),
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
    const result = await ensureNoteScaffold(notePath, DEFAULT_CONFIG.templateSections);
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
      await runtime.sidecar.close();
      await runtime.enhancer?.waitForIdle();
      if (reason === "stopped" && runtime.enhancer !== undefined) {
        this.reportOutcome(await runtime.enhancer.enhanceNow("link"));
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

  private onEnhanceStatus(status: EnhanceStatus): void {
    if (status.kind === "started") {
      this.dispatch({ type: "enhancement-started" });
    } else if (status.kind === "finished") {
      this.dispatch({ type: "enhancement-finished" });
    } else if (status.kind === "expired") {
      this.dispatch({ type: "enhancement-stopped", message: status.message });
      new Notice(status.message, 8_000);
    } else if (status.kind === "error") {
      this.fail(status.message);
    } else if (status.kind === "requeued" && status.retryAfterMs !== undefined) {
      // Only a target that asked for a backoff is actionable. A plain re-queue means
      // the note kept changing under the writer — i.e. the user is typing during the
      // meeting — which self-heals on the next pass and must stay silent.
      this.fail(`${status.message} Close competing file handles; Shorthand will retry on the next pass.`);
    }
  }

  private reportOutcome(outcome: PassOutcome): void {
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
        : "The meeting note was busy. Close competing file handles and run Enhance now again.");
    } else if (outcome.status === "failed") {
      this.fail(outcome.error);
    } else if (outcome.status !== "not-ready" && outcome.status !== "in-flight") {
      this.fail(`Enhancement did not complete (${outcome.status}).`);
    }
  }

  private activeMarkdownFile(): TFile | undefined {
    const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
    if (file !== null && file !== undefined) return file;
    new Notice("Open a Markdown note before running Shorthand.");
    return undefined;
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
    this.#statusBar.setText(`Shorthand: ${this.#state.mode}${progress}${elapsed}`);
    this.#statusBar.setAttribute(
      "title",
      this.#state.message ?? (pending === undefined
        ? "Shorthand status"
        : `${pending} of ${this.settings.minNewChars} characters toward the next enhancement pass. "Shorthand: Enhance now" runs one immediately.`),
    );
  }
}

class ShorthandSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ShorthandPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    // No plugin-name heading at the top: Obsidian already titles this pane "Shorthand", and
    // the guidelines reserve headings for separating multiple sections.
    textSetting(containerEl, this.plugin, "Shorthand executable", "Path to shorthand.exe, or a command available on PATH.", "shorthandExecutable");
    textSetting(containerEl, this.plugin, "Claude executable", "Optional path to claude.exe. Leave blank for automatic detection.", "claudeExecutable");
    textSetting(containerEl, this.plugin, "Transcript sidecar directory", "Vault-relative directory used for new transcript notes.", "sidecarDirectory");
    numberSetting(containerEl, this.plugin, "Minimum new characters", "Live-pass transcript threshold.", "minNewChars");
    numberSetting(containerEl, this.plugin, "Minimum interval (ms)", "Minimum time between completed live passes.", "minIntervalMs");
    new Setting(containerEl)
      .setName("Enable live enhancement")
      .setDesc("Run tick passes while capture is active. Stop and Enhance now still use a link-tier pass.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.enableLiveEnhancement)
        .onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, enableLiveEnhancement: value })));
    new Setting(containerEl)
      .setName("Control Shorthand recording")
      .setDesc("Start capture and Stop capture also drive Shorthand's recorder, so a capture needs no separate press of Shorthand's hotkey. Starting a capture cancels any recording already in progress — that recording's corrected transcript is discarded — and then starts a fresh one. Stopping a capture sends the recording toggle only when a recording is believed to be running, and never once Shorthand is known to be gone. Closing Obsidian cancels the recording in progress, and so does losing the transcript stream — the only case where no cancel is sent is when nothing this capture saw shows Shorthand was ever reached, since signalling a Shorthand that is not running would launch it. The consequence of that bias: quitting Shorthand in the middle of a capture normally does relaunch it, because the cancel is sent whenever there is any chance a recording is still running.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.controlShorthandRecording)
        .onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, controlShorthandRecording: value })));
    new Setting(containerEl)
      .setName("Use Shorthand post-processing")
      .setDesc("Drive Shorthand's post-processed transcription instead of plain transcription. Post-processing runs an LLM pass after the recording ends, so stopping a capture waits longer for the final transcript (45s instead of 10s). A capture keeps the value this setting had when it started, so that it stops the recording with the same toggle it started; changing it mid-capture affects only the \"Toggle Shorthand recording\" command and the next capture.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.useShorthandPostProcessing)
        .onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, useShorthandPostProcessing: value })));

    // setHeading() rather than a raw <h3>: the guidelines call for it, and it inherits
    // Obsidian's own settings typography instead of hardcoding a heading level.
    new Setting(containerEl)
      .setName("Direct-file write limitation")
      .setHeading()
      .setDesc(
        "Shorthand writes through its core atomic file writer, not Obsidian's vault API. Obsidian detects those writes with its file watcher. If a note has unsaved keystrokes in an editor buffer, that buffer can win on its next save and an AI update may be lost. This is the safe direction: user text is never discarded by Shorthand.",
      );
  }
}

function textSetting(
  container: HTMLElement,
  plugin: ShorthandPlugin,
  name: string,
  description: string,
  key: "shorthandExecutable" | "claudeExecutable" | "sidecarDirectory",
): void {
  new Setting(container).setName(name).setDesc(description).addText((text) => text
    .setValue(plugin.settings[key])
    .onChange(async (value) => plugin.saveSettings({ ...plugin.settings, [key]: value })));
}

function numberSetting(
  container: HTMLElement,
  plugin: ShorthandPlugin,
  name: string,
  description: string,
  key: "minNewChars" | "minIntervalMs",
): void {
  new Setting(container).setName(name).setDesc(description).addText((text) => {
    text.inputEl.type = "number";
    text.setValue(String(plugin.settings[key])).onChange(async (value) => {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) await plugin.saveSettings({ ...plugin.settings, [key]: parsed });
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

/** Which of Shorthand's two recording toggles a capture drives. */
function recordingSignalFor(postProcessing: boolean): ControlSignal {
  return postProcessing ? "toggle-post-process" : "toggle-transcription";
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

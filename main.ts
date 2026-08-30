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
  normalizePath,
  type Editor,
  type TextComponent,
} from "obsidian";
import { existsSync } from "node:fs";
// Core is consumed by package name through its `exports` map — never a deep path.
// It is a separate repository (mshish/shorthand-core), pinned by tag in package.json.
import {
  AgentCatalogError,
  ClaudeAgentClient,
  CodexAgentClient,
  DEFAULT_CONFIG,
  DEFAULT_EDITORIAL_GUIDANCE,
  detectClaudeExecutable,
  detectCodexExecutable,
  detectShorthandExecutable,
  EnhanceRunner,
  listClaudeModels,
  listCodexModels,
  LlmAgentClient,
  llmCredentialsPath,
  readLlmCredentials,
  ShorthandControl,
  SidecarWriter,
  StreamClient,
  TranscriptStore,
  enhancementDelta,
  type AgentCatalog,
  type ControlResult,
  type ControlSignal,
  type EnhanceStatus,
  type ExitDiagnosis,
  type PassOutcome,
} from "shorthand-core";
import {
  transcriptWikilink,
} from "shorthand-core/markdown";
import {
  enhanceCommandName,
  resolveEnhanceMode,
  type EnhanceCommandId,
} from "./src/enhance-mode.js";
import { COMMAND_NAMES } from "./src/commands.js";
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
  type ShorthandPluginSettings,
} from "./src/settings.js";
import {
  apiKeyDescription,
  baseUrlDescription,
  catalogFetchFailedDescription,
  catalogLoadingDescription,
  claudeExecutableDescription,
  codexExecutableDescription,
  decideEffortRow,
  decideModelRow,
  newCharacterThresholdDescription,
  passIntervalDescription,
  shorthandExecutableDescription,
  transcriptFolderDescription,
  type AgentBackendLabel,
  type CatalogRowDecision,
  type StoredKeyState,
} from "./src/settings-display.js";
import {
  INITIAL_PLUGIN_STATE,
  canStartCapture,
  reducePluginState,
  type PluginUiEvent,
  type PluginUiState,
} from "./src/state.js";
import {
  ShorthandRecorder,
  shorthandProvenDown,
  type HelloInfo,
  type RecorderPhase,
} from "./src/recorder.js";
import { describeStatus } from "./src/status-text.js";
import { createRequestUrlFetch } from "./src/request-url-fetch.js";
import { deleteLlmCredentials, writeLlmCredentials } from "./src/llm-credentials-writer.js";
import { LlmProfileCommitQueue } from "./src/llm-profile-commit-queue.js";
import { ObsidianNoteSink } from "./src/obsidian-note-sink.js";
import { ObsidianSidecarStore } from "./src/obsidian-sidecar-store.js";
import {
  ensureTranscriptLink,
  preflightMarkers,
  scaffoldAfterPreflight,
} from "./src/obsidian-note-setup.js";
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

/**
 * Only consulted for Assisted Notes. How long to wait, once the toggle is confirmed delivered,
 * for the session it should have started to actually announce itself. Shorthand's disabled-mode
 * refusal still exits the forwarding process 0 — the primary instance is the one that declines —
 * so a confirmed `sent` is not proof of a live recording the way it is for Meeting, and without
 * a bound Obsidian would sit "capturing" indefinitely with a follower attached and no `begin`
 * ever coming. Sized a little more generously than `BEGIN_GRACE_MS`: that budget covers only the
 * ordinary gap between a toggle landing and Shorthand announcing the session, while this one also
 * has to absorb Shorthand raising its window before it can even evaluate the flag.
 */
const START_ACKNOWLEDGEMENT_MS = 3_000;

type CaptureRuntime = {
  /** The live Obsidian identity, retained across normal rename and move operations. */
  noteFile: TFile;
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
 *
 * `start` is not among these: which manual command can resume the capture depends on which
 * signal it was trying to send, so it is a function of that signal instead — see
 * `START_NOT_RUNNING`. A manual recovery that always named "Toggle Shorthand meeting recording"
 * would start a *Meeting* on a capture that was trying to start Assisted Notes.
 */
const NOT_RUNNING_NOTICES: Record<Exclude<RecorderPhase, "start"> | "manual", string> = {
  recall: "Shorthand did not confirm the cancel for the recording this capture had just started. Check that Shorthand is not still recording.",
  finalize: "Shorthand was not running, so there was no recording to finalize. The transcript keeps whatever Shorthand had already sent.",
  backstop: "Shorthand did not confirm the final cancel. Check that Shorthand is not still recording.",
  manual: "Shorthand was not running; it is starting now. Run the command again once it is up.",
};

const START_NOT_RUNNING = (signal: ControlSignal): string =>
  `Shorthand was not running, so this capture did not start a recording; Shorthand is starting now. Once it is up, start the recording with Shorthand's shortcut or "${
    signal === "toggle-assisted-notes"
      ? COMMAND_NAMES["toggle-shorthand-assisted-notes"]
      : COMMAND_NAMES["toggle-shorthand-recording"]
  }" — the capture is already running and will pick it up.`;

/**
 * Assisted Notes' three capability-gated ways to fail to start, named by
 * `ShorthandRecorder.startFailure` after `start()` resolves `"not-started"`. An ordinary
 * control failure (`ShorthandControl.send()` itself reporting `not-running` or `error`) leaves
 * `startFailure` `undefined` and is not among these: `reportControl` already showed a complete,
 * specific message for it via the ordinary report channel, and a second, generic notice on top
 * would only be noise.
 */
const ASSISTED_NOTES_START_FAILURE_NOTICES: Record<"no-hello" | "unsupported" | "start-timeout", string> = {
  "no-hello": "Assisted Notes needs a compatible running Shorthand with live transcript following; none was found in time. Start Shorthand with that setting enabled and try again.",
  unsupported: "This Shorthand build does not support Assisted Notes. Install a Shorthand build that advertises it and try again.",
  "start-timeout": "Assisted Notes did not start. In Shorthand, open Settings → Modes → Notetaking → Assisted notes, enable it, and try again.",
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
    // Clickable, and stop-only. The item is hidden while idle (see describeStatus),
    // so there is never a moment where a click could mean "start" — starting lives on
    // the ribbon icon and in the side panel.
    this.#statusBar.addClass("mod-clickable");
    this.registerDomEvent(this.#statusBar, "click", () => {
      if (this.#capture === undefined) return;
      void this.stopCapture().catch((error: unknown) => this.fail(errorMessage(error)));
    });
    this.#renderStatus();
    // The elapsed-time display is otherwise only refreshed from a transcript-delta handler
    // and from dispatch(), so between utterances it would visibly freeze. A ticking interval
    // keeps it advancing during silence; registerInterval auto-clears it on unload.
    this.registerInterval(window.setInterval(() => this.#renderStatus(), 1_000));
    this.addSettingTab(new ShorthandSettingTab(this.app, this));

    // Names come from src/commands.ts so they are covered by bun test; main.ts cannot
    // be imported under it. They carry no plugin prefix and are sentence case, per
    // Obsidian's plugin guidelines: the palette already renders these as "Shorthand:
    // Start meeting capture on this note". Spelling it out here produced "Shorthand:
    // Shorthand: start capture…".
    // checkCallback, not callback: Obsidian hides a command whose check returns false,
    // which is its prescribed way to express "needs an open Markdown note". The check
    // runs on every palette render, so it must not fire a Notice — hence
    // hasActiveMarkdownFile rather than activeMarkdownFile.
    this.addCommand({
      id: "start-capture-this-note",
      name: COMMAND_NAMES["start-capture-this-note"],
      checkCallback: (checking: boolean) => {
        if (!this.hasActiveMarkdownFile()) return false;
        if (checking) return true;
        void this.startCaptureOnActiveNote();
        return true;
      },
    });
    this.addCommand({
      id: "start-assisted-notes-capture-this-note",
      name: COMMAND_NAMES["start-assisted-notes-capture-this-note"],
      checkCallback: (checking: boolean) => {
        if (!this.hasActiveMarkdownFile()) return false;
        if (checking) return true;
        void this.startCaptureOnActiveNote("toggle-assisted-notes");
        return true;
      },
    });
    this.addCommand({
      id: "stop-capture",
      name: COMMAND_NAMES["stop-capture"],
      callback: () => { void this.stopCapture().catch((error: unknown) => this.fail(errorMessage(error))); },
    });
    this.addCommand({
      id: "enhance-now",
      name: COMMAND_NAMES["enhance-now"],
      checkCallback: (checking: boolean) => {
        if (!this.hasActiveMarkdownFile()) return false;
        if (!checking) void this.enhanceActiveNote();
        return true;
      },
    });
    this.addCommand({
      id: "clean-up-this-note",
      name: COMMAND_NAMES["clean-up-this-note"],
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
      name: COMMAND_NAMES["toggle-shorthand-recording"],
      callback: () => { this.fireControl("toggle-transcription"); },
    });
    // Not decoration: a manual recovery that named "Toggle Shorthand meeting recording" would
    // start a *Meeting*. The Assisted Notes recovery path has to select the same mode it was
    // trying to start — see START_NOT_RUNNING, which points here for that signal.
    this.addCommand({
      id: "toggle-shorthand-assisted-notes",
      name: COMMAND_NAMES["toggle-shorthand-assisted-notes"],
      callback: () => { this.fireControl("toggle-assisted-notes"); },
    });
    this.addCommand({
      id: "cancel-shorthand-recording",
      name: COMMAND_NAMES["cancel-shorthand-recording"],
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

  async startCaptureOnActiveNote(
    recordingSignal: ControlSignal = "toggle-transcription",
  ): Promise<void> {
    // Synchronous, before any await. The guard this replaces tested `#capture`, which is
    // assigned further down — so two starts fired inside the setup window both passed it,
    // and the second orphaned the first's follower, control and enhancer.
    if (!canStartCapture(this.#state)) {
      new Notice("Shorthand is already capturing. Stop it before starting another note.");
      return;
    }
    this.dispatch({ type: "capture-starting" });
    let unownedEnhancer: EnhanceRunner | undefined;
    // "Handed off" means something else now owns this runtime's lifecycle — not that a
    // capture started. Set immediately after `#capture = runtime` below, before either
    // dispatch that could follow it: from that assignment on, `finishRuntime`,
    // `forceStopCapture`, `captureSettled` and `abortAssistedNotesStart` are all reachable
    // and each dispatches its own terminal event, so this `finally` must not also fire.
    let handedOff = false;

    try {
      try {
        // `file` and `vaultRoot` moved inside this try along with everything after them:
        // both can fail, and a failure here is exactly the kind of exit the outer `finally`
        // exists to catch. Leaving them ahead of the guard would dispatch "starting" and
        // then abandon it on the very first early return.
        const file = this.activeMarkdownFile();
        if (file === undefined) return;
        const vaultRoot = this.vaultRoot();
        if (vaultRoot === undefined) return;
        const noteSink = this.noteSink(file, vaultRoot);
        const markerPreflight = await preflightMarkers(noteSink);
        if (markerPreflight.status === "error") {
          this.fail(markerPreflight.message);
          return;
        }
        // Do this before either frontmatter or marker writes. Starting capture is
        // the only point at which we may ask the user to let Shorthand claim an
        // unmarked note, and declining must leave every byte untouched.
        if (markerPreflight.status === "needs-scaffold" && !await confirmScaffold(this.app)) return;
        let sidecar: SidecarWriter | undefined;
        if (this.settings.writeTranscriptNote) {
          const noteContent = await noteSink.readContent();
          if (!noteContent.ok) {
            this.fail(noteContent.message);
            return;
          }
          let linked = transcriptWikilink(noteContent.content);
          if (linked === undefined) {
            const candidate = `${this.settings.sidecarDirectory}/${timestampName(new Date()).replace(/\.md$/i, "")}`;
            // A folder named `Notes [2026]` is legal in Obsidian but cannot survive
            // a round trip through `[[...]]`: every later capture would fail to
            // read the link back and would generate another sidecar.
            if (/[[\]|#^]/.test(candidate)) {
              this.fail(
                `The transcript folder "${this.settings.sidecarDirectory}" contains a character a wikilink cannot hold `
                + "([, ], |, # or ^). Rename the folder or change the transcript folder setting.",
              );
              return;
            }
            const linkedResult = await ensureTranscriptLink({
              fileManager: this.app.fileManager,
              metadataCache: this.app.metadataCache,
            }, file, candidate);
            if (linkedResult.status === "error") {
              this.fail(`Could not add the transcript link: ${linkedResult.message}`);
              return;
            }
            linked = linkedResult.linkPath;
          }
          const target = this.app.metadataCache.getFirstLinkpathDest(linkTarget(linked), file.path);
          const store = this.sidecarStore(file, linked, target);
          if (store === undefined) return;
          sidecar = new SidecarWriter(store.describe, {
            flushIntervalMs: DEFAULT_CONFIG.sidecarFlushIntervalMs,
            store,
          });
        }
        if (!await this.ensureScaffold(noteSink)) return;

        const transcript = new TranscriptStore();
        let enhancer: EnhanceRunner | undefined;
        let enhancementUnavailable: string | undefined;
        try {
          enhancer = await this.createEnhancer(
            noteSink,
            DEFAULT_CONFIG.enhancement.timeoutMs,
          );
          unownedEnhancer = enhancer;
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
        // Resolved with the follower's parsed `hello` record; `ShorthandRecorder.start()` explains
        // why the start toggle waits on it, and Assisted Notes additionally gates the toggle on
        // the record's advertised `capabilities`.
        let markAttached = (_info: HelloInfo): void => {};
        const attached = new Promise<HelloInfo>((resolveAttached) => { markAttached = resolveAttached; });
        const recorder = this.settings.controlShorthandRecording
          ? new ShorthandRecorder({
            control,
            recordingSignal,
            report: (phase, result) => this.reportControl(phase, result, recordingSignal),
            // The recorder's wait for the terminal record replaces the follower's own drain
            // rather than preceding it, so it gets the same budget.
            finalizeTimeoutMs: DEFAULT_CONFIG.drainTimeoutMs,
            attachGraceMs: ATTACH_GRACE_MS,
            beginGraceMs: BEGIN_GRACE_MS,
            // Only Assisted Notes needs the capability gate and the bounded acknowledgement: an
            // older app would otherwise parse-fail the flag mid-capture, and Shorthand's
            // disabled-mode refusal exits the forwarding process 0 with nothing to say a
            // recording never actually began. Meeting keeps the plain fire-and-forget contract.
            ...(recordingSignal === "toggle-assisted-notes"
              ? { requiredCapability: "toggle-assisted-notes", startAcknowledgementMs: START_ACKNOWLEDGEMENT_MS }
              : {}),
          })
          : undefined;
        const runtime: CaptureRuntime = {
          noteFile: file,
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
        handedOff = true;
        unownedEnhancer = undefined;
        // Meeting is fire-and-forget: a sent toggle is proof enough, so it goes straight to
        // capturing. Assisted Notes waits — see the acknowledgement branch below, and
        // START_ACKNOWLEDGEMENT_MS for why a sent toggle is not proof there.
        if (recordingSignal !== "toggle-assisted-notes" || recorder === undefined) {
          this.dispatch({ type: "capture-started" });
        }
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
            // `record.capabilities`, when present, already passed core's own defensive parsing
            // (`stringArrayField`): a malformed field is dropped before this event ever fires, so
            // it is not re-validated here.
            markAttached({ capabilities: record.capabilities });
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
        if (recorder === undefined || recordingSignal !== "toggle-assisted-notes") {
          // Meeting's existing contract, unchanged: not awaited here — the capture is live
          // either way — but the promise is retained by the recorder itself, which is what lets
          // a stop sequence wait for it.
          void recorder?.start(attached);
          new Notice(`Shorthand capture started: ${file.path}`);
        } else {
          // Assisted Notes opts into the bounded acknowledgement: a `sent` toggle is not proof
          // Shorthand actually started recording (see `START_ACKNOWLEDGEMENT_MS`), so the
          // "capture started" notice — and the dispatch that claims capturing — wait for that
          // proof instead of firing unconditionally.
          void recorder.start(attached).then(async (outcome) => {
            if (outcome === "started") {
              // `recorder.start()`'s own race can settle "ack" — and so resolve `"started"`
              // here — even after `requestStop()` flipped its stop flag, if the acknowledgement
              // and the stop request land in the same microtask window; see `#runStart`'s
              // acknowledgement race in recorder.ts. That would reset `stopping: false` while a
              // stop is tearing this same runtime down. Left alone deliberately: the ordinary
              // path (`requestStop()` synchronous with the call site) never races this way, and
              // whichever order wins, `finishRuntime` dispatches `capture-stopped` right behind
              // it and the mode self-heals.
              this.dispatch({ type: "capture-started" });
              new Notice(`Shorthand capture started: ${file.path}`);
              return;
            }
            if (outcome === "stopped") {
              // A concurrent stop/quit already owns its own notices and teardown.
              return;
            }
            const reason = recorder.startFailure;
            if (reason !== undefined) new Notice(ASSISTED_NOTES_START_FAILURE_NOTICES[reason], 10_000);
            await this.abortAssistedNotesStart(runtime);
          });
        }
      } catch (error) {
        // If setup failed after the agent client was created but before the runtime took
        // ownership, there is no #capture for forceStopCapture() to dispose.
        await unownedEnhancer?.dispose().catch((cleanupError: unknown) => {
          this.fail(`Agent session cleanup failed: ${errorMessage(cleanupError)}`);
        });
        this.fail(errorMessage(error));
        this.forceStopCapture();
      }
    } finally {
      // Any path that left without handing ownership to a live runtime has to release
      // `starting`, or the plugin refuses every later start with "already capturing".
      // `capture-start-failed` returns to idle only from `starting`, so a setup error
      // that already dispatched a sticky `error` keeps its message.
      if (!handedOff) this.dispatch({ type: "capture-start-failed" });
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
    // dispose() calls stop() synchronously before its first await, so no provider work can
    // outlive unload even though Obsidian cannot await this hook.
    void runtime.enhancer?.dispose().catch((error: unknown) => {
      console.error(`[shorthand] Agent session cleanup failed: ${errorMessage(error)}`);
    });
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

  /**
   * Assisted Notes' start acknowledgement timed out, its capability check refused, or no hello
   * ever arrived — `startCaptureOnActiveNote()`'s `not-started` branch calls this rather than
   * `finishRuntime()`, because nothing here was ever driven to "capturing" in the sense that
   * path expects: there is no finalized transcript worth a closing enhancement pass, and
   * "Shorthand capture stopped" would tell the user a capture had run when it never actually
   * started recording. Unlike `forceStopCapture()` this can and does await the follower's exit
   * and the sidecar's flush, since it runs from inside the start sequence, not a shutdown hook.
   */
  private async abortAssistedNotesStart(runtime: CaptureRuntime): Promise<void> {
    if (this.#capture !== runtime) return;
    runtime.stopping = true;
    runtime.enhancer?.stopLiveTicks();
    runtime.client.forceStop();
    await runtime.settled;
    await runtime.sidecar?.close().catch(() => {});
    await runtime.enhancer?.dispose().catch((error: unknown) => {
      this.fail(`Agent session cleanup failed: ${errorMessage(error)}`);
    });
    if (this.#capture === runtime) this.#capture = undefined;
    // Not `capture-stopped`: this path exists precisely because no recording ever
    // started, and reporting a stopped capture tells the user something ran.
    this.dispatch({ type: "capture-start-failed" });
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
    const noteSink = this.noteSink(file, vaultRoot);
    try {
      // Two separate facts, deliberately. A capture survives a failed createEnhancer, so
      // "is a capture running here" and "does it have a runner" are not the same question,
      // and collapsing them would let a second enhancer start on a note a capture still owns.
      const captureOnThisNote = this.#capture?.noteFile === file;
      const liveEnhancer = captureOnThisNote ? this.#capture?.enhancer : undefined;
      const noteContent = await noteSink.readContent();
      if (!noteContent.ok) throw new Error(noteContent.message);
      const mode = resolveEnhanceMode({
        command,
        captureOnThisNote,
        captureEnhancerReady: liveEnhancer !== undefined,
        transcriptLink: transcriptWikilink(noteContent.content),
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
      if (!await this.prepareScaffold(noteSink)) return;
      switch (mode.kind) {
        case "live-capture":
          // `liveEnhancer` is what made this mode reachable; re-checking is for the compiler.
          if (liveEnhancer === undefined) return;
          this.reportOutcome(await liveEnhancer.enhanceNow("link"), command);
          return;
        case "transcript": {
          const sidecar = this.app.metadataCache.getFirstLinkpathDest(linkTarget(mode.transcriptLink), file.path);
          if (sidecar === null || sidecar === file) {
            this.fail("The note's shorthand-transcript link does not resolve to a separate vault note.");
            return;
          }
          const enhancer = await this.createEnhancer(
            noteSink,
            DEFAULT_CONFIG.enhancement.standaloneTimeoutMs,
          );
          try {
            enhancer.appendTranscript(await this.app.vault.read(sidecar));
            this.reportOutcome(await enhancer.enhanceNow("link"), command);
          } finally {
            await enhancer.dispose();
          }
          return;
        }
        case "notes-only": {
          const enhancer = await this.createEnhancer(
            noteSink,
            DEFAULT_CONFIG.enhancement.standaloneTimeoutMs,
          );
          try {
            // No appendTranscript, and core's empty-transcript gate would decline forever
            // without the waiver. The note's own prose reaches the model as `user_notes`.
            this.reportOutcome(await enhancer.enhanceNow("link", { allowEmptyTranscript: true }), command);
          } finally {
            await enhancer.dispose();
          }
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

  /**
   * `signal` is only consulted for phase `"start"`, which is the one notice that has to name a
   * specific recovery command — see `START_NOT_RUNNING`. Every other phase's wording is fixed
   * regardless of which signal was being sent.
   */
  private reportControl(phase: RecorderPhase | "manual", result: ControlResult, signal?: ControlSignal): void {
    if (result.status === "sent") return;
    if (result.status === "not-running") {
      new Notice(phase === "start" ? START_NOT_RUNNING(signal ?? "toggle-transcription") : NOT_RUNNING_NOTICES[phase], 10_000);
      return;
    }
    this.fail(`Shorthand control failed: ${result.message}`);
  }

  private async createEnhancer(
    sink: ObsidianNoteSink,
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
      agent = new ClaudeAgentClient(claudeAgentOptions(this.settings));
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
      agent = new CodexAgentClient({
        codexPathOverride: codexExecutable,
        ...codexAgentOptions(this.settings),
      });
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
      sink,
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

  private async prepareScaffold(sink: ObsidianNoteSink): Promise<boolean> {
    const preflight = await preflightMarkers(sink);
    if (preflight.status === "error") {
      this.fail(preflight.message);
      return false;
    }
    if (preflight.status === "needs-scaffold" && !await confirmScaffold(this.app)) return false;
    return this.ensureScaffold(sink);
  }

  private async ensureScaffold(sink: ObsidianNoteSink): Promise<boolean> {
    const result = await scaffoldAfterPreflight(sink, resolveTemplateSections(this.settings.templateSectionText));
    if (result.ok) return true;
    this.fail(result.message);
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
      try {
        await runtime.sidecar?.close();
        await runtime.enhancer?.waitForIdle();
        if (reason === "stopped" && runtime.enhancer !== undefined) {
          // Not issued from either command: this is capture's own finishing pass. "Enhance now"
          // is still the right retry, since it is the command that resumes work on a note this
          // capture already owns.
          this.reportOutcome(await runtime.enhancer.enhanceNow("link"), "enhance-now");
        }
      } finally {
        await runtime.enhancer?.dispose();
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
        // Dispatched before `fail()`, not after: `fail()` dispatches its own sticky
        // `error`, and this pass's slot has to be released without disturbing it.
        // `enhancement-finished` would also release the slot, but it additionally clears
        // a sticky `error`/`enhancement-stopped` via `restingMode` — the reward for a pass
        // that actually completed. This pass didn't, so nothing here may fix what `fail()`
        // is about to report as broken.
        this.dispatch({ type: "enhancement-ended" });
        this.fail(status.message);
        return;
      case "requeued":
        // `enhancement-ended` fires on both branches below, including the silent one: a
        // plain re-queue (no `retryAfterMs`) is the routine case — the note kept changing
        // under the writer, i.e. the user typing during the meeting — and it still has to
        // release the slot `started` claimed, or the depth never returns to zero and the
        // status bar reads "· writing" for the rest of the capture. Only a target that
        // asked for a backoff is actionable as a `Notice`.
        //
        // Writing through Obsidian, the note itself is never the busy party, so the
        // `Notice` reports the delay without advising a remedy that would not apply.
        this.dispatch({ type: "enhancement-ended" });
        if (status.retryAfterMs !== undefined) {
          this.fail(`${status.message} Shorthand will retry on the next pass.`);
        }
        return;
      case "timed-out":
        // Self-healing like a re-queue: the transcript is kept and retried. Only the
        // eventual drop at the re-queue limit loses data, and that arrives as `error`.
        // Still releases the slot `started` claimed — see the `requeued` comment above.
        this.dispatch({ type: "enhancement-ended" });
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
      // No `enhancement-finished` here: core emitted a `finished` status before
      // returning this outcome, and `onEnhanceStatus` already dispatched for it.
      // Both firing double-decrements the pass counter, which ends the `enhancing`
      // state while a second, overlapping pass is still writing.
      new Notice(outcome.written ? "Shorthand updated the AI block." : "The AI block was already up to date.");
    } else if (outcome.status === "expired") {
      // Same reason: `onEnhanceStatus`'s `expired` arm owns the dispatch and the Notice.
    } else if (outcome.status === "requeued") {
      this.fail(outcome.retryAfterMs === undefined
        ? `Enhancement was safely re-queued (${outcome.reason}).`
        : `The meeting note was busy. Run ${enhanceCommandName(command)} again in a moment.`);
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

  private noteSink(file: TFile, vaultRoot: string): ObsidianNoteSink {
    return new ObsidianNoteSink({
      file,
      agentContext: { cwd: vaultRoot },
      api: {
        vault: this.app.vault,
        openEditor: (target) => this.openEditor(target),
      },
    });
  }

  /**
   * The editor holding `file`, in whichever leaf holds it. Deliberately not
   * `getActiveViewOfType`: Obsidian keeps a separate unsaved buffer per leaf,
   * so a note in a split or a background tab can be holding keystrokes that its
   * file does not have yet. Writing such a note through the Vault would put the
   * update underneath that buffer, and the buffer wins on its next save.
   */
  private openEditor(file: TFile): Readonly<{ editor: Editor; save(): Promise<void> }> | undefined {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || view.file !== file) continue;
      return { editor: view.editor, save: () => view.save() };
    }
    return undefined;
  }

  /**
   * Convert a wikilink into a Vault store, never an operating-system path.
   * MetadataCache is authoritative for an existing target (including aliases
   * and renamed files); only a missing generated target falls back to its
   * vault-relative link text so Vault.create can make it on first flush.
   */
  private sidecarStore(note: TFile, link: string, resolved: TFile | null): ObsidianSidecarStore | undefined {
    // Only an unresolved link falls back to being read as a path, and a link is
    // not a path: `[[Note#Section]]` names a heading inside a note, so the
    // subpath has to come off before either half is used. What is left can be
    // empty — `[[#Section]]` points into the meeting note itself — and an empty
    // name would otherwise become a file called `.md` at the vault root.
    const target = linkTarget(link);
    const path = resolved?.path ?? (target === "" ? "" : normalizePath(addMarkdownExtension(target)));
    if (!isVaultMarkdownPath(path) || resolved === note || path === note.path) {
      this.fail("The shorthand-transcript link must name a separate Markdown note inside this vault.");
      return undefined;
    }
    return new ObsidianSidecarStore({
      api: {
        vault: this.app.vault,
        openEditor: (target) => this.openEditor(target),
      },
      path,
      ...(resolved === null ? {} : { file: resolved }),
    });
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
    const display = describeStatus({
      state: this.#state,
      elapsedMs: this.#capture === undefined ? undefined : Date.now() - this.#capture.startedAt,
      pendingCharacters: this.#capture?.enhancer?.state.pendingCharacters,
      minNewChars: this.settings.minNewChars,
    });
    // `hide()`/`show()` rather than clearing the text: an item holding "" still
    // occupies its separator, which is the space this change exists to reclaim.
    if (!display.visible) {
      this.#statusBar.hide();
      return;
    }
    this.#statusBar.show();
    this.#statusBar.setText(display.text);
    this.#statusBar.setAttribute("title", display.tooltip);
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
    // Each backend fetches its own catalog and renders its own sign-in row (shown only once
    // `signedIn: false` comes back — see displayAgentCatalog), rather than an if/else on a
    // shared block, for the reason recorded on the LLM-profile branch below: a third backend
    // added later must not inherit a block written for a different one.
    if (this.plugin.settings.backend === "claude-agent-sdk") {
      this.displayAgentCatalog(containerEl, displayGeneration, "claude");
    }
    if (this.plugin.settings.backend === "codex") {
      this.displayAgentCatalog(containerEl, displayGeneration, "codex");
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
          href: "https://github.com/mshish/shorthand-obsidian-plugin#driving-shorthands-recorder",
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
   * The model and effort rows for one agent backend, plus the sign-in row that only appears
   * once the fetched catalog says `signedIn: false`.
   *
   * The catalog is fetched lazily, here, rather than in `display()` — it spawns a subprocess
   * and costs ~0.6-2.6s (see `CATALOG_TIMEOUT_MS`'s doc comment in core), so paying that cost
   * for a backend the user has not selected would be wasted work on every tab open. The
   * `isCurrentDisplay` guard follows the same pattern `displayLlmProfileControls` uses: the tab
   * can be closed, or the backend switched, before the fetch resolves, and a resolved fetch
   * must not write into a `Setting` row `display()` has already discarded.
   */
  private displayAgentCatalog(
    containerEl: HTMLElement,
    displayGeneration: number,
    backend: "claude" | "codex",
  ): void {
    const isCurrentDisplay = (): boolean => this.#displayGeneration === displayGeneration;
    const backendLabel: AgentBackendLabel = backend === "claude" ? "Claude" : "Codex";
    const loginCommand = backend === "claude" ? "claude login" : "codex login";
    const modelKey = backend === "claude" ? "claudeModel" : "codexModel";
    const effortKey = backend === "claude" ? "claudeEffort" : "codexEffort";
    let catalog: AgentCatalog | undefined;

    // Reserved here, in the same position the old unconditional "Codex sign-in" row held, and
    // hidden until the fetch resolves and says nobody is signed in — a hard fetch failure gets
    // its own message on the rows below instead, per catalog.ts's AgentCatalog.signedIn doc:
    // neither backend fails merely because nobody is signed in, so this is not the row a
    // failed fetch uses.
    const signInSetting = new Setting(containerEl)
      .setName(`${backendLabel} sign-in`)
      .setDesc(createFragment((desc) => {
        desc.appendText("Sign in with ");
        desc.createEl("code", { text: loginCommand });
        desc.appendText(" in a terminal first. Shorthand uses that sign-in and cannot start it for you.");
      }));
    signInSetting.settingEl.hide();

    let modelDropdown!: DropdownComponent;
    const modelRow = new Setting(containerEl).setName(`${backendLabel} model`).setDesc(catalogLoadingDescription());
    modelRow.addDropdown((dropdown) => {
      modelDropdown = dropdown
        .addOption("", "Provider default")
        .setValue(this.plugin.settings[modelKey]);
      dropdown.onChange(async (value) => {
        // Preserve-and-flag, not clear-and-reset: whether `value`'s model still accepts the
        // stored effort is exactly what `decideEffortRow` below already works out from
        // `this.plugin.settings[effortKey]`, so the effort is left untouched here. A model
        // switch that invalidates it does not lose it — the next render shows it selected,
        // disabled, and described as unavailable, the same presentation `decideModelRow` uses
        // for a stale model id, which is what forces a visible re-pick instead of a silent
        // substitution.
        await this.plugin.saveSettings({ ...this.plugin.settings, [modelKey]: value });
        if (catalog !== undefined) renderEffortOptions(catalog);
      });
    });
    modelRow.setDisabled(true);

    let effortDropdown!: DropdownComponent;
    const effortRow = new Setting(containerEl).setName(`${backendLabel} effort`).setDesc(catalogLoadingDescription());
    effortRow.addDropdown((dropdown) => {
      effortDropdown = dropdown.addOption("", "Provider default");
      dropdown.onChange(async (value) => this.plugin.saveSettings({ ...this.plugin.settings, [effortKey]: value }));
    });
    effortRow.setDisabled(true);

    const renderEffortOptions = (loadedCatalog: AgentCatalog): void => {
      const decision = decideEffortRow(loadedCatalog, this.plugin.settings[modelKey], this.plugin.settings[effortKey]);
      applyCatalogDecision(effortDropdown, effortRow, decision);
    };

    const executableOverride = this.plugin.settings[backend === "claude" ? "claudeExecutable" : "codexExecutable"];
    const fetchCatalog = backend === "claude"
      ? listClaudeModels(executableOverride.length === 0 ? {} : { executableOverride })
      : listCodexModels(executableOverride.length === 0 ? {} : { codexPathOverride: executableOverride });

    void fetchCatalog.then((loadedCatalog) => {
      if (!isCurrentDisplay()) return;
      catalog = loadedCatalog;
      signInSetting.settingEl.toggle(!loadedCatalog.signedIn);

      applyCatalogDecision(modelDropdown, modelRow, decideModelRow(loadedCatalog, this.plugin.settings[modelKey]));
      renderEffortOptions(loadedCatalog);
    }).catch((error: unknown) => {
      if (!isCurrentDisplay()) return;
      const message = catalogFetchFailedDescription(
        backendLabel,
        error instanceof AgentCatalogError ? error.reason : "protocol",
      );
      modelRow.setDesc(message).setDisabled(true);
      effortRow.setDesc(message).setDisabled(true);
    });
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
    if (this.plugin.settings.backend === "claude-agent-sdk" || this.plugin.settings.backend === "codex") {
      new Setting(containerEl)
        .setName("Agent session history")
        .setDesc("Keeps local Claude or Codex transcripts after a capture or one-off enhancement ends.")
        .addToggle((toggle) => toggle
          .setValue(this.plugin.settings.retainAgentSessionHistory)
          .onChange(async (value) => this.plugin.saveSettings({
            ...this.plugin.settings,
            retainAgentSessionHistory: value,
          })));
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

/**
 * Renders a `CatalogRowDecision` from `src/settings-display.ts` onto a model or effort
 * dropdown and its `Setting` row — the thin, untested half of the pair described in that
 * module's `decideModelRow`/`decideEffortRow` doc comments. All the branching lives in the
 * decision; this only walks its `options` array.
 *
 * `DropdownComponent.addOption` has no `disabled` parameter, so a flagged option reaches the
 * underlying `<select>` directly. A disabled `<option>` can still be the element's `.value`
 * when set programmatically — browsers only refuse it as a *user* selection — which is what
 * lets an unavailable stored id stay selected and visible instead of silently falling back to
 * "Provider default".
 */
function applyCatalogDecision(dropdown: DropdownComponent, row: Setting, decision: CatalogRowDecision): void {
  dropdown.selectEl.empty();
  for (const option of decision.options) {
    const optionEl = dropdown.selectEl.createEl("option", { value: option.value, text: option.label });
    optionEl.disabled = option.disabled;
  }
  dropdown.setValue(decision.selected);
  row.setDesc(decision.description);
  row.setDisabled(decision.disabled);
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
          href: "https://github.com/mshish/shorthand-obsidian-plugin#note-writing",
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

/** The note half of a wikilink: `Folder/Note#Heading` names the note `Folder/Note`. */
function linkTarget(link: string): string {
  return link.split(/[#^]/, 1)[0]?.trim() ?? link;
}

function isVaultMarkdownPath(path: string): boolean {
  // A name, not merely an extension: `.md` is a dot-file, not a note.
  return /[^/]\.md$/i.test(path)
    && !path.startsWith("/")
    && !/^[A-Za-z]:/.test(path)
    && !path.includes("\\")
    && path.split("/").every((segment) => segment.trim().length > 0 && segment !== "." && segment !== "..");
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

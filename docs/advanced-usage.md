# Advanced usage

This page covers the controls and configuration behind Shorthand's short setup flow.

## Modes

- **Meeting** takes notes from a conversation, including your microphone and computer audio.
- **Assisted notes** helps organize solo thinking and dictation.

Both modes write only inside Shorthand's owned section of the open note.

## Commands

Obsidian adds the “Shorthand:” prefix in the command palette.

- **Start meeting notes on this note**
- **Start assisted notes on this note**
- **Stop taking notes**
- **Enhance now**
- **Clean up this note**
- **Take notes again from the last meeting** (listed only while a transcript is held for recovery)
- **Toggle Shorthand meeting recording**
- **Toggle Shorthand assisted notes recording**
- **Cancel Shorthand recording**
- **Open Shorthand panel**

**Clean up this note** improves a note you wrote or dictated without using a transcript. It does not run on a note that already has a linked transcript.

## Recovering a transcript

If enhancement fails during a capture, for example because the AI note taker's sign-in expired, Shorthand keeps that capture's transcript in memory. When you stop, the panel shows a card saying some of the meeting didn't make it into your notes, with the raw error under **Details** and a **Take notes again** button. Fix your note taker or choose another one from the line below the mode cards, then press the button; the **Take notes again from the last meeting** command does the same. A successful attempt clears the card, and a failed one keeps the transcript and shows the new error.

One transcript is held per note. Starting a new capture on the same note, dismissing the card, or closing Obsidian discards it. Turn on **Transcript notes** to keep a copy on disk. If the note was deleted, the card offers to copy the transcript to the clipboard instead.

## Meeting end detection

**Detect meeting end and stop recording** is on by default and applies to Meeting mode only; Assisted notes never stops itself. After each enhancement pass the agent reports whether the transcript shows clear signs the conversation is over, such as farewells or people leaving. When it does, the panel and a notice show "Meeting looks like it has ended" with the agent's reason and a 30-second countdown. At zero, Shorthand stops through the same path as **Stop taking notes**, so the closing pass and the transcript recovery card behave as usual. This setting is independent of **Control Shorthand transcription**: it stops Shorthand's recording even when that setting is off, and for a capture started with Shorthand's hotkey. If Shorthand does not confirm the stop, the plugin says so, because it may still be recording.

The agent only reports; the plugin decides, and the transcript is untrusted. Someone saying or pasting "the meeting is over" can do no more than start a countdown you can cancel. Press **Cancel** in the panel or the notice, or keep talking: about one sentence of new speech (core's live-notes threshold) cancels it automatically. After a cancel, a countdown can start again only once new speech has arrived and a later pass reports the meeting ended again. Stopping by hand clears the countdown. With the setting off, the report is ignored.

## Recorder control

**Control Shorthand transcription** is on by default. Starting note-taking asks Shorthand to start the selected mode directly, rather than toggling whatever it happens to be doing. It does not disturb a different recording, is safe to retry, and reports why a request was declined.

Stopping follows the same explicit contract, so a stop cannot start a recording by mistake. If Shorthand quits while a capture is ending, the plugin may reopen it to send the final stop command. Turn the setting off to manage transcription only through Shorthand.

**Detect meeting end and stop recording** is the exception: it is a separate setting, and when it is on, it stops Shorthand's recording when the meeting looks over, whether or not this setting is on.

The three recorder commands are manual controls for Shorthand; they do not start or stop note-taking in Obsidian.

## Auto-start notes from Shorthand hotkey

**Auto-start notes from Shorthand hotkey** is off by default. When it is enabled, beginning a Meetings or Assisted notes recording with Shorthand's own global hotkey automatically starts taking notes on your active note in Obsidian.

The plugin never follows Dictation. A capture that starts this way does not stop Shorthand's recording when you stop it, because the plugin did not start that recording. Stop it with the same Shorthand control that began it. The exception is **Detect meeting end and stop recording**: if it is on and the meeting looks over, the plugin stops Shorthand's recording even for a capture that began this way.

This needs a Shorthand version that reports a recording's mode. An older app is deliberately ignored rather than guessed at.

## AI backends

Choose one enhancement backend in the plugin settings:

- **Claude Code** is the default and can look up related notes elsewhere in your vault.
- **Codex** uses your local Codex login.
- **Cursor CLI** uses your local Cursor installation and subscription. Install the CLI from https://cursor.com/cli.
- **Agent Client Protocol (ACP)** connects to any ACP-compatible agent over standard I/O or WebSocket.
- **LLM provider** supports OpenAI, Anthropic, Ollama, and OpenAI-compatible endpoints.

Claude Code, Codex, Cursor CLI, and ACP receive the current note and transcript. The LLM provider sends them to the provider or endpoint you configure. Ollama and other local compatible endpoints can keep that traffic on your machine. Shorthand itself does not collect telemetry.

Provider credentials are kept in the Shorthand app's credential store, outside the vault, so sync does not copy them.

Leave the API key field blank to keep the saved key. Use **Clear key** to remove it.

## Note writing

The plugin changes only the note section marked for Shorthand. It checks that section again before each update and leaves the current text unchanged if the markers or generated result are invalid.

Under **Note writing**, you can provide your name, customize separate prompts for Meeting and Assisted notes, and change the headings added to a new note. Leave either prompt on **Default** to receive future improvements automatically.

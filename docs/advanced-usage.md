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
- **Toggle Shorthand meeting recording**
- **Toggle Shorthand assisted notes recording**
- **Cancel Shorthand recording**
- **Open Shorthand panel**

**Clean up this note** improves a note you wrote or dictated without using a transcript. It does not run on a note that already has a linked transcript.

## Recorder control

**Control Shorthand transcription** is on by default. Starting note-taking asks Shorthand to start the selected mode directly, rather than toggling whatever it happens to be doing. It does not disturb a different recording, is safe to retry, and reports why a request was declined.

Stopping follows the same explicit contract, so a stop cannot start a recording by mistake. If Shorthand quits while a capture is ending, the plugin may reopen it to send the final stop command. Turn the setting off to manage transcription only through Shorthand.

The three recorder commands are manual controls for Shorthand; they do not start or stop note-taking in Obsidian.

## Following Shorthand's recordings

**Follow Shorthand's recordings** is off by default. When it is enabled, beginning a Meetings or Assisted notes recording with Shorthand's own hotkey starts note-taking on the Markdown note you have open in Obsidian.

The plugin never follows Dictation. A capture that starts this way does not stop Shorthand's recording when you stop it, because the plugin did not start that recording. Stop it with the same Shorthand control that began it.

This needs a Shorthand version that reports a recording's mode. An older app is deliberately ignored rather than guessed at.

## AI backends

Choose one enhancement backend in the plugin settings:

- **Claude Code** is the default and can look up related notes elsewhere in your vault.
- **Codex** uses your local Codex login.
- **LLM provider** supports OpenAI, Anthropic, Ollama, and OpenAI-compatible endpoints.

Claude Code and Codex receive the current note and transcript. The LLM provider sends them to the provider or endpoint you configure. Ollama and other local compatible endpoints can keep that traffic on your machine. Shorthand itself does not collect telemetry.

Provider credentials are kept outside the vault so sync does not copy them:

- Windows: `%APPDATA%\Shorthand\llm-credentials.json`
- macOS: `~/Library/Application Support/Shorthand/llm-credentials.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/shorthand/llm-credentials.json`

Leave the API key field blank to keep the saved key. Use **Clear key** to remove it.

## Note writing

The plugin changes only the note section marked for Shorthand. It checks that section again before each update and leaves the current text unchanged if the markers or generated result are invalid.

Under **Note writing**, you can provide your name, customize separate prompts for Meeting and Assisted notes, and change the headings added to a new note. Leave either prompt on **Default** to receive future improvements automatically.

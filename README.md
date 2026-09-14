# Shorthand

[![Obsidian Community Plugin](https://img.shields.io/badge/Obsidian-Community%20Plugin-7C3AED?logo=obsidian&logoColor=white)](https://community.obsidian.md/plugins/shorthand)
[![Downloads](https://img.shields.io/github/downloads/mshish/shorthand-obsidian-plugin/total?label=downloads&color=4d8b74)](https://github.com/mshish/shorthand-obsidian-plugin/releases)
[![MIT License](https://img.shields.io/badge/license-MIT-536f9e)](LICENSE)
[![Support](https://img.shields.io/badge/Support-Stripe-635BFF?logo=stripe&logoColor=white)](https://buy.stripe.com/bJe28r91b87UemkahifEk02)

**AI meeting notes and personal note taking using your existing AI subscription (ChatGPT, Claude, or Cursor).**

Take meeting notes, think out loud, or tidy up your writing directly in Obsidian. Shorthand organizes conversations and dictated thoughts into clear notes as you speak.

- **Meeting notes** — capture your microphone and system audio for notes that keep up with the discussion, whether you use Zoom, Meet, Teams, or another calling app.
- **Personal notes** — think out loud, dictate your thoughts, or improve writing without a recording.
- **Your writing style** — customize how Shorthand structures and writes your notes.
- **Linked transcripts** — optionally save the transcript so you can revisit the original conversation.
- **More AI options** — connect another AI agent via ACP, choose an API provider, or use a local model with Ollama.

Live transcription runs locally using the [Shorthand desktop app](https://shorthand.ing), which is required for note taking.

By default, Shorthand deletes recordings, transcripts, and AI agent sessions when you finish. It is free and open source.

## Start here

1. Install **Shorthand** from **Settings → Community plugins** in desktop Obsidian.
2. Install and run the [Shorthand desktop app](https://shorthand.ing).
3. In Shorthand's plugin settings, choose an AI backend: Claude Code, Codex, Cursor CLI, an ACP agent, or an LLM provider.
4. Open the note you want to update, then open **Shorthand panel** from the command palette or microphone ribbon icon.
5. Choose **Meeting** for a conversation or **Assisted notes** for solo thinking. Stop from the panel or status bar when you are done.

Requires Shorthand 0.5.0 or newer for the OpenAI, Anthropic, Ollama, OpenAI-compatible, and ACP network backends.

The first start adds Shorthand's note section automatically. Turn off **Automatic note scaffolding** in settings if you prefer to approve it first.

## What you get

- A right-sidebar panel that always shows the current state, elapsed time, and the note being updated.
- Live meeting notes that improve as new transcript arrives.
- A linked transcript note when you turn on **Transcript notes**.
- **Enhance now** for a saved transcript, or **Clean up this note** for writing with no transcript.

## Note writing

Shorthand checks its ownership markers before every update and preserves the existing text if the note is no longer safe to change. Under **Note writing**, you can set your name, adjust mode-specific prompts, and choose the headings in a new note. See [note-writing options](docs/advanced-usage.md#note-writing).

## Privacy and access

- Shorthand transcribes locally and does not collect telemetry.
- The plugin reads and updates your active note and an optional linked transcript. Claude Code may also search other notes in your vault when you choose that backend.
- The selected AI backend receives the current note and transcript. Claude, Codex, Cursor, OpenAI, Anthropic, and compatible providers use the account or endpoint you configure; Ollama and other local endpoints can keep that traffic on your machine.
- The plugin launches the local Shorthand and selected AI executables. Provider keys are stored by the Shorthand app in your operating system's credential store; the plugin never writes them to disk.

## Learn more

- [Advanced usage: commands, AI backends, and settings](docs/advanced-usage.md)
- [Contributing and building from source](CONTRIBUTING.md)
- [Architecture](docs/architecture.md)
- [Support Shorthand on Stripe](https://buy.stripe.com/bJe28r91b87UemkahifEk02) or [GitHub Sponsors](https://github.com/sponsors/mshish)

## Third-party code

The plugin's source is MIT-licensed. Its compiled `main.js` also bundles third-party libraries, including the non-open-source Anthropic Claude Agent SDK, copyright Anthropic PBC, used subject to [Anthropic's legal agreements](https://code.claude.com/docs/en/legal-and-compliance). The build appends an inventory and the applicable license text for every bundled dependency to `main.js`.

The plugin runs on desktop only. It does not include Shorthand, an AI model, or a cloud service.

## License

MIT. See [LICENSE](LICENSE).

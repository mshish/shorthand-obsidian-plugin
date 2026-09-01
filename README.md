# Obsidian Shorthand

Obsidian Shorthand keeps a meeting note up to date while you talk. The [Shorthand desktop app](https://github.com/mshish/shorthand) transcribes your microphone and meeting audio; this plugin turns that transcript and your own notes into a structured summary in Obsidian.

Your notes stay in your vault. You choose which AI backend generates the summary.

## What you need

- The Shorthand desktop app, running with **Follow live transcript output** enabled under **Advanced**
- A desktop Obsidian vault
- One enhancement backend:
  - Claude Agent SDK, with the `claude` CLI installed and signed in
  - Codex, with the `codex` CLI installed and `codex login` completed
  - An OpenAI, Anthropic, Ollama, or OpenAI-compatible provider

Shorthand and this plugin are separate installs. The plugin cannot record or transcribe a meeting by itself.

## Install

### From a release

Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](../../releases/latest). Put them in:

```text
<vault>/.obsidian/plugins/shorthand/
```

In Obsidian, open **Settings → Community plugins**, reload the installed plugins, and enable **Shorthand**.

### With BRAT

Add `mshish/shorthand-obsidian-plugin` as a beta plugin in BRAT. BRAT installs the latest release.

## Start a meeting

1. Open the meeting note in Obsidian.
2. Make sure the Shorthand desktop app is running.
3. Run **Shorthand: Start meeting capture on this note** from the command palette.
4. Run **Shorthand: Stop capture** when the meeting ends.

If the note has not been prepared for Shorthand, the plugin adds the required sections. Turn off **Automatic note scaffolding** in settings if you would rather be asked first. Your own writing stays outside the section maintained by AI.

Turn on **Transcript notes** if you also want a linked note containing the raw transcript. This is optional. **Enhance now** can use that saved transcript after the live capture has ended.

## The Shorthand panel

**Open Shorthand panel**, or the microphone icon in the ribbon, opens a panel in the right sidebar with Start and Stop buttons, the current state, the elapsed time, and the note being captured. It is not opened automatically.

While a capture is running, the status bar shows the elapsed time and clicking it stops the capture. It is hidden when nothing is capturing.

## Commands

Obsidian adds the “Shorthand:” prefix in the command palette.

- **Start meeting capture on this note**
- **Start assisted notes capture on this note**
- **Stop capture**
- **Enhance now**
- **Clean up this note**
- **Toggle Shorthand meeting recording**
- **Toggle Shorthand assisted notes recording**
- **Cancel Shorthand recording**
- **Open Shorthand panel**

**Clean up this note** improves a note you wrote or dictated without using a transcript. It does not run on a note that already has a linked transcript.

## Enhancement backends

Claude Agent SDK is the default. It can look up related notes elsewhere in your vault when improving the meeting note.

Codex uses your local Codex login. An LLM provider uses the provider, model, endpoint, and optional API key you enter in the plugin settings. Codex and LLM provider backends receive the current note and transcript, but they do not search the rest of your vault.

Claude and Codex may send that material to the services associated with the account you signed in to. OpenAI and Anthropic provider profiles send it to those providers; an OpenAI-compatible profile sends it to the endpoint you configure. Ollama and other local compatible endpoints can keep that traffic on your machine. Shorthand itself does not collect telemetry.

Provider credentials are stored outside the vault, so they are not copied by vault sync:

- Windows: `%APPDATA%\Shorthand\llm-credentials.json`
- macOS: `~/Library/Application Support/Shorthand/llm-credentials.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/shorthand/llm-credentials.json`

Leave the API key field blank to keep the saved key. Use **Clear key** to remove it.

## Driving Shorthand's recorder

**Control Shorthand recording** is on by default. Starting and stopping a capture also starts and stops the Shorthand recorder, so you do not need to use its global shortcut.

Starting a Meeting capture cancels any recording already in progress, to guarantee a clean start. Starting an Assisted notes capture instead asks Shorthand to start Assisted notes specifically — it does not disturb a different recording that happens to be running, and it is safe to retry. If you quit Shorthand during a capture, the plugin may reopen it while making sure the recorder is stopped. Turn off **Control Shorthand recording** if you prefer to manage the recorder yourself.

The three recorder commands remain available as manual controls. They control Shorthand but do not start or stop an Obsidian capture.

## Following Shorthand's recordings

**Follow Shorthand's recordings** is off by default. Turn it on and starting a Meetings or Assisted notes recording with Shorthand's own hotkey also starts a capture on the note you have open in Obsidian.

While it is on, the plugin keeps a connection to Shorthand open so it can see those recordings — reopening it roughly every 30 seconds, indefinitely, whenever Shorthand is not running. Dictation is never followed.

A capture started this way does not stop Shorthand's recording when you stop it, because it was not the one that started it. Stop the recording the way you started it.

This needs a Shorthand build that reports which mode a recording is. **No shipped build does this yet** — the `shorthand-app` half that reports it is on an unmerged pull request — so today the plugin always sees a recording started but not what kind, and does nothing rather than guess. Turning the setting on has no effect until that build ships.

## Note writing

The plugin changes only the note section marked for Shorthand. It checks that section again before each update and keeps the existing text if the markers or generated result are invalid.

Under **Note writing**, you can change the instructions used to write notes and the headings added to a new note. Leave these settings on **Default** to receive future improvements automatically.

## What the plugin accesses

- Your active note and any linked transcript note
- Other notes in your vault only when the Claude backend performs a lookup
- The local Shorthand transcript stream
- The local AI command or provider you selected

Outside the vault, the plugin launches the configured Shorthand, Claude, or Codex executable so it can receive transcripts or run the backend you selected. It directly manages the provider-credential file at the platform-specific path above and may create temporary or retained session files for the agent backends; the launched tools use their own account and configuration files. Those accesses are required to connect the recorder and enhancement backend. The plugin does not install or update those programs.

## Third-party code

The plugin's own source is MIT-licensed. The compiled `main.js` also bundles third-party libraries. In particular, the Anthropic Claude Agent SDK is non-open-source software, copyright Anthropic PBC, and its use is subject to [Anthropic's legal agreements](https://code.claude.com/docs/en/legal-and-compliance). The build appends an inventory and the applicable license text for every bundled dependency to `main.js`, so the file installed by Obsidian carries those notices.

The plugin runs on desktop only. It does not include Shorthand, an AI model, or a cloud service.

## Build from source

Use Node.js 20 or later and npm. npm is the documented package manager because this repository commits `package-lock.json`.

For the standard Obsidian development loop, clone the repository into your vault's plugin folder:

```sh
git clone https://github.com/mshish/shorthand-obsidian-plugin.git "<vault>/.obsidian/plugins/shorthand"
cd "<vault>/.obsidian/plugins/shorthand"
npm install
npm run build
npm run dev
```

`npm run dev` watches the source and rebuilds `main.js`. Toggle the plugin off and on after a rebuild unless you use Obsidian's Hot Reload plugin.

To keep the repository outside your vault, set `OBSIDIAN_PLUGIN_DIR` only for the build or watch command:

```sh
OBSIDIAN_PLUGIN_DIR="<vault>/.obsidian/plugins/shorthand" npm run dev
```

```powershell
$env:OBSIDIAN_PLUGIN_DIR = "<vault>\.obsidian\plugins\shorthand"
npm run dev
```

The build copies `main.js`, `manifest.json`, and `styles.css` into that folder. Do not set `OBSIDIAN_PLUGIN_DIR` in your shell profile because builds from any checkout would then overwrite the plugin in your live vault.

Before opening a pull request:

```sh
npm run build
npm test
```

## Architecture

Capture, transcript handling, note updates, and enhancement live in [`shorthand-core`](https://github.com/mshish/shorthand-core). Its [design](https://github.com/mshish/shorthand-core/blob/main/docs/DESIGN.md) and [consumer contract](https://github.com/mshish/shorthand-core/blob/main/docs/CONTRACT.md) describe the implementation boundaries.

## License

MIT. See [LICENSE](LICENSE).

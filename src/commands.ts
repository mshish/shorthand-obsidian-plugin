/**
 * Every command this plugin registers, as data rather than as eight string literals
 * scattered through `main.ts`.
 *
 * It is here and not there for the reason `AGENTS.md` gives for the settings surface:
 * `node_modules/obsidian` ships types only, so nothing in `main.ts` can be imported
 * under `bun test`. A name written inline there is verifiable only by a human reading
 * it, which is how the two capture commands came to be named asymmetrically.
 */

export type CommandId =
  | "start-meeting-notes-this-note"
  | "start-assisted-notes-this-note"
  | "stop-notes"
  | "enhance-now"
  | "clean-up-this-note"
  | "toggle-recording"
  | "toggle-assisted-notes"
  | "cancel-recording"
  | "open-panel";

/**
 * The ids are frozen from here on. Obsidian keys a user's custom hotkey to
 * `<plugin-id>:<command-id>`, so renaming one silently discards their binding with
 * nothing to say it happened. Every id above has already had its one free rename,
 * right here, while that cost still did not apply. `toggle-recording`,
 * `toggle-assisted-notes` and `cancel-recording` came off `toggle-shorthand-recording` /
 * `toggle-shorthand-assisted-notes` / `cancel-shorthand-recording` — ids that embedded
 * the plugin id Obsidian already prefixes onto every command
 * (`obsidianmd/commands/no-plugin-id-in-command-id`). `start-meeting-notes-this-note`,
 * `start-assisted-notes-this-note` and `stop-notes` came off ids that still said
 * "capture" after the commands themselves stopped saying it. This plugin has not
 * shipped to the marketplace yet, so no hotkey bound to any of the old ids existed to
 * break — the one moment the freeze could not yet apply to. It will not come again.
 *
 * The spellings of the modes come from the app's own settings pane
 * (`shorthand-app/src/shorthand/locales/en.json`: "Meetings", "Assisted notes"), not
 * from this repository's guesses. Sentence case throughout, per Obsidian's plugin
 * guidelines, and no "Shorthand:" prefix — the palette adds one.
 *
 * The three recorder commands do name Shorthand, because they drive the external app
 * rather than this plugin. That exception is recorded in `docs/settings-copy-style.md`
 * under "Obsidian's other binding rules".
 */
export const COMMAND_NAMES: Readonly<Record<CommandId, string>> = Object.freeze({
  "start-meeting-notes-this-note": "Start meeting notes on this note",
  "start-assisted-notes-this-note": "Start assisted notes on this note",
  "stop-notes": "Stop taking notes",
  "enhance-now": "Enhance now",
  "clean-up-this-note": "Clean up this note",
  "toggle-recording": "Toggle Shorthand meeting recording",
  "toggle-assisted-notes": "Toggle Shorthand assisted notes recording",
  "cancel-recording": "Cancel Shorthand recording",
  "open-panel": "Open Shorthand panel",
});

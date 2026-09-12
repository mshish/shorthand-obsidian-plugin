# 0.9.0

## Breaking: provider keys move to the Shorthand app

Provider API keys (OpenAI, Anthropic, Ollama, OpenAI-compatible, and ACP
network agents) are no longer stored by the plugin. The Shorthand desktop app
now holds them in your operating system's credential store, and the plugin
talks to the app over its request socket to set, clear, and check them. The
plugin itself never writes a provider key to disk.

**Requires Shorthand 0.5.0 or newer.**

## One-time migration

On the first load after upgrading, if the vault has a legacy
`llm-credentials.json` file, the plugin moves its key into the Shorthand
app's keyring, deletes the file, and shows "Shorthand: provider keys moved to
the Shorthand app." Nothing is required from you beyond having the app
running:

- If the app isn't running yet, the migration defers and runs on the next
  load — the file and your settings are untouched until then.
- Provider, model, and any other settings values carry over unchanged; only
  the secret itself moves.
- If the app is unreachable and the key can't be moved, LLM enhancement asks
  you to open Shorthand rather than falling back to a stored key.

No action is needed for vaults with no legacy credentials file.

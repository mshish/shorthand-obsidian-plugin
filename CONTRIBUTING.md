# Contributing

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

## Verify a change

Before opening a pull request, run:

```sh
npm run build
npm test
```

See [AGENTS.md](AGENTS.md) for the repository's maintainer and release procedures.

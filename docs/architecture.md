# Architecture

Shorthand for Obsidian is the Obsidian-facing layer: commands, settings, the right-sidebar panel, recorder lifecycle, and note-sink wiring. The capture, transcript, and enhancement primitives live in [shorthand-core](https://github.com/mshish/shorthand-core).

The plugin keeps decision rules in `src/` so they can be unit tested. `main.ts` remains the thin Obsidian wiring layer because Obsidian ships type declarations without a runtime module for tests.

For the cross-repository design boundaries, see shorthand-core's [design](https://github.com/mshish/shorthand-core/blob/main/docs/DESIGN.md) and [consumer contract](https://github.com/mshish/shorthand-core/blob/main/docs/CONTRACT.md).

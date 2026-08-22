Read @AGENTS.md

This repo is the downstream half of `shorthand-core`, which lives at
`D:/tools/shorthand-repos/shorthand-core` and is consumed here by pinned GitHub
tag. If you arrived because core's exported surface changed, that change is not
finished until this repo compiles and its gates pass.

The rest is deliberately not imported — open it only when the work calls for it.

- `README.md` § "Cutting a release" — before bumping the core pin. It records
  that npm can keep a cached git resolution and leave the old version in
  `node_modules` even after the tag in `package.json` changes, which makes a
  green typecheck prove nothing. Re-run the install naming the tag explicitly
  and check that the `resolved` commit in `package-lock.json` actually moved.
- `README.md` § testing — before assuming `npm test` covers `main.ts`. It
  cannot be imported under `bun test`, so most of what it expresses is verified
  only by typecheck, the bundle-load smoke test, and a human.
- `test/plugin-bundle.test.ts` — before changing entry points or adding a
  barrel. It loads the built `main.js` under a stub `obsidian`, and it exists
  because CI once built the bundle and never required it, which shipped a load
  failure with every check green.

`onEnhanceStatus` in `main.ts` switches exhaustively over `EnhanceStatus["kind"]`
with a `never` default. Keep it that way: it was an if/else chain once, and a
status added upstream fell through silently while every check stayed green.

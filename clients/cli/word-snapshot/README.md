# word-snapshot — the Notees-for-Word add-in, committed snapshot

Built snapshot of the `clients/word` add-in's **localhost flavor**
(`pnpm build:localhost` in `clients/word`), served locally by
`notees word serve` — the add-in is no longer hosted on the Notees sync
server.

- `dist/` — the statics the command serves (task-pane bundle + vendored
  Office.js + manifest icons), copied verbatim from the add-in build.
- `manifest.xml` — the raw manifest template with its `${HOST}` /
  `${BASE_PATH}` placeholders intact. `notees word serve` renders it for
  the actual port into the per-user cache dir
  (`~/.cache/notees/word/manifest.xml`, `%LOCALAPPDATA%\notees\word\manifest.xml`
  on Windows) and serves it at `/manifest.xml`; Word's shared-folder catalog
  reads the cache-dir file.
- `PROVENANCE.json` — the source commit and build command.

Resolution at runtime and at embed time (see `src/word/paths.ts` and
`scripts/word-dist-source.mjs`): `NOTEES_WORD_DIST` > a built
`clients/word/dist` in the monorepo checkout > this snapshot > the copy
embedded in `cli.mjs`. The snapshot exists so source checkouts, CI, and the
test gate always have statics without building the add-in; refresh it from
a built `clients/word` when the add-in ships — never edit these files by
hand.

The single-file release bundle carries no snapshot; an installed bundle
serves the copy embedded in `cli.mjs` (or a snapshot pointed at by
`NOTEES_WORD_DIST`).

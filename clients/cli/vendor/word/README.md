# vendor/word — the Notees-for-Word add-in, vendored

Built snapshot of the `miquelrosell99/notees-word` **localhost flavor**
(`pnpm build:localhost`), served locally by `notees word serve` — the
add-in is no longer hosted on the Notees sync server.

- `dist/` — the statics the command serves (task-pane bundle + vendored
  Office.js + manifest icons), copied verbatim from the add-in build.
- `manifest.xml` — the raw manifest template with its `${HOST}` /
  `${BASE_PATH}` placeholders intact. `notees word serve` renders it for
  the actual port into the per-user cache dir
  (`~/.cache/notees/word/manifest.xml`, `%LOCALAPPDATA%\notees\word\manifest.xml`
  on Windows) and serves it at `/manifest.xml`; Word's shared-folder catalog
  reads the cache-dir file.
- `PROVENANCE.json` — the source commit and build command.

Refresh — never edit these files by hand:

```sh
node scripts/sync-word-dist.mjs [--from <notees-word checkout>]
```

The single-file release bundle carries no vendor tree; an installed bundle
serves a snapshot pointed at by the `NOTEES_WORD_DIST` env var instead.

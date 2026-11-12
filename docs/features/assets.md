# Assets

Files in Notees: content-addressed blobs with an index row, uploaded once and referenced from nodes three different ways. An asset is not a page attachment buried in a page — it is a first-class `asset`-classed node in the graph (searchable, linkable, cover-worthy) whose bytes ride the workspace's content-addressed store, keyed by sha256: identical files store their bytes once, no matter how many nodes reference them. The index keeps each upload's mime type, size, original name, and time; the node's attachments are ordinary log state (`asset.attach`/`asset.detach`), so every replica derives the same file lists from the same log.

## The three attachment surfaces

- **The `Attachments` property row** — an asset-typed property value points at an asset node (the type is the filter). A source's files are the canonical case ([sources.md](sources.md)): the row renders its files as a list (thumbnail, name, remove) with **Upload** and **Link** buttons — Upload opens the upload modal (drag-drop or paste, a category chip, image/audio preview, explicit progress, honest server errors), Link opens the asset-scoped picker; a multi row keeps both buttons at the list's bottom, a single-value row asks for a clear first. The property machinery is [properties.md](properties.md)'s.
- **Cover and Banner** — wire node fields on any page (`coverAssetId` / `bannerAssetId`), not properties: the header card's right-side image and the page banner each reference one asset node, and the asset wears a derived badge while anything points at it ([pages.md](pages.md#page-chrome--what-sticks-and-where)).
- **Content tokens** — an `asset_ref` token inline in a block renders the file instead of naming it: image-like bytes show an inline preview (click opens the fullscreen lightbox, with download), anything else a filename-and-size chip (click downloads); a block whose entire content is one asset renders it full-bleed. A reference whose asset no longer exists shows a dashed placeholder with the raw id — never a silent hole ([outliner.md](outliner.md)).

## Upload acceptance

Uploads are **content-sniffed first**: the server's magic-byte table decides (jpeg / png / webp / pdf / epub / audio), never the filename. When sniffing is inconclusive — some audio containers keep no recognizable magic in their first frames — the audio extensions **aac / m4a / ogg / flac** are accepted as a fallback, and sniffing always wins when it does decide (a `.aac` rename of a png is still a png). Anything else is refused with an honest error naming both checks, and each upload is capped per category (document vs media). The upshot for scripts: pass real bytes; extensions only rescue genuine audio.

## The CLI surface

Everything above is scriptable ([cli.md](../cli.md)):

```console
$ notees asset add ./paper.pdf --object 01a0dd78-…     # upload + attach in one call
$ notees asset add ./scans/                             # a directory: every regular file, recursively
$ notees asset add a.pdf b.pdf ./more/ --jobs 4         # mixed batch, 4-way concurrency
$ notees asset attach 01a1… --object 01a0dd78-…         # link an EXISTING asset (idempotent)
$ notees asset list [--object 01a0dd78-…] [--limit 100] # the workspace index, newest first
$ notees asset get 01a1… --output ./copy.pdf            # download the bytes
```

`asset add` takes one or more files **and/or directories** (a directory adds every regular file in it, recursively) — per-file failures are collected and reported with the counts (exit 1 when anything failed, `--stop-on-error` aborts the rest), and `--object` attaches every uploaded asset to that node. `asset attach` links an asset that already exists: it pre-validates both ids, then submits the same `asset.attach` op the app uses — re-attaching upserts the same derived row, a state no-op. `asset list` reads the workspace index with each asset's attached-object ids (`--object` filters to one node's files). In the scripting shell the same rides as `upload(filePath)` / `addAssets(paths, objectId?)` helpers.

## Known edge: attach to a dangling node id

Stated plainly, because it bites scripts first: **attaching to a node id that does not exist stores the bytes but attaches them to nothing.** The multipart upload stores the CAS bytes before the attach, and the `asset.attach` applier upserts its derived row without validating the node — so a dangling id answers success with the file orphaned (a server-side guard there is pending). Both CLI commands pre-validate the node id before anything is written; any direct API caller should do the same.

## Assets in and out

Exports can bundle the bytes: markdown zips carry an `assets/` folder, the PDF renderer inlines them as data URLs, and the JSON archive records every asset reference in its edges ([exporting.md](exporting.md)). Imports are the honest limit: a Notees dump's bundled asset bytes are **not** restored through the snapshot path — they are counted in the import's statistics, never faked ([import.md](import.md)).

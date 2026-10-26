# Import

The unified **Import Workspace** modal — the command palette's "Import…" row
(Ctrl/Cmd+K → "Import…") brings in content from five sources. Everything
writes through the ordinary client op path (the current-workspace sources
work fully offline; the workspace-creating sources need the sync server).

## Sources

| Source | Target | Input |
|---|---|---|
| **Notees Dump** | A *new* workspace | A v2-produced export: a `.json` archive or a zip with `dump.json` (+ optional `assets/`) |
| **Markdown** | A *new* workspace | `.md` files (Logseq/Obsidian grammar), picked after the workspace is created |
| **Markdown file** | The *current* workspace | One `.md` file |
| **Logseq folder** | The *current* workspace | A Logseq graph folder (`pages/`, `journals/`, `assets/`) |
| **Logseq DB** | The *current* workspace | A Logseq DB-version `.sqlite` export |

The workspace-name field (with the "This name is already taken" check,
client-side and case-insensitive) shows only for the two workspace-creating
sources. Import is disabled until the source is valid; Enter submits.

## Notees Dump

The export is validated (`dump.json` at the zip root, unsafe paths refused),
rebuilt **client-side** into a derived-store image — the archive's nodes,
classes, property schemas, and values replayed as op envelopes over a fresh
in-browser store — and installed into a new envelope-empty workspace through
the snapshot checkpoint path (`PUT /snapshot/data?mode=import`, the server's
sanctioned import mode: the workspace's log starts empty and the installed
snapshot is its rebuild source). On success the app switches to the new
workspace.

Known limit: a dump zip's **asset bytes are not restored** through the
snapshot path (a snapshot image is the derived node projection; CAS bytes
would need re-keying the asset endpoints do not support). Bundled assets are
counted in the import's statistics, never faked.

## Markdown (workspace)

A new empty workspace is created, your `.md` files are picked, and each file
becomes a page with its outline blocks — **plain text, no classes, no link
conversion** (the v1 semantics). Per-page failures are caught, listed, and
skipped without aborting the run. The app switches to the new workspace when
done.

## Markdown file

One `.md` file into the current workspace, honoring the frontmatter grammar:

- `---` or `+++` delimiters, YAML, keys lower-cased. Invalid YAML fails loud.
- Recognized keys: `title`, `name`, `uuid`, `classes` (uuids or
  `{uuid?, name?}`), `tags`, `is_page` (default true), `icon`, `color`,
  `properties` (dict).
- Title precedence: frontmatter `title` → `name` → the first `# ` heading →
  "Untitled".
- A frontmatter `uuid` is honored: the node is created with that id;
  `block` (default) fails loud on a conflict, `return_existing` reports the
  existing node.
- Classes resolve by uuid or case-insensitive name; unknown classes fail
  loud. Unknown tags become stub pages (the v1 semantics).
- The body appends as **one** child block, markdown-inline parsed (marks,
  headings; external links stay literal).
- `properties` match workspace property schemas by name; values coerce per
  the schema's type (strings that name a node resolve to node refs; lists
  per item). Un-preparable values land in the warning list — never fatal.

## Logseq folder

The v1 client-side Logseq Markdown importer, ported 1:1:

- Page title from the filename (`.md` stripped, `___` → `/`, percent-decoded);
  page-level `key:: value` properties parse before the first bullet,
  block-level `key::` stays inline. `id::` is ignored — fresh uuidv7
  everywhere.
- `[[wiki-links]]` resolve through the page map; unresolved targets get
  **stub pages**.
- Journals (`journals/YYYY_MM_DD.md`) parent their pages under the
  calendar's day node.
- Pure-asset blocks (`![alt](../assets/name){:attrs}`) and inline asset refs
  upload through the assets API and become asset references; unresolvable
  refs stay literal text.
- **Sharp edge (documented, not fixed):** re-running the import duplicates
  the pages — there is no dedupe, matching v1.

## Logseq DB (.sqlite)

The Logseq DB-version export decodes **in the browser** (the transit-encoded
`kvs` datom store is read with sql.js; nothing leaves the device). Before
anything is written you get a **dry-run preview**: how many nodes would be
created, how many existing nodes would be filled, what's unchanged, and
which classes/properties have no mapping. Writes happen only on the
explicit confirm, with a progress bar.

The reconcile is by uuid, and **Notees wins**:

- A node that already exists is never renamed and its content is never
  touched. A property value is written only when the node has no value for
  that schema — your edits since any previous import are never clobbered.
- A missing node is created with its **preserved Logseq uuid**, parented
  under its Logseq parent (a parent missing everywhere → the node is
  created at root and listed).
- Classes map by title (case-insensitive) against the workspace's classes;
  unmapped classes are listed and their members import **unclassed** —
  never guessed.
- Property values map through an explicit table (Logseq title → Notees
  schema), validated against the owner's export. Values for unmapped
  properties are **not written** and are listed.
- Date-typed values join the calendar's date chain; node-typed references
  resolve in a two-pass (content first, then refs); a reference missing
  from both the export and the workspace is listed, not faked.
- The export's assets are metadata only (checksums, no file bytes) — they
  are counted as skipped, never faked.

The report lists Created / Filled / Skipped / Failed plus the unmapped
classes and properties, the unresolved references, and every failure.

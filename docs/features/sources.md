# Sources

The source library: one `source` class family covering the Zotero item-type roster, a resolver that turns an identifier (or a PDF) into a prefilled source, citekeys generated from your pattern, and bibliography export (.bib / CSL-JSON) over any selection. A source is an ordinary node — in the graph, queryable, backlinkable; its files are `attachments` ([properties.md](properties.md)'s dedicated asset row) and its notes are ordinary child blocks ([pages.md](pages.md)). The family toggle and the class machinery underneath are [classes.md](classes.md)'s; the export dialog's other formats are [exporting.md](exporting.md)'s.

## The source family: 39 type-classes

`source` is the family base; 9 everyday types are enabled from the start (`book`, `journal_article`, `thesis`, `document`, `film`, `song`, `tv_series`, `conference`, `web_page`) and 30 more carry the Zotero long tail (`book_section`, `conference_paper`, `patent`, `dataset`, `artwork`, …). 18 of the long-tail types seed **archived** — off your pickers and the create list, not out of the graph: archiving is visibility, never absence. An archived type still extends `source`, still answers `class:` queries, still exports. Two doors turn one switch: pick the type's card in the classes gallery, or check its row in the Sources settings list below. Each type carries its Zotero field set (a journal article shows container/volume/issue/pages/ISSN; a patent shows patent number and jurisdiction), all inherited from the family base. You can also define your own source subclass at runtime — `extends [source]` joins the family.

## Adding a source

Three doors lead to the same dialog: the command palette's **Add source…** (hidden offline, the share-target pattern), the **Add source…** button in the Sources settings section, and a node picker's **Create source from link** row, offered whenever what you typed into a create row looks like a DOI, ISBN, arXiv id, or URL. The dialog takes one input — a DOI, ISBN, arXiv id, a URL, or a PDF link — plus a PDF file input. An identifier resolves against the metadata providers; a URL is fetched server-side and scanned for the DOI printed in its PDF; a file you pick uploads to the asset store and links to the created source (a failed upload creates no half-source). On success the create form opens **prefilled**: type, title, the type's venue fields, year, DOI, ISBN, URL, publisher, and authors/editors.

The honest edges: a PDF with no DOI says so and creates nothing; the resolver-off state points at the Sources settings (a plain URL then still creates a plain weblink page); a provider failure surfaces the provider's message; a resolved type that is archived is re-enabled automatically, the un-archive riding the same undo step as the create. A DOI or ISBN already in the library shows an **Already in your library** warning with a link — creating again stays allowed. An empty citekey fills from your pattern when auto-citekey is on, a deterministic `a`/`b`/`c` suffix disambiguating collisions (compared case-insensitively, continuing past `z`).

## Authors: plain text, and the people graph

Authorship is deliberately dual-track, and the two tracks never write each other. **`authors`** is plain text — one name per value, in BibTeX "Family, Given" form (the create form splits a pasted `;`- or newline-separated list, a comma lives safely inside one name). It is the citation and export source of truth, and creating a source never spawns person nodes. **`linkedAuthors`** is the people-graph view: node-typed links to `person`/`organization` agents, drawn as chips with backlinks, carrying zero availability semantics — you link the authors you care about, whenever you care, by hand. Authorship reads use `authors` first and derive names from the `linkedAuthors` targets only when the text track is empty (read-time only, never written back).

## Settings → Features → Sources

The Sources section under the workspace feature toggles:

- **Citekey pattern** — the token language `[auth]`/`[auth:lower]` (first author's family), `[year]`, `[title]`/`[title:lower]`/`[title:lower:N]` (first N words), plus literals; default `[auth:lower][year][title:lower:3]`. The input previews a sample entry live (Lovelace, Ada / 1843 / "Notes on the Analytical Engine" → `lovelace1843notesonthe`), an invalid pattern shows its error and is never written, and the committed pattern only affects future generations — existing citekeys are never recomputed.
- **Metadata resolver** — look up DOIs/ISBNs/arXiv ids when a source lacks metadata. See the privacy note below.
- **Auto-citekey** — fill an empty citekey from the pattern when a source is created.
- **Source types** — all 39 type-classes as checked rows: unchecked is archived, the same archive flag the gallery respects.

Every settings change is one write to the feature row, so the keys never clobber each other — and a family toggle off/on keeps them (the row is one whole-row unit; turning Sources off hides the family's surfaces, instances keep their data).

## Export: .bib and CSL-JSON

The export dialog registers **BibTeX (.bib)** and **CSL JSON** beside the other formats. Both are one document over the whole selection — every source-classed node becomes one entry, batch included, deduplicated by node id; body blocks are content, never entries. Entries project through the same dual-track read everywhere ([exporting.md](exporting.md)): `authors` first, `linkedAuthors`-derived names when empty, the type's venue fields through its Zotero bindings. The LaTeX export's bibliography reads the same contract.

## The resolver's privacy note

Resolution asks three public metadata providers — **Crossref, Open Library, and arXiv; that list is complete.** Only the queried identifier leaves the server: no request body, no workspace content, nothing else. The resolver is the server's only outbound egress. Your workspace's resolver toggle gates it (absent = on), results cache for 24 h on the server, and a provider that fails or times out (10 s) answers with an honest error instead of a stall.

## Deliberately not here

The designed-not-built register, stated plainly: **in-editor `cites` citations** (a `cites` verb marking text with a source + locator — the model is settled, the surface is not built), a **PDF reader** (PDFs attach as files; nothing renders them in-app), and **Zotero sync** (import maps Zotero item types; there is no live sync). The source library ships what is on this page — no more, and it says so.

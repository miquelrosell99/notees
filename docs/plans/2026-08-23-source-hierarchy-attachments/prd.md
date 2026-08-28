---
status: implementation-ready
created: 2026-08-23
---

# Source Hierarchy & Attachments — Unified Knowledge System

Canonical implementation brief. Owner-reviewed 2026-08-23 (14 review points + Agent hierarchy + citekey support + lowercase naming + dispatch-sequence/test-gate review + citekey pattern setting + reading-workflow refinements + KOReader-via-paste + bib-export removal incorporated). Aligned 2026-08-28 with the owner's v1-phases document: Work/Edition nesting pattern, `cover` property on sources, supplementary source metadata (`movie`, `language`, `series`, `series_index`), asset-metadata plugin API, export-engine architecture, phase↔task mapping, v1 success journey (Decisions 27–32).

## Context

Product direction: grow Notees from a Logseq-like notes app into a unified knowledge system where sources (books, papers, movies…), evidence (highlights), and user knowledge share one node model. Hard invariants: `source` is a system class; `book ⊏ source` etc.; `attachments` is a system property pointing to **Asset nodes**; a Book with `attachments = []` is fully valid and is *the same object* once files exist; Library is a projection, not a subsystem; OPDS/Zotero/exports are integrations over Source+Asset semantics; **a node classed as source may be a page OR a block**.

## Problem

Build the foundation: reliable system classes/inheritance, reliable system properties, asset attachments, source classes, optional Library view — on top of existing machinery whose gaps are documented in `gap-analysis.md`.

## Synthesis

- `gap-analysis.md` — per-lens repository evidence (7 lenses, file:line).
- `alternatives.md` — contested design points, options weighed: **A1** existing class system + `extends`; **B1** `attachments` = system multi-`node` property, `role` = optional selection property on the `asset` class; **C1** extend existing asset-node model; **D1** capabilities = class-membership checks; **E→23** Library = builtin view plugin (supersedes the earlier core-feature + workspace-setting option); **F1** highlights as nodes with asset/provenance properties; **G** class-system fixes in scope; **H** agent superclass + stored citekey with configurable pattern.

Chosen in one line: everything is classes + properties + the op log; **no new tables, no new op types, no parallel storage, no second membership/collection subsystem** in v1.

## Conceptual Model (owner-approved)

```
Node
├── Note
├── source          (system class; pages AND blocks)
│   ├── book
│   ├── paper
│   ├── article
│   ├── thesis
│   ├── document
│   └── movie           (Task 3b; further media classes later, with a consumer)
├── agent           (system class — authorship/creation)
│   ├── person
│   └── organization
├── collection      (system class; membership = nesting + links, v1)
├── highlight       (transient evidence; staged under the source)
└── asset           (already exists; Notees-level representation of content)

source
  └── attachments → asset        "Assets semantically attached to this node"
                        │         (NOT "all files somehow associated")
                        ├── role           (optional; metadata about the asset, NOT the blob)
                        ├── filename / mime_type / size (node_asset row)
                        └── Blob (sha256 CAS — purely physical content;
                                  two assets may point to identical bytes)

source
  └── authors → agent (person | organization)
```

**Work/Edition (optional pattern, not an ontology):** any source may use ordinary nesting (`parent_id`) to express Work → Edition: the **Work** holds shared identity (title, authors, cover); **Editions** nest under it and carry edition-specific metadata (`isbn`, `language`, `citekey`) plus `attachments`. Nothing forces this split — a flat source with attachments is equally valid, and a Work with `attachments = []` is complete. The Library's grouped view (Task 7) merely exploits the structure when present.

**Cover:** `cover` reuses the existing system cover property (`00000000-0000-0000-0000-000000000005`, the asset-UUID page-cover mechanism), bound to `source` so every subclass inherits it. Cards/OPDS resolve a source's cover with **fallback to `parent.cover`** — an Edition with no cover shows its Work's. The asset-side `role=cover` value remains for representation-level consumers; the property is the canonical pointer.

**Naming convention:** class names are **lowercase everywhere**, including user-facing contexts (`source`, `book`, `person`, `agent`, …). Internal identifiers stay `SOURCE_CLASS_UUID`-style.

**Asset↔blob phrasing (not an invariant):** in v1, each asset node references exactly one canonical blob, while content-addressable storage may deduplicate the underlying bytes. This deliberately leaves room for derived assets / alternative encodings later.

**Closure invariant (hard):** `book extends source` and `source extends X` must mean queries for `X` include every book — on both derived stores. Same for `person extends agent`: anything filtering by `agent` must include persons and organizations.

**Authorship naming & citation:** structured name properties on `person` — `given_name` + `family_name` (node display name stays the full natural name, e.g. "Frank Herbert"); `organization` carries just its name.

**Reading & processing workflow convention (evidence → elaboration → own thinking):** (1) add sources from the web UI (drag files, PDF lookup, ISBN/DOI); (2) read on the surface that fits the device — KOReader on e-ink, the Flutter companion on mobile; (3) highlights reach Notees as **transient staging blocks** under the source — from KOReader via **pasting its Markdown highlight export** onto the book page (parsed into highlight blocks), from Flutter via direct sync — ordinary movable blocks with literal text + `highlight_asset` + `provenance`, **not** permanent immutable entities; (4) processing = the user converts them into paraphrases or curated verbatim quotes **wherever they want** — the source page, a daily note with a link to the book and that day's reading notes below, anywhere; deleting staged highlights is normal workflow, not data loss, because the permanent knowledge is the user's own words; (5) the user's own thinking (opinions, questions, connections) lives as ordinary blocks on the source page or linking to specific highlights. The app imposes **no reading-session or history structure** — users who group notes per re-read or per day do it with ordinary nesting, by hand, at zero system cost.

**`citekey`**: system property on `source`, **type `text`, empty by default, user-editable**. It is filled only when absent — by import integrations, or by an explicit "generate citekey" action — and **never recomputed or overwritten** once stored. Generation is driven by a **workspace-level setting `citekey_pattern`** (Better BibTeX-style template; default `{family_name:lower}{year}` → `herbert1965`; supported tokens at minimum: `family_name`/`organization_name`, `year`, `title_word`, with `:lower`/`:upper` modifiers; unresolved tokens fall back to title-derived, then to `untitled`). Changing the pattern affects only future generations. Collisions are resolved **deterministically** (letter suffix: `herbert1965` → `herbert1965a` → `herbert1965b`), never by silent overwrite. Not autogenerated at node-creation time: that would freeze a key before author/year metadata exists, and page-only generation would be inconsistent since sources can be blocks. This is what makes cite-as-`@citekey` possible later; inline citation rendering is out of v1 scope.

## Chosen Approach (detail)

1. **Class-system hardening (prerequisite)**: recursive closure recompute on `class.setExtends`; cycle detection (reject op); frontend `class.update` honors `extends` (parity); server-side enforcement via dormant `SystemClassConstraintError` (`app/domain/errors.py:93-102`).
2. **System UUID registry + parity test**: add fixed UUIDs (`…0023` onward) for classes `source, book, paper, article, thesis, document, agent, person, organization, collection, highlight, weblink` and property schemas `attachments, authors, isbn, doi, publication_date, publisher, role, provenance, highlight_asset, given_name, family_name, citekey, url` to `app/domain/entities/constants.py` + `frontend/src/constants/systemProperties.ts`. **Automated parity test** fails on any drift between the two maps. (Capacities/Tana survey: `weblink` is the only basic object type Notees lacked; meeting/project/idea stay user classes — see Decision 25.) Supplementary batch (Task 3b, Decision 29): `movie` class + `language`/`series`/`series_index` properties + `cover` bound to `source`.
3. **Seed + backfill**: both seeds (`app/core/seed.py`, `frontend/src/core/seed.ts`) emit identical op sequences: `class.create` **with `extends`**, `propertySchema.create`, `classPropertyEdge.create`. Property schemas are **class-scoped, not global** (`scope='class'` + binding): `attachments`/`authors` (filter `agent`)/`isbn`/`doi`/`publication_date`/`publisher`/`citekey`(text) → `source`; `given_name`/`family_name` → `person`; `url` → `weblink`; `role` → `asset`; `provenance`/`highlight_asset` → `highlight`. Inheritance through the closure gives them to subclasses for free; ordinary nodes never see them. Idempotent "ensure system schema" runs **on workspace open** for existing workspaces (re-emit; all these appliers are `INSERT OR REPLACE`-safe).
4. **Plugin provisioning idempotency (platform-level prerequisite)**: `PluginContext.ensure_class` / `ensure_property_schema` must **converge** — name-based lookup (pattern: `app/features/import_/service.py:140-168`) + system-UUID resolution; add `set_class_extends` and `is_system` support. Same convergence requirement for **find-or-create of `agent` nodes by name** during imports (no duplicate "Frank Herbert" per sync). Fixed at platform level, not patched inside individual plugins.
5. **Source block-compatibility**: source classes stay OUT of `BLOCK_ONLY_CLASS_UUIDS`; nothing in seeds, UI filters, or queries may assume `kind='page'`.
6. **Assets**: widen `ALLOWED_CONTENT_TYPES` (PDF, EPUB, CBZ, …) + magic-byte signatures + size policy (`app/features/assets/utils.py:15-29`). `role` = selection property on the `asset` class: `representation|cover|supplement|attachment|generated|thumbnail|other`, **optional, no default** — `attachments: [asset A]` with no role is valid; OPDS/export phases get stricter.
7. **Collections (v1)**: `collection` system class; membership via existing nesting + links only. **No second collection-membership table.** Typed `member_of` deferred with the edge substrate.
8. **Highlights (transient evidence)**: `highlight` system class; a highlight's visible content is the selected text; properties `highlight_asset` (node-ref → asset, optional) and `provenance` (`koreader`, `flutter`, …). Position info (chapter/page, CFI, datetime) rides as plain text in the block content — there is deliberately **no `locator` system property** (Decision 33). They arrive as **ordinary movable blocks** staged under the source; the user processes them into paraphrases/quotes wherever they want and deletes them at will. **No reading/history structure is imposed by the system.**
9. **Hierarchy-aware class filtering (generic fix)**: the query compilers already descend the closure, but node pickers/search filters do exact UUID matching (`frontend/src/features/content/hooks/useNodeSearch.utils.ts:91,266`, possibly `queryHelpers.ts:884`/`buildSuggestions`). The fix must be **generic** — every place that filters nodes by a class (pickers, suggestions, list filters, search filters) resolves filter UUIDs through `class_hierarchy` — not special-cased for `agent`. Otherwise the query system and the pickers disagree for any superclass.
10. **KOReader highlights via paste (no plugin)**: the KOReader plugin is **eliminated**. Highlights arrive through the normal paste flow: KOReader's Markdown highlight export pasted onto a source page is detected and parsed into highlight blocks (selected text as content; chapter/page + datetime kept as inline text; note preserved; `provenance=koreader`), staged under that source. The source is the page the user pastes on — no matching pipeline, no sync endpoint, no HTTP client. Pasting the same export twice dedupes via `(source, text-hash)`. Non-KOReader Markdown falls through to normal paste.
11. **Plugin migrations**: Zotero/BibTeX move off ad-hoc "Source*" classes onto the system tree; Zotero item types map to book/paper/article; creators → find-or-create `person`/`organization` refs; DOI/date/URL/tags land in properties; `citekey` filled **only when empty**, generated from the workspace `citekey_pattern` setting — existing citekeys (including Zotero's own) are never recomputed or overwritten; collisions get deterministic letter suffixes.
12. **Library view**: **a builtin plugin**, not a core feature — shipped as the reference implementation of the hardened view platform (plugins compose views from exposed primitives; enable/disable without restart). Plugin enablement replaces the `library_enabled` setting as the toggle: disabling hides only the management UX — source classes, attachments, graph, search keep working. Views themselves stay query-driven (`query_ast = class:source`, hierarchy-aware by construction); declarative custom views (query + view mode, no code) ride the existing `node_view` machinery.
13. **Search**: make FTS/metadata class filters hierarchy-aware (`search.ts:125-132`, `queryNodes.ts:202-209` currently exact-match); defer any `node_class` junction/index until measured.
14. **Library UX parity (Phase 2, post-v1)**: three-pane Library layout (collections/agents tree + item table + metadata inspector), drag-to-attach & drag-to-collect, add-by-identifier (ISBN/DOI lookup), PDF lookup (add-by-file). All additive UX over the same Source+Asset model — no data-model changes. See Tasks 11–14. Library lists support **table and card view modes** (card covers from the system `cover` property) already in v1 (Task 7).
15. **Work/Edition via nesting** — see Conceptual Model; no new mechanism, only conventions plus the Library grouped/flat view modes. Identity on the Work; `isbn`/`language`/`citekey`/`attachments` on the Edition.
16. **Asset metadata plugins (Task 15b)**: a MIME-registered plugin API operating on **streams** — `extract(stream) → source properties`, `inject(stream, properties, cover?) → modified stream`, `extractCover(stream) → image stream`; the core owns storage, hashing, and `blob_ref` updates. EPUB (OPF read/write + cover inject/extract) is the v1 plugin, with per-attachment "Extract metadata → source" / "Sync source metadata → EPUB" actions.
17. **Export engine architecture (Task 15)**: profile config JSON → provider plugin `generateManifest` (injected services; the provider never touches the filesystem) → path validation → reconciler (managed vs foreign files) → materializer (`copy` v1). The same query yields the same selection in Library UI, API, and export.

## Schema & Migration Impact

**No paradigm change; no storage-format migration in v1.** The op log remains the source of truth; derived SQLite on both sides; `protocol/SPEC.md` untouched. v1 adds **no new op types and no new tables** — all new semantics are *data rows* written through existing ops (`class.create/setExtends`, `propertySchema.create`, `classPropertyEdge.create`, `property.set`).

Soft-schema / behavior shifts to be aware of:

1. **Backfill ops on workspace open**: existing workspaces receive a burst of system class/property/binding ops on first open after upgrade. Idempotent and replay-safe, but visible in the log.
2. **Closure recompute changes derived results** for pre-existing user hierarchies (stale closures become correct). Converges on replay; recommend a derived-state rebuild after deploy.
3. **Cycle rejection is emit-time only**: replay of any historical op must never crash the applier — validate at creation, tolerate at replay.
4. **Seed sequence changes** affect fresh workspaces; backend/frontend seed parity (contract `seed.ts:4-9`) must hold or adoption diverges.
5. **Task 9 is the only true data migration**: merging duplicated ad-hoc "Source*" plugin classes into the system tree and re-classing their nodes — deliberately scoped "where feasible" because it touches user data.
6. Deferred perf work (`node_class` junction / expression index for Library scans) would be a derived-schema change, but derived state is rebuildable from the log — low risk, only after measurement.

## Execution protocol (owner-mandated)

- **Controlled sequencing, not a 10-way fan-out.** Dispatch the foundation batch first — Tasks 1–4 — then reassess repository state before starting higher-level work. Target order: class-system correctness → system classes + properties → asset attachments/MIME → hierarchy-aware pickers → Library view → KOReader paste import → Zotero/BibTeX + citekeys → search/index → (Phase 2: Library UX parity — three-pane, drag-and-drop, add-by-identifier, PDF lookup) → (Phase 3: asset-metadata plugin API + EPUB → export profiles plugin → OPDS plugin) → (Phase 4: Flutter library mode + mobile annotation, cross-repo).
- **Test gate after every foundational task**: run the existing backend suite (`pytest`) and frontend suite (vitest) plus the targeted parity tests (derived-state replay parity, UUID-map parity, seed parity). Notees has dual Python/TS derived-state implementations — a green task on one side only is not done.
- Tasks 1 and 2 are independent (disjoint files) and may run in parallel; Tasks 3 and 4 follow once 1+2 land.
- Task 3b (supplementary system schema: `movie`, `language`/`series`/`series_index`, `cover` binding) can land any time after Task 3 and before Task 7; Task 4b (plugin platform UX: restartless toggles, catalog, ZIP install, folder discovery) follows Task 4; Task 15b (asset-metadata plugin API + EPUB) joins Phase 3 after Task 5. Under the owner's v1-phases framing, "v1" ≈ Tasks 1–10 + 3b + 15b + 15 + 16 (Fases 1–7); see the phase mapping below.

## v1 product phases ↔ plan tasks (owner fases doc, 2026-08-28)

The owner's v1 phasing restates the target from a product perspective; much of its Fases 1–2 already ships in Notees today (offline graph, op log + sync via relay, blocks, references, backlinks). This plan is the delta.

| Fase (owner doc) | Plan tasks | Notes |
|---|---|---|
| 1 — Core Graph | (exists) + Tasks 1–3, 3b | Class-hierarchy/inheritance fixes, system classes, class-scoped properties. Per-node ACL deferred — Decision 32. |
| 2 — Notes | (exists) | Blocks, references, backlinks already ship. |
| 3 — Source System + Work/Edition | Tasks 2–3, 3b, 6 | Work/Edition = optional nesting pattern (Decision 27); `citekey` empty by default, generated at import (Decision 8). |
| 4 — Asset Integration + metadata plugins | Tasks 5, 15b | Asset nodes + CAS already exist; the metadata plugin API is the new part. |
| 5 — Query Infrastructure + Library views | Tasks 6, 7, 10 (+ Task 15 selection semantics) | `has_asset()` = attachment role/MIME filter; `member_of`/`references` expressed via nesting + links in v1 (typed edges deferred); Library modes: table/card × flat/grouped; Library views ride the existing saved-query/`node_view` machinery; same query → same results in UI, API, export. |
| 6 — Export System | Task 15 | Layered engine per Decision 31; continuous event-driven reconciliation + per-user roots (Decision 13); ships as a generalized builtin **plugin, disabled by default** (Decision 34). |
| 7 — OPDS + KOReader | Tasks 16, 8 | OPDS = builtin **plugin, disabled by default** (Decision 34). KOReader = import of its exports (Markdown paste v1; `metadata.epub.lua` optional stretch), no plugin, no sync endpoint. |
| 8 — External integrations (post-v1) | Tasks 9, 13, 14 | Zotero/BibTeX appear early only because those plugins **already ship** and must be migrated off ad-hoc classes (schema hygiene); net-new providers (Crossref/ISBN/Calibre) stay post-v1. Multi-device sync already exists via the relay. |

Reaffirmed non-goals for v1 (owner doc §"Lo que NO es"): no native EPUB/PDF reader in the web app (management only; reading via OPDS → KOReader, or the Flutter companion in Phase 4); not a media server (Jellyfin/Plex); not a Calibre/Zotero replacement (imports aside); Work/Edition is optional structure, not a mandatory ontology; no full-text search inside binaries; the filesystem is a projection, never the canon.

**v1 success journey (owner doc):** create a Work "Dune" and an Edition "Dune (1965)" nested under it; upload `dune.epub` as an asset attached to the Edition; edit metadata (title, author, cover) in the web UI; inject metadata + cover into the EPUB via the metadata plugin; write a note referencing the Work with quote blocks and see backlinks from Dune; export the Edition to the export folder as `Herbert - Dune.epub` (copy); serve it via OPDS to KOReader; read offline; paste KOReader highlights back into Notees referencing the right source. All without internet.

## Task Breakdown

### Task 1 — Class-system hardening
- **Files**: owns `app/core/derived/class_hierarchy.py`, `app/core/derived/class.py`, `frontend/src/core/derived/class.ts`, `tests/core/` + `frontend/src/core/derived/__tests__/` (new tests). Shares `app/core/derived/__init__.py` (dispatch, read-mostly).
- **Consumes**: existing op payloads (`class.create.update/setExtends`), closure table shape.
- **Produces**: recursive closure recompute; `class.setExtends` cycle rejection (validation error); frontend `class.update` honoring `extends`; replay-parity tests proving backend/frontend derived states match for hierarchy op sequences.
- **Acceptance**: `pytest tests/core` and frontend vitest pass; new test: `X ← source ← book`, change `source extends Y` → book's closure includes Y; cycle op `A↔B` rejected on both sides; query `class:X` returns book instances.

### Task 2 — System UUID registry + parity test
- **Files**: owns `app/domain/entities/constants.py`, `frontend/src/constants/systemProperties.ts`, one new parity test (e.g. `tests/core/test_system_uuid_parity.py` + a small exported JSON/TS snapshot).
- **Consumes**: fixed-UUID convention (`…0023` next free; `…0002` skipped).
- **Produces**: class UUIDs `source, book, paper, article, thesis, document, agent, person, organization, collection, highlight, weblink`; property UUIDs `attachments, authors, isbn, doi, publication_date, publisher, role, provenance, highlight_asset, given_name, family_name, citekey, url`; parity test comparing both maps. (`…0018` was briefly assigned to a `locator` property, later withdrawn — Decision 33; the UUID stays reserved.)
- **Acceptance**: parity test passes; deliberately breaking one side fails it.

### Task 3 — Seed & backfill system schema
- **Files**: owns `app/core/seed.py`, `frontend/src/core/seed.ts`, workspace-open ensure path (backend `app/core/workspace_store.py` open/ensure entry; frontend `ensureLocalWorkspace`). Shares `app/domain/entities/constants.py` (Task 2 output).
- **Consumes**: Task 1 (extends reliability), Task 2 (UUIDs).
- **Produces**: identical seed op sequences creating classes with `extends` (incl. `person/organization extends agent`), **class-scoped** property schemas (`scope='class'`; `citekey` as type `text`, empty default) with `classPropertyEdge` bindings per the mapping in approach item 3 (incl. `url`→`weblink`); idempotent ensure-system-schema on workspace open for existing workspaces.
- **Acceptance**: fresh workspace (backend seed + frontend seed) has full closure rows and bound properties, verified on both derived stores; ensure run twice converges (no duplicate classes/schemas); seed parity contract (`seed.ts:4-9`) holds — adoption test passes. Full pytest + vitest suites green.

### Task 3b — Supplementary system schema (movie, language/series/series_index, cover binding)
- **Files**: owns `app/domain/entities/constants.py`, `frontend/src/constants/systemProperties.ts`, `app/core/seed.py`, `frontend/src/core/seed.ts`, the workspace-open ensure path, `tests/core/test_system_uuid_parity.py`.
- **Consumes**: Tasks 1–3 (the same additive seed + backfill machinery; no new mechanism).
- **Produces**: `movie` class (extends `source`) with the next free class UUID (`…0035`); class-scoped property schemas `language` (text), `series` (text), `series_index` (number) bound to `source` with fresh UUIDs (`…0025`–`…0027`; `…0018` stays reserved — withdrawn `locator`); the existing `cover` system property (`…0000-0005`) bound to `source` via `classPropertyEdge` so all source subclasses inherit it. Same idempotent ensure on workspace open; parity test extended.
- **Acceptance**: fresh + existing workspaces converge to the extended schema on both derived stores; `class:source` queries include `movie` nodes; source property panels show `language`/`series`/`series_index`/`cover`; parity and seed-parity tests green; full suites green.

### Task 4 — Plugin provisioning idempotency
- **Files**: owns `app/plugins/core/context.py`, `app/core/workspace_store.py` (lookup helpers), `tests/` (new plugin-context tests).
- **Consumes**: Task 2 UUIDs; name-lookup pattern from `app/features/import_/service.py:140-168`.
- **Produces**: converging `ensure_class`/`ensure_property_schema` (system-UUID resolution, then name lookup, then create); `PluginContext.set_class_extends`; `is_system` flag support; `find_or_create_node_by_name(class_uuid, name)` helper for agent dedup.
- **Acceptance**: `ensure_class("source")` always returns the system UUID; two Zotero syncs produce exactly one `source` class and one "Zotero Key" schema; find-or-create agent called twice with the same name returns the same node. Full pytest suite green.

### Task 4b — Plugin platform UX parity (catalog, ZIP install, folder discovery)
- **Files**: owns `app/plugins/core/manager.py` (restartless enable/disable), `app/plugins/core/installer.py` (ZIP install path alongside git), `app/plugins/core/loader.py` (rescan/discovery), the plugins router, frontend plugins settings UI (`UserSettingsModal` plugins tab or a new `frontend/src/features/plugins/`).
- **Consumes**: Task 4 (idempotent provisioning); existing loader/installer/manager.
- **Produces**: (a) **restartless enable/disable** — fix `manager.py:194-200` so toggling mounts/unmounts routers and frontend contributions without restart (Task 7's view platform depends on this); (b) **plugin catalog UI on par with Zotero/Obsidian** — installed list with toggles, per-plugin settings entry, install action, "open plugins folder" affordance, clear builtin vs external distinction; (c) **ZIP import** — upload a plugin `.zip` → validate manifest → extract into the external plugins folder (path containment, no traversal, no absolute paths) → discover + load without restart; (d) **folder-drop discovery** — plugin folders placed manually by the user in the config plugins folder (`data/plugins/`) are detected and listed (startup scan + an explicit rescan action; loading still respects enablement); (e) storage convention documented: external plugins live one-folder-per-plugin under the instance plugins folder; git-URL install remains as an additional source.
- **Acceptance**: enabling/disabling a plugin takes effect without restart; installing a ZIP results in a loaded plugin listed in the catalog; dropping a valid plugin folder into `data/plugins/` + rescan lists and loads it; a malicious ZIP (`../` entries, absolute paths) is rejected; disabling a plugin removes its routes/views/settings contributions cleanly.

### Task 5 — Asset MIME widening
- **Files**: owns `app/features/assets/utils.py`, `app/features/assets/service.py` (size policy), `tests/test_assets.py`.
- **Consumes**: existing CAS/upload/token machinery (unchanged).
- **Produces**: PDF/EPUB/CBZ(+document set) in allowlist with magic-byte signatures; size policy for documents.
- **Acceptance**: EPUB and PDF uploads create asset node + `node_asset` row and are downloadable via token flow; pre-existing asset tests still pass.

### Task 6 — Hierarchy-aware class filtering (generic) + class-aware picker
- **Files**: owns `frontend/src/features/content/hooks/useNodeSearch.utils.ts`, `frontend/src/core/worker/queryHelpers.ts` (`buildSuggestions`), the node-link picker used by slash-menu insertion, the class-aware quick-create dialogs, related tests.
- **Consumes**: existing `class_hierarchy` closure; Task 3 (agent/person classes exist).
- **Produces**: a **generic** hierarchy-aware filter resolution — every node picker/suggestion/list filter that applies `class_filter_uuids` resolves through the closure; no `agent`-specific special-casing. On top of it, a **class-aware create flow** in the standard node-link insertion: the picker interprets "create" according to the filtered class — filtered by `source` (or a subclass) it opens a **source quick-create dialog** (title, source-class selector, authors via the agent picker, optional year/DOI) that creates a properly classed source node and links it; filtered by `asset` it opens a **file selector → upload**, and the resulting asset node is linked/set (reuses the existing upload path: `node.create` + `class.assign` + `asset.upload`; PDF/EPUB depend on Task 5); filtered by `agent` (or `person`/`organization`) it opens a **minimal agent creator** — type choice (person/organization), `given_name` + `family_name` for persons (feeds citekey generation), plain name for organizations; **no contact-manager fields** (an agent is a name + structure; anything more is ordinary user properties). Since the picker already searches existing agents while typing, create only fires on no-match — reinforcing find-or-create dedupe. This same flow serves the `attachments` property editor: adding an attachment to a book = pick an existing asset or upload a new file in one action. A slash-menu "Link to source" entry may open the same picker pre-filtered as a shortcut, but there is one insertion path and one class-aware creator.
- **Acceptance**: with `authors` filtered by `agent`, the picker offers both `person` and `organization` nodes; a `class:source` suggestion filter offers books; exact-subclass filters still work (no over-broadening); from the slash menu, inserting a source link with no match lets the user create a `book` with title + authors in one dialog, and the created node has the right class and agent refs; in the `attachments` editor of a source, "add" offers existing asset nodes AND an upload action — uploading a PDF creates the asset node and sets it as the property value without leaving the picker; in the `authors` editor, creating "Frank Herbert" yields a `person` with `given_name=Frank`, `family_name=Herbert`, and typing "Herbert" later offers that same node instead of a duplicate.

### Task 7 — Library as a builtin view plugin (+ view-platform hardening)
- **Files**: owns new `frontend/src/features/library/` (or `frontend/src/plugins/builtin/library/`) + backend plugin package, plugin view-platform plumbing (`frontend/src/plugins/core/registries.ts`, `app/plugins/core/manager.py` enablement), route registration.
- **Consumes**: Task 3 (classes exist), Task 6, existing `QueryNodeCollection`/view registry/`useViewSettings`.
- **Produces**: (a) **View-platform hardening**: plugins can compose views from the app's primitives (`QueryNodeCollection`, class-aware picker, `PropertiesSection`, `PageViewHeader`) via the plugin API instead of writing components from scratch; enable/disable without restart (fix `manager.py:194-200`); (b) **Library as the reference builtin plugin** over that platform: sidebar entry, top-level view (All Sources, per-subclass sections, Authors by `class:agent`) driven by `class:source` query AST; **table and card view modes** (card covers from the system `cover` property — `NodeView.tsx:730-751` precedent) **× grouping modes**: **flat** (every source its own row) and **grouped** — sources with source-classed children render as Works with their Editions collapsed beneath them (ordinary parent/child structure; Decision 27); kind-agnostic (block-sources appear). The `library_enabled` setting from earlier drafts is dropped — plugin enablement IS the toggle; source classes/attachments/graph/search work regardless.
- **Acceptance**: disabling the Library plugin removes the UI without restart while source nodes/properties/graph keep working; enabling restores it; a block classed `book` and a page classed `book` both list under Books; table and card modes render and switch; grouping toggles between flat and Work→Edition grouped views; cover resolves from the source's `cover` property with fallback to `parent.cover`, neutral placeholder otherwise; a minimal third-party-style test plugin can register a custom view (e.g. class-filtered dashboard) using only the exposed primitives.

### Task 8 — KOReader highlight import via Markdown paste
- **Files**: owns the frontend paste pipeline (paste handler / Markdown import path) + a KOReader-export parser (`frontend/src/features/import/` or colocated with paste handling), tests with real KOReader Markdown fixtures.
- **Consumes**: Task 3 (`highlight` class + `provenance`/`highlight_asset` schemas); existing Markdown paste/import machinery.
- **Produces**: detection of KOReader's Markdown highlight export on paste (book title header + per-highlight blocks with chapter/page/datetime); parsing into `highlight` nodes staged under the source page pasted on — content = selected text (chapter/page + datetime kept as inline text), `provenance=koreader`, note preserved; dedupe via `(source, text-hash)` so re-pasting the same export is a no-op; non-KOReader Markdown falls through to normal paste untouched. **No plugin, no sync endpoint, no HTTP client.** KOReader's `metadata.epub.lua` highlight export is an optional secondary input to the same parser pipeline (stretch; same dedupe contract).
- **Acceptance**: pasting a real KOReader export onto a book page creates one highlight block per annotation with text/chapter-info/note intact; pasting it twice creates no duplicates; pasting ordinary Markdown behaves exactly as today.

### Task 9 — Zotero/BibTeX onto system tree + citekey generator
- **Files**: owns `app/plugins/builtin/zotero/`, `app/plugins/builtin/bibtex/`, a shared citekey-generation helper (proposed: `app/domain/services/citekey.py` or `app/plugins/core/` utility), workspace setting `citekey_pattern` registration + settings UI entry, frontend counterparts.
- **Consumes**: Tasks 2–4; workspace settings plumbing (precedent: `app/features/workspaces/router.py:112-134`).
- **Produces**: item-type → book/paper/article mapping; creators → find-or-create `person`/`organization` refs (structured `given_name`/`family_name` from Zotero two-field creators); DOI/date/URL/tags into properties; **pattern-driven citekey generator** (tokens `family_name`/`organization_name`/`year`/`title_word` + `:lower`/`:upper`; default pattern `{family_name:lower}{year}`) used **only when `citekey` is empty** — never recomputes or overwrites, preserves Zotero's own citekey when present; deterministic letter-suffix collision resolution; workspace setting `citekey_pattern` with default `{family_name:lower}{year}`; migration of existing ad-hoc "Source*" classes where feasible; **opt-in class consolidation tool**: given an explicit old→system class-UUID mapping (e.g. user's `fuente`→`source`, `libros`→`book`), reassign nodes (`class.assign` new + `class.unassign` old), remap matching class-property edges to system schemas, then soft-delete the old class. Never name-guessed; the mapping is always user-provided and the automatic backfill (Task 3) stays strictly additive.
- **Acceptance**: two consecutive syncs idempotent (no duplicate classes/schemas/agents, citekeys unchanged); a Zotero book shows `authors` (agent refs), `doi`, `publication_date`, `citekey` populated and appears in Library's Books section; re-sync after user metadata edits leaves `citekey` untouched; two sources that would both yield `herbert1965` end up `herbert1965` + `herbert1965a` deterministically; changing `citekey_pattern` changes only subsequently generated keys; unit tests for the pattern interpreter.

### Task 10 — Hierarchy-aware search filters
- **Files**: owns `frontend/src/core/query/search.ts`, `frontend/src/core/query/queryNodes.ts`.
- **Consumes**: existing `class_hierarchy` closure; Task 6 (generic resolution helpers, if extracted there).
- **Produces**: FTS search and metadata listing class filters use the closure (match `compileToSqlite.ts:290` semantics).
- **Acceptance**: text search filtered by `class:source` returns book/paper instances; parity with AST compiler behavior.

## Phase 2 — Library UX parity (post-v1, after Task 10)

Goal: close the gap between "queryable source table" and a Zotero-like workflow. All additive UX over the same Source+Asset model; no data-model changes.

### Task 11 — Library three-pane layout
- **Files**: owns `frontend/src/features/library/` (extends Task 7), shared-pane primitives as needed.
- **Consumes**: Task 7 Library view; `PropertiesSection`; collection nesting (v1 collections); query AST `child_path`/`reference` conditions.
- **Produces**: single-screen layout — **left pane: tree view of collections** (nodes of class `collection`, nested; expandable); center: sources of the selected collection; right: metadata inspector (reusing the class-bound property panel). **Collection contents semantics**: sources nested under the collection **recursively (subcollections included)** ∪ sources that **link to** the collection — union, deduped, intersected with `class:source`. **Multi-membership**: a source nests under its "home" collection and links to any additional ones; it appears in all of them while remaining one object. Selecting in any pane filters/loads the others without page navigation.
- **Acceptance**: sidebar shows the collection tree; selecting a collection lists its sources AND those of its subcollections; a source linked to a second collection appears in both; no duplicates when a source both nests under and links to the same collection; inspector edits persist via normal property ops.

### Task 12 — Drag-to-attach & drag-to-collect
- **Files**: owns Library view DnD + asset upload integration (`frontend/src/features/assets/`), drop targets on collection nodes.
- **Consumes**: Task 5 (MIME widening), `attachments` property ops, collection membership = links.
- **Produces**: drag a file onto a source → upload + asset node + `attachments` entry; drag a source onto a collection → link. No new op types.
- **Acceptance**: dropped PDF appears as attachment (asset node, `node_asset` row); dropped source appears in collection; both sync via normal ops.

### Task 13 — Add-by-identifier (ISBN/DOI lookup)
- **Files**: owns a new small lookup service (backend route + metadata provider abstraction) + Library UI entry point.
- **Consumes**: Tasks 2–4 (system schema, idempotent provisioning); pattern-driven citekey generator (Task 9).
- **Produces**: paste ISBN/DOI → fetch bibliographic metadata (external provider, e.g. Crossref/open library — dependency failure mode must be decided: unreachable ⇒ clear error, no partial node) → create source + agents + citekey. Provider choice and its failure behavior need a decision before implementation.
- **Acceptance**: given a valid DOI, a fully populated source appears (authors as agent refs, date, DOI, citekey); provider down ⇒ explicit error, no half-created node.

### Task 14 — PDF lookup (add-by-file)
- **Files**: owns PDF metadata extraction (backend service) + Library/UI entry point; shares the Task 13 provider abstraction.
- **Consumes**: Task 13 (provider + create-source pipeline), Task 5 (PDF upload support).
- **Produces**: drop/select a PDF → extract identifiers from the file (DOI from text/XMP metadata, title heuristics) → resolve via Task 13 provider → create/populate the source and attach the PDF as an asset (role `representation` where the user confirms). Unidentified PDFs fall back to creating the source from filename + attachment, marked for manual completion.
- **Acceptance**: a PDF with an embedded DOI yields a populated source + attachment in one action; a PDF with no identifiers creates a minimal source with the file attached and no crash; provider down ⇒ explicit error, source/attachment state consistent (either complete or nothing).

### Task 14b — Inline whiteboard blocks
- **Files**: owns the block-level renderer for whiteboard-class blocks (`frontend/src/features/whiteboard/` + block dispatch in `frontend/src/features/content/`), reusing the existing canvas component.
- **Consumes**: existing `whiteboard` system class + `_whiteboard_data` property; existing `WhiteboardView` (standalone pages).
- **Produces**: a whiteboard as a **system class** (no new `kind`) with two presentations by kind: page + class → full-page canvas (exists today); block + class → **inline canvas card** rendered among sibling blocks, sharing the same canvas component and per-node `_whiteboard_data` persistence; tap/click expands to the full view.
- **Acceptance**: a block with the whiteboard class renders an interactive canvas card inline among its siblings; edits persist via the same property; the same node opened standalone shows the full canvas; independent of the source track — schedulable at will.

## Phase 3 — Export & distribution

### Task 15 — Source file export profiles (continuous) — **builtin plugin, disabled by default**
- **Files**: owns `app/plugins/builtin/export_profiles/` (new — the whole feature ships as a generalized builtin plugin: engine + `bibliographic` provider + frontend profile editor/run UI integrated into Library); profile storage in workspace settings. The export provider API is platform-level so third-party plugins can register their own providers.
- **Consumes**: Tasks 2–6 (classes, attachments, role), Task 9 (template interpreter — generalize `citekey_pattern` into a shared template service), existing QueryAST compilers, asset CAS/token machinery.
- **Produces**: named export profiles = `{ selection: queryAST | saved-query ref, attachment_filter: { roles: […] (default ["representation"]), mime_types: […] | all }, path_template: string (e.g. "/{class}/{citekey}.{ext}") }` plus a manual "export ZIP" action over the same resolution. Convenience presets compile to AST: class picker, collection picker. **The profile's folder is a continuously maintained derived view of the graph** (precedent: `auto_export_service.py` per-page mirror): a post-commit hook on op application (asset/property/class/node ops affecting selected sources) triggers a debounced re-resolution of affected profiles, and a startup reconciliation pass repairs drift. Create/update semantics come free: citekey or metadata change → file moves to the new templated path; source deleted or attachment removed → file deleted; new matching source → file appears. The folder therefore always mirrors the current selection (no separate mirror mode; stale-file cleanup is inherent). **Output roots at a per-user folder** — `<export_root>/<user_uuid>/<profile_slug>/…` (default under `data/users/<user_uuid>/exports/`, configurable root) — so each user's exports are isolated and the folder can be pointed at Syncthing/rsync for ereader distribution. Template paths are sanitized (no `..`, no absolute paths); deletions never escape the profile folder. Missing template tokens → deterministic fallback (title, then uuid); filename collisions → deterministic suffix. Profiles stored as JSON in workspace settings — no new op types/tables. **Internally the engine is layered** (owner fases doc, Fase 6): profile config (`id, name, enabled, provider, query, destination, materializer, reconciliation_policy, provider_config` — `provider_config` opaque to the core) → **export provider plugin** `generateManifest({config, nodes, services}) → {files: [{asset_uuid, relative_path}]}` with injected services (asset API stream/metadata, query engine, class resolver) — the provider never touches the filesystem or canonical storage paths → **path validation** (no `..`, no absolutes, filename sanitization) → **reconciler** (distinguishes engine-managed files from foreign files; foreign files are never modified or deleted under any policy) → **materializer** (`copy` in v1; `symlink` optional; `hardlink` post-v1). The builtin `bibliographic` provider carries `asset_filter` (MIME/roles) and `filename_template` (tokens `{author}`, `{title}`, `{year}`, `{citekey}`, `{series}`, `{series_index}`, `{extension}`) in `provider_config` and emits one file per selected attachment. The same query yields the same selection in Library UI, API, and export.
- **Acceptance**: with profile `class:book`, filter role=representation, template `/{class}/{citekey}.{ext}`: uploading an EPUB to a book creates `<user_uuid>/<profile>/book/herbert1965.epub` without manual intervention; editing the citekey renames the file; removing the attachment or deleting the source removes the file; startup reconciliation reproduces the correct tree from scratch; exports from two users land in disjoint roots; a malicious template (`../../etc/x`) is rejected; attachment-less sources appear in the skip report; two resolutions over unchanged data produce byte-identical trees (reproducibility); collection-scoped profile tracks membership changes; pytest coverage for hook/debounce/reconciliation/containment paths.

### Task 15b — Asset Metadata Plugin API + EPUB plugin
- **Files**: owns a new metadata-plugin registry (`app/features/assets/metadata/` or `app/plugins/core/metadata.py`), the builtin EPUB plugin (`app/plugins/builtin/epub/`), asset-service integration points (stream extraction/injection, blob replacement), frontend per-attachment actions.
- **Consumes**: Task 5 (EPUB/PDF uploads), Task 3b (`language`/`series`/`series_index` schemas), asset CAS machinery.
- **Produces**: a MIME-registered **Asset Metadata Plugin API** operating on streams — `extract(stream) → source-properties dict` (reads OPF), `inject(stream, properties, cover_stream?) → modified stream` (writes OPF), `extractCover(stream) → image stream`; the core owns storage, hashing, and `blob_ref` updates (inject = read stream → plugin → new blob under CAS → asset node points at the new blob via ordinary ops; old blob handled by normal CAS rules). The **EPUB plugin (v1)**: read/write OPF (`title`, `authors`, `publisher`, `publication_date`, `language`, `series`, `series_index`, `isbn`), inject/extract cover image. UI: per-attachment actions "Extract metadata → source" and "Sync source metadata → EPUB" (writes the source node's title/authors/cover into the file). PDF metadata editing, OCR, and other formats are post-v1.
- **Acceptance**: uploading `dune.epub` and running extract populates title/authors/publisher on the source; editing the title on the source and running inject produces an EPUB whose OPF shows the new title; changing the source's `cover` and injecting embeds that image as the EPUB cover; injecting twice is idempotent; the asset node keeps its identity while its blob/hash updates; a non-EPUB attachment shows no EPUB actions.

### Task 16 — OPDS catalog (plugin, disabled by default)
- **Files**: owns new `app/plugins/builtin/opds/` + frontend settings tab. Manifest ships `enabled_by_default=false`.
- **Consumes**: Task 15's selection/filter semantics (shares the "sources + role-filtered attachments" resolution), asset token/download flow.
- **Produces**: OPDS feed over selected sources — the catalog includes only sources passing `has_asset()` (downloadable `role=representation` attachments); covers come from the source's `cover` **property** (with `parent.cover` fallback), `role=cover` assets as a secondary source; attachment-less sources simply absent from acquisition feeds. Per-user authentication; the feed never exposes internal storage paths.
- **Acceptance**: OPDS client can browse and download an EPUB; a book with `attachments=[]` causes no feed error; feed respects the same selection mechanism as export profiles.

## Phase 4 — Mobile reading & annotation (Flutter, cross-repo)

Work lands in the `notees-flutter` companion repo; this plan defines the **contract** that side must honor. No new op types: everything below is `node.create` + `class.assign` + `property.set` over the existing relay protocol.

### Task 17 — Library mode in the Flutter companion
- **Files**: `notees-flutter` repo (out of this skill's ownership; coordinate via contract).
- **Consumes**: Task 3 (system schema), Task 7 semantics (class:source projections), asset token/download flow (range/206 support already exists).
- **Produces**: a Library mode inside the existing Flutter app (**not a dedicated app** — duplicating the sync/auth stack buys no isolation): browse sources by class/collection, table/card lists with covers, download `role=representation` assets for offline reading (blob cache keyed by hash).
- **Acceptance**: phone shows the same Books a web Library view shows; an EPUB downloads once and opens offline.

### Task 18 — EPUB/PDF readers with highlight capture
- **Files**: `notees-flutter` repo; contract tests here (`tests/` fixture asserting the emitted op sequence).
- **Consumes**: Task 17; the shared highlight contract (below).
- **Produces**: EPUB reader (CFI-based positions) and PDF reader (page-based positions); an **e-ink mode toggle** (no animations, paginated rendering, high contrast, volume-key page turns) — the same app serves Android e-ink devices, optionally exposed as a separate launcher entry ("Notees Reader" activity-alias) so it feels like a dedicated reading app without duplicating the sync stack; text selection → "Highlight" action → emits ops creating a `highlight` node staged under the source: content = selected text, `highlight_asset` → the asset node being read, `provenance = "flutter"`. Works offline — ops queue in the local outbox and sync later (local-first for free). Display side: existing highlights (any provenance) for the asset being read are listed alongside the reader (no positional overlay — there is no `locator` property, Decision 33).
- **Acceptance**: fixture test — highlighting a passage offline emits the exact op sequence; after sync the web graph shows the highlight block with the actual text under the source; a KOReader-pasted highlight on the same EPUB renders as an overlay in the Flutter reader.

### Task 19 — Highlight dedupe + reading progress sync
- **Files**: dedupe contract shared backend/Flutter; progress as synced state.
- **Consumes**: Tasks 8, 18.
- **Produces**: dedupe rule `(highlight_asset, text-hash)` — or `(source, text-hash)` when the asset is unknown — applied by all producers (KOReader paste, Flutter, future web reader) so the same passage is never double-recorded; `reading_position` (CFI / page+percent) stored per user on the asset node, enabling resume-anywhere. Optional follow-up: kosync-compatible progress endpoint so KOReader and Flutter share positions.
- **Acceptance**: annotating a passage on device and later pasting the same passage from a KOReader export yields exactly one highlight node; reading position set on phone is honored on web and vice versa.

## Requirements & Acceptance Criteria (hard)

- A source class may be assigned to a page node **or a block node**; inherited class-bound properties work for both (page NodeView and focused-block PropertiesSection).
- Closure invariant: `book extends source`, `source extends X` ⇒ queries for `X` include every book, both derived stores. Same for `person|organization extends agent` under `agent` filters — including node pickers (Task 6, generic fix).
- A book with `attachments = []` is valid and appears in `class:source` queries; the same node accepts attachments later without identity change.
- `attachments` means "assets semantically attached to this node"; `class_filter` restricts values to asset-class nodes; `role` is optional metadata **on the asset node**, never on the blob.
- `authors` accepts both persons and organizations (filter = `agent`, hierarchy-aware).
- `citekey` is a **text** system property, empty by default, user-editable; generation is pattern-driven via the workspace `citekey_pattern` setting; importers/actions fill it only when absent, never overwrite it, and resolve collisions deterministically (letter suffix).
- Highlights are **ordinary movable blocks** staged under the source: no permanence, no reading/history structure is forced; users process them into paraphrases/quotes wherever they want (source page, daily notes, …) and delete them at will. Multiple personal workflows must be expressible without schema changes.
- KOReader highlight import needs **no plugin**: pasting a KOReader Markdown export on a source page creates highlight blocks; re-pasting dedupes.
- **No second collection-membership database/table in v1**; collections use nesting + links only.
- `ensure_class` / `ensure_property_schema` / find-or-create-agent converge: repeated calls never duplicate classes/schemas/agents.
- Backend/frontend system-UUID maps guarded by an automated parity test.
- Backend/frontend seed op sequences remain equivalent (adoption-safe).
- Disabling the Library plugin hides only the management UX (plugin enablement is the toggle; Decision 23); source classes/attachments/graph/search keep working.
- Class names lowercase everywhere, including user-facing labels.
- Work/Edition is an **optional nesting pattern, not a mandatory ontology**: a flat source with attachments and a Work→Edition pair are both valid; the grouped Library view exploits the pattern when present.
- `cover` resolves from the source's `cover` property with fallback to `parent.cover`.
- Export engine: the same query yields the same selection in Library UI, API, and export; the reconciler never modifies or deletes foreign files; provider plugins never touch the filesystem.
- Highlights carry **no `locator` property**: position info rides as text in the block content (Decision 33).
- After each foundational task: full `pytest` + `vitest` suites green plus targeted parity tests (replay parity, UUID parity, seed parity).

## Out of Scope (v1)

- Library UX parity (three-pane layout, drag-to-attach/collect, add-by-identifier, PDF lookup) — planned as Phase 2 (Tasks 11–14), explicitly post-v1.
- Export profiles + OPDS — Phase 3 (Tasks 15–16).
- Flutter library mode, mobile EPUB/PDF reading, on-device highlights, reading-progress sync — Phase 4 (Tasks 17–19), cross-repo (`notees-flutter`); this plan defines the op/property contract only.
- Typed relation substrate (`edge.*` ops; `member_of`/`authored_by`/`cites`) — deferred (alternatives §B2).
- Bibliographic auto-export (`.bib`/CSL-JSON) — removed; a future dedicated Word/citation plugin is the more likely direction.
- Media classes beyond `movie` (tvseries/podcast/…) — tree is extensible; add with a consumer.
- Capability registry; blob replication protocol beyond adoption; `.asset_refs.db` rebuild-from-log.
- Per-(source, asset)-pair roles (accepted limitation; asset nodes are per-upload).
- Native EPUB/PDF reader in the web app (v1 is management-only; reading via OPDS → KOReader, or the Flutter companion in Phase 4).
- Full-text search inside binaries; OCR; PDF metadata editing; non-EPUB asset-metadata plugins.
- `hardlink` export materializer; timed/cron export scheduling (event-driven continuous reconciliation is in scope, timed scheduling is not).
- Per-node ACLs (the user→workspace access model covers v1; `accessible_by()` = workspace membership; parent-inherited permissions post-v1 — Decision 32).
- Bidirectional KOReader sync, KOReader-side plugins, reading-state sync from KOReader.
- Calibre import and other net-new importers (owner Fase 8; Zotero/BibTeX appear earlier only because those plugins already ship and must be migrated).
- Media-server / folder-based file-manager ambitions — the filesystem is a projection, never the canon.

## Decisions (owner, 2026-08-23)

1. Library off by default (plugin ships disabled; enable per instance/workspace as the platform allows); underlying source classes unaffected. Packaging revised by Decision 23.
2. `role` ships on the `asset` class but optional, unset by default.
3. `authors` = multi node-ref filtered by `agent`; `person` and `organization` extend `agent`.
4. Backfill on workspace open (lazy).
5. Attachments = B1 (property machinery); typed edges deferred.
6. Milestone sequencing: foundation (Tasks 1–5) → filtering/Library (6–7) → evidence/imports (8–9) → search (10); OPDS/export integrations afterward.
7. Class names lowercase everywhere (supersedes the earlier capitalization note).
8. Citation: `citekey` = **text** system property on `source`, **empty by default**, user-editable; generation is a pure default driven by the **workspace-level `citekey_pattern` setting** (default `{family_name:lower}{year}`); never overwritten; deterministic letter-suffix collision resolution; structured `given_name`/`family_name` on `person`. No creation-time autogeneration (freezes keys before metadata exists; page-only would be inconsistent with block-sources).
9. Hierarchy-aware class filtering is a **generic** fix — all superclass filters, not just the `agent` picker.
10. Dispatch: foundation batch (Tasks 1–4) first, reassess repo state, then higher-level tasks; full test suites + parity tests gate every foundational task.
11. Library UX parity (three-pane, drag-and-drop, add-by-identifier, PDF lookup) approved as Phase 2 (Tasks 11–14), post-v1; additive UX only, no data-model changes. Add-by-identifier's metadata provider + failure behavior needs a decision before Task 13 starts.
12. Library lists support **table and card view modes** in v1 (Task 7); card covers resolve from the system `cover` property (existing asset-UUID mechanism).
13. Export profiles (Phase 3, Task 15): query-based selection (QueryAST / saved query refs; class and collection presets compile to AST), role/MIME attachment filter, configurable path templates (shares the citekey template interpreter), per-user output root `<export_root>/<user_uuid>/<profile>/…` with hard path containment. **The folder is a continuously maintained derived view** (post-commit hook + debounce + startup reconciliation; precedent `auto_export_service.py`) — no manual re-runs; renames/deletes propagate automatically. Profiles stored in workspace settings (no new op types/tables); skipped-sources report; reproducible output. OPDS follows as Task 16 over the same selection/filter semantics.
14. Mobile reading & annotation (Phase 4, Tasks 17–19): library mode **inside the existing Flutter companion** (not a dedicated app; optional "Notees Reader" launcher alias + e-ink mode toggle for Android e-ink devices); EPUB (CFI) + PDF (page+rects) readers; highlights emitted as standard `highlight` nodes staged under the source (content = selected text, `highlight_asset`, `provenance="flutter"`) — no new op types, offline capture via the existing outbox; cross-producer dedupe by `(highlight_asset, text-hash)`; per-user `reading_position` on the asset node for resume-anywhere (kosync-compatible endpoint as optional follow-up).
15. **Highlights are transient evidence, not forced entities**: imported/captured highlights stage as ordinary movable blocks under the source; users process them into paraphrases or curated quotes wherever they want (source page, daily notes, …) and delete them freely. **No `reading` system class** — per-read/per-day grouping is a personal convention done by hand with ordinary nesting (supersedes the earlier reading-history design).
16. **Citation export strategy**: citekeys stay as stable identifiers, but the continuous `.bib`/CSL-JSON auto-export is **dropped** (not essential). Likely future direction: a dedicated Word/citation plugin for Notees. Revisit when citation-in-documents becomes a concrete need.
17. **Source link insertion**: one insertion path — the standard slash-menu node-link picker becomes class-aware (Task 6); filtered by `source`, "create" opens a source quick-create dialog (title, class, authors) producing a properly classed source. A dedicated slash entry may pre-filter the same picker as a shortcut, but no separate insertion flow.
18. **Asset-aware create**: the same class-aware picker interprets "create" under an `asset` filter as file-selector → upload → link/set (reuses the existing upload path; PDF/EPUB gated on Task 5). This powers the `attachments` property editor: add = pick existing asset or upload new, in one action.
19. **Agent-aware create**: under an `agent`/`person`/`organization` filter, "create" is a minimal dialog (type choice; `given_name`+`family_name` for persons — feeds citekeys; plain name for organizations). Explicitly **not** a contact manager; dedupe reinforced because create only fires on no-match.
20. **KOReader plugin eliminated**: highlights arrive by pasting KOReader's Markdown export onto the source page (Task 8) — no sync endpoint, no HTTP client, no matching pipeline. The existing `app/plugins/builtin/koreader/` code is removed as part of Task 8.
21. **Format lives on the asset, not the class**: a `book` is the same object whether its attachments are EPUB, PDF, or audiobook MP3 — format is the asset's `mime_type`, not a source subclass (no `audiobook` class). Multiple named export profiles = multiple export paths; query selection + MIME/role filters route different representations of the same source to different folders/devices. Notees stores media only when the file feeds the knowledge pipeline (annotate/cite/read); media with dedicated management pipelines (Jellyfin/Radarr/NAS) is referenced, never duplicated.
22. **Collection semantics**: a collection is a **root-level page with class `collection`** — not a parentless block (orphan blocks fight every tree/sidebar/breadcrumb assumption) and not a revived classes-as-nodes pattern (a parallel membership mechanism the codebase deliberately migrated away from). Collection-classed pages render with a specialized **collection-manager view** (member list instead of document flow — same class-drives-chrome principle as whiteboard) and are **filtered out of the regular notes sidebar** (UI concern, not data model). Contents = sources nested under it **recursively** (subcollections included) ∪ sources linking to it — deduped union, intersected with `class:source`. Multi-membership = nesting for the "home" collection + links for additional ones; the source stays one object. No membership table.
23. **Library = builtin view plugin** (supersedes the core-feature + `library_enabled` packaging): Task 7 hardens the plugin view platform (compose views from exposed primitives — `QueryNodeCollection`, class-aware picker, `PropertiesSection`; enable/disable without restart) and ships Library as its reference plugin. Users can build custom views the same way (project dashboards, asset managers); no-code variants ride `node_view` + query AST. Plugin enablement is the on/off toggle; underlying source semantics never depend on it.
24. **Whiteboards are a system class, not a `kind`**: standalone = page + `whiteboard` class (full-page canvas, exists today); inline = block + class → inline canvas card among sibling blocks (Task 14b, new block renderer reusing the same canvas component and `_whiteboard_data` persistence). Same dual presentation principle as sources (class semantics, kind chooses chrome).
25. **Class-scoped properties + `weblink`**: bibliographic schemas are seeded with `scope='class'` bound to their owning class (source/agent/asset/highlight/weblink) — never global, so ordinary nodes don't see them (mirrors Zotero's per-item-type fields). Additional system classes after surveying Capacities (Page/Tag/Image/Weblink/Audio/PDF/Files/Query/Table basics) and Tana (user-defined supertags): only `weblink` (+ `url` property) was missing; `meeting`/`project`/`idea` and similar stay **user-created classes** — the class system already supports them, seeding them would be bloat.
26. **Class consolidation is opt-in migration, never backfill**: the Task 3 backfill is strictly additive. Pre-existing user classes duplicating system semantics (`fuente`, `libros`, `agente`, `persona`, …) are replaced only through the Task 9 consolidation tool with an explicit user-provided UUID mapping — reassign nodes, remap property edges, soft-delete old class. Names are free text in any language; equivalence is never guessed.
27. **Work/Edition = optional nesting pattern, not ontology** (owner fases doc, 2026-08-28). `parent_id` on sources expresses Work → Edition: the Work holds shared identity (title, authors, cover); the Edition holds `isbn`/`language`/`citekey`/`attachments`. Both flat and hierarchical sources are valid — no mandatory FRBR-style model. The Library gets flat and grouped view modes (Task 7) that exploit the pattern when present.
28. **`cover` is the existing system cover property** (`00000000-0000-0000-0000-000000000005`) bound to `source` (class-scoped, inherited by all subclasses); consumers (cards, OPDS) fall back to `parent.cover`. The asset-side `role=cover` value stays for representation-level semantics; the property is the canonical pointer.
29. **Supplementary system schema (Task 3b)**: `movie` class (extends `source`) + class-scoped `language`/`series`/`series_index` properties on `source` + `cover` bound to `source` — from the owner fases doc's Fase 3 property list. Same additive seed + backfill path as Task 3; UUIDs `…0035` (class) and `…0025`–`…0027` (properties).
30. **Asset Metadata Plugin API (Task 15b)**: MIME-registered plugins operating on **streams** (`extract`/`inject`/`extractCover`); the core owns storage, hashing, and `blob_ref` updates. EPUB (OPF read/write + cover inject/extract) is the v1 plugin, with per-attachment "Extract metadata → source" / "Sync source metadata → EPUB" actions. PDF metadata editing, OCR, and other formats post-v1.
31. **Export engine architecture (Task 15)**: layered engine — config JSON (`id, name, enabled, provider, query, destination, materializer, reconciliation_policy, provider_config`), provider plugin `generateManifest({config, nodes, services}) → {files: [{asset_uuid, relative_path}]}` with injected services (the provider never touches the filesystem), path validation, reconciler (managed vs foreign files — foreign files are never touched under any policy), materializers (`copy` v1, `symlink` optional, `hardlink` post-v1). Event-driven continuous reconciliation stands (Decision 13); timed scheduling is out. The builtin `bibliographic` provider holds `asset_filter` + `filename_template` (tokens `{author}`/`{title}`/`{year}`/`{citekey}`/`{series}`/`{series_index}`/`{extension}`); multiple attachments per source → multiple files.
32. **Permissions**: the existing user→workspace access model covers v1; per-node ACLs (and parent-inherited permissions) are deferred post-v1. `accessible_by()` in query/OPDS contexts means workspace membership; OPDS authenticates per user and never exposes internal paths. (The fases doc's "permission system básico" is read against what already ships.)
33. **No `locator` property** (owner, 2026-08-28): highlights deliberately carry no structured position property — position info (chapter/page, CFI, datetime) rides as plain text in the block content. Consistent with Decision 15 (highlights are transient staging, not position-anchored immutable evidence). The `…0018` UUID was withdrawn from the registry and stays reserved; dedupe keys drop the locator component (`(highlight_asset, text-hash)` / `(source, text-hash)`). `reading_position` (progress state on the asset, Task 19) is unaffected — it is not a highlight property.
34. **OPDS and export profiles are plugins, both disabled by default** (owner, 2026-08-28). OPDS stays a builtin plugin (Task 16) with `enabled_by_default=false`. The export-profiles feature (Task 15) is packaged as a generalized builtin plugin too — engine + `bibliographic` provider + UI — also disabled by default; the export **provider API** is platform-level so third-party plugins register their own providers (same "plugin never touches the filesystem" rule). Enabling either is a per-instance/plugin toggle via the catalog; the underlying source/asset semantics never depend on them.
35. **Plugin platform UX on par with Zotero/Obsidian (Task 4b)** (owner, 2026-08-28): a real plugin catalog (installed list, restartless enable/disable toggles, per-plugin settings, builtin vs external); **ZIP import** (upload → manifest validation → contained extraction → load without restart; git-URL install remains as another source); external plugins stored one-folder-per-plugin in the instance config plugins folder (`data/plugins/`); **folder-drop discovery** — folders placed manually in that folder are detected (startup scan + explicit rescan) and listed. Restartless toggling (fixing `manager.py:194-200`) is shared with Task 7's view-platform hardening.

## Reading list for implementers

- `docs/plans/2026-08-23-source-hierarchy-attachments/gap-analysis.md` (evidence, file:line)
- `docs/plans/2026-08-23-source-hierarchy-attachments/alternatives.md` (decisions + rejected options)
- `app/core/derived/{schema,class,class_hierarchy,property,asset}.py`
- `app/core/seed.py` + `frontend/src/core/seed.ts` (parity contract `seed.ts:4-9`)
- `app/domain/entities/constants.py` + `frontend/src/constants/systemProperties.ts`
- `app/features/assets/service.py`, `app/plugins/core/context.py`, `app/plugins/builtin/{zotero,bibtex}/`

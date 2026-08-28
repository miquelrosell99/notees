# Alternatives — contested design points

> Conclusion: reuse the existing class/property/asset machinery everywhere; the only genuinely contested point is how `attachments` + per-attachment `role` are represented, and the pragmatic winner is a system multi-`node` property `attachments` on `Source` + a system `role` property on the `Asset` class — no new op types, no new tables, inheritance and UI come for free.

## A. Source hierarchy representation

**Option A1 — existing class system with `extends` (CHOSEN).** Add fixed-UUID system classes (`source`, `book`, `paper`, …) to both constants maps, seed with `extends` payloads, bind properties via `class_property_edge`. Pros: inheritance, queries, property panels, icons already work; zero new machinery. Cons: inherits the closure-maintenance bugs (no descendant recompute, no cycle detection) — must fix as part of the work.

**Option A2 — class metadata / tag-only.** A `source_type` selection property instead of real subclasses. Pros: trivial. Cons: loses per-class property schemas, inheritance-aware queries become property filters, contradicts the product spec ("class = Book" identity, plugin-extensible subclasses). Rejected.

## B. `attachments` + `role` representation

**Option B1 — system multi-`node` property + role on the Asset node (CHOSEN).**
`attachments`: a system `property_schema` (type `node`, `multi=1`, `is_system=1`, `class_filter_uuids=[asset class]`), bound to `Source` via `class_property_edge` → inherited by all subclasses. `role`: a system `selection` property (`representation|cover|supplement|attachment|generated|thumbnail|other`) bound to the existing `asset` class.
Pros: no new op types, no schema change, no dual-compiler work; LWW/sync/tombstones come free; backlink scan and graph "property-reference" heuristic already surface it; renders today through the node-property renderer; matches the spec's wording ("the Asset should carry a semantic role"); zero-attachment Book = absent rows, valid by construction.
Cons: role-per-(source,asset) pair is impossible if one asset node were attached to two sources with different roles. Mitigation: asset **nodes** are never shared today — CAS dedup shares blobs, not nodes; each upload creates its own node. Accept the limitation, document it.

**Option B2 — typed relation edges.** New `edge.upsert`/`edge.delete` ops writing `edge(source, target, type='attachment', metadata={role})` — uses the dormant `edge.property_schema_id`/`metadata` columns.
Pros: true per-link role; a general typed-relations substrate for `authored_by`/`cites`/`member_of` later. Cons: new op types (both sides), new appliers (both sides), must bypass content-rebuild clobbering, new query condition types (both compilers), new UI. This is the right *long-term* substrate for graph relations, but it is a project of its own and not required for attachments v1. Defer; keep as a named future option.

**Option B3 — assets discoverable via nesting** (asset blocks as children of the Source node). Pros: no new property. Cons: single-parent tree means an asset block can't live anywhere else; conflates outline structure with attachments; can't attach an existing asset node without moving it. Rejected.

## C. Asset model

**Option C1 — extend the existing asset-node model (CHOSEN).** Assets are already block nodes with the `asset` system class + `node_asset` metadata + CAS storage. Widen the MIME allowlist (PDF, EPUB, …), bind `role` to the asset class, reuse token/download flow for OPDS/plugins.
**Option C2 — separate LibraryAsset records.** Explicitly forbidden by the spec ("There must not be a separate LibraryBook record"; "Do not introduce a parallel binary storage system"). Rejected.

## D. Capabilities (citable/readable/downloadable/…)

**Option D1 — derive from class + attachments (CHOSEN for v1).** No capability registry: `downloadable` = has attachment with `role=representation`; `citable` = class is/extends a citable Source subclass — plain class-membership checks, which the closure table already answers in one indexed query. The spec itself allows "straightforward class-based checks initially".
**Option D2 — capability flags as class-bound system properties.** More explicit, plugin-settable, but adds schema surface with no consumer today. Defer until a second consumer appears.

## E. Library view placement & toggle

**Option E1 — core feature + workspace-level setting (CHOSEN).** A top-level Library view (reusing `QueryNodeCollection` + view-mode registry) gated by a workspace setting `library_enabled`, following the `sidebar_show_*` precedent in `GraphSettingsModal`. Source classes/schemas exist regardless; the toggle only hides the management UX — exactly the spec's semantics. Workspace level because the schema is shared op-log state.
Option E2 — as a plugin: possible (views/sidebar/settings are contributable), but Library management is core product surface in the spec; plugin enable/disable requires restart (`manager.py:194-200`). Rejected as primary mechanism; plugins (OPDS, Zotero, KOReader) still integrate through it.
Option E3 — `featureFlagStore`: dormant, zero consumers, local-only — wrong level. Rejected.

> **Superseded (2026-08-23, prd Decision 23):** E1's placement was reversed — Library ships as a **builtin view plugin** over a hardened view platform; plugin enablement is the toggle (restartless enable/disable became part of the work, Task 4b/7). E1's semantics (classes exist regardless, only the management UX is hidden) carry over. The same packaging rule was later extended to OPDS and export profiles — both generalized builtin plugins, disabled by default (prd Decision 34).

## F. Highlights (KOReader evidence model)

**Option F1 — highlight blocks nested under the Source/Asset node + system properties (CHOSEN for v1).** A `highlight` system class (block-only), nested under the asset's source page; system properties: `asset` (node ref → the specific Asset node), `provenance` (e.g. `koreader`), plus selected text as block content. Reuses nesting + properties; queryable via class + property conditions today. (2026-08-28: the `locator` property was dropped — position info rides as text in the block content; prd Decision 33.)
**Option F2 — dedicated annotation subsystem** (new tables/ops). Over-engineering for one producer (KOReader); revisit when a second annotation source appears.

> **Superseded in delivery mechanism (2026-08-23):** the KOReader *plugin* was eliminated — highlights arrive by **pasting KOReader's Markdown export** onto the source page (parsed into highlight blocks; prd Task 8). F1's node model stands; the sync/matching pipeline it assumed does not. Highlights were later reclassified as **transient staging blocks** rather than permanent evidence (prd Decision 15).

## G. Fixing class-system bugs in scope

Seeding `Source extends …` trees into existing workspaces forces three fixes: (1) recursive closure recompute (or at least seed-order independence), (2) cycle detection on `class.setExtends`, (3) frontend `class.update` honoring `extends` (parity). Plus a **backfill mechanism**: an idempotent "ensure system classes" pass (backend workspace open / migration op emitter) since seeds only run at creation.

## H. Authorship & citation (added 2026-08-23)

**Option H1 — `agent` superclass, `person` + `organization` subclasses (CHOSEN).** `authors` filters on `agent`; both natural persons and corporate creators are first-class. Structured `given_name`/`family_name` on `person`; node display name stays the full natural name. Pros: organizations are legitimate creators (Zotero produces them); one filter covers both; citation needs (`family_name`) are structured data, not string parsing at cite time. Cons: one more system class + two name properties.

**Option H2 — `person` only.** Rejected: corporate authors become fake persons or plain text; contradicts Zotero's creator model.

**Citekey — stored, pattern-driven, empty by default (CHOSEN).** `citekey` is a **text** system property on `source`, **empty by default** and user-editable. Importers (or an explicit "generate citekey" action) fill it **only when absent**, using a **workspace-level `citekey_pattern` setting** (Better BibTeX-style template; default `{family_name:lower}{year}` → `herbert1965`; tokens `family_name`/`organization_name`/`year`/`title_word` + `:lower`/`:upper`). Once stored it is the source of truth — never recomputed, never overwritten on re-sync; collisions get deterministic letter suffixes (`herbert1965a`, `herbert1965b`). Changing the pattern affects only future generations. Rejected alternatives: (a) deriving citekeys dynamically at render time — unstable under metadata edits; (b) autogenerating at node-creation time — freezes a key before author/year metadata exists, and page-only autogeneration would be inconsistent now that sources can be blocks; (c) hardcoding the pattern in the generator — Zotero/Better-BibTeX users expect configurability, and a workspace setting costs little over a constant.

**Related fix (generic):** node pickers currently apply `class_filter_uuids` by exact UUID match (`useNodeSearch.utils.ts:91,266`, `queryHelpers.ts:884`). The hierarchy-aware fix must be generic — every superclass filter everywhere — or pickers and query compilers disagree. Special-casing `agent` was rejected.

## I. v1-phases alignment (added 2026-08-28)

**Work/Edition representation (CHOSEN: ordinary nesting).** Options: (1) `parent_id` nesting — Work page with Edition children; zero new machinery, Library groups by structure. (2) typed `edition_of` edges — requires the deferred edge substrate (B2). (3) class-based split (`work`/`edition` classes) — forces the split on every source. Chosen: (1), as an **optional pattern**, not a mandatory ontology.

**Cover representation (CHOSEN: existing `cover` property on the source).** The `cover` system property (asset-UUID mechanism) is bound to `source`; consumers fall back to `parent.cover`. Alternative — infer the cover from an attachment with `role=cover` — rejected as canonical mechanism: role stays representation-level metadata, and a cover that was never uploaded as a separate attachment (e.g. extracted from the EPUB) still needs a node to point at.

**Asset metadata read/write (CHOSEN: stream-based plugin API).** Plugins register by MIME and operate on streams (`extract`/`inject`/`extractCover`); the core owns storage, hashing, `blob_ref`. Alternative — plugins touching storage paths directly — rejected: breaks CAS discipline and the "plugin never touches the filesystem" rule (same rule as export providers).

**Export engine (CHOSEN: layered engine + provider manifest, packaged as a plugin).** The core engine owns config, path validation, reconciliation (managed vs foreign files), and materialization (`copy` v1); provider plugins only map nodes → `{asset_uuid, relative_path}` manifest with injected services. Alternative — providers writing files themselves — rejected for containment and reproducibility. The whole export-profiles feature ships as a generalized builtin plugin, disabled by default — same packaging as OPDS (prd Decision 34).

**Plugin distribution & management (CHOSEN: folder-based catalog).** External plugins live one-folder-per-plugin under the instance config plugins folder; install sources: ZIP upload (validated, contained) and git URL (existing); manual folder drops are detected via startup scan + rescan. Catalog UX targets Zotero/Obsidian parity with restartless toggles. Alternative — install-only-via-git, restart-required toggles (status quo) — rejected by the owner as below the bar for a self-hosted product.

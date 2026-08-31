# Gap Analysis — Source Hierarchy & Attachments

> Conclusion: the target architecture maps onto machinery that mostly **already exists** (class inheritance with materialized closure, class-bound properties, assets-as-nodes, inheritance-aware query compilers). The real gaps are: no seeded `Source` class tree, no `attachments` system property, no asset `role`, no typed relations, no highlight model, plugin schema-provisioning is broken (non-idempotent), and several parity/correctness bugs in the class system that this work would expose.

Evidence convention: `path:line`. Seven lenses were investigated in parallel; condensed below.

## 1. Class system & inheritance — MOSTLY EXISTS

- Classes live in a dedicated `class` table with `extends_class_ids` (JSON list, **multiple inheritance allowed**) and a materialized transitive-closure table `class_hierarchy(class_id, ancestor_id)` including self-rows (`app/core/derived/schema.py:147-169`; mirror `frontend/src/core/db/schema.ts:139-160`).
- Ops: `class.create/update/delete/setExtends`, `class.assign/unassign` (`app/core/operation.py:45-48`; appliers `app/core/derived/class.py:60-141`, `class_hierarchy.py`; frontend mirror `frontend/src/core/derived/class.ts`).
- Nodes carry `class_ids` JSON array — **multiple classes per node, kind-agnostic** (applies to `page` and `block` alike; `node.kind` CHECK is only `('page','block')`, `app/core/derived/schema.py:56-57`). The user's constraint "a Source may be a block" needs no schema change.
- **System classes exist as a fixed-UUID convention** (no `is_system` column): 21 hardcoded UUIDs `00000000-0000-0000-0001-…` in `app/domain/entities/constants.py:92-138`, mirrored in `frontend/src/constants/systemProperties.ts:67-89`. `asset` is already system class `…0009`. Protection is frontend-only (`isSystemClassUuid`, `BLOCK_ONLY_CLASS_UUIDS`, `NON_REMOVABLE_CLASS_UUIDS`); backend `SystemClassConstraintError` (`app/domain/errors.py:93-102`) is never raised.
- Seeds emit `class.create` per system class on both sides (`app/core/seed.py:57-91`, `frontend/src/core/seed.ts:40-121`) but **never pass `extends`** — all current system classes are flat.
- Consumers already resolve inheritance: both query compilers match subclass instances via the closure (`app/core/query_ast/compiler.py:358-366`, `frontend/src/core/query/compileToSqlite.ts:290,312`); property inheritance via `class_hierarchy × class_property_edge` (`frontend/src/core/adapters/propertyQueries.ts:284-320`); icon/color inheritance (`frontend/src/utils/nodeIcon.ts:82-188`).

**Bugs/risks this work would expose:**
- Closure rebuild is **not recursive**: if `Source extends X` changes after `Book extends Source`, Book's closure never gains X (`app/core/derived/class_hierarchy.py:10-37`).
- **No cycle detection** on `extends`, either side.
- Asymmetry: backend recomputes hierarchy on `class.update` with extends; frontend `class.update` ignores extends (`frontend/src/core/derived/class.ts:95-124`) → divergent derived state.
- `class.delete` soft-deletes without cleaning `class_hierarchy` or `node.class_ids` (`app/core/derived/class.py:125-130`).
- `class.setExtends` is whole-list LWW replace — concurrent edits lose data.
- Existing workspaces: seeds are create-time only and `ensureLocalWorkspace` skips existing classes (`frontend/src/core/seed.ts:101-105`) — a `Source` tree needs a backfill story for existing workspaces.

## 2. Assets & binary storage — ASSETS ARE ALREADY NODES

- Upload creates a **block node with the `asset` system class** plus a `node_asset(node_id, asset_hash, mime_type, size, original_name, uploaded_at)` metadata row (`app/features/assets/service.py:384-451`; applier `app/core/derived/asset.py`; schema `app/core/derived/schema.py:246-256`). Bytes live **outside the op log**, content-addressed: SHA-256 → `<workspace>/assets/<hash[:4]>/<hash>.<ext>` with refcounting in a local `.asset_refs.db` (`service.py:96-250`).
- Token/download flow: 15-min JWT `asset_access` tokens, Range/206 support (`app/features/assets/router.py:40-57,195-259`). Frontend local mode stores blobs in IndexedDB keyed by hash, same op sequence (`frontend/src/features/assets/api/localAssets.ts`).
- Trash/GC: `trash.is_asset` + deferred ref decrement (`app/core/derived/node.py:129-166`, `app/cleanup.py:209-227`).
- **A node with zero assets is trivially valid** — nothing forces a `node_asset` row.

**Gaps:**
- **No `role`** anywhere (representation/cover/supplement/…). Closest: MIME-derived `category` (`app/features/assets/utils.py:32-44`) and the hardcoded `cover`/`banner` system properties holding asset-node UUIDs — the direct precedent for "property pointing at an asset node".
- **MIME allowlist is images+audio only** — PDF/EPUB are rejected at upload (`utils.py:15-29`, `router.py:105-111`); 50 MB cap; magic-byte checks lack signatures for documents.
- 1:1 node↔blob assumption everywhere (`_get_asset_row`, thumbnails keyed by node UUID). Fits the target if each attachment is its own Asset node; role then lives on the Asset node or the attachment link, not the blob.
- Blob replication across devices is upload-only (adoption re-uploads every blob, `frontend/src/core/adoption.ts:23-27`); `.asset_refs.db` is non-replicated and not rebuildable from the op log today.

## 3. Property system (system vs user) — EXISTS, WITH HOLES

- `property_schema` has `is_system`, `multi`, `type`, `class_filter_uuids`, scope, validation (`app/core/derived/schema.py:171-193`). `property_value` is LWW per `(node_id, property_schema_id, idx)`, value = JSON scalar (`schema.py:85-108`).
- **`node`-type properties referencing other nodes exist**, multi-valued via `idx`; `class_filter_uuids` can restrict targets to the `asset` class. Backlinks scan `json_extract(pv.value,'$') = <uuid>` (`frontend/src/core/query/propertyBacklinks.ts:16-23`).
- Class-bound properties via `class_property_edge` with inheritance — an `attachments` schema bound to `Source` would be inherited by Book/Paper/… for free.
- 9 property ops, both sides (`app/core/operation.py:35-44`).

**Gaps:**
- Frontend read path **drops `is_system`** (`rowToProperty` hardcodes false, `frontend/src/core/adapters/propertyQueries.ts:81-101`); systemness is enforced only by fixed-UUID lists.
- **Seeds emit no `propertySchema.create`** — system property schemas only exist in migrated/imported workspaces (`app/core/seed.py`, `frontend/src/core/seed.ts`). A system `attachments` schema must be added to both seeds (seed parity is a hard invariant, `seed.ts:4-9`).
- **No per-value metadata**: role cannot hang on a property value (one JSON scalar per slot). Encoding `{node, role}` objects would break backlink scans and node renderers.
- Type-vocabulary drift: migration emits `number/select/file`, frontend coerces unknown types to `text` (`propertyQueries.ts:39-54`).

## 4. Graph, relations, nesting, collections — RELATIONS ARE THE BIGGEST HOLE

- `node_link` = per-instance links extracted from content AST; `edge` = legacy dedup'd projection, hardcoded `type='reference'`, docstring says it's pending deprecation (`app/core/derived/edge.py:163-216`). `edge.property_schema_id`/`metadata` columns exist but are **never populated** — a dormant hook.
- **No typed relations** (`member_of`, `authored_by`, `cites`): no op type exists; the registry rejects unknown ops (`app/core/derived/__init__.py:179-180`). Graph view synthesizes types ad hoc client-side (`frontend/src/core/query/graphLinks.ts:45-92`), including a heuristic "any property value that looks like a node UUID = property-reference edge".
- Nesting = strict single-parent tree (`parent_id` + `node_child_order`). Nested nodes can carry arbitrary links. **No Collection class exists**; `NodeCollection` is a UI component family, not data.
- **Content-rebuild clobbering**: edge/node_link rows are deleted+reinserted on every content change — typed relations must NOT live in tables rebuilt from content, or they'll be wiped per keystroke.

## 5. Plugins & existing source-ish features — HALF-BUILT

- Plugin surface (backend): routers at `/api/plugins/<id>/…`, importers, exporters, sync sources, settings, class side-effect hooks, `ensure_class`/`ensure_property_schema`, generic `plugin.op` escape hatch (`app/plugins/core/`). Frontend: views, sidebar items, settings tabs, NodeCollection view modes, property renderers, node actions (`frontend/src/plugins/core/PluginContext.ts:40-78`). A Library view fits as a plugin view or core view.
- **Closed permission set; no manifest way to contribute classes/property schemas/op types.**
- **`ensure_class`/`ensure_property_schema` are non-idempotent** — fresh uuidv7 per call (`app/plugins/core/context.py:264-318`); none of the builtin plugins persist UUIDs, so **every Zotero sync duplicates its "Source" class**. Fix: name-based lookup like `app/features/import_/service.py:140-168`.
- KOReader: fetches highlights then **discards text/note/page entirely** — creates one page per book under ad-hoc class "Source: KOReader" (`app/plugins/builtin/koreader/sync.py:41-59`). Hardcoded server URL. Sync-trigger endpoint doesn't exist (frontend POSTs to a route matching nothing). **No highlight/annotation model exists anywhere.**
- Zotero: creates its own "Source" class (random per-workspace UUID — **will collide semantically with a system Source**) and drops DOI/creators/abstract/date (`app/plugins/builtin/zotero/sync.py:53-84`).
- BibTeX: same pattern, class "Source: BibTeX", drops author/year.
- **OPDS: zero matches in the repo.** Export profiles: do not exist; export selects explicit node lists (`app/features/export/models.py:20-41`).

## 6. Search & query — CAPABILITY EXISTS, PERFORMANCE DOESN'T

- QueryAST with 14 condition types; saved in `node_view.query_ast`; two compilers (backend `app/core/query_ast/compiler.py` — dormant, test-only; frontend `compileToSqlite.ts` — live). **Class conditions are hierarchy-aware on both sides** — "class is Source" already matches Book/Paper instances.
- So a Library projection = a `node_view`/NodeCollection with a class condition on `Source`: works today with zero new capability.
- **Gaps**: no index on `node.class_ids` (JSON TEXT → full scan; a `node_class` junction table or expression index would fix); FTS search path and metadata listing use **exact** class match, not hierarchy-aware (`search.ts:125-132`, `queryNodes.ts:202-209`); no SQL ORDER BY/LIMIT (JS slice); backend/frontend compiler parity gaps (`in/not_in`, `flag`, `$.value` vs `$`, extends semantics).

## 7. Frontend UI — MOSTLY READY

- Node pages already render class-driven property panels with inheritance (`PropertiesSection` + `useNodeClassPropertyEdges`), for **pages and focused blocks** (blocks get it via `BlockRow`, `NodeView.tsx:1296-1299`). Kind/class constraints are frontend-only lists (`BLOCK_ONLY_CLASS_UUIDS` — Source classes must simply stay out of it).
- Whole-page class switches are hardcoded (whiteboard, class, task) — **no per-class custom section registry**; an "Attachments" panel would be either a generic property renderer or a new hardcoded section.
- Library-quality chrome exists: `ClassesView`, `QueryNodeCollection`, 10 view modes, `PageViewHeader`, design primitives in `frontend/src/components/ui/`. No Library/shelf UI; the `'assets'` MainViewType route is dead (`appStore.ts:28`).
- Settings: three tiers exist. **Workspace-level settings** (sidebar-toggles precedent, `GraphSettingsModal.tsx:115-119`) are the right home for "Enable Library Management"; `featureFlagStore` is dormant with zero consumers.
- **Post-swarm finding (2026-08-23)**: node pickers apply `class_filter_uuids` by **exact UUID match** (`frontend/src/features/content/hooks/useNodeSearch.utils.ts:91,266`; `buildSuggestions` at `frontend/src/core/worker/queryHelpers.ts:884`), not through the `class_hierarchy` closure — filtering by a superclass (e.g. `agent`) silently excludes subclass nodes (`person`). Any superclass-filtered UI disagrees with the query compilers until fixed generically.

## Cross-cutting invariants any implementation must respect

1. **Dual-derived parity**: every applier exists in Python and TS; both replay the same op log. Any new op/table lands in both schemas + both applier sets.
2. **Seed parity**: `app/core/seed.py` and `frontend/src/core/seed.ts` must emit equivalent op sequences or adoption diverges.
3. **Bytes outside the op log**: asset blobs sync via a separate channel; metadata via ops.
4. **UUID maps mirrored by hand**: `app/domain/entities/constants.py` ↔ `frontend/src/constants/systemProperties.ts` drift is a real hazard.
5. Fixed-UUID convention: next free system-class UUID is `…0023` (`…0002` already skipped).

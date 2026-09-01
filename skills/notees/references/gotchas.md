# Gotchas

<!--
Format per entry:

## **[topic]** <short title>

**Symptom:** what you see when you hit this
**Cause:** why it happens (one paragraph max)
**Fix:** the minimal correct response
**Prevent:** how future tasks avoid this (links to workflow checklist if activated)

Tag reference:
  [topic]  — short reusable noun for dedup clustering (e.g. [lifecycle], [auth], [styling])
           — reuse existing topics; same topic in one file = check for duplicates

Only record entries that pass the Recording Threshold (repeatable + costly + not obvious from code — at least 2 of 3).
Generalize before writing: `specific finding → abstract pattern → consequence of ignoring`.

═════════════════════════════════════════════════════════════════════════
Organization upgrade path — pick the stage that matches your current size:

(1) ≤ 10 entries: flat list with **[topic]** tags is enough.
    `grep -oP '\*\*\[([^\]]+)\]' references/gotchas.md | sort | uniq -c`
    quickly shows topic clusters and duplicates.

(2) 10–25 entries: group under H2 categories.
    Promote frequent [topic] tags to ## headings and turn entry titles into ###.
    Example shape (do NOT pre-fill — wait until clusters emerge from real entries):

      ## Data Flow
      ### **[lifecycle]** Tabs re-open does not re-fetch
      ### **[lifecycle]** ServiceStore.removeStore race

      ## Forms
      ### **[validation]** addRule receives undefined value

    Goal: any new author can find "is my pitfall already recorded?" in
    O(category) instead of O(file).

(3) > 25 entries OR > 400 lines OR any category itself reaches stage-2 size:
    Split into domain-specific pitfall files (e.g. `data-flow-pitfalls.md`,
    `form-pitfalls.md`). Run `workflows/maintain-docs.md § Step 1b` first
    to confirm the split decision is real (separable topics, each part ≥
    30 lines, no broken cross-references after).

Smoke-test enforces:
  - line count ≤ $GOTCHAS_MAX_LINES (default 400)
  - no duplicate ## headings (signals copy-paste recurrence — same entry
    added twice without checking dedup)

If two entries describe the same root cause but were noticed in different
contexts, merge into ONE entry with both contexts listed under Symptom.
═════════════════════════════════════════════════════════════════════════
-->

<!-- OPTIONAL: this file starts empty. Entries grow via After-Action Review. Do NOT pre-populate. -->

## **[ast]** Markdown round-trip loses `node_link` pills

**Symptom:** After an import, export, copy/paste, or seed operation, node links render as "…" in breadcrumbs, sidebars, or search; reference/backlink counts are lower than expected.

**Cause:** A `node_link` pill stores its stable identity in `link_id = targetUuid:linkUuid`. Markdown/plain-text serializers only know the target UUID, so the `linkUuid` is dropped on the way out. When the content is parsed back in, the pill becomes a bare target reference (or plain text), breaking the registry lookup that surfaces rely on.

**Fix:** Transport the AST directly across boundaries that need round-trip fidelity. If the AST must be text-encoded, use JSON; do not use Markdown. When re-creating links from external sources, generate a fresh `linkUuid` for each instance and write `targetUuid:linkUuid`.

**Prevent:** See `rules/coding-standards.md` § TypeScript / React → node_link preservation rules. Any importer, exporter, seed, or copy/paste pipeline should be tested with a link-only block and its breadcrumb path.

## **[navigation]** Property context shape mismatch

**Symptom:** A block opened through a text property renders the right content, but the breadcrumb trail omits the property name or the property crumb navigates to the wrong place.

**Cause:** `useNavigationStore` and `NodeBreadcrumbs` expect the property context shape `{ propertyUuid, propertyName }`. Several call sites use the field name `propertyId`; an `as` cast hides the mismatch from TypeScript, so the breadcrumb logic receives `undefined` for the UUID and silently skips the property segment.

**Fix:** Use `propertyUuid` (and `propertyName`) when building a property context for navigation or breadcrumbs. Remove `as` casts around the context object and let the type check surface the mismatch.

**Prevent:** When adding a new "open via property" path, grep for existing `propertyUuid` usages and match that shape instead of inventing a local `propertyId` alias.

## **[navigation]** Text-property value blocks must be children of the owning node

**Symptom:** A text-property block's content is saved, but returning to the owning node shows the property as empty; or the block shows up both in the property panel and the main block list.

**Cause:** Text properties identify their value by a block UUID stored in the owner's `properties_uuid`. The main block list relies on `filterTextPropertyBlocks` to remove any child whose UUID is referenced by a text property on the parent. If the block is created with `parentId: null`, it is not a child of the owner, so the filter cannot hide it and the owner does not consider it part of its block tree.

**Fix:** Create text-property value blocks with `parentId` set to the owning node's UUID. Render them with `NodeCollection rootIsBlock={true}` without overwriting `parent_uuid`.

**Prevent:** When adding new code that creates a block to back a text property, grep for `filterTextPropertyBlocks` and match the existing child-block pattern.

## **[derived]** `getClassProperties` hides edges whose schema row is missing locally

**Symptom:** An idempotent ensure/seed path re-emits a `classPropertyEdge.create` op on every workspace open even though the edge already exists, growing the op log by one op per open.

**Cause:** `getClassProperties` (frontend `core/adapters/propertyQueries.ts`) resolves edges with `JOIN property_schema s ON s.id = e.property_schema_id WHERE s.active = 1`. An edge bound to a base system property whose schema row is not present in the local DB (e.g. `cover`, created server-side and not yet synced) is invisible to the JOIN, so an existence check built on it never sees the edge.

**Fix:** Existence checks must query the raw `class_property_edge` table (e.g. `getClassPropertyEdgeIds`, added for the local seed ensure). Only use `getClassProperties` when schema metadata is actually needed and the schema is guaranteed present.

**Prevent:** When writing idempotent backfill/ensure logic that checks class-property edges, use the raw edge query; reserve the JOINed variant for UI display.

## **[derived]** Applier changes must bump the derived-state version

**Symptom:** After an applier-logic fix ships, existing clients still show stale or wrong query results (e.g. class/extends queries over `class_hierarchy` return nothing) while fresh installs work.

**Cause:** Client-side applier changes leave rows derived from already-applied operations stale; nothing fails CI when `CURRENT_DERIVED_STATE_VERSION` (`frontend/src/core/store.ts`) is not bumped, so only a hard rebuild (version mismatch → full log replay) heals existing clients.

**Fix:** Bump `CURRENT_DERIVED_STATE_VERSION` in the same commit as the applier change, and add any new derived table to `resetDerivedState`'s DELETE list so the replay starts clean.

**Prevent:** When a diff touches `frontend/src/core/derived/**` appliers, verify the version bump and reset list in the same commit.

**Corollary — a bump is the expensive option; prefer targeted startup repairs.** A bump forces every client to replay the full operation log (minutes on large workspaces), and before 2026-08 the version was stamped *before* the rebuild, so an interrupted rebuild persisted wiped tables marked current — no retry, broken client. When the affected state derives from one small local table (e.g. `class_hierarchy` from `class.extends_class_ids`), add an idempotent startup repair instead (`repairClassHierarchy` / `repairDatePageHierarchy` pattern, wired into both store-init paths). The version is now stamped in `SyncEngine.initialize` only after the rebuild's pull succeeds; keep it that way.

## **[query]** Persisted system views store an empty `query_ast`

**Symptom:** A system section (`classed_nodes`, `extended_by`, `child_pages`) renders empty even though matching nodes exist, while its query editor shows the expected system condition chip (e.g. "class contains current page").

**Cause:** Default system views are created with `createEmptyQueryAST()`; the required system condition is restored by `autoFixSystemQuery`. The edit UI and filter badge apply it, but if the execution path doesn't, the empty AST executes and the empty-query gate forces zero results — the chip reflects a condition that never runs.

**Fix:** Route every persisted-view execution AST through `getExecutionAST` (`frontend/src/features/content/components/nodes/QueryNodeCollection/helpers.tsx`), which applies `autoFixSystemQuery(ast, viewType, { nodeUuid })`.

**Prevent:** When adding a new execution path for persisted views, use `getExecutionAST`; the invariant is unit-tested in `getExecutionAST.test.ts`.

## **[sync]** Relay `saved_ids` excludes duplicates — ack the whole accepted batch

**Symptom:** Client stuck on "Connecting to server…" forever; backend logs show an endless stream of `POST /api/relay/batch` 200s while the envelope count stays flat.

**Cause:** The relay omits duplicates from `saved_ids` (`app/relay/storage.py save_envelopes`). A client that acknowledges only `saved_ids` never advances its push watermark on duplicate-only batches, so the same ops are re-sent indefinitely. This stays latent until the push watermark is reset while the op log still holds server-known operations (e.g. an interrupted derived-state rebuild).

**Fix:** On a successful batch response, acknowledge the entire chunk — validation/permission failures raise, so any unsaved envelope is a duplicate the server already has. Fixed in `frontend/src/core/sync.ts` `push()`.

**Prevent:** When touching relay dedupe or push-ack logic, test with a duplicate-only batch (covered by sync.test.ts "duplicate-only batches").

## **[views]** BlockList ignores `node.children` unless `localOnly`

**Symptom:** You attach a computed/synthetic tree (e.g. the class inheritance hierarchy for `extended_by`) to the `nodes` prop of `NodeCollection`/`ListView`, but the list renders flat — or empty when `pagesOnly` filters the synthetic nodes out — even though each node carries `children`.

**Cause:** With a core client available, `useBlockTree` (`frontend/src/features/content/hooks/useBlockTree.ts`) re-projects every node via `projectNode` and resolves children through the store's `getChildren` — the `children` arrays on the passed `nodes` are only used in the no-client fallback and in `localOnly` mode. Children that exist only in memory (class-table rows have no `node_child_order` entries) are invisible to that path.

**Fix:** Pass `localOnly` (plumbed `QueryNodeCollection → NodeCollection → ListView → BlockList`) for synthetic trees, set `has_children` on parent nodes so the collapse chevron renders, and make sure `pagesOnly`/`skipPages` don't filter the node kind you are rendering. Live updates still work: the flat list recomputes when the `nodes` prop changes.

**Prevent:** When rendering anything that is not a node-table tree (class hierarchies, scratchpads, previews), reach for `localOnly` first and unit-test the tree builder; see `buildClassHierarchyTree` in `QueryNodeCollection/helpers.tsx` and its test.

**Corollary 1 — never depend on the `options` object identity in `useBlockTree` effects.** Callers (`BlockList`) rebuild the options object inline on every render. The projection effects once listed `options` in their deps, so every render re-ran the effect; on the local-only path `buildLocalFlatNodes` + `setProjectedFlatNodes` run synchronously inside the effect → infinite render loop → React "Maximum update depth exceeded". The hook now builds a memoized `projectionOptions` from the primitive fields and skips the projection effect entirely in `localOnly` mode (the `flatNodes` memo is the single source there). If you add an option, add it to that memo's field list and dep array.

**Corollary 2 — synthetic `Node.content` must be paragraph-wrapped.** Static renderers (`InlineContentStatic`, used by `BlockRow`) only extract inline children of `paragraph`/`heading` blocks; a bare `{ type: 'text' }` node at document level renders icon + blank text. `classRowToNode` wraps the class name as `[{ type: 'paragraph', children: [{ type: 'text', text: name }] }]` — copy that shape for any synthetic node content.

## **[testing]** Frontend vitest suite flakes under concurrent heavy load

**Symptom:** `npm run test:run` fails with 1–2 errors like "Chunk count mismatch" in `src/core/persistence/__tests__/indexedDb.test.ts` (or similar persistence timing tests), but the same files pass in isolation and in an idle rerun.

**Cause:** The persistence tests use fake-indexeddb with real timers; running the frontend suite concurrently with a full pytest run (or another CPU-heavy job) starves the event loop enough to break their timing assumptions.

**Fix:** Treat it as a load flake, not a regression: rerun the suite idle and confirm green before investigating. Run backend and frontend full suites sequentially, not in parallel.

**Prevent:** When gating a task with "full suites green", run one suite at a time; if a persistence test fails only under parallel load, rerun before touching code.

## **[lifecycle]** One-shot async effects must not be cancelled by cleanup

**Symptom:** Reloading a deep link (e.g. `/<workspace>/<node-uuid>`) lands on the home view instead of the entity; in-app navigation to the same URL works fine.

**Cause:** The effect marks the input as processed (ref guard) and then starts async work, but its cleanup sets `cancelled = true`. Under React StrictMode (dev) effects mount → clean up → remount: the cleanup kills the only processing run, and the processed-guard blocks the remount from retrying, so the URL is never applied. The same kill happens on any mid-flight dependency-identity change, not just StrictMode.

**Fix:** Drop cleanup-based cancellation for one-shot async route/init processing; arbitrate staleness with a monotonic generation counter checked after every `await` (see `useRouteAdapter.ts`). All side-effecting writes must be preceded by a generation check after the last await.

**Prevent:** Any effect that (a) guards re-entry with an "already processed" ref and (b) awaits before writing state must either skip cleanup cancellation or reset the guard so a remount retries. Test one-shot URL/init effects under `<StrictMode>` with all guards satisfied on first mount.

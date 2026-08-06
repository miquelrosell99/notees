# Temporary vs Stored Queries — Design

Date: 2026-07-15
Status: Approved (design Q&A with user), in implementation

## Summary

Formalize the split between **stored queries** (persisted, revisited) and
**temporary queries** (in-memory, cleared on reload/navigation). Both share
the same building system (`QueryAST` IR + `ViewBuilder` UI + `executeQuery`);
the only difference is persistence. The temporary surface already exists in
the store (`openNodeCollection`) but its render branch was lost in a
refactor — this spec rewires it and adds the user-facing entry points.

## Decisions (from design Q&A)

1. **One builder, two exits; primacy flips with context.** The standalone
   filter builder (palette → "New temporary query") makes **Run** (temporary)
   the primary action and "Save as view…" secondary. Embedded query sections
   in pages stay Save-only — they are stored by nature (AST lives in page
   content) and already have a live preview. No side-by-side Save/Run
   buttons everywhere.
2. **Temporary means in-memory only.** Temporary collections live in
   `navigationStore` (no `persist` middleware) and the URL adapter maps
   `node-collection` → `''`, so they are gone on reload and un-deep-linkable.
   This is the desired "cleared on page reload/reaccess" semantic.
3. **The temporary view is a living query, not a snapshot.** Its header
   shows the prose intent (`getQueryIntent`), a "Temporary" chip, and a
   "Save as view…" promotion. Design steals Linear's filter-ephemerality and
   chips, not Notion's dropdown-stack filters.
4. **Promotion artifact = page + query-class child block.** NodeViews always
   belong to a node (`NodeViewCreate.node_uuid`), so a standalone saved
   query is persisted as a new page (title = view name) with one query-class
   child block whose `name` is `[paragraph(title), query(ast)]` — the exact
   shape `useQueryBlock.saveQueryAST` writes, rendered live by
   `BlockAfterContent → QueryPreview` with zero new render code. The page is
   linkable, searchable, and offline-syncable.
5. **Existing temporary entry points get fixed, not replaced.** "Broken
   links", "Open Today" (palette commands) and Ctrl+Enter on palette search
   results already call `openNodeCollection*`; they currently dead-end on a
   stub and start working again with this change.

## Architecture

- **Render fix:** `MainContentPane`'s `node-collection` branch renders
  `NodeCollectionView` (lazy) with the store's `nodeCollectionTitle` /
  `nodeCollectionQueryAST` / `nodeCollectionNodeUuids`.
- **`NodeCollectionView` changes:** prop `nodes?: Node[]` →
  `nodeUuids?: string[]` (resolved via `useQueries` + `nodeKeys.detail` +
  `nodesApi.getNode`); header gains prose intent line (nodesMap built from
  `useClasses()`, mirroring `QueryNodeCollection`), "Temporary" chip, and
  "Save as view…" button (queryAST mode only) opening a name prompt.
- **`useSaveQueryAsView()`** (new, `features/queries/hooks/`): creates the
  page + query-class child block via `useCreateNode`, then
  `closeNodeCollection()` + `openNode(page.uuid)`. Shared by the temporary
  view and the filter builder modal.
- **`FilterBuilderModal`** (new, `features/queries/components/`): modal
  wrapping `ViewBuilder` with a 300 ms-debounced `useQueryCount` preview
  ("N nodes found"), optional name field, primary **Run** (disabled when
  the AST has no conditions), secondary "Save as view…" (disabled without
  a name). Open state: `isFilterBuilderOpen` in `modalStore`; mounted lazy
  in `Layout.tsx` like the other global modals.
- **Palette command:** `COMMAND_IDS.NEW_TEMP_QUERY` (`query.newTemporary`),
  label "New temporary query", executes
  `useModalStore.getState().setFilterBuilderOpen(true)`.

## Out of scope

- Query sections in pages (unchanged, Save-only).
- NodeView CRUD, ViewBuilder internals, text query language, SQL preview.
- Backend changes (none needed — `executeQuery` and node create already
  cover both paths).

## Testing

- `NodeCollectionView.test.tsx` — AST mode renders prose/chip/save;
  nodeUuids mode resolves and renders nodes; save flow calls createNode
  with page + query-block payloads and navigates.
- `FilterBuilderModal.test.tsx` — Run disabled with empty AST; Run opens
  the collection with the AST and closes; Save disabled without a name.
- `useSaveQueryAsView.test.ts` — payload shapes, closeNodeCollection +
  openNode ordering.
- Gates: `npx vitest run`, `npx tsc -b --noEmit`, `npm run lint` in the dev
  container; manual browser check of all three entry points.

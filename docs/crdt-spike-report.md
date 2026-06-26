# M4 CRDT Text Spike Report

## Objective
Determine whether Yjs + Lexical's official collaboration binding can give Notees real-time, conflict-free co-editing of the same block without 409s, while preserving inline links, date ranges, math, and formatting.

## Spike Setup
- Two `SpikeInlineEditor` instances rendered side-by-side.
- Both editors share a single `Y.Doc`.
- Each editor uses `CollaborationPluginV2__EXPERIMENTAL` with a minimal in-memory provider that satisfies Lexical's `Provider` contract (sync signal, status, awareness).
- Custom Lexical nodes (`InlineLinkNode`, `InlineDateRangeNode`, `MathNode`) are registered in the editor config and implement `exportJSON`/`importJSON`.

Files:
- `frontend/src/features/editor/spike/CrdtSpikePage.tsx` — interactive harness.
- `frontend/src/features/editor/spike/SpikeInlineEditor.tsx` — minimal editor with collaboration plugin.
- `frontend/src/features/editor/spike/inMemoryProvider.ts` — local Yjs provider.
- `frontend/src/features/editor/spike/crdtSpikeHelpers.ts` — seed AST and AST read helpers.
- `frontend/src/features/editor/spike/CrdtSpikePage.test.tsx` — automated assertions.

## Test Results

| Scenario | Result |
|----------|--------|
| Rich content seeded in editor A appears in editor B | ✅ Pass |
| Inline link pill survives the round-trip | ✅ Pass |
| Inline date-range pill survives the round-trip | ✅ Pass |
| Inline math formula survives the round-trip | ✅ Pass |
| Bold / italic formatting survives the round-trip | ✅ Pass |
| Concurrent text edits in A and B merge deterministically | ✅ Pass |
| Both editors converge to identical AST after merge | ✅ Pass |

Automated test run:
```
✓ src/features/editor/spike/CrdtSpikePage.test.tsx (2 tests)
```

## Verdict: GO

The spike passes all go/no-go criteria:
- Two editors bound to the same `Y.Doc` merge simultaneous plain-text edits deterministically.
- Custom inline nodes (link, date-range, math) round-trip through Yjs updates without corruption.
- Formatting (bold/italic) is preserved during concurrent edits.
- The integration uses only public Lexical APIs (`@lexical/react/LexicalCollaborationPlugin` and `@lexical/yjs`).

We can proceed to a full M4 implementation.

## Recommended Integration Sketch

### Frontend
1. **Per-block Yjs document**: Maintain one `Y.Doc` per block, keyed by block UUID. Store the doc in a new `BlockYjsStore` or attach it to the `InlineEditor` lifecycle.
2. **Binding lifecycle**: Replace `SyncedContentPlugin` for v2 blocks with `CollaborationPluginV2__EXPERIMENTAL`. Keep `SyncedContentPlugin` for read-only / v1 fallback.
3. **Remote update transport**: Use the existing v2 sync channel:
   - On local edit, capture the Yjs update from `doc.on('update')`.
   - Send `update_content` op with a `yjs_update` field (base64-encoded Uint8Array) instead of the full AST.
   - On receiving a remote op, call `Y.applyUpdate(doc, update)`.
4. **Initial load**: When a block is first rendered, fetch the latest Yjs state snapshot from the server and apply it with `Y.applyUpdate(doc, snapshot)`. If no snapshot exists, bootstrap from the existing `name` JSON AST.
5. **AST fallback**: Keep serializing the editor state to the existing AST for non-CRDT clients, search indexing, and export.

### Backend
1. **Schema**: Add `node_yjs_state` table:
   ```sql
   CREATE TABLE node_yjs_state (
       node_id UUID PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
       state BYTEA NOT NULL,
       updated_at TIMESTAMPTZ DEFAULT NOW()
   );
   ```
2. **Merge endpoint**: When `update_content` carries `yjs_update`, load the existing state (or empty doc), `Y.applyUpdate(doc, update)`, persist `Y.encodeStateAsUpdate(doc)`, and broadcast the merged update.
3. **Version vectors**: Text edits no longer advance the version vector or cause 409s. Tree ops continue to use the existing vector-clock batch sync.
4. **Snapshot endpoint**: `GET /nodes/{uuid}/yjs_state` returns the current Yjs snapshot for initial loads.

### Sync Protocol Changes
- Extend `OperationIntent` with an optional `yjs_update` field.
- Server ignores `content_ast` when `yjs_update` is present (for v2 CRDT-enabled clients).
- 409s are now raised only for tree conflicts, permission issues, or deleted nodes — never for text edits.

## Risks and Open Questions

| Risk | Mitigation |
|------|------------|
| Bundle size from Yjs provider code | Yjs and `@lexical/yjs` are already dependencies. The only new runtime code is the per-block doc management layer, which is small. |
| Offline initial load without server snapshot | Keep the existing AST in `node.name`; bootstrap the Yjs doc from AST when no server snapshot is available. |
| Custom node properties not covered by default binding | All custom properties are serializable JSON primitives; the Lexical-Yjs V2 binding syncs `exportJSON`/`importJSON` automatically. |
| Undo/redo integration | The collaboration plugin registers its own undo manager. We need to reconcile it with Notees' existing undo engine for v2 blocks. |
| Migration of existing workspaces | Make CRDT opt-in per workspace or per block. Existing content remains readable via AST fallback. |
| Search indexing | Continue to derive searchable text from the AST snapshot, updated whenever the Yjs doc changes. |

## Next Steps
1. Implement the backend `node_yjs_state` table and merge endpoint.
2. Add a `BlockYjsStore` to manage per-block `Y.Doc` instances in the frontend.
3. Wire `CollaborationPluginV2__EXPERIMENTAL` into `InlineEditor` behind a feature flag.
4. Update `SyncManagerV2` to transport Yjs updates for text edits and skip 409 handling for text conflicts.
5. Add end-to-end tests simulating two clients editing the same block concurrently.

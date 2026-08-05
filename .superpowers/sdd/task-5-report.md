# Task 5 Report: Migrate Remaining Display Surfaces

## Status

DONE

## Summary

Migrated the remaining display surfaces to use class-aware display-name helpers (`nodeNameToDisplayText` / `useNodeDisplayName`) and swept leftover modal confirmation messages that embedded raw node names. Search/matching/query code continues to use raw `nodeNameToText`.

## Files Modified

### Primary surfaces (from task brief)
- `frontend/src/features/sidebar/components/SidebarCardNode.tsx`
- `frontend/src/features/sidebar/components/SidebarNodeView.tsx`
- `frontend/src/features/sidebar/components/SidebarContextSections.tsx`
- `frontend/src/features/content/components/PresentationModal.tsx`
- `frontend/src/features/content/pages/TrashView.tsx`
- `frontend/src/features/content/components/nodes/NodeMetadataSection.tsx`
- `frontend/src/features/layout/components/Sidebar/SidebarPinnedPages.tsx`

### Remaining modal confirmation messages swept
- `frontend/src/features/content/components/nodes/ArchivedNodeContextMenu.tsx`
- `frontend/src/features/content/components/nodes/NodeContextMenu.tsx`
- `frontend/src/features/content/components/nodes/TrashNodeContextMenu.tsx`
- `frontend/src/features/layout/components/Modals/MergePagesModal.tsx`

### Additional display-only usages swept
- `frontend/src/features/views/components/KanbanCard.tsx` — cover image alt text and selection checkbox aria-label
- `frontend/src/features/sidebar/components/SidebarCardLocalGraph.tsx` — card title
- `frontend/src/features/content/components/nodes/NodeSearchBox.tsx` — default search result title
- `frontend/src/lib/astProseRenderer.ts` — QueryAST prose renderer node display name

### Progress tracking
- `.superpowers/sdd/progress.md`

## Approach

- Imported `nodeNameToDisplayText` or `useNodeDisplayName` from `@/features/queries`.
- Replaced `nodeNameToText(node.name) || 'Untitled'` and similar display patterns with the class-aware equivalents.
- React components that render display text and should react to `dateFormat` changes use `useNodeDisplayName`.
- Non-React utilities and render functions that cannot subscribe to settings use `nodeNameToDisplayText(node)` directly.
- `nodeNameToText` itself was not modified.
- Search/matching/query code, editing inputs, data-persistence calls, and analysis helpers were left using raw `nodeNameToText`.

## Verification

- `cd frontend && npx tsc -b --noEmit` — passed.
- `cd frontend && npm run lint` — passed (only pre-existing warnings unrelated to this change).
- `cd frontend && npm run test:run` — passed.
- `cd frontend && npm run test:run -- nodeDisplayName` — passed (12/12).

## Audit Notes

After migration, the grep command from the brief still reports hits. The remaining usages fall into categories that were intentionally left untouched:

- **Search/matching/query code**: `LinkedReferenceProjection.ts`, `queryHelpers.ts`, `evaluateQueryAST.ts`, `TriggerPopup.tsx`, `CommandPalette/useCommandPaletteState.ts`, `CommandPalette/CommandPaletteResult.tsx`, `NodeSelector.tsx`, `useNodeDateQueries.ts`, `useNodeSearch.ts`.
- **Editing inputs**: `ConvertToPageModal.tsx`, `ClassHeader.tsx`.
- **Data persistence / analysis**: `NodeView.tsx` (word count and class name persistence).
- **Date property internals**: `DatePropertyValue.tsx`, `DatePropertyCell.tsx`.
- **Developer / raw AST tooling**: `ASTViewerModal.tsx`, `NodeNameContent.tsx`.
- **Mixed concern components**: `SuggestionPopup.tsx`, `DuplicatePageModal.tsx`, `NodeContent.tsx`, `BlockAfterContent.tsx`.
- **Type-shape mismatch**: `GraphView.tsx` operates on `ApiGraphNode` whose class field is `class_uuids`, not `classes_uuid`, and the computed name is also used for system-page detection; left raw to avoid changing matching behavior.

## Concerns

- The working tree contains uncommitted changes to `frontend/src/features/queries/hooks/useStringifyAST.ts` and an untracked `frontend/src/features/queries/hooks/useStringifyAST.test.ts`. These were not authored during this task and were excluded from the commit to honor the critical constraint not to modify `nodeNameToText`. They remain in the working tree for separate review/commit.

## Commits

- `18de3064` — feat(ui): use class-aware display names in remaining surfaces

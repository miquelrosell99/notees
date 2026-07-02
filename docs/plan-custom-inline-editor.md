# Plan: Replace Lexical with a custom inline editor

## Goal

Remove Lexical from the Notees frontend and replace the per-block `InlineEditor` with a lightweight, React-controlled inline editor. The new editor must preserve the existing AST (`ContentAST`) as the single source of truth and support all current inline content: text, formatting marks, node-link pills, broken links, external links, date-range pills, inline math, and hard breaks.

## Scope

### In scope

- New custom `InlineEditor` component mounted only when a block is active.
- Reuse the existing `InlineContentStatic` renderer for the read-only view.
- Unified renderer that can render the same AST in both static and editable modes.
- Text insertion, deletion, cursor movement, selection.
- Formatting marks: strong, em, strikethrough, underline, highlight, code.
- Atomic inline nodes: node links (pills), broken links, external links, date ranges, math, hard breaks.
- Keyboard integration with `BlockRow`/`BlockList`: Enter, Backspace-at-start, Delete-at-end, Escape, Ctrl+Enter.
- Popup commands: `[[` / `[[text` node-link picker, `/` slash commands, `@` mentions, `+` class adder, `#` tag picker.
- Floating toolbar for formatting and link creation.
- Copy/paste of inline content (HTML and plain text).
- Find/replace across visible blocks.
- Mobile editor bridge (`reportEditorFocus`).
- Remove Lexical nodes, plugins, theme, and `@lexical/*` packages from `package.json`.

### Out of scope (for this plan)

- Block-level rich features that do not use the inline editor (whiteboards, queries) are unaffected.
- CRDT collaboration is intentionally left as a later phase. This plan replaces the Lexical-based Yjs binding with the existing `update_content` sync path. Real-time inline collaborative editing will be re-introduced after the custom editor is stable.

## High-level architecture

```
┌─────────────────────────────────────────────────────────────┐
│  InlineEditor (React component)                             │
│  - owns local AST + cursor state                            │
│  - renders editable surface via InlineContentRenderer       │
│  - handles DOM events and delegates mutations to model      │
└──────────────────┬──────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────┐
│  InlineEditorModel (pure functions)                         │
│  - AST mutations: insertText, deleteRange, toggleMark,      │
│    insertNode, splitAtCursor, mergeWithNext, etc.           │
│  - cursor/selection management                              │
└──────────────────┬──────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────┐
│  InlineContentRenderer (React)                              │
│  - renders ContentAST to DOM                                │
│  - used by static view and editable view                    │
│  - atomic nodes render contentEditable=false wrappers       │
└─────────────────────────────────────────────────────────────┘
```

## Data model

### Editor state

```ts
interface InlineEditorState {
  ast: ContentAST;
  selection: InlineSelection;
  isComposing: boolean;
}

type InlineSelection =
  | { type: 'collapsed'; offset: number }
  | { type: 'range'; anchor: number; focus: number }
  | { type: 'node'; nodeIndex: number }; // selected atomic node
```

- Offsets are logical: text characters count as 1; atomic nodes count as 1.
- Only the first paragraph/heading block of the AST is editable inline. Whiteboard/query blocks are not edited with this component.

### Cursor helpers

- `getTextLength(node)` / `getNodeLogicalSize(node)` — consistent with `cursorOffsetFromPoint.ts`.
- `offsetToDOM(root, offset)` — maps logical offset to a DOM node + text offset for selection restoration.
- `domToOffset(root, domNode, domOffset)` — maps a DOM caret to a logical offset.

## Phases

### Phase 0 — Foundation (model + renderer)

1. Create `frontend/src/features/editor/custom/` directory.
2. Define `InlineEditorState`, `InlineSelection`, and operation types.
3. Implement pure AST mutation functions in `frontend/src/features/editor/custom/model/inlineEditorModel.ts`:
   - `insertText(state, text)`
   - `deleteRange(state, start, end)`
   - `deleteBackward(state)` / `deleteForward(state)`
   - `splitAtCursor(state)` — returns new AST for the split block
   - `toggleMark(state, mark)`
   - `insertAtomicNode(state, node)`
   - `getCursorOffset(state)` / `setCursorOffset(state, offset)`
4. Add unit tests for the model (`inlineEditorModel.test.ts`).
5. Create a unified `InlineContentRenderer` in `frontend/src/features/editor/custom/components/InlineContentRenderer.tsx` that can render the AST for both static and editable modes. It must expose stable DOM structure so offset mapping works.
6. Add tests for the renderer.

### Phase 1 — Editable surface

1. Create `CustomInlineEditor.tsx`:
   - `contentEditable` container.
   - Renders via `InlineContentRenderer`.
   - Tracks `InlineEditorState` locally.
   - On `beforeinput` / `input`, suppress default mutation and apply model operations.
   - On every state change, re-render and restore DOM selection from logical offset.
   - Handles `compositionstart`/`compositionend` for IME.
2. Wire keyboard handlers:
   - Arrow keys: move cursor by logical offset.
   - Shift+arrows: extend selection.
   - Enter: call `onEnter` callback (BlockList splits block).
   - Shift+Enter: insert hard break.
   - Backspace: delete backward; at offset 0 call `onBackspaceAtStart`.
   - Delete: delete forward; at end call `onDeleteAtEnd`.
   - Escape: blur and call `onEscape`.
   - Ctrl+Enter: call `onCtrlEnter`.
3. Implement `useInlineSelection` hook to sync DOM selection with logical selection.
4. Add tests for the editable surface (input, cursor, selection).

### Phase 2 — Formatting marks

1. Implement `toggleMark` for `strong`, `em`, `strikethrough`, `underline`, `highlight`, `code`.
2. Add keyboard shortcuts: Ctrl/Cmd+B/I/U/etc.
3. Update renderer to apply mark classes/tags.
4. Ensure marks can overlap and nest correctly in the AST.
5. Tests.

### Phase 3 — Atomic inline nodes

1. Render atomic nodes in `InlineContentRenderer`:
   - node links via existing `InlineLink` component (adapted to work without Lexical)
   - broken links
   - external links
   - date ranges via existing `InlineDateRange`
   - math via KaTeX
   - hard breaks
2. Implement selection of atomic nodes (click selects; arrow keys move before/after).
3. Implement deletion of selected atomic nodes and `onPillRemove` callback.
4. Adapt `InlineLink` to mutate AST through a provided callback instead of Lexical commands.
5. Tests.

### Phase 4 — Popups and triggers

1. Port `TriggerPlugin` logic to a hook/component that works with the custom editor:
   - detect `/`, `[[`, `@`, `+`, `#` patterns
   - open existing picker popups
   - apply results as AST mutations
2. Port `NodeLinkPlugin` pill click/edit/remove behavior.
3. Port `FloatingToolbarPlugin` to show/hide based on selection.
4. Tests for trigger detection and popup integration.

### Phase 5 — Block integration and lifecycle

1. Update `BlockRow.tsx` to use `CustomInlineEditor` instead of `InlineEditor`.
2. Keep the `InlineEditorHandle` imperative API (focus, blur, getCursorPosition, getCursorOffset) so `BlockList` keyboard navigation continues to work.
3. Replace `inlineEditorRegistry` Lexical editor map with custom editor refs/handles.
4. Update `activeEditorRegistry` and `mobileEditorBridge` to work without Lexical.
5. Tests.

### Phase 6 — Find/replace, copy/paste, and cleanup

1. Port `FindReplaceWidget` and `blockFindReplace` / `singleEditorFindReplace` to operate on AST logical offsets.
2. Port `InlineCopyPastePlugin` to parse HTML/plain text into AST and insert at cursor.
3. Remove all Lexical node/plugin/theme files under `frontend/src/features/editor/editor/`.
4. Remove Lexical dependencies from `package.json` and run `npm install`.
5. Update barrel exports.
6. Run full lint and test suite; fix failures.

### Phase 7 — CRDT collaboration (future)

After the custom editor is stable, re-introduce real-time collaborative editing by replacing the Lexical-Yjs binding with a custom binding that maps AST operations to Yjs updates.

## Testing strategy

- Unit tests for the model (pure functions, edge cases, marks, atomic nodes).
- Component tests for `CustomInlineEditor` using `@testing-library/react` and `userEvent`.
- Renderer tests for AST -> DOM mapping.
- Full frontend test suite (`npm run test:run`) must pass before each phase merges.
- Manual browser QA for IME, mobile soft keyboards, and pill interactions.

## Progress

- Phases 1–6 implemented on branch `feat/custom-inline-editor`.
- `CustomInlineEditor` replaces `InlineEditor` in `BlockRow` and `KanbanCard`.
- Model, renderer, selection sync, triggers, node links, copy/paste, floating toolbar, and find/replace ported.
- All Lexical source files, nodes, plugins, theme, and frontend Yjs binding removed.
- `lexical`, `@lexical/*`, and `yjs` removed from `frontend/package.json`.
- `npm run lint`, `npm run test:run`, `npm run build`, and backend `uv run pytest tests/unit -m unit --no-cov` pass.

## Migration checklist

- [x] No `lexical` or `@lexical/*` imports remain in production source.
- [x] Editor barrel exports `CustomInlineEditor` and `InlineEditorHandle` with compatible signatures.
- [x] `BlockRow` mounts the custom editor when active.
- [x] All existing block-level keyboard navigation works.
- [x] Pills can be inserted, navigated, and removed.
- [x] Formatting marks can be applied and persisted.
- [x] Copy/paste handles internal blocks, link pills, images, and plain text.
- [x] Find/replace works across visible blocks.
- [x] Lint and tests pass.
- [x] `package.json` no longer lists Lexical packages.
- [ ] Real-time CRDT collaborative editing (Phase 7) intentionally deferred.

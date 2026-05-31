# Editor Refactor — Regressions & Missing Features Tracker

**Branch:** `feat/editor-block-level-refactor`  
**Comparison target:** `main`  
**Date:** 2026-05-30

---

## P0 — Blockers (must fix before merge)

| # | Issue | Root Cause | Fix Strategy |
|---|-------|------------|--------------|
| 0.1 | ✅ **Fixed:** `too much recursion` in `BlockList.tsx` | `flattenNodesFromRuntime` used `graphNode.parentId` to look up children instead of the node's own UUID | Use `uuid` as key for `byParent` children lookup |
| 0.2 | 🔴 **404 on `/properties/uuid/{daily_uuid}`** | Router or breadcrumb logic treats a node UUID as a property UUID | Find where daily node UUID is passed to property API; likely in breadcrumb resolver or URL parser |
| 0.3 | 🟡 **Double auth initialization** | `App.tsx` or `Layout.tsx` mounts auth logic twice | Investigate React StrictMode + useEffect duplication in auth restore flow |
| 0.4 | 🟡 **WebSocket live-sync fails silently** | `useLivePageSync` may not handle WS connection failure gracefully | Add error boundary / retry logic; ensure it doesn't crash the app |

---

## P1 — Critical Missing Features (regressions from `main`)

### 1.1 Task System (`TaskCheckboxPlugin`, `TaskCyclePlugin`, `TaskBadgesPlugin`)
**Status:** ❌ Completely removed  
**Impact:** Tasks render as plain text. No checkboxes, no status cycling, no priority badges.  
**Files deleted:**
- `frontend/src/editor/plugins/TaskCheckboxPlugin.tsx`
- `frontend/src/editor/plugins/TaskCyclePlugin.tsx`
- `frontend/src/editor/plugins/TaskBadgesPlugin.tsx`

**Fix strategy:**
- Detect task nodes (nodes with task class or task_status property)
- Render checkbox in `BlockUI.tsx` (left of bullet)
- Clicking checkbox cycles status via runtime intent + API
- Show badge (priority/status) in `BlockUI.tsx`

### 1.2 Paste Image (`PasteImagePlugin`)
**Status:** ❌ Removed  
**Impact:** Pasting an image into a block does nothing.  
**File deleted:** `frontend/src/editor/plugins/PasteImagePlugin.tsx`

**Fix strategy:**
- Add paste handler in `InlineEditor.tsx` or `InlineCopyPastePlugin.tsx`
- Detect image data in clipboard
- Upload via asset API
- Insert `[[assetNodeId]]` link or create asset block

### 1.3 Table Blocks (`TableBlockPlugin` + `BlockTableCellNode`)
**Status:** ❌ Removed  
**Impact:** Tables render as plain text. No grid UI.  
**Files deleted:**
- `frontend/src/editor/plugins/TableBlockPlugin.tsx`
- `frontend/src/editor/nodes/BlockTableCellNode.ts`
- `frontend/src/editor/plugins/TableBlockPlugin.css`

**Fix strategy:**
- Detect table class nodes
- Render table grid in `BlockRow.tsx` or `BlockAfterContent.tsx`
- Editable cells: either inline editors per cell or a dedicated table renderer
- Support `/table` slash command

### 1.4 Asset Blocks (`AssetBlockPlugin`)
**Status:** ❌ Removed  
**Impact:** Image/audio/video asset blocks render as plain text.  
**File deleted:** `frontend/src/editor/plugins/AssetBlockPlugin.tsx`

**Fix strategy:**
- Detect asset class nodes
- Render preview (image/audio/video) in `BlockRow.tsx`
- Click to open full asset view

### 1.5 Code Blocks (`BlockCodePlugin` + `BlockCodeNode`)
**Status:** ❌ Removed  
**Impact:** Code blocks render as plain text. No syntax highlighting.  
**Files deleted:**
- `frontend/src/editor/plugins/BlockCodePlugin.tsx`
- `frontend/src/editor/nodes/BlockCodeNode.ts`

**Fix strategy:**
- Detect code class nodes
- Render `<pre><code>` with syntax highlighting in `BlockRow.tsx`
- Support language property

### 1.6 Query Blocks (`QueryBlockPlugin`)
**Status:** ❌ Removed  
**Impact:** Embedded query blocks show raw text instead of live results.  
**File deleted:** `frontend/src/editor/plugins/QueryBlockPlugin.tsx`

**Fix strategy:**
- Detect query class nodes
- Render `QueryNodeCollection` or `NodeCollection` inside `BlockRow.tsx`
- Execute query AST against API

### 1.7 Embed Blocks (`EmbedBlockPlugin`)
**Status:** ❌ Removed  
**Impact:** Embed blocks (iframes, external content) show as plain text.  
**File deleted:** `frontend/src/editor/plugins/EmbedBlockPlugin.tsx`

**Fix strategy:**
- Detect embed class nodes or URL pattern
- Render iframe or embed preview in `BlockRow.tsx`

### 1.8 Backlinks (`BlockBacklinksPlugin`)
**Status:** ❌ Removed  
**Impact:** No backlink display under blocks.  
**File deleted:** `frontend/src/editor/plugins/BlockBacklinksPlugin.tsx`

**Fix strategy:**
- Add backlinks section to `BlockAfterContent.tsx`
- Fetch backlinks via API (or use existing data)

---

## P2 — Important Missing Features

### 2.1 Virtualization
**Status:** ❌ Removed  
**Impact:** Large documents render all blocks in DOM → performance issues  
**File deleted:** `frontend/src/editor/plugins/VirtualizationPlugin.tsx`

**Fix strategy:**
- Integrate `@tanstack/react-virtual` in `BlockList.tsx`
- Measure row heights dynamically

### 2.2 External File Drop (`ExternalDropPlugin`)
**Status:** ❌ Removed  
**Impact:** Dragging files from desktop into editor does nothing  
**File deleted:** `frontend/src/editor/plugins/ExternalDropPlugin.tsx`

**Fix strategy:**
- Add `dragover`/`drop` handlers on `BlockList` container
- Upload dropped files as assets
- Create asset blocks

### 2.3 Collapse Thread Lines
**Status:** ⚠️ Partial  
**Impact:** Collapse/expand works but no visual thread lines  
**File deleted:** `frontend/src/editor/plugins/ThreadLinePlugin.tsx`

**Fix strategy:**
- Add CSS pseudo-elements or SVG lines in `BlockRow.css` showing parent-child relationships

### 2.4 Property Icons
**Status:** ⚠️ Partial  
**Impact:** Properties render in `BlockAfterContent` but without icons  
**File deleted:** `frontend/src/editor/plugins/BlockPropertyIconsPlugin.tsx`

**Fix strategy:**
- Add icon display next to property values in `BlockAfterContent.tsx`

### 2.5 Live Sync Plugin Integration
**Status:** ⚠️ Partial  
**Impact:** `useLivePageSync` handles WS messages but there's no plugin bridging remote updates into per-block editors  
**File deleted:** `frontend/src/editor/plugins/LiveSyncPlugin.tsx`

**Fix strategy:**
- Ensure `useLivePageSync` updates query cache, which triggers `BlockList` re-render
- Verify cursor position is preserved during remote updates

---

## P3 — Polish / Code Quality

| # | Issue | Strategy |
|---|-------|----------|
| 3.1 | Stale comments referencing `BlockEditor` / `BlockPlugin` / `BlockNode` | Search/replace comments in ~30 files |
| 3.2 | `ASTBlockNode` type name still exists though `BlockNode` was deleted | Consider renaming to avoid confusion |
| 3.3 | `editor/virtualizedState.ts` mentions deleted `VirtualizationPlugin` | Update JSDoc |

---

## Errors Observed in Browser Console

| Error | Log Snippet | Likely Location |
|-------|-------------|-----------------|
| 404 `/properties/uuid/{daily_uuid}` | `GET /properties/uuid/00000000-0000-0000-00dd-202605280000` | Breadcrumb resolver or URL sync treating node UUID as property UUID |
| WS connection fail | `Firefox no puede establecer una conexión con el servidor en ws://atlas:5173/api/ws/live/...` | `useLivePageSync` or `LiveSyncManager` |
| Double init | `Notees application initialized` appears twice | `App.tsx` mount logic or StrictMode |

---

## Files Most Frequently Touched

| File | Why |
|------|-----|
| `frontend/src/components/blocks/BlockRow.tsx` | Add conditional rendering for task/table/asset/code/query/embed blocks |
| `frontend/src/components/blocks/BlockUI.tsx` | Add task checkbox, badges, icons |
| `frontend/src/components/blocks/BlockAfterContent.tsx` | Add backlinks, property icons |
| `frontend/src/components/blocks/BlockList.tsx` | Add external drop handlers, virtualization |
| `frontend/src/editor/InlineEditor.tsx` | Add paste image handler |
| `frontend/src/editor/plugins/InlineCopyPastePlugin.tsx` | Enhance with image paste support |
| `frontend/src/runtime/NodeGraphRuntime.ts` | May need new intents (e.g., `toggle_task_status`) |
| `frontend/src/hooks/useContentSave.ts` | Ensure task status changes are persisted |

---

## Implementation Order Recommendation

1. **Fix P0 errors first** (404, double init, WS)
2. **Task system** (checkbox + cycle) — highest user-facing impact
3. **Paste image** — common workflow
4. **Table blocks** — complex but heavily used
5. **Asset blocks** — visual impact
6. **Code blocks** — developer-friendly
7. **Query blocks** — power-user feature
8. **Embed blocks** — nice to have
9. **Virtualization** — performance for large docs
10. **Polish** — comments, cleanup

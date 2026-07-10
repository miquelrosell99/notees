# Slash Command: Date — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/date` slash command that opens a calendar popup and inserts a node link to the selected daily journal page.

**Architecture:** Reuse the existing slash-command plumbing (`TriggerPopup` + `InlineTriggers`) and the existing `DatePickerPopup`. On selection, eagerly create the daily page via `getOrCreateDaily` and insert a `node_link` pill.

**Tech Stack:** React, TypeScript, Notees custom inline editor.

## Global Constraints

- Frontend changes only; no backend changes.
- Follow existing patterns in `InlineTriggers.tsx` (mirrors the `date-range` command).
- Use path aliases (`@/...`) — no relative `../../` imports.
- Verify with `npx tsc -b --noEmit` and `npm run lint` inside the frontend container.

---

## Task 1: Register the `date` slash command

**Files:**
- Modify: `frontend/src/features/editor/editor/plugins/TriggerPopup.tsx` (the `SLASH_COMMANDS` array near lines 41–62).

- [ ] **Step 1: Add the command entry**

Insert a new object into `SLASH_COMMANDS` so it appears in the `/` popup:

```ts
{ id: 'date', label: 'Date', description: 'Insert a link to a daily journal page' },
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/features/editor/editor/plugins/TriggerPopup.tsx
git commit -m "feat(editor): add /date slash command entry"
```

## Task 2: Wire the command to the date picker and insert the node link

**Files:**
- Modify: `frontend/src/features/editor/custom/plugins/InlineTriggers.tsx`

**Interfaces:**
- Consumes: `insertPill(nodeUuid, refType)` (already defined in this file), `getCaretCoordinates` (local helper), `removePlaceholder`, `handleClose`, `popupOpenRef`, `setPopup`.
- Consumes: `DatePickerPopup` from `@/features/content` (props: `onSelect(isoDate)`, `onClose()`, `anchorRef`).
- Consumes: `getOrCreateDaily(isoDate)` from `@/api/nodes` → resolves to a `Node` with `.uuid`.
- Consumes: `applyMutation` from props.

- [ ] **Step 1: Add imports**

Add to the import block:

```ts
import { DatePickerPopup } from '@/features/content';
import { getOrCreateDaily } from '@/api/nodes';
```

- [ ] **Step 2: Add state and refs for the picker**

Next to the existing `dateRangePickerOpen` state, add:

```ts
const [datePickerOpen, setDatePickerOpen] = useState(false);
const dateAnchorRef = useRef<HTMLSpanElement>(null);
const [dateAnchorPos, setDateAnchorPos] = useState<{ top: number; left: number } | null>(null);
const dateInsertOffsetRef = useRef<number | null>(null);
```

- [ ] **Step 3: Handle the `date` command**

In `handleSelectCommand`, add a branch after the `date-range` branch:

```ts
if (commandId === 'date') {
  // removePlaceholder() already ran; selection is at the insertion offset.
  dateInsertOffsetRef.current = placeholderOffsetRef.current;
  const coords = getCaretCoordinates(rootRef.current ?? document.body);
  setDateAnchorPos({
    top: coords.caretTop - window.scrollY,
    left: coords.left - window.scrollX,
  });
  handleClose();
  setDatePickerOpen(true);
  return;
}
```

- [ ] **Step 4: Add the select handler**

Add a `handleDateSelect` callback (alongside `insertDateRange`):

```ts
const handleDateSelect = useCallback(
  async (isoDate: string) => {
    setDatePickerOpen(false);
    const insertOffset = dateInsertOffsetRef.current;
    try {
      const dayNode = await getOrCreateDaily(isoDate);
      applyMutation((prev) =>
        insertAtomicNode(
          { ...prev, selection: { type: 'collapsed', offset: insertOffset ?? prev.selection.type === 'collapsed' ? prev.selection.offset : 0 } },
          nodeLink(buildLinkId(dayNode.uuid, generateUUID())),
        ),
      );
    } catch (err) {
      console.error('Failed to create daily page:', err);
    } finally {
      dateInsertOffsetRef.current = null;
    }
  },
  [applyMutation],
);
```

- [ ] **Step 5: Render the picker**

In the returned fragment, next to the `dateRangePickerOpen` block, add:

```tsx
{datePickerOpen && dateAnchorPos && (
  <>
    <span
      ref={dateAnchorRef}
      style={{
        position: 'fixed',
        top: dateAnchorPos.top,
        left: dateAnchorPos.left,
        width: 0,
        height: 0,
        pointerEvents: 'none',
      }}
    />
    <DatePickerPopup
      onSelect={handleDateSelect}
      onClose={() => {
        setDatePickerOpen(false);
        dateInsertOffsetRef.current = null;
      }}
      anchorRef={dateAnchorRef}
    />
  </>
)}
```

- [ ] **Step 6: Type-check and lint**

Run inside the frontend container:

```bash
docker compose -f compose.dev.yaml exec frontend npx tsc -b --noEmit
docker compose -f compose.dev.yaml exec frontend npm run lint
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/editor/custom/plugins/InlineTriggers.tsx
git commit -m "feat(editor): wire /date command to calendar picker and node link"
```

## Task 3: Manual verification

- [ ] **Step 1: Rebuild the dev stack**

```bash
docker compose -f compose.dev.yaml down && docker compose -f compose.dev.yaml up --build
```

- [ ] **Step 2: Verify in the browser**

1. Open a page and click into a block.
2. Type `/date` and select the **Date** command.
3. Pick a date from the calendar popup.
4. Confirm a node-link pill appears showing the daily page name.
5. Click the pill and confirm it navigates to the daily page.
6. Reload and confirm the link persists.

# Class-Aware Display Name Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-_SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render date-page names (`YYYYMMDD`, `YYYYMM00`, `YYYY0000`) formatted by the user's `dateFormat` preference across all UI display surfaces, without changing `nodeNameToText` or any search/matching/query logic.

**Architecture:** Introduce a class-aware display-name layer: `nodeNameToDisplayText(node, options?)` extracts raw text and formats only when the node carries a date class; `useNodeDisplayName(node, fallback?)` subscribes to `dateFormat` for React surfaces. All display call sites migrate from `nodeNameToText(node.name)` to these new primitives.

**Tech Stack:** React 19, TypeScript 6, Vite, Vitest, Zustand, TanStack Query.

## Global Constraints

- `nodeNameToText` must remain a plain AST/text extractor with no date-formatting side effects.
- Only nodes with `SYSTEM_CLASS_UUIDS.day`, `SYSTEM_CLASS_UUIDS.month`, or `SYSTEM_CLASS_UUIDS.year` are formatted.
- The implementation must react live to `useSettingsStore.dateFormat` changes.
- Follow path aliases (`@/...`), co-located CSS, and feature-barrel imports per `agents/frontend.md`.
- Do not change how date content is stored in the backend or worker.
- Do not modify search indexing or query evaluation behavior.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `frontend/src/features/queries/nodeDisplayName.ts` | New helper `nodeNameToDisplayText` and hook `useNodeDisplayName`. |
| `frontend/src/features/queries/nodeDisplayName.test.ts` | Unit tests for helper and hook. |
| `frontend/src/features/queries/index.ts` | Re-export the new helper/hook. |
| Display surface files (listed per task) | Replace `nodeNameToText(node.name)` with `nodeNameToDisplayText(node)` or `useNodeDisplayName(node)`. |

---

## Task 1: Implement `nodeNameToDisplayText` and `useNodeDisplayName`

**Files:**
- Create: `frontend/src/features/queries/nodeDisplayName.ts`
- Create: `frontend/src/features/queries/nodeDisplayName.test.ts`
- Modify: `frontend/src/features/queries/index.ts`

**Interfaces:**
- Consumes: `Node` from `@/types`; `SYSTEM_CLASS_UUIDS` from `@/constants/systemProperties`; `formatDatePageContent` from `@/utils/datePageDisplay`; `nodeNameToText` from `./hooks/useStringifyAST`; `useSettingsStore` and `DateFormat` from `@/stores`.
- Produces: `nodeNameToDisplayText(node, options?)` and `useNodeDisplayName(node, fallback?)` exported from `@/features/queries`.

- [ ] **Step 1: Write the new module**

Create `frontend/src/features/queries/nodeDisplayName.ts`:

```ts
/**
 * Class-aware node display-name helpers.
 *
 * These build on top of `nodeNameToText` and add date-formatting only for
 * nodes that carry one of the system date classes (day/month/year).
 */
import type { Node } from '@/types';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import { formatDatePageContent } from '@/utils/datePageDisplay';
import { nodeNameToText } from './hooks/useStringifyAST';
import { useSettingsStore } from '@/stores';

const DATE_CLASS_UUIDS = new Set([
  SYSTEM_CLASS_UUIDS.day,
  SYSTEM_CLASS_UUIDS.month,
  SYSTEM_CLASS_UUIDS.year,
]);

export interface NodeDisplayNameOptions {
  maxLength?: number;
}

/**
 * Convert a node's name into the text that should be displayed to the user.
 *
 * - Returns `''` for missing/empty nodes so callers can apply their own fallback.
 * - For date-class nodes, formats compact date content using the user's
 *   `dateFormat` preference.
 * - For all other nodes, returns the raw text extracted by `nodeNameToText`.
 */
export function nodeNameToDisplayText(
  node: Node | null | undefined,
  options?: NodeDisplayNameOptions,
): string {
  if (!node) return '';
  const raw = nodeNameToText(node.name, options?.maxLength);
  if (!raw) return '';

  const isDatePage = node.classes_uuid?.some((id) => DATE_CLASS_UUIDS.has(id));
  if (!isDatePage) return raw;

  const dateFormat = useSettingsStore.getState().dateFormat;
  return formatDatePageContent(raw, dateFormat) ?? raw;
}

/**
 * React hook that returns a node's display name and reacts to date-format
 * preference changes.
 */
export function useNodeDisplayName(
  node: Node | null | undefined,
  fallback = 'Untitled',
): string {
  const dateFormat = useSettingsStore((s) => s.dateFormat);
  return nodeNameToDisplayText(node) || fallback;
}
```

- [ ] **Step 2: Re-export from the queries barrel**

Modify `frontend/src/features/queries/index.ts`:

```ts
export * from './nodeDisplayName';
export * from './hooks/useStringifyAST';
// ... existing exports unchanged
```

- [ ] **Step 3: Write unit tests**

Create `frontend/src/features/queries/nodeDisplayName.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { nodeNameToDisplayText, useNodeDisplayName } from './nodeDisplayName';
import type { Node } from '@/types';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';

const mockDateFormat = vi.hoisted(() => vi.fn().mockReturnValue('YYYY/MM/DD'));

vi.mock('@/stores', () => ({
  useSettingsStore: Object.assign(
    (selector: (s: { dateFormat: string }) => unknown) => selector({ dateFormat: mockDateFormat() }),
    { getState: () => ({ dateFormat: mockDateFormat() }) },
  ),
  formatDate: (date: Date, format: string) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return format === 'YYYY/MM/DD'
      ? `${y}/${m}/${d}`
      : format === 'YYYY-MM-DD'
        ? `${y}-${m}-${d}`
        : `${d}/${m}/${y}`;
  },
  formatMonth: (year: number, month: number, format: string) => {
    const m = String(month).padStart(2, '0');
    const sep = format.includes('/') ? '/' : '-';
    return format.startsWith('YYYY')
      ? `${year}${sep}${m}`
      : `${m}${sep}${year}`;
  },
  formatYear: (year: number) => String(year),
}));

function makeNode(overrides: Partial<Node> & { classes_uuid?: string[] } = {}): Node {
  return {
    uuid: 'node-uuid',
    name: '',
    is_page: true,
    classes_uuid: [],
    ...overrides,
  } as Node;
}

beforeEach(() => {
  mockDateFormat.mockReturnValue('YYYY/MM/DD');
});

describe('nodeNameToDisplayText', () => {
  it('formats a day-class node as YYYY/MM/DD', () => {
    const node = makeNode({
      name: '20260805',
      classes_uuid: [SYSTEM_CLASS_UUIDS.day],
    });
    expect(nodeNameToDisplayText(node)).toBe('2026/08/05');
  });

  it('formats a month-class node as YYYY/MM', () => {
    const node = makeNode({
      name: '20260800',
      classes_uuid: [SYSTEM_CLASS_UUIDS.month],
    });
    expect(nodeNameToDisplayText(node)).toBe('2026/08');
  });

  it('formats a year-class node as YYYY', () => {
    const node = makeNode({
      name: '20260000',
      classes_uuid: [SYSTEM_CLASS_UUIDS.year],
    });
    expect(nodeNameToDisplayText(node)).toBe('2026');
  });

  it('respects the dateFormat preference for day-class nodes', () => {
    mockDateFormat.mockReturnValue('DD/MM/YYYY');
    const node = makeNode({
      name: '20260805',
      classes_uuid: [SYSTEM_CLASS_UUIDS.day],
    });
    expect(nodeNameToDisplayText(node)).toBe('05/08/2026');
  });

  it('respects the dateFormat preference for month-class nodes', () => {
    mockDateFormat.mockReturnValue('MM-YYYY');
    const node = makeNode({
      name: '20260800',
      classes_uuid: [SYSTEM_CLASS_UUIDS.month],
    });
    expect(nodeNameToDisplayText(node)).toBe('08-2026');
  });

  it('does not format a non-date page with a numeric-looking name', () => {
    const node = makeNode({
      name: '20260805',
      classes_uuid: [SYSTEM_CLASS_UUIDS.page],
    });
    expect(nodeNameToDisplayText(node)).toBe('20260805');
  });

  it('returns empty string for a missing node', () => {
    expect(nodeNameToDisplayText(undefined)).toBe('');
    expect(nodeNameToDisplayText(null)).toBe('');
  });

  it('returns empty string for an empty name', () => {
    const node = makeNode({ name: '', classes_uuid: [SYSTEM_CLASS_UUIDS.day] });
    expect(nodeNameToDisplayText(node)).toBe('');
  });

  it('respects maxLength', () => {
    const node = makeNode({
      name: '20260805',
      classes_uuid: [SYSTEM_CLASS_UUIDS.day],
    });
    expect(nodeNameToDisplayText(node, { maxLength: 4 })).toBe('2026');
  });
});

describe('useNodeDisplayName', () => {
  it('returns the formatted display name for a date node', () => {
    const node = makeNode({
      name: '20260805',
      classes_uuid: [SYSTEM_CLASS_UUIDS.day],
    });
    const { result } = renderHook(() => useNodeDisplayName(node));
    expect(result.current).toBe('2026/08/05');
  });

  it('returns the fallback for a missing node', () => {
    const { result } = renderHook(() => useNodeDisplayName(null));
    expect(result.current).toBe('Untitled');
  });

  it('returns a custom fallback when provided', () => {
    const { result } = renderHook(() => useNodeDisplayName(null, 'None'));
    expect(result.current).toBe('None');
  });
});
```

- [ ] **Step 4: Run the new tests**

Run:

```bash
cd frontend && npm run test:run -- src/features/queries/nodeDisplayName.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/queries/nodeDisplayName.ts \
        frontend/src/features/queries/nodeDisplayName.test.ts \
        frontend/src/features/queries/index.ts
git commit -m "feat(queries): add class-aware node display name helpers"
```

---

## Task 2: Migrate High-Impact Display Surfaces

**Files:**
- Modify: `frontend/src/features/content/components/nodes/PageHeader.tsx`
- Modify: `frontend/src/features/layout/components/Sidebar/SidebarFavorites.tsx`
- Modify: `frontend/src/features/layout/components/Sidebar/SidebarRecents.tsx`
- Modify: `frontend/src/features/content/components/nodes/NodeBreadcrumbs.tsx`

**Interfaces:**
- Consumes: `nodeNameToDisplayText` and `useNodeDisplayName` from `@/features/queries`.
- Produces: No new exports; behavior change only.

- [ ] **Step 1: PageHeader**

In `PageHeader.tsx`, replace:

```ts
const [inputValue, setInputValue] = useState(nodeNameToText(page.name) || '');
```

and the `useEffect` that syncs it, with:

```ts
import { useNodeDisplayName, nodeNameToDisplayText } from '@/features/queries';

// ...
const displayName = useNodeDisplayName(page);
const [inputValue, setInputValue] = useState(displayName);

useEffect(() => {
  setInputValue(displayName);
}, [displayName]);
```

Date pages are system pages and already read-only/disabled for editing, so the input should simply display the formatted name.

- [ ] **Step 2: SidebarFavorites**

In `SidebarFavorites.tsx`, replace `nodeNameToText(node.name) || 'Untitled'` with `useNodeDisplayName(node)` in the aria-label and rendered text.

- [ ] **Step 3: SidebarRecents**

In `SidebarRecents.tsx`, replace `nodeNameToText(node.name) || 'Untitled'` with `useNodeDisplayName(node)` in the aria-label and rendered text.

- [ ] **Step 4: NodeBreadcrumbs**

In `NodeBreadcrumbs.tsx`, replace `nodeNameToText(liveName) || 'Untitled'` with `nodeNameToDisplayText(itemNode)` (where `itemNode` is the resolved node for that breadcrumb item). Also update the `displayName` derived from `display_name` to use `nodeNameToDisplayText` if the item is a date node, or leave backend-resolved `display_name` as-is for non-date nodes.

- [ ] **Step 5: Verify in browser**

Open the app, navigate to a date page, and confirm:
- Page header shows `2026/08/05` (or chosen format).
- Favorites, recents, and breadcrumbs show formatted month/year/day names.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/content/components/nodes/PageHeader.tsx \
        frontend/src/features/layout/components/Sidebar/SidebarFavorites.tsx \
        frontend/src/features/layout/components/Sidebar/SidebarRecents.tsx \
        frontend/src/features/content/components/nodes/NodeBreadcrumbs.tsx
git commit -m "feat(ui): use class-aware display names in header, sidebar, breadcrumbs"
```

---

## Task 3: Migrate Command Palette and Node Selector

**Files:**
- Modify: `frontend/src/features/layout/components/CommandPalette/CommandPaletteResult.tsx`
- Modify: `frontend/src/features/layout/components/CommandPalette/useCommandPaletteItems.ts`
- Modify: `frontend/src/features/content/components/nodes/NodeSelector.tsx`

**Interfaces:**
- Consumes: `nodeNameToDisplayText` and `useNodeDisplayName` from `@/features/queries`.

- [ ] **Step 1: CommandPaletteResult**

Replace `nodeNameToText(result.node.name) || 'Untitled'` in the result name and aliased node name with `nodeNameToDisplayText(result.node) || 'Untitled'`.

For class badges, keep `nodeNameToText(c.name)` (class names are not date pages).

- [ ] **Step 2: useCommandPaletteItems**

Remove the local `formatNodeName` helper and its `formatDatePageContent` import. Replace its usages with `nodeNameToDisplayText(node)`.

- [ ] **Step 3: NodeSelector**

Remove the local `formatDisplayName` helper and its `formatDatePageContent` import. Replace usages with `nodeNameToDisplayText(node)`.

- [ ] **Step 4: Run tests / lint**

```bash
cd frontend && npm run lint
cd frontend && npm run test:run -- src/features/layout/components/CommandPalette src/features/content/components/nodes/NodeSelector.tsx
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/layout/components/CommandPalette/CommandPaletteResult.tsx \
        frontend/src/features/layout/components/CommandPalette/useCommandPaletteItems.ts \
        frontend/src/features/content/components/nodes/NodeSelector.tsx
git commit -m "feat(ui): use class-aware display names in command palette and node selector"
```

---

## Task 4: Migrate Trigger Popup and Inline Displays

**Files:**
- Modify: `frontend/src/features/editor/editor/plugins/TriggerPopup.tsx`
- Modify: `frontend/src/features/content/components/blocks/NodeInline.tsx`
- Modify: `frontend/src/features/content/components/blocks/NodeNameContent.tsx`
- Modify: `frontend/src/features/content/hooks/useNodeDisplay.ts`

**Interfaces:**
- Consumes: `nodeNameToDisplayText` from `@/features/queries`.

- [ ] **Step 1: TriggerPopup display paths**

In `TriggerPopup.tsx`, update `buildParentPath` and `buildBlockParentPath` to use `nodeNameToDisplayText(parent)` for display. Keep the create-option class check using raw `nodeNameToText`.

- [ ] **Step 2: NodeInline**

Replace `nodeNameToText(node.name)` display usage with `nodeNameToDisplayText(node)`.

- [ ] **Step 3: NodeNameContent**

Remove the redundant `formatDatePageContent` import and call; rely on `nodeNameToDisplayText(node)` or the equivalent already-computed display text.

- [ ] **Step 4: useNodeDisplay**

Remove the `formatDatePageContent` import and the local date-formatting logic in `displayText`. Subscribe to `dateFormat` so the hook re-renders when the setting changes, and delegate formatting to `nodeNameToDisplayText`:

```ts
const dateFormat = useSettingsStore((s) => s.dateFormat);

const displayText = useMemo(() => {
  if (!node) return fallbackText;
  const displayNode = {
    ...node,
    name:
      node.display_name && node.display_name !== node.name
        ? node.display_name
        : (liveName || node.name || ''),
  };
  const text = nodeNameToDisplayText(displayNode);
  if (!text || text.trim() === '') {
    return node.is_page ? '[Untitled Page]' : '[Empty Block]';
  }
  return text;
}, [node, fallbackText, liveName, dateFormat]);
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/editor/editor/plugins/TriggerPopup.tsx \
        frontend/src/features/content/components/blocks/NodeInline.tsx \
        frontend/src/features/content/components/blocks/NodeNameContent.tsx \
        frontend/src/features/content/hooks/useNodeDisplay.ts
git commit -m "feat(ui): use class-aware display names in trigger popup and inline displays"
```

---

## Task 5: Migrate Remaining Display Surfaces

**Files:**
- Modify: `frontend/src/features/sidebar/components/SidebarCardNode.tsx`
- Modify: `frontend/src/features/sidebar/components/SidebarNodeView.tsx`
- Modify: `frontend/src/features/sidebar/components/SidebarContextSections.tsx`
- Modify: `frontend/src/features/content/components/PresentationModal.tsx`
- Modify: `frontend/src/features/content/pages/TrashView.tsx`
- Modify: `frontend/src/features/content/components/nodes/NodeMetadataSection.tsx`
- Modify: `frontend/src/features/layout/components/Sidebar/SidebarPinnedPages.tsx`
- Modify any remaining modal confirmation messages that embed a node name via `nodeNameToText(node.name)`

**Interfaces:**
- Consumes: `nodeNameToDisplayText` and `useNodeDisplayName` from `@/features/queries`.

- [ ] **Step 1: SidebarCardNode, SidebarNodeView, SidebarContextSections**

Replace `nodeNameToText(node.name) || 'Untitled'` display usages with `nodeNameToDisplayText(node) || 'Untitled'` or `useNodeDisplayName(node)`.

- [ ] **Step 2: PresentationModal**

Update `getSlideTitle` to use `nodeNameToDisplayText(node) || 'Untitled'`.

- [ ] **Step 3: TrashView and NodeMetadataSection**

Update modal messages/titles and alias-of labels to use `nodeNameToDisplayText`.

- [ ] **Step 4: SidebarPinnedPages**

Update aria-labels and rendered text to use `useNodeDisplayName(node)`.

- [ ] **Step 5: Sweep remaining display usages**

Search for remaining `nodeNameToText(node.name)` or `nodeNameToText(node?.name)` used for display and migrate them. Leave search/matching/query usages untouched.

Command to audit:

```bash
cd frontend && grep -R "nodeNameToText(.*\.name" src --include='*.ts' --include='*.tsx' | grep -v test | grep -v nodeNameToDisplayText
```

For each remaining hit, determine if it is display-only. If yes, migrate.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(ui): use class-aware display names in remaining surfaces"
```

---

## Task 6: Verify and Clean Up

**Files:**
- All modified files.

- [ ] **Step 1: Remove now-redundant `formatDatePageContent` imports**

Search for remaining `formatDatePageContent` imports in display files and confirm they are still needed:

```bash
cd frontend && grep -R "formatDatePageContent" src --include='*.ts' --include='*.tsx' -l
```

Expected remaining usages: only inside `nodeDisplayName.ts` and possibly `useCommandPaletteState.ts` if it still formats parsed date labels for the create-option. Remove any others.

- [ ] **Step 2: Run frontend lint**

```bash
cd frontend && npm run lint
```

Fix any lint errors introduced by the migration.

- [ ] **Step 3: Run frontend tests**

```bash
cd frontend && npm run test:run
```

Fix any failing tests.

- [ ] **Step 4: Type-check**

```bash
cd frontend && npx tsc -b --noEmit
```

Fix any TypeScript errors.

- [ ] **Step 5: Browser verification**

1. Open the app and switch date format to `YYYY/MM/DD`.
2. Open a daily page (e.g. `2026/08/05`) and confirm the page header shows the formatted date.
3. Add the page to favorites; confirm the sidebar favorite shows the formatted date.
4. Open the command palette and search for the date; confirm results show the formatted date.
5. Switch date format to `DD/MM/YYYY` and confirm all surfaces update live.
6. Verify a non-date page named with digits (if one exists) still shows raw digits.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(ui): clean up redundant date formatting after class-aware migration"
```

---

## Self-Review

**Spec coverage:**
- Class-aware formatting only for date-class nodes → Task 1.
- `nodeNameToText` unchanged → no task modifies it.
- React live subscription to `dateFormat` → Task 1 `useNodeDisplayName`.
- Migration of page header, favorites, recents, breadcrumbs → Task 2.
- Migration of command palette, node selector, trigger popup, inline displays → Tasks 3 and 4.
- Removal of redundant `formatDatePageContent` → Tasks 4 and 6.
- Tests → Task 1.

**Placeholder scan:**
- No `TBD`, `TODO`, or "implement later".
- No vague "handle edge cases" steps.
- No "write tests for the above" without code.
- All file paths are exact.
- All code blocks contain concrete implementation.

**Type consistency:**
- `Node` type imported from `@/types` consistently.
- `SYSTEM_CLASS_UUIDS` keys `day`, `month`, `year` match existing constants.
- `formatDatePageContent` signature reused unchanged.

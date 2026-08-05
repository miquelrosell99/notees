# Class-Aware Display Name Layer

## Problem

Date pages in Notees store compact numeric content:

- Day: `YYYYMMDD` (e.g. `20260805`)
- Month: `YYYYMM00` (e.g. `20260800`)
- Year: `YYYY0000` (e.g. `20260000`)

The user can choose a date format preference (e.g. `YYYY/MM/DD`), but many UI surfaces call `nodeNameToText(node.name)` directly and therefore show the raw compact string instead of the formatted display name.

## Goal

Display date pages formatted per user preference everywhere a node name is rendered. Do not change the behavior of search, filtering, matching, query evaluation, or the low-level `nodeNameToText` extractor.

## Constraints

- `nodeNameToText` is used in 600+ places across the frontend, including search/filter logic, exact-match checks, query evaluation, and display. Its behavior must remain unchanged.
- Formatting must be class-aware: only nodes with the system date classes (`day`, `month`, `year`) should be formatted. A user-created page literally named `20260805` must not be reformatted unless it has the date class.
- The solution must react live to changes in `useSettingsStore.dateFormat`.

## Design

### New primitives

#### `nodeNameToDisplayText(node, options?)`

A pure helper function that converts a `Node` into the text that should be shown to the user.

Responsibilities:

1. Extract raw text via existing `nodeNameToText(node.name)`.
2. If the node has one of the system date classes (`SYSTEM_CLASS_UUIDS.day`, `SYSTEM_CLASS_UUIDS.month`, `SYSTEM_CLASS_UUIDS.year`), pass the raw text through `formatDatePageContent(rawText, dateFormat)`.
3. Return the formatted text, or the raw text if formatting does not apply.

It reads `useSettingsStore.getState().dateFormat` directly; outside React this is safe because the store exposes `.getState()`.

File: `frontend/src/features/queries/nodeDisplayName.ts`

Signature:

```ts
interface NodeDisplayNameOptions {
  maxLength?: number;
}

function nodeNameToDisplayText(
  node: Node | null | undefined,
  options?: NodeDisplayNameOptions
): string;
```

The helper intentionally returns `''` when the input is missing or empty, leaving the fallback decision to the caller (e.g. `|| 'Untitled'`). This matches the existing convention used with `nodeNameToText`.

#### `useNodeDisplayName(node, fallback?)`

A React hook wrapper in the same file that subscribes to the `dateFormat` setting and returns the formatted display name.

```ts
function useNodeDisplayName(
  node: Node | null | undefined,
  fallback?: string
): string;
```

When `node` is missing or the computed display text is empty, it returns `fallback` (default `'Untitled'`).

### Migration targets

The following display surfaces should use the new helper/hook instead of calling `nodeNameToText(node.name)` directly:

- `PageHeader`
- `SidebarFavorites`, `SidebarRecents`, `SidebarPinnedPages`
- `NodeBreadcrumbs`
- `CommandPaletteResult`
- `useCommandPaletteItems` (replace custom `formatNodeName`)
- `NodeSelector` (replace custom `formatDisplayName`)
- `TriggerPopup` display paths (parent path, block parent path, result items)
- `NodeInline`, `NodeNameContent`, `useNodeDisplay` (review and remove redundant `formatDatePageContent` calls)
- `SidebarCardNode`, `SidebarNodeView`, `SidebarContextSections`
- `PresentationModal`
- Modal titles and confirmation messages that show a node name

### What stays unchanged

- `nodeNameToText` remains a plain AST/text extractor with no date formatting.
- Search/filter/matching code continues to use raw `nodeNameToText`:
  - `useNodeSearch`
  - `useNodeDateQueries` and `useNodeDateQueries.store`
  - `TriggerPopup` create-option check
  - `SuggestionPopup` class matching
- Query evaluation (`evaluateQueryAST`, `queryHelpers`) continues to use raw text.
- Backend-resolved `display_name` semantics remain unchanged.

### Class detection

Date class detection uses `SYSTEM_CLASS_UUIDS` from `@/constants/systemProperties`:

```ts
const DATE_CLASS_UUIDS = new Set([
  SYSTEM_CLASS_UUIDS.day,
  SYSTEM_CLASS_UUIDS.month,
  SYSTEM_CLASS_UUIDS.year,
]);
```

A node is considered a date page if `node.classes_uuid?.some((id) => DATE_CLASS_UUIDS.has(id))` is true.

### Date formatting

The existing `formatDatePageContent(content, dateFormat)` utility in `@/utils/datePageDisplay` handles the compact formats:

- `YYYYMMDD` → day
- `YYYYMM00` → month
- `YYYY0000` → year

This utility is reused unchanged.

## Testing

- Unit tests for `nodeNameToDisplayText`:
  - Day class with each supported `dateFormat`.
  - Month class with each supported `dateFormat`.
  - Year class.
  - Non-date class with a numeric-looking name (must stay raw).
  - Missing/empty node.
  - `maxLength` option.
- Hook test for `useNodeDisplayName`:
  - Returns formatted text for a date node.
  - Updates when `dateFormat` changes.
  - Returns fallback for missing node.

## Implementation order

1. Implement `nodeNameToDisplayText` and `useNodeDisplayName` with tests.
2. Migrate the high-impact surfaces the user reported: `PageHeader`, `SidebarFavorites`, `SidebarRecents`, `NodeBreadcrumbs`.
3. Migrate remaining display surfaces listed above.
4. Remove redundant `formatDatePageContent` calls from `useNodeDisplay`, `NodeNameContent`, `useCommandPaletteItems`, and `NodeSelector` where the new helper now covers the behavior.
5. Run frontend lint and tests.

## Out of scope

- Changing how date content is stored in the backend or worker.
- Adding new date formats.
- Modifying search indexing or query behavior.
- A CLI client for Notees (mentioned by the user as a future idea, not part of this fix).

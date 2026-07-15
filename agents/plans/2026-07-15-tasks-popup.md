# Tasks Top-Bar Popup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the full-page Tasks view with a Google-Tasks-style top-bar dropdown popup (Overdue / Today / Upcoming / Completed-today circle-checkbox list, quick-add, count badge), rerouting the rail button and palette entry to it.

**Architecture:** New popup follows the existing `CalendarPopup` pattern: open state in `stores/modalStore.ts`, a `Button` trigger in `TopBar.tsx` with a `ButtonBadge` count, dropdown positioned via `useViewportFlip`. Data comes from new QueryAST builders in `utils/taskQueries.ts` executed via `executeQuery` (`@/api/nodeViews`) in a new `useTasksPopupData` hook; status writes go through a new `useSetTaskStatus` hook sharing helpers with `useTaskActions`. The old `TasksView`/`useTasks`/`mainViewType === 'tasks'` surface is deleted.

**Tech Stack:** React 19 + TypeScript, Zustand (modalStore), TanStack Query 5, Vite + Vitest (jsdom).

**Spec:** `agents/superpowers/specs/2026-07-15-tasks-popup-design.md` (approved). Branch: `main`. Commits: one per task, Conventional Commits, stage only edited files (never `git add -A`).

## Global Constraints

- **All frontend commands run inside the dev container** (host `frontend/node_modules` is stale — missing `@floating-ui`):
  - Tests: `docker compose -f compose.dev.yaml exec frontend npx vitest run <path>`
  - Type check: `docker compose -f compose.dev.yaml exec frontend npx tsc -b --noEmit`
  - Lint: `docker compose -f compose.dev.yaml exec frontend npm run lint`
  - The dev stack is running (frontend :5173, API :8001, postgres :5433).
- Import style: path aliases (`@/...`), never relative `../../../`; cross-feature imports only through feature barrels (`@/features/properties`, `@/features/content`); `@/api/*` and `@/utils/*` are shared and importable anywhere.
- Query keys only via factories in `frontend/src/hooks/queryKeys.ts` — no literal query-key arrays in components/hooks.
- Never `window.confirm`/`alert`/`prompt`; toasts via `useNotificationStore.getState().error(title, message?)`.
- `useTaskActions` public API and `useTaskActions.test.ts` assertions must keep passing **unmodified** (Task 1 refactors internals only, preserving exact `setProperty.mutate` call shapes).
- Task statuses (DB line names, exact casing): `Backlog, Pending, Doing, Reviewing, Done, Cancelled` (`constants/systemProperties.ts` `TASK_STATUSES`).
- Day UUIDs are deterministic: `00000000-0000-0000-00dd-YYYYMMDD0000`; helpers in `@/utils/dateUuid` (`getTodayDayUuid`, `dateToDayUuid`, `dayUuidToDate`, `compareDayUuids`, `dayUuidToDisplay`, `isDayUuid`).
- Date property values in `node.properties_uuid` are day-UUID strings keyed by property UUID; selection values are option-UUID strings (see `resolveTaskStatus` in `features/content/hooks/useRuntimeSync.ts:158-166`).

---

### Task 1: Popup data layer (queries, query keys, status hook, popup-data hook)

**Files:**
- Modify: `frontend/src/constants/systemProperties.ts` (add `TASK_POPUP_HIDDEN_STATUSES` after line 38)
- Modify: `frontend/src/utils/taskQueries.ts` (append popup builders)
- Modify: `frontend/src/hooks/queryKeys.ts:171-177` (add `popup` to `taskKeys`; keep `view` — removed in Task 3)
- Create: `frontend/src/features/tasks/hooks/taskStatusShared.ts`
- Create: `frontend/src/features/tasks/hooks/useSetTaskStatus.ts`
- Create: `frontend/src/features/tasks/hooks/useTasksPopupData.ts`
- Modify: `frontend/src/features/tasks/hooks/useTaskActions.ts` (import shared helpers + re-export `TaskStatus`; delete local copies; **bodies unchanged**)
- Test: `frontend/src/utils/taskQueries.popup.test.ts` (new)
- Test: `frontend/src/features/tasks/hooks/useSetTaskStatus.test.ts` (new)
- Test: `frontend/src/features/tasks/hooks/useTasksPopupData.test.ts` (new)

**Interfaces:**
- Consumes: `createClassCondition`, `createPropertyCondition` (`@/types/queryAST`); `SYSTEM_CLASS_UUIDS`, `SYSTEM_PROPERTY_UUIDS`, `TASK_CLOSED_STATUSES` (`@/constants/systemProperties`); `executeQuery(request: QueryExecuteRequest): Promise<{ nodes: Node[]; total_count?: number; ... }>` (`@/api/nodeViews`); `useSetNodeProperty`, `useProperties` (`@/features/properties`); `getOperationRuntime` (`@/runtime`), `getNode` (`@/runtime/graphHelpers`), `upsertNodes` (`@/runtime/eventBus`); `queryClient` (`@/lib/queryClient`); `propertyKeys` (`@/hooks/queryKeys`).
- Produces (used by Tasks 2-3):
  - `TASK_POPUP_HIDDEN_STATUSES: Set<string>` = `{'Backlog','Reviewing'}`
  - `buildPopupOverdueQueryAST()`, `buildPopupTodayQueryAST()`, `buildPopupUpcomingQueryAST(days = 7)`, `buildPopupCompletedTodayQueryAST()` — all `() => QueryAST`
  - `taskKeys.popup(section: string)` → `['tasks', 'popup', section]`
  - `type TaskStatus` (now defined in `taskStatusShared.ts`, re-exported by `useTaskActions.ts` — public API unchanged)
  - `useSetTaskStatus(): (nodeUuid: string, status: TaskStatus | null) => void`
  - `type PopupSection = 'overdue' | 'today' | 'upcoming' | 'completed'`
  - `interface PopupSectionData { nodes: Node[]; totalCount: number }`
  - `getPopupQueryForSection(section: PopupSection): QueryExecuteRequest`
  - `getTaskDateUuid(node: Node): string | null`
  - `useTasksPopupData(): { sections: Record<PopupSection, PopupSectionData>; dueCount: number; isLoading: boolean; isError: boolean; refetch: () => void }`

- [ ] **Step 1: Add the hidden-statuses constant**

In `frontend/src/constants/systemProperties.ts`, immediately after `TASK_CLOSED_STATUSES` (line 38):

```ts
/** Open statuses hidden from the tasks popup (still open, but not actionable there). */
export const TASK_POPUP_HIDDEN_STATUSES = new Set<string>(['Backlog', 'Reviewing']);
```

- [ ] **Step 2: Write the failing popup-builder tests**

Create `frontend/src/utils/taskQueries.popup.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  buildPopupOverdueQueryAST,
  buildPopupTodayQueryAST,
  buildPopupUpcomingQueryAST,
  buildPopupCompletedTodayQueryAST,
} from './taskQueries';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';
import { getTodayDayUuid } from '@/utils/dateUuid';
import type { QueryAST, PropertyCondition } from '@/types/queryAST';

/** Recursively collect all property conditions in an AST. */
function collectConditions(ast: QueryAST): PropertyCondition[] {
  const out: PropertyCondition[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string; children?: unknown[] };
    if (n.type === 'property_condition') out.push(n as unknown as PropertyCondition);
    n.children?.forEach(walk);
  };
  walk(ast.root_group);
  return out;
}

function statusConditions(ast: QueryAST): PropertyCondition[] {
  return collectConditions(ast).filter((c) => c.property === 'task_status');
}

describe('popup task query ASTs', () => {
  it.each([
    ['overdue', buildPopupOverdueQueryAST],
    ['today', buildPopupTodayQueryAST],
    ['upcoming', buildPopupUpcomingQueryAST],
  ] as const)('%s shows only Pending/Doing tasks', (_name, build) => {
    const excluded = statusConditions(build())
      .filter((c) => c.operator === 'not_equals')
      .map((c) => c.value);
    expect(excluded).toEqual(expect.arrayContaining(['Done', 'Cancelled', 'Backlog', 'Reviewing']));
  });

  it('overdue is bounded before today on scheduled or deadline', () => {
    const conds = collectConditions(buildPopupOverdueQueryAST());
    const bounds = conds.filter((c) => c.operator === 'less_than').map((c) => [c.property, c.value]);
    expect(bounds).toContainEqual(['task_scheduled', getTodayDayUuid()]);
    expect(bounds).toContainEqual(['task_deadline', getTodayDayUuid()]);
  });

  it('upcoming is bounded after today and within 7 days by default', () => {
    const conds = collectConditions(buildPopupUpcomingQueryAST());
    const greater = conds.filter((c) => c.operator === 'greater_than').map((c) => c.value);
    expect(greater).toContain(getTodayDayUuid());
    expect(conds.some((c) => c.operator === 'less_than')).toBe(true);
  });

  it('completed-today selects Done tasks closed today', () => {
    const conds = collectConditions(buildPopupCompletedTodayQueryAST());
    expect(conds).toContainEqual(
      expect.objectContaining({ property: 'task_status', operator: 'equals', value: 'Done' }),
    );
    expect(conds).toContainEqual(
      expect.objectContaining({
        property: 'task_closed_date',
        operator: 'equals',
        value: getTodayDayUuid(),
        property_uuid: SYSTEM_PROPERTY_UUIDS.task_closed_date,
      }),
    );
    expect(statusConditions(buildPopupCompletedTodayQueryAST()).some((c) => c.operator === 'not_equals')).toBe(false);
  });
});
```

Note for the implementer: verify the `PropertyCondition` field names (`property`, `operator`, `value`, `property_uuid`) against `frontend/src/types/queryAST.ts` `createPropertyCondition(name, operator, value, type, uuid)` before finalizing the test — if the emitted field names differ, adapt the assertions to the real shape. Verify the same way the condition `type` discriminant is spelled (e.g. `'property_condition'`).

- [ ] **Step 3: Run tests to verify they fail**

Run: `docker compose -f compose.dev.yaml exec frontend npx vitest run src/utils/taskQueries.popup.test.ts`
Expected: FAIL — `buildPopupOverdueQueryAST is not a function` (or import error).

- [ ] **Step 4: Implement the popup builders**

Append to `frontend/src/utils/taskQueries.ts`. Also update the file-header comment to mention the popup builders (they additionally exclude Backlog/Reviewing).

```ts
import {
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  TASK_CLOSED_STATUSES,
  TASK_POPUP_HIDDEN_STATUSES,
} from '@/constants/systemProperties';

/**
 * Conditions for the tasks popup: open tasks only (not Done/Cancelled) and
 * only actionable statuses (not Backlog/Reviewing).
 */
function popupOpenConditions(): PropertyCondition[] {
  return [
    ...notCompletedConditions(),
    ...Array.from(TASK_POPUP_HIDDEN_STATUSES).map((status) =>
      createPropertyCondition(
        'task_status',
        'not_equals',
        status,
        'select',
        SYSTEM_PROPERTY_UUIDS.task_status,
      )
    ),
  ];
}

/** Date OR-group: (prop is_not_empty AND prop < dayUuid) for scheduled or deadline. */
function beforeDayOrGroup(dayUuid: string) {
  return {
    type: 'group' as const,
    logic: 'OR' as const,
    children: [
      {
        type: 'group' as const,
        logic: 'AND' as const,
        children: [
          createPropertyCondition('task_scheduled', 'is_not_empty', undefined, 'date', SYSTEM_PROPERTY_UUIDS.task_scheduled),
          createPropertyCondition('task_scheduled', 'less_than', dayUuid, 'date', SYSTEM_PROPERTY_UUIDS.task_scheduled),
        ],
      },
      {
        type: 'group' as const,
        logic: 'AND' as const,
        children: [
          createPropertyCondition('task_deadline', 'is_not_empty', undefined, 'date', SYSTEM_PROPERTY_UUIDS.task_deadline),
          createPropertyCondition('task_deadline', 'less_than', dayUuid, 'date', SYSTEM_PROPERTY_UUIDS.task_deadline),
        ],
      },
    ],
  };
}

function popupTaskAST(dateClause: unknown): QueryAST {
  return {
    type: 'query',
    version: '1.0',
    scope: { type: 'scope', scope_type: 'entire_workspace' },
    root_group: {
      type: 'group',
      logic: 'AND',
      children: [
        createClassCondition(SYSTEM_CLASS_UUIDS.task),
        ...popupOpenConditions(),
        dateClause,
      ],
    },
  } as QueryAST;
}

/** Overdue for the popup: scheduled or deadlined before today, Pending/Doing only. */
export function buildPopupOverdueQueryAST(): QueryAST {
  return popupTaskAST(beforeDayOrGroup(getTodayDayUuid()));
}

/** Today for the popup: scheduled or deadlined exactly today, Pending/Doing only. */
export function buildPopupTodayQueryAST(): QueryAST {
  const todayUuid = getTodayDayUuid();
  return popupTaskAST({
    type: 'group',
    logic: 'OR',
    children: [
      createPropertyCondition('task_scheduled', 'equals', todayUuid, 'date', SYSTEM_PROPERTY_UUIDS.task_scheduled),
      createPropertyCondition('task_deadline', 'equals', todayUuid, 'date', SYSTEM_PROPERTY_UUIDS.task_deadline),
    ],
  });
}

/** Upcoming for the popup: scheduled or deadlined within the next `days` days. */
export function buildPopupUpcomingQueryAST(days = 7): QueryAST {
  const todayUuid = getTodayDayUuid();
  const future = new Date();
  future.setDate(future.getDate() + days + 1);
  const futureUuid = dateToDayUuid(future);
  return popupTaskAST({
    type: 'group',
    logic: 'OR',
    children: ['task_scheduled', 'task_deadline'].map((prop) => ({
      type: 'group' as const,
      logic: 'AND' as const,
      children: [
        createPropertyCondition(prop, 'is_not_empty', undefined, 'date', SYSTEM_PROPERTY_UUIDS[prop as 'task_scheduled' | 'task_deadline']),
        createPropertyCondition(prop, 'greater_than', todayUuid, 'date', SYSTEM_PROPERTY_UUIDS[prop as 'task_scheduled' | 'task_deadline']),
        createPropertyCondition(prop, 'less_than', futureUuid, 'date', SYSTEM_PROPERTY_UUIDS[prop as 'task_scheduled' | 'task_deadline']),
      ],
    })),
  });
}

/** Completed today for the popup: Done tasks whose closed date is today. */
export function buildPopupCompletedTodayQueryAST(): QueryAST {
  const todayUuid = getTodayDayUuid();
  return {
    type: 'query',
    version: '1.0',
    scope: { type: 'scope', scope_type: 'entire_workspace' },
    root_group: {
      type: 'group',
      logic: 'AND',
      children: [
        createClassCondition(SYSTEM_CLASS_UUIDS.task),
        createPropertyCondition('task_status', 'equals', 'Done', 'select', SYSTEM_PROPERTY_UUIDS.task_status),
        createPropertyCondition('task_closed_date', 'equals', todayUuid, 'date', SYSTEM_PROPERTY_UUIDS.task_closed_date),
      ],
    },
  };
}
```

`SYSTEM_PROPERTY_UUIDS.task_closed_date` already exists (`constants/systemProperties.ts:24`).

- [ ] **Step 5: Run the builder tests — verify pass**

Run: `docker compose -f compose.dev.yaml exec frontend npx vitest run src/utils/taskQueries.popup.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Add the popup query key**

In `frontend/src/hooks/queryKeys.ts`, inside `taskKeys` (after line 175, keeping `view`):

```ts
  popup: (section: string) => [...taskKeys.all, 'popup', section] as const,
```

- [ ] **Step 7: Extract shared status helpers**

Create `frontend/src/features/tasks/hooks/taskStatusShared.ts`:

```ts
import { getOperationRuntime } from '@/runtime';
import { getNode } from '@/runtime/graphHelpers';
import { upsertNodes } from '@/runtime/eventBus';
import { queryClient } from '@/lib/queryClient';
import { propertyKeys, taskKeys } from '@/hooks/queryKeys';
import { SYSTEM_PROPERTY_UUIDS, TASK_STATUSES } from '@/constants/systemProperties';

/** All known task statuses (matches backend TASK_STATUS_OPTIONS). */
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Optimistically mirror a task-status change into the runtime so the status
 * badge (read from the runtime projection in BlockAfterContent) updates
 * immediately, without waiting for a server refetch.
 */
export function setRuntimeTaskStatus(nodeUuid: string, status: TaskStatus | null): void {
  const runtime = getOperationRuntime();
  const gn = getNode(runtime, nodeUuid);
  if (gn) upsertNodes([{ ...gn, taskStatus: status }]);
}

/**
 * Resolve the property UUID and option UUID for a given task status name.
 * Looks up from the TanStack Query property cache.
 */
export function resolveTaskStatusIds(
  statusName: TaskStatus
): { propertyId: string; optionId: string } | null {
  const allProperties = queryClient.getQueryData<
    { uuid: string; options?: { uuid: string; name: string }[] }[]
  >(propertyKeys.lists());
  const statusProp = allProperties?.find(
    (p) => p.uuid === SYSTEM_PROPERTY_UUIDS.task_status
  );
  if (!statusProp) return null;
  const option = statusProp.options?.find((o) => o.name === statusName);
  if (!option) return null;
  return { propertyId: statusProp.uuid, optionId: option.uuid };
}

/** Invalidate all tasks-popup section queries (badge + list refresh). */
export function invalidateTaskPopupQueries(): void {
  queryClient.invalidateQueries({ queryKey: [...taskKeys.all, 'popup'] });
}
```

- [ ] **Step 8: Point `useTaskActions` at the shared helpers (behavior unchanged)**

In `frontend/src/features/tasks/hooks/useTaskActions.ts`:
- Delete the local `setRuntimeTaskStatus` (lines 46-55), `resolveTaskStatusIds` (lines 57-74), and the `TaskStatus` type definition (line 20).
- Add imports: `import { setRuntimeTaskStatus, resolveTaskStatusIds } from './taskStatusShared';` and `import type { TaskStatus } from './taskStatusShared';` plus `export type { TaskStatus } from './taskStatusShared';` (keeps the barrel re-export working).
- Keep `TASK_STATUSES` imported from `@/constants/systemProperties` (still used at line 43); drop now-unused imports (`getOperationRuntime`, `getNode`, `upsertNodes`, `queryClient`, `propertyKeys` — check each against remaining code: `cycleTaskStatus` still uses `getOperationRuntime`/`getNode` at lines 154-156, so those two stay).
- Do **not** change any function body or the `setProperty.mutate({...})` single-argument call shapes.

Run: `docker compose -f compose.dev.yaml exec frontend npx vitest run src/features/tasks/hooks/useTaskActions.test.ts`
Expected: PASS, unmodified test file.

- [ ] **Step 9: Write the failing `useSetTaskStatus` test**

Create `frontend/src/features/tasks/hooks/useSetTaskStatus.test.ts`. Follow the exact mock pattern of `useTaskActions.test.ts` in the same directory (fresh `OperationRuntime` per test, `resetRuntimeEventBus(runtime)`, `vi.mock('@/features/properties')`, seeded `queryClient.setQueryData(propertyKeys.lists(), [TASK_STATUS_PROPERTY])`, `renderHook` with a QueryClient wrapper — copy that file's setup; read it first):

```ts
// After copying the setup from useTaskActions.test.ts:

it('sets a task status via the resolved property/option ids and mirrors it to the runtime', () => {
  // seed a runtime node 'task-1' with taskStatus 'Pending' (same helper as useTaskActions.test.ts)
  const { result } = renderHook(() => useSetTaskStatus(), { wrapper });
  act(() => result.current('task-1', 'Done'));
  expect(setPropertyMutate).toHaveBeenCalledWith(
    { nodeUuid: 'task-1', propertyId: TASK_STATUS_PROPERTY.uuid, value: 'opt-done-uuid' },
    expect.objectContaining({ onSettled: expect.any(Function) }),
  );
  expect(getNode(getOperationRuntime(), 'task-1')?.taskStatus).toBe('Done');
});

it('clears a task status with value null', () => {
  const { result } = renderHook(() => useSetTaskStatus(), { wrapper });
  act(() => result.current('task-1', null));
  expect(setPropertyMutate).toHaveBeenCalledWith(
    { nodeUuid: 'task-1', propertyId: SYSTEM_PROPERTY_UUIDS.task_status, value: null },
    expect.objectContaining({ onSettled: expect.any(Function) }),
  );
  expect(getNode(getOperationRuntime(), 'task-1')?.taskStatus).toBeNull();
});

it('invalidates the tasks popup queries on settle', () => {
  const spy = vi.spyOn(queryClient, 'invalidateQueries');
  const { result } = renderHook(() => useSetTaskStatus(), { wrapper });
  act(() => result.current('task-1', 'Done'));
  const onSettled = setPropertyMutate.mock.calls[0][1].onSettled as () => void;
  act(() => onSettled());
  expect(spy).toHaveBeenCalledWith({ queryKey: ['tasks', 'popup'] });
});
```

- [ ] **Step 10: Run it — verify fail**

Run: `docker compose -f compose.dev.yaml exec frontend npx vitest run src/features/tasks/hooks/useSetTaskStatus.test.ts`
Expected: FAIL — `useSetTaskStatus is not a function`.

- [ ] **Step 11: Implement `useSetTaskStatus`**

Create `frontend/src/features/tasks/hooks/useSetTaskStatus.ts`:

```ts
import { useCallback } from 'react';
import { useSetNodeProperty, useProperties } from '@/features/properties';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';
import {
  setRuntimeTaskStatus,
  resolveTaskStatusIds,
  invalidateTaskPopupQueries,
  type TaskStatus,
} from './taskStatusShared';

/**
 * Set or clear the task status of any node by uuid.
 * Mirrors the change optimistically into the runtime (badge updates instantly)
 * and invalidates the tasks popup queries once the mutation settles.
 */
export function useSetTaskStatus() {
  // Ensure properties are cached so resolveTaskStatusIds works
  useProperties();
  const setProperty = useSetNodeProperty();

  return useCallback(
    (nodeUuid: string, status: TaskStatus | null) => {
      if (!nodeUuid) {
        console.warn('[useSetTaskStatus] Node has no UUID yet');
        return;
      }
      if (status === null) {
        setProperty.mutate(
          { nodeUuid, propertyId: SYSTEM_PROPERTY_UUIDS.task_status, value: null },
          { onSettled: invalidateTaskPopupQueries },
        );
        setRuntimeTaskStatus(nodeUuid, null);
        return;
      }
      const ids = resolveTaskStatusIds(status);
      if (!ids) {
        console.warn('[useSetTaskStatus] Could not resolve task status property IDs');
        return;
      }
      setProperty.mutate(
        { nodeUuid, propertyId: ids.propertyId, value: ids.optionId },
        { onSettled: invalidateTaskPopupQueries },
      );
      setRuntimeTaskStatus(nodeUuid, status);
    },
    [setProperty],
  );
}
```

- [ ] **Step 12: Run it — verify pass**

Run: `docker compose -f compose.dev.yaml exec frontend npx vitest run src/features/tasks/hooks/useSetTaskStatus.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 13: Write the failing `useTasksPopupData` tests**

Create `frontend/src/features/tasks/hooks/useTasksPopupData.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { getPopupQueryForSection, getTaskDateUuid, useTasksPopupData } from './useTasksPopupData';
import { executeQuery } from '@/api/nodeViews';

vi.mock('@/api/nodeViews', () => ({ executeQuery: vi.fn() }));
const executeQueryMock = vi.mocked(executeQuery);

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('getPopupQueryForSection', () => {
  it.each(['overdue', 'today', 'upcoming', 'completed'] as const)(
    'requests properties for the %s section',
    (section) => {
      expect(getPopupQueryForSection(section).include_properties).toBe(true);
    },
  );

  it('caps upcoming at 20 and completed at 10 rows', () => {
    expect(getPopupQueryForSection('upcoming').limit).toBe(20);
    expect(getPopupQueryForSection('completed').limit).toBe(10);
    expect(getPopupQueryForSection('overdue').limit).toBeUndefined();
    expect(getPopupQueryForSection('today').limit).toBeUndefined();
  });
});

describe('getTaskDateUuid', () => {
  it('prefers scheduled over deadline and ignores non-day-uuid values', () => {
    const node = {
      properties_uuid: {
        '00000000-0000-0000-0003-000000000003': '00000000-0000-0000-00dd-202607200000',
        '00000000-0000-0000-0003-000000000002': '00000000-0000-0000-00dd-202607180000',
      },
    } as never;
    expect(getTaskDateUuid(node)).toBe('00000000-0000-0000-00dd-202607200000');
    expect(getTaskDateUuid({ properties_uuid: { '00000000-0000-0000-0003-000000000003': 42 } } as never)).toBeNull();
    expect(getTaskDateUuid({ properties_uuid: undefined } as never)).toBeNull();
  });
});

describe('useTasksPopupData', () => {
  beforeEach(() => {
    executeQueryMock.mockReset();
    executeQueryMock.mockImplementation(async (req) => {
      const ast = JSON.stringify(req.query_ast);
      if (ast.includes('task_closed_date')) return { nodes: [], total_count: 2 };
      if (ast.includes('less_than') && !ast.includes('greater_than')) return { nodes: [{ uuid: 'o1' }], total_count: 5 };
      if (ast.includes('greater_than')) return { nodes: [{ uuid: 'u1' }], total_count: 7 };
      return { nodes: [{ uuid: 't1' }], total_count: 3 }; // today: equals only
    });
  });

  it('derives the due count from overdue + today totals', async () => {
    const { result } = renderHook(() => useTasksPopupData(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.dueCount).toBe(8); // 5 overdue + 3 today
    expect(result.current.sections.upcoming.totalCount).toBe(7);
    expect(result.current.sections.completed.totalCount).toBe(2);
    expect(executeQueryMock).toHaveBeenCalledTimes(4);
  });
});
```

- [ ] **Step 14: Run it — verify fail**

Run: `docker compose -f compose.dev.yaml exec frontend npx vitest run src/features/tasks/hooks/useTasksPopupData.test.ts`
Expected: FAIL — module does not export `useTasksPopupData`.

- [ ] **Step 15: Implement `useTasksPopupData`**

Create `frontend/src/features/tasks/hooks/useTasksPopupData.ts`:

```ts
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { executeQuery } from '@/api/nodeViews';
import { taskKeys } from '@/hooks/queryKeys';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';
import { compareDayUuids, isDayUuid } from '@/utils/dateUuid';
import {
  buildPopupOverdueQueryAST,
  buildPopupTodayQueryAST,
  buildPopupUpcomingQueryAST,
  buildPopupCompletedTodayQueryAST,
} from '@/utils/taskQueries';
import type { QueryExecuteRequest } from '@/types/nodeView';
import type { Node } from '@/types/api';

export type PopupSection = 'overdue' | 'today' | 'upcoming' | 'completed';

export interface PopupSectionData {
  nodes: Node[];
  totalCount: number;
}

export function getPopupQueryForSection(section: PopupSection): QueryExecuteRequest {
  switch (section) {
    case 'overdue':
      return { query_ast: buildPopupOverdueQueryAST(), include_properties: true };
    case 'today':
      return { query_ast: buildPopupTodayQueryAST(), include_properties: true };
    case 'upcoming':
      return { query_ast: buildPopupUpcomingQueryAST(7), include_properties: true, limit: 20 };
    case 'completed':
      return { query_ast: buildPopupCompletedTodayQueryAST(), include_properties: true, limit: 10 };
  }
}

/**
 * Best-effort date for a task row: scheduled day UUID, else deadline day UUID.
 * Returns null when neither property is a day-UUID string.
 */
export function getTaskDateUuid(node: Node): string | null {
  const props = node.properties_uuid as Record<string, unknown> | undefined;
  const scheduled = props?.[SYSTEM_PROPERTY_UUIDS.task_scheduled];
  if (typeof scheduled === 'string' && isDayUuid(scheduled)) return scheduled;
  const deadline = props?.[SYSTEM_PROPERTY_UUIDS.task_deadline];
  if (typeof deadline === 'string' && isDayUuid(deadline)) return deadline;
  return null;
}

function byTaskDateAsc(a: Node, b: Node): number {
  return compareDayUuids(getTaskDateUuid(a) ?? '', getTaskDateUuid(b) ?? '');
}

export function useTasksPopupData() {
  const overdue = useQuery({
    queryKey: taskKeys.popup('overdue'),
    queryFn: () => executeQuery(getPopupQueryForSection('overdue')),
    staleTime: 30_000,
  });
  const today = useQuery({
    queryKey: taskKeys.popup('today'),
    queryFn: () => executeQuery(getPopupQueryForSection('today')),
    staleTime: 30_000,
  });
  const upcoming = useQuery({
    queryKey: taskKeys.popup('upcoming'),
    queryFn: () => executeQuery(getPopupQueryForSection('upcoming')),
    staleTime: 30_000,
  });
  const completed = useQuery({
    queryKey: taskKeys.popup('completed'),
    queryFn: () => executeQuery(getPopupQueryForSection('completed')),
    staleTime: 30_000,
  });

  const sections = useMemo<Record<PopupSection, PopupSectionData>>(
    () => ({
      overdue: {
        nodes: [...(overdue.data?.nodes ?? [])].sort(byTaskDateAsc),
        totalCount: overdue.data?.total_count ?? 0,
      },
      today: {
        nodes: today.data?.nodes ?? [],
        totalCount: today.data?.total_count ?? 0,
      },
      upcoming: {
        nodes: [...(upcoming.data?.nodes ?? [])].sort(byTaskDateAsc),
        totalCount: upcoming.data?.total_count ?? 0,
      },
      completed: {
        nodes: completed.data?.nodes ?? [],
        totalCount: completed.data?.total_count ?? 0,
      },
    }),
    [overdue.data, today.data, upcoming.data, completed.data],
  );

  const dueCount = sections.overdue.totalCount + sections.today.totalCount;
  const isLoading = overdue.isLoading || today.isLoading || upcoming.isLoading || completed.isLoading;
  const isError = overdue.isError || today.isError || upcoming.isError || completed.isError;
  const refetch = () => {
    void overdue.refetch();
    void today.refetch();
    void upcoming.refetch();
    void completed.refetch();
  };

  return { sections, dueCount, isLoading, isError, refetch };
}
```

- [ ] **Step 16: Run it — verify pass, then full regression + gates**

Run:
```
docker compose -f compose.dev.yaml exec frontend npx vitest run src/features/tasks/hooks/ src/utils/
docker compose -f compose.dev.yaml exec frontend npx tsc -b --noEmit
docker compose -f compose.dev.yaml exec frontend npm run lint
```
Expected: all tests PASS (incl. the untouched `useTaskActions.test.ts`), tsc clean, lint 0 errors.

- [ ] **Step 17: Commit**

```bash
git add frontend/src/constants/systemProperties.ts frontend/src/utils/taskQueries.ts frontend/src/utils/taskQueries.popup.test.ts frontend/src/hooks/queryKeys.ts frontend/src/features/tasks/hooks/taskStatusShared.ts frontend/src/features/tasks/hooks/useSetTaskStatus.ts frontend/src/features/tasks/hooks/useSetTaskStatus.test.ts frontend/src/features/tasks/hooks/useTasksPopupData.ts frontend/src/features/tasks/hooks/useTasksPopupData.test.ts frontend/src/features/tasks/hooks/useTaskActions.ts
git commit -m "feat(tasks): popup data layer — section queries, status setter, popup-data hook"
```

---

### Task 2: Popup UI, quick-add, modal state, TopBar trigger + badge

**Files:**
- Modify: `frontend/src/stores/modalStore.ts` (add tasks-popup state; mirror the calendar lines 33-34/82-83)
- Create: `frontend/src/features/tasks/hooks/useQuickAddTask.ts`
- Create: `frontend/src/features/tasks/components/TaskPopupRow.tsx`
- Create: `frontend/src/features/tasks/components/TasksPopupSection.tsx`
- Create: `frontend/src/features/tasks/components/TasksPopup.tsx`
- Create: `frontend/src/features/tasks/components/TasksPopup.css`
- Modify: `frontend/src/features/layout/components/TopBar.tsx` (tasks button + popup next to the calendar block, ~lines 315-333)
- Modify: `frontend/src/features/tasks/index.ts` (barrel: export the new hooks/components)
- Test: `frontend/src/features/tasks/components/TasksPopup.test.tsx` (new)
- Test: `frontend/src/features/tasks/hooks/useQuickAddTask.test.ts` (new)

**Interfaces:**
- Consumes (from Task 1): `useTasksPopupData()` → `{ sections, dueCount, isLoading, isError, refetch }`; `PopupSection`, `PopupSectionData`, `getTaskDateUuid`; `useSetTaskStatus()` → `(nodeUuid, status: TaskStatus | null) => void`; `taskKeys.popup`.
- Consumes (existing): `useViewportFlip(anchorRef, isOpen, { popupRef, popupHeight, fixed: true })` → `{ top, left } | null` (`@/hooks/useViewportFlip`); `Button` + `ButtonBadge` (`@/components/ui`), `Icon` (`@/components/ui`); `useCreateNode()` (`@/features/content`) — variables include `{ name, parent_uuid?, class_uuids? }` (verify against `useCreateNode.ts`; `TasksView.tsx:61` passes `class_uuids`); `useSetNodeProperty` (`@/features/properties`); `nodesApi.getOrCreateDaily(dateStr: string): Promise<Node>` (`@/api/nodes`); `useNavigationStore((s) => s.openNode)` → `(nodeUuid: string) => void`; `useNotificationStore.getState().error(title, message?)` (`@/stores/notificationStore`); `getTodayDayUuid`, `dayUuidToDate` (`@/utils/dateUuid`); `parseAST`, `stringifyAST`, `StringifyMode` (mirror the imports in `features/content/hooks/useRuntimeSync.ts:48,58`).
- Produces:
  - modalStore: `isTasksPopupOpen: boolean`, `setTasksPopupOpen(open: boolean): void`, `toggleTasksPopup(): void`
  - `useQuickAddTask(): { quickAdd: (name: string) => Promise<void>; isAdding: boolean }`
  - `TasksPopup({ isOpen, onClose, anchorRef }: { isOpen: boolean; onClose: () => void; anchorRef: React.RefObject<HTMLElement | null> })`
  - TopBar tasks button with `badges=[{ count: dueCount, position: 'top-right' }]` when `dueCount > 0`

- [ ] **Step 1: Add modal-store state**

In `frontend/src/stores/modalStore.ts`: interface (next to `isCalendarOpen` / `setCalendarOpen` / `toggleCalendar`):

```ts
isTasksPopupOpen: boolean;
setTasksPopupOpen: (open: boolean) => void;
toggleTasksPopup: () => void;
```

Implementation (next to the calendar ones):

```ts
isTasksPopupOpen: false,
setTasksPopupOpen: (open) => set({ isTasksPopupOpen: open }),
toggleTasksPopup: () => set((s) => ({ isTasksPopupOpen: !s.isTasksPopupOpen })),
```

- [ ] **Step 2: Write the failing quick-add test**

Create `frontend/src/features/tasks/hooks/useQuickAddTask.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useQuickAddTask } from './useQuickAddTask';
import { nodesApi } from '@/api/nodes';

const mutateAsyncMock = vi.fn();
const setPropertyMutateMock = vi.fn();

vi.mock('@/api/nodes', () => ({
  nodesApi: { getOrCreateDaily: vi.fn() },
}));
vi.mock('@/features/content', () => ({
  useCreateNode: () => ({ mutateAsync: mutateAsyncMock }),
}));
vi.mock('@/features/properties', () => ({
  useSetNodeProperty: () => ({ mutate: setPropertyMutateMock }),
}));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useQuickAddTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(nodesApi.getOrCreateDaily).mockResolvedValue({ uuid: 'daily-uuid' } as never);
    mutateAsyncMock.mockResolvedValue({ uuid: 'new-task-uuid' });
  });

  it('creates a task block on today\'s daily page and schedules it for today', async () => {
    const { result } = renderHook(() => useQuickAddTask(), { wrapper });
    await act(async () => { await result.current.quickAdd('Buy milk'); });
    expect(mutateAsyncMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Buy milk', parent_uuid: 'daily-uuid' }),
    );
    expect(setPropertyMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ nodeUuid: 'new-task-uuid', value: expect.stringMatching(/^00000000-0000-0000-00dd-/) }),
    );
  });

  it('ignores empty names', async () => {
    const { result } = renderHook(() => useQuickAddTask(), { wrapper });
    await act(async () => { await result.current.quickAdd('   '); });
    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });

  it('reports failures via toast and rethrows', async () => {
    mutateAsyncMock.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useQuickAddTask(), { wrapper });
    await expect(act(async () => { await result.current.quickAdd('X'); })).rejects.toThrow('boom');
    const { useNotificationStore } = await import('@/stores/notificationStore');
    expect(useNotificationStore.getState().notifications.some((n) => n.type === 'error')).toBe(true);
  });
});
```

(If `class_uuids` needs asserting: `expect(mutateAsyncMock).toHaveBeenCalledWith(expect.objectContaining({ class_uuids: [expect.any(String)] }))`.)

- [ ] **Step 3: Run it — verify fail**

Run: `docker compose -f compose.dev.yaml exec frontend npx vitest run src/features/tasks/hooks/useQuickAddTask.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement `useQuickAddTask`**

Create `frontend/src/features/tasks/hooks/useQuickAddTask.ts`:

```ts
import { useCallback, useState } from 'react';
import { nodesApi } from '@/api/nodes';
import { useCreateNode } from '@/features/content';
import { useSetNodeProperty } from '@/features/properties';
import { useNotificationStore } from '@/stores/notificationStore';
import { queryClient } from '@/lib/queryClient';
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';
import { getTodayDayUuid } from '@/utils/dateUuid';
import { invalidateTaskPopupQueries } from './taskStatusShared';

/** Local ISO date (YYYY-MM-DD), matching the CalendarPopup wrapper's format. */
function toIsoLocal(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Quick-add a task from the popup: creates a task block on today's daily
 * journal page (Status=Pending comes from backend class-property defaults)
 * and schedules it for today so it lands in the popup's Today section.
 */
export function useQuickAddTask() {
  const [isAdding, setIsAdding] = useState(false);
  const createNode = useCreateNode();
  const setProperty = useSetNodeProperty();

  const quickAdd = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (!trimmed || isAdding) return;
      setIsAdding(true);
      try {
        const daily = await nodesApi.getOrCreateDaily(toIsoLocal(new Date()));
        const node = await createNode.mutateAsync({
          name: trimmed,
          parent_uuid: daily.uuid,
          class_uuids: [SYSTEM_CLASS_UUIDS.task],
        });
        setProperty.mutate({
          nodeUuid: node.uuid,
          propertyId: SYSTEM_PROPERTY_UUIDS.task_scheduled,
          value: getTodayDayUuid(),
        });
        invalidateTaskPopupQueries();
      } catch (err) {
        useNotificationStore
          .getState()
          .error('Failed to add task', err instanceof Error ? err.message : undefined);
        throw err;
      } finally {
        setIsAdding(false);
      }
    },
    [createNode, setProperty, isAdding],
  );

  return { quickAdd, isAdding };
}
```

Note for the implementer: verify `useCreateNode`'s variables type accepts `class_uuids` (`frontend/src/features/content/hooks/useCreateNode.ts`; `TasksView.tsx:61` passes it). Verify `SYSTEM_CLASS_UUIDS.task` exists in `@/constants/systemProperties`. If `frontend/src/features/content/components/CalendarPopup.tsx` imports `toIsoLocal` from a shared util, import from there instead of defining locally and delete the local copy. Remove any unused import (`taskKeys` is intentionally not imported here — `invalidateTaskPopupQueries` wraps it).

- [ ] **Step 5: Run quick-add tests — verify pass**

Run: `docker compose -f compose.dev.yaml exec frontend npx vitest run src/features/tasks/hooks/useQuickAddTask.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Write the failing popup component test**

Create `frontend/src/features/tasks/components/TasksPopup.test.tsx`. Mock the three task hooks and the viewport hook; drive the real `useNavigationStore` for `openNode` (pattern: `SidebarRail.test.tsx`):

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TasksPopup } from './TasksPopup';
import { useNavigationStore } from '@/stores';
import type { PopupSectionData } from '@/features/tasks/hooks/useTasksPopupData';

const setTaskStatusMock = vi.fn();
const quickAddMock = vi.fn();

const sections: Record<string, PopupSectionData> = {
  overdue: { nodes: [{ uuid: 'o1', name: 'Overdue task', page_name: 'Journal' }], totalCount: 1 },
  today: { nodes: [{ uuid: 't1', name: 'Today task', page_name: 'Journal' }], totalCount: 1 },
  upcoming: {
    nodes: [{
      uuid: 'u1', name: 'Future task', page_name: 'Journal',
      properties_uuid: { '00000000-0000-0000-0003-000000000003': '00000000-0000-0000-00dd-202607200000' },
    }],
    totalCount: 1,
  },
  completed: { nodes: [{ uuid: 'c1', name: 'Done task', page_name: 'Journal' }], totalCount: 1 },
};

vi.mock('@/features/tasks/hooks/useTasksPopupData', () => ({
  useTasksPopupData: () => ({
    sections, dueCount: 2, isLoading: false, isError: false, refetch: vi.fn(),
  }),
  getTaskDateUuid: (n: { properties_uuid?: Record<string, string> }) =>
    n.properties_uuid?.['00000000-0000-0000-0003-000000000003'] ?? null,
}));
vi.mock('@/features/tasks/hooks/useSetTaskStatus', () => ({
  useSetTaskStatus: () => setTaskStatusMock,
}));
vi.mock('@/features/tasks/hooks/useQuickAddTask', () => ({
  useQuickAddTask: () => ({ quickAdd: quickAddMock, isAdding: false }),
}));
vi.mock('@/hooks/useViewportFlip', () => ({
  useViewportFlip: () => ({ top: 0, left: 0 }),
}));

function renderPopup(onClose = vi.fn()) {
  return render(
    <TasksPopup isOpen onClose={onClose} anchorRef={{ current: null }} />,
  );
}

describe('TasksPopup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useNavigationStore.setState({ openNode: vi.fn() } as never);
  });

  it('renders all four sections with their rows', () => {
    renderPopup();
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Upcoming')).toBeInTheDocument();
    expect(screen.getByText('Completed today')).toBeInTheDocument();
    expect(screen.getByText('Overdue task')).toBeInTheDocument();
    expect(screen.getByText('Done task')).toBeInTheDocument();
  });

  it('checking an open task sets it Done; unchecking a completed one sets Pending', () => {
    renderPopup();
    fireEvent.click(screen.getByRole('button', { name: /mark "today task" as done/i }));
    expect(setTaskStatusMock).toHaveBeenCalledWith('t1', 'Done');
    fireEvent.click(screen.getByRole('button', { name: /mark "done task" as not done/i }));
    expect(setTaskStatusMock).toHaveBeenCalledWith('c1', 'Pending');
  });

  it('clicking a task title navigates and closes', () => {
    const onClose = vi.fn();
    renderPopup(onClose);
    fireEvent.click(screen.getByText('Today task'));
    expect(useNavigationStore.getState().openNode).toHaveBeenCalledWith('t1');
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    renderPopup(onClose);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('quick-add submits the trimmed name and clears the input', () => {
    renderPopup();
    const input = screen.getByPlaceholderText(/add a task/i);
    fireEvent.change(input, { target: { value: '  New thing  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(quickAddMock).toHaveBeenCalledWith('  New thing  ');
    expect((input as HTMLInputElement).value).toBe('');
  });
});
```

Note for the implementer: `node.name` values here are plain strings; if the row renders through `parseAST`/`stringifyAST`, plain strings still round-trip to themselves. Cast fixture nodes `as never`/build a `makeNode` helper if the `Node` type complains. If `useNavigationStore` lacks `openNode` in its type at `setState`, cast as shown.

- [ ] **Step 7: Run it — verify fail**

Run: `docker compose -f compose.dev.yaml exec frontend npx vitest run src/features/tasks/components/TasksPopup.test.tsx`
Expected: FAIL — modules missing.

- [ ] **Step 8: Implement the row component**

Create `frontend/src/features/tasks/components/TaskPopupRow.tsx`:

```tsx
import { Icon } from '@/components/ui';
import { dayUuidToDate } from '@/utils/dateUuid';
import { getTaskDateUuid } from '@/features/tasks/hooks/useTasksPopupData';
import { parseAST } from '@/lib/parseAST';
import { stringifyAST, StringifyMode } from '@/lib/stringifyAST';
import type { Node } from '@/types/api';

interface TaskPopupRowProps {
  node: Node;
  completed?: boolean;
  showDate?: boolean;
  onToggle: (node: Node, completed: boolean) => void;
  onOpen: (node: Node) => void;
}

function plainName(node: Node): string {
  try {
    return stringifyAST(parseAST(node.name ?? ''), { mode: StringifyMode.TEXT_ONLY });
  } catch {
    return node.name ?? '';
  }
}

function shortDateLabel(dayUuid: string): string | null {
  const date = dayUuidToDate(dayUuid);
  if (!date) return null;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function TaskPopupRow({ node, completed = false, showDate = false, onToggle, onOpen }: TaskPopupRowProps) {
  const name = plainName(node);
  const dateUuid = showDate ? getTaskDateUuid(node) : null;
  const dateLabel = dateUuid ? shortDateLabel(dateUuid) : null;

  return (
    <li className={`tasks-popup__row${completed ? ' tasks-popup__row--completed' : ''}`}>
      <button
        type="button"
        className="tasks-popup__circle"
        aria-label={completed ? `Mark "${name}" as not done` : `Mark "${name}" as done`}
        aria-pressed={completed}
        onClick={() => onToggle(node, completed)}
      >
        <Icon
          path={completed ? 'mdi mdi-checkbox-marked-circle' : 'mdi mdi-checkbox-blank-circle-outline'}
          size={0.9}
        />
      </button>
      <button type="button" className="tasks-popup__title" onClick={() => onOpen(node)}>
        <span className="tasks-popup__name">{name}</span>
        <span className="tasks-popup__meta">
          {dateLabel && <span className="tasks-popup__date">{dateLabel}</span>}
          {node.page_name && <span className="tasks-popup__page">{node.page_name}</span>}
        </span>
      </button>
    </li>
  );
}
```

Note: verify the exact module paths/exports of `parseAST`/`stringifyAST`/`StringifyMode` against the imports at the top of `frontend/src/features/content/hooks/useRuntimeSync.ts` and copy those paths verbatim.

- [ ] **Step 9: Implement the section component**

Create `frontend/src/features/tasks/components/TasksPopupSection.tsx`:

```tsx
import type { Node } from '@/types/api';
import { TaskPopupRow } from './TaskPopupRow';

interface TasksPopupSectionProps {
  title: string;
  tone?: 'default' | 'danger' | 'muted';
  nodes: Node[];
  totalCount: number;
  completed?: boolean;
  showDates?: boolean;
  onToggle: (node: Node, completed: boolean) => void;
  onOpen: (node: Node) => void;
}

export function TasksPopupSection({
  title,
  tone = 'default',
  nodes,
  totalCount,
  completed = false,
  showDates = false,
  onToggle,
  onOpen,
}: TasksPopupSectionProps) {
  if (nodes.length === 0) return null;
  return (
    <section className="tasks-popup__section" aria-label={title}>
      <header className={`tasks-popup__section-title tasks-popup__section-title--${tone}`}>
        <span>{title}</span>
        <span className="tasks-popup__count">
          {totalCount > nodes.length ? `${nodes.length} of ${totalCount}` : totalCount}
        </span>
      </header>
      <ul className="tasks-popup__list">
        {nodes.map((node) => (
          <TaskPopupRow
            key={node.uuid}
            node={node}
            completed={completed}
            showDate={showDates}
            onToggle={onToggle}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 10: Implement the popup**

Create `frontend/src/features/tasks/components/TasksPopup.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { useViewportFlip } from '@/hooks/useViewportFlip';
import { useNavigationStore } from '@/stores';
import { useTasksPopupData } from '@/features/tasks/hooks/useTasksPopupData';
import { useSetTaskStatus } from '@/features/tasks/hooks/useSetTaskStatus';
import { useQuickAddTask } from '@/features/tasks/hooks/useQuickAddTask';
import { TasksPopupSection } from './TasksPopupSection';
import type { Node } from '@/types/api';
import './TasksPopup.css';

export interface TasksPopupProps {
  isOpen: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

export function TasksPopup({ isOpen, onClose, anchorRef }: TasksPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  const [quickAddValue, setQuickAddValue] = useState('');
  const { sections, isLoading, isError, refetch } = useTasksPopupData();
  const setTaskStatus = useSetTaskStatus();
  const { quickAdd, isAdding } = useQuickAddTask();
  const openNode = useNavigationStore((s) => s.openNode);

  const position = useViewportFlip(
    anchorRef as React.RefObject<HTMLElement>,
    isOpen,
    { popupRef, popupHeight: 420, fixed: true },
  );

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (
        popupRef.current &&
        !popupRef.current.contains(e.target as globalThis.Node) &&
        anchorRef?.current &&
        !anchorRef.current.contains(e.target as globalThis.Node)
      ) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose, anchorRef]);

  // Close on Escape (CalendarPopup lacks this; the tasks popup adds it)
  useEffect(() => {
    if (!isOpen) return;
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleToggle = (node: Node, completed: boolean) => {
    setTaskStatus(node.uuid, completed ? 'Pending' : 'Done');
  };

  const handleOpen = (node: Node) => {
    openNode(node.uuid);
    onClose();
  };

  const handleQuickAddKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || isAdding) return;
    const value = quickAddValue;
    if (!value.trim()) return;
    setQuickAddValue('');
    void quickAdd(value).catch(() => {
      setQuickAddValue(value); // restore on failure
    });
  };

  const isEmpty =
    !isLoading &&
    !isError &&
    sections.overdue.nodes.length === 0 &&
    sections.today.nodes.length === 0 &&
    sections.upcoming.nodes.length === 0 &&
    sections.completed.nodes.length === 0;

  return (
    <div
      className="tasks-popup"
      ref={popupRef}
      role="dialog"
      aria-label="Tasks"
      style={position ? {
        position: 'fixed',
        top: position.top,
        left: position.left,
      } : { position: 'fixed', visibility: 'hidden' }}
    >
      <div className="tasks-popup__quick-add">
        <input
          type="text"
          placeholder="Add a task"
          aria-label="Add a task"
          value={quickAddValue}
          disabled={isAdding}
          onChange={(e) => setQuickAddValue(e.target.value)}
          onKeyDown={handleQuickAddKeyDown}
        />
      </div>

      <div className="tasks-popup__body">
        {isLoading && <div className="tasks-popup__state">Loading tasks…</div>}
        {isError && (
          <div className="tasks-popup__state tasks-popup__state--error">
            Failed to load tasks.{' '}
            <button type="button" onClick={refetch}>Retry</button>
          </div>
        )}
        {isEmpty && <div className="tasks-popup__state">No tasks due. Enjoy the calm.</div>}

        <TasksPopupSection
          title="Overdue"
          tone="danger"
          nodes={sections.overdue.nodes}
          totalCount={sections.overdue.totalCount}
          showDates
          onToggle={handleToggle}
          onOpen={handleOpen}
        />
        <TasksPopupSection
          title="Today"
          nodes={sections.today.nodes}
          totalCount={sections.today.totalCount}
          onToggle={handleToggle}
          onOpen={handleOpen}
        />
        <TasksPopupSection
          title="Upcoming"
          nodes={sections.upcoming.nodes}
          totalCount={sections.upcoming.totalCount}
          showDates
          onToggle={handleToggle}
          onOpen={handleOpen}
        />
        <TasksPopupSection
          title="Completed today"
          tone="muted"
          nodes={sections.completed.nodes}
          totalCount={sections.completed.totalCount}
          completed
          onToggle={handleToggle}
          onOpen={handleOpen}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 11: Add the stylesheet**

Create `frontend/src/features/tasks/components/TasksPopup.css`. Follow the visual conventions of `frontend/src/components/ui/CalendarPopup.css` (card surface, border, shadow, radius — read it and match tokens/variables). Minimum:

```css
.tasks-popup {
  min-width: 320px;
  max-width: 380px;
  max-height: 420px;
  display: flex;
  flex-direction: column;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  z-index: var(--z-dropdown, 1000);
}
.tasks-popup__quick-add { padding: var(--spacing-sm); border-bottom: 1px solid var(--color-border); }
.tasks-popup__quick-add input { width: 100%; background: transparent; border: none; outline: none; color: var(--color-text); font-size: var(--font-size-sm); }
.tasks-popup__body { overflow-y: auto; padding: var(--spacing-xs) 0; }
.tasks-popup__section-title {
  display: flex; justify-content: space-between; align-items: center;
  padding: var(--spacing-xs) var(--spacing-sm);
  font-size: var(--font-size-xs); font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.04em; color: var(--color-text-secondary);
}
.tasks-popup__section-title--danger { color: var(--color-error); }
.tasks-popup__section-title--muted { color: var(--color-text-tertiary); }
.tasks-popup__count { font-weight: 500; }
.tasks-popup__list { list-style: none; margin: 0; padding: 0; }
.tasks-popup__row { display: flex; align-items: flex-start; gap: var(--spacing-xs); padding: 2px var(--spacing-sm); }
.tasks-popup__circle { background: none; border: none; padding: 2px; cursor: pointer; color: var(--color-text-secondary); flex-shrink: 0; }
.tasks-popup__circle:hover { color: var(--color-primary); }
.tasks-popup__row--completed .tasks-popup__name { text-decoration: line-through; color: var(--color-text-tertiary); }
.tasks-popup__title { flex: 1; min-width: 0; background: none; border: none; padding: 2px 0; cursor: pointer; text-align: left; color: var(--color-text); }
.tasks-popup__title:hover .tasks-popup__name { color: var(--color-primary); }
.tasks-popup__name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--font-size-sm); }
.tasks-popup__meta { display: flex; gap: var(--spacing-xs); font-size: var(--font-size-xs); color: var(--color-text-tertiary); }
.tasks-popup__state { padding: var(--spacing-md); text-align: center; color: var(--color-text-secondary); font-size: var(--font-size-sm); }
.tasks-popup__state--error { color: var(--color-error); }
```

Adjust token names to the ones actually used in `CalendarPopup.css` / the design tokens (`agents/design-language.md`); delete any token that doesn't exist in favor of the real one.

- [ ] **Step 12: Run the popup test — verify pass**

Run: `docker compose -f compose.dev.yaml exec frontend npx vitest run src/features/tasks/components/TasksPopup.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 13: Wire the TopBar trigger**

In `frontend/src/features/layout/components/TopBar.tsx`:

1. Extend the `useModalStore` selection (lines ~77-93) with `isTasksPopupOpen`, `setTasksPopupOpen`, `toggleTasksPopup` (same selection style as `isCalendarOpen`/`toggleCalendar`/`setCalendarOpen`).
2. Add a ref next to `calendarBtnRef`: `const tasksBtnRef = useRef<HTMLButtonElement>(null);`
3. Add the data hook near the other hooks: `const { dueCount } = useTasksPopupData();` with `import { useTasksPopupData } from '@/features/tasks';`
4. Immediately before the calendar `<div className="top-bar-calendar-container">` block (~line 315), insert:

```tsx
{/* Tasks popup button */}
<div className="top-bar-tasks-container">
  <Button
    ref={tasksBtnRef}
    icon={"mdi mdi-checkbox-marked-circle-outline"}
    variant="ghost"
    size="sm"
    active={isTasksPopupOpen}
    onClick={toggleTasksPopup}
    aria-label="Open tasks"
    title="Open tasks"
    className="toolbar-btn"
    badges={dueCount > 0 ? [{ count: dueCount, position: 'top-right' }] : undefined}
  />
  <TasksPopup
    isOpen={isTasksPopupOpen}
    onClose={() => setTasksPopupOpen(false)}
    anchorRef={tasksBtnRef as React.RefObject<HTMLElement>}
  />
</div>
```

with `import { TasksPopup, useTasksPopupData } from '@/features/tasks';` (single barrel import — merge with the line above).

5. Update the barrel `frontend/src/features/tasks/index.ts` to export the new modules:

```ts
export * from './hooks/useTaskActions';
export * from './hooks/useSetTaskStatus';
export * from './hooks/useTasksPopupData';
export * from './hooks/useQuickAddTask';
export { TasksPopup } from './components/TasksPopup';
```

(Read the current barrel first and keep its existing style/exports; `TaskStatus` is exported via `useTaskActions` re-export — avoid duplicate-export conflicts for `TaskStatus`: if the barrel already does `export * from './hooks/useTaskActions'` and `useTaskActions` re-exports `TaskStatus`, do not also `export * from './taskStatusShared'`.)

- [ ] **Step 14: Full regression + gates**

Run:
```
docker compose -f compose.dev.yaml exec frontend npm run test:run
docker compose -f compose.dev.yaml exec frontend npx tsc -b --noEmit
docker compose -f compose.dev.yaml exec frontend npm run lint
```
Expected: all tests PASS, tsc clean, lint 0 errors.

- [ ] **Step 15: Commit**

```bash
git add frontend/src/stores/modalStore.ts frontend/src/features/tasks/hooks/useQuickAddTask.ts frontend/src/features/tasks/hooks/useQuickAddTask.test.ts frontend/src/features/tasks/components/TaskPopupRow.tsx frontend/src/features/tasks/components/TasksPopupSection.tsx frontend/src/features/tasks/components/TasksPopup.tsx frontend/src/features/tasks/components/TasksPopup.css frontend/src/features/tasks/components/TasksPopup.test.tsx frontend/src/features/layout/components/TopBar.tsx frontend/src/features/tasks/index.ts
git commit -m "feat(tasks): top-bar tasks popup with quick-add and due-count badge"
```

---

### Task 3: Reroute entry points + delete the old Tasks view

**Files:**
- Modify: `frontend/src/features/layout/components/Sidebar/NavigationSidebar.tsx:260-270` (rail Tasks button)
- Modify: `frontend/src/features/commands/navigationCommands.ts:25-32` (palette execute)
- Modify: `frontend/src/features/layout/components/MainContentPane.tsx` (remove `mainViewType === 'tasks'` branch ~:91-97 and the `TasksView` import ~:16)
- Modify: `frontend/src/features/layout/hooks/url.ts` (remove `tasks` from `SPECIAL_VIEWS` ~:20 and `VIEW_TO_PATH` ~:39)
- Modify: `frontend/src/stores/appStore.ts:33` (remove `'tasks'` from `MainViewType`)
- Modify: `frontend/src/hooks/useDocumentTitle.ts:27` (remove `VIEW_LABELS.tasks`)
- Modify: `frontend/src/hooks/queryKeys.ts` (remove `taskKeys.view`)
- Delete: `frontend/src/features/tasks/pages/TasksView.tsx`
- Delete: `frontend/src/features/tasks/hooks/useTasks.ts`
- Delete: `frontend/src/features/tasks/hooks/useTasks.test.ts`
- Modify: `frontend/src/features/layout/components/Sidebar/SidebarRail.test.tsx` (tasks-button tests now assert popup toggle)
- Modify: `README.md:37` (wording)

**Interfaces:**
- Consumes (from Task 2): `useModalStore` `isTasksPopupOpen` / `toggleTasksPopup`.
- Produces: no `mainViewType === 'tasks'` anywhere; `/tasks` URLs fall through to the default view; palette "Open Tasks" (id `view.tasks`) opens the popup.

- [ ] **Step 1: Update the failing rail test first**

In `frontend/src/features/layout/components/Sidebar/SidebarRail.test.tsx`, rewrite the Tasks-button tests (read the current file first; keep its mock pattern) to:

```tsx
it('opens the tasks popup from the rail button', () => {
  useModalStore.setState({ isTasksPopupOpen: false });
  render(<SidebarRail {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /^tasks$/i }));
  expect(useModalStore.getState().isTasksPopupOpen).toBe(true);
});

it('shows the rail tasks button active while the popup is open', () => {
  useModalStore.setState({ isTasksPopupOpen: true });
  render(<SidebarRail {...props} />);
  expect(screen.getByRole('button', { name: /^tasks$/i }).className).toContain('btn--active');
});
```

Add `useModalStore` to the `@/stores` import (or its existing import source). Run:
`docker compose -f compose.dev.yaml exec frontend npx vitest run src/features/layout/components/Sidebar/SidebarRail.test.tsx`
Expected: FAIL (clicking still sets `mainViewType`).

- [ ] **Step 2: Reroute the rail button**

In `NavigationSidebar.tsx` (~:260-270): replace `active={mainViewType === 'tasks'}` and `onClick={() => setMainViewType('tasks')}` with modal-store wiring:

```tsx
const isTasksPopupOpen = useModalStore((s) => s.isTasksPopupOpen);
const toggleTasksPopup = useModalStore((s) => s.toggleTasksPopup);
...
<Button
  className="sidebar-rail__btn"
  variant="ghost"
  size="md"
  icon="mdi mdi-checkbox-marked-circle-outline"
  fullWidth
  active={isTasksPopupOpen}
  onClick={toggleTasksPopup}
  aria-label="Tasks"
  title="Tasks"
/>
```

(Add the `useModalStore` import to the file's store imports; remove now-unused `mainViewType`/`setMainViewType` selectors **only if** no other button in the file still uses them — check first.)

Run the rail test — verify PASS.

- [ ] **Step 3: Reroute the palette command**

In `frontend/src/features/commands/navigationCommands.ts:25-32`, change `execute` to open the popup (keep `id`, `label`, `icon`, `context`, `palette` unchanged so `navigationCommands.test.ts` keeps passing):

```ts
execute: () => useModalStore.getState().toggleTasksPopup(),
```

Adjust the store import (`useModalStore` from `@/stores` or the file's existing store import path). Run:
`docker compose -f compose.dev.yaml exec frontend npx vitest run src/features/commands/`
Expected: PASS.

- [ ] **Step 4: Delete the old view surface**

1. Delete `frontend/src/features/tasks/pages/TasksView.tsx`, `frontend/src/features/tasks/hooks/useTasks.ts`, `frontend/src/features/tasks/hooks/useTasks.test.ts`.
2. `MainContentPane.tsx`: remove the `mainViewType === 'tasks'` branch and the `TasksView` import.
3. `frontend/src/features/layout/hooks/url.ts`: remove the `tasks` entries from `SPECIAL_VIEWS` and `VIEW_TO_PATH`.
4. `frontend/src/stores/appStore.ts`: remove `'tasks'` from the `MainViewType` union.
5. `frontend/src/hooks/useDocumentTitle.ts`: remove `VIEW_LABELS.tasks`.
6. `frontend/src/hooks/queryKeys.ts`: remove `taskKeys.view`.
7. Check the tasks barrel (`frontend/src/features/tasks/index.ts`) for a `useTasks`/pages export and remove it.
8. `README.md:37`: change `| Task lists | ✅ | ✅ (dedicated Tasks tab) |` to `| Task lists | ✅ | ✅ (top-bar Tasks popup) |` (verify the exact current line with grep before editing).
9. Sweep: `grep -rn "TasksView\|taskKeys.view\|useTasks\b\|mainViewType === 'tasks'\|setMainViewType('tasks')" frontend/src` — every hit must be intentional (plan/spec docs are out of scope).

- [ ] **Step 5: Full regression + gates**

Run:
```
docker compose -f compose.dev.yaml exec frontend npm run test:run
docker compose -f compose.dev.yaml exec frontend npx tsc -b --noEmit
docker compose -f compose.dev.yaml exec frontend npm run lint
```
Expected: all PASS, 0 errors. Fix any missed reference the sweep/compiler surfaces — do not leave dead code.

- [ ] **Step 6: Commit**

```bash
git add -u frontend/src README.md
git commit -m "refactor(tasks): reroute rail and palette to the popup, drop the /tasks view"
```

(Verify `git status` first — only intended files; the deletions are part of `-u`.)

---

### Task 4: Final verification (no code changes)

**Files:** none (verification only; report to `.superpowers/sdd/popup-task-4-report.md`).

- [ ] **Step 1: Gates**

```
docker compose -f compose.dev.yaml exec backend uv run ruff check app/
docker compose -f compose.dev.yaml exec backend uv run pytest tests/ -m "not slow" --no-cov -q
docker compose -f compose.dev.yaml exec frontend npm run lint
docker compose -f compose.dev.yaml exec frontend npx tsc -b --noEmit
docker compose -f compose.dev.yaml exec frontend npm run test:run
```
Expected: all PASS (backend untouched — confirm no regressions).

- [ ] **Step 2: Rebuild the dev stack**

```
docker compose -f compose.dev.yaml down && docker compose -f compose.dev.yaml up --build -d
```
Expected: all containers healthy; backend logs "Database schema initialized" + "Application startup complete"; `curl -s -o /dev/null -w '%{http_code}' http://localhost:5173/` → 200.

- [ ] **Step 3: API-level verification**

Mint a short-lived dev token inside the backend container (same approach as the badge-plan verification — via the app's own `create_token()`, no credentials read, nothing persisted) and run the popup's four ASTs against `POST /api/nodes/views/execute` with `include_properties: true`:
- Overdue/today/upcoming: every returned node's Status is Pending or Doing (resolve via `properties_uuid` + the workspace's Status property options); none Backlog/Reviewing/Done/Cancelled.
- Completed-today: every node has Status Done and `task_closed_date` = today's day UUID.
- `total_count` present per section.

- [ ] **Step 4: Manual-UX checklist for the user (document, don't execute)**

Playwright browsers are not installed in the container and installing requires user confirmation — record these as the user's manual pass at http://localhost:5173:
1. Top-bar tasks icon shows the overdue+today badge count; clicking it opens the popup; Esc/outside-click/navigation close it.
2. Sections show the right tasks; Overdue is red; checking a circle moves the task to "Completed today" (struck through); unchecking returns it to Today/Overdue; the block's status badge in the editor updates instantly.
3. Quick-add creates a task on today's journal page, scheduled today, Pending — visible in Today and on the journal page.
4. Rail button and Ctrl+K → "Open Tasks" open the popup; `/tasks` URL no longer shows the old view; the task class page still works as the power surface.
5. Backlog/Reviewing tasks never appear in the popup.

- [ ] **Step 5: Report**

Write `.superpowers/sdd/popup-task-4-report.md` with gate outcomes, rebuild result, API verification results, and the manual checklist. `STATUS: DONE` when gates are green and the stack is healthy; `STATUS: DONE_WITH_CONCERNS` listing anything left for the manual pass.

---

## Self-review notes (plan author)

- **Spec coverage:** popup sections + status filtering (Task 1), circle check/uncheck + quick-add + badge + Esc (Task 2), route/palette/rail reroute + full deletion surface incl. URL maps and README (Task 3), verification incl. the spec's manual browser pass (Task 4). Class page untouched, per spec.
- **Deviations from spec, intentional:** open state lives in `modalStore` (spec corrected); badge queries run always (TopBar + popup share the cache by query key — no duplicate fetches); `useSetTaskStatus` takes `(nodeUuid, status)` rather than binding a node, so dynamic rows can use it.
- **Known accepted tradeoffs:** popup queries have no offline local fallback (direct `executeQuery`; the old view's `useQuery_` fallback is not reused — popup shows its error state offline); editor Ctrl+Enter status changes don't invalidate popup keys (30s `staleTime` + focus refetch bound the staleness); date chip/sort read `properties_uuid` defensively (non-day-UUID values degrade to no chip/unsorted, not crashes).
- **Type consistency:** `PopupSection`, `PopupSectionData`, `getPopupQueryForSection`, `getTaskDateUuid`, `useSetTaskStatus`, `useQuickAddTask`, `invalidateTaskPopupQueries`, `TASK_POPUP_HIDDEN_STATUSES` are used consistently across tasks; Task 2/3 interface blocks restate them.

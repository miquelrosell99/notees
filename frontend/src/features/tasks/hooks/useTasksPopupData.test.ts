import { describe, it, expect } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { getPopupQueryForSection, getTaskDateUuid, useTasksPopupData } from './useTasksPopupData';
import { WorkspaceStoreProvider } from '@/core/hooks/WorkspaceStoreProvider';
import { useWorkspaceStore } from '@/core/hooks/useWorkspaceStore';
import { MemoryRelay, MemoryTransport } from '@/core/transport';
import { uuidv7 } from '@/core/uuid';
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';
import { dateToDayUuid, getTodayDayUuid } from '@/utils/dateUuid';

function createWrapper() {
  const actorId = uuidv7();
  const relay = new MemoryRelay();
  const transport = new MemoryTransport(relay, 'ws-test');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: qc },
      createElement(
        MemoryRouter,
        { initialEntries: ['/ws-test'] },
        createElement(
          Routes,
          null,
          createElement(
            Route,
            {
              path: '/:workspaceId/*',
              element: createElement(
                WorkspaceStoreProvider,
                { actorId, transport, children }
              ),
            }
          )
        )
      )
    );
  };
}

function seedTaskData(store: NonNullable<ReturnType<typeof useWorkspaceStore>['store']>) {

  // Seed class hierarchy for the task class.
  store.getDb().run(
    'INSERT OR IGNORE INTO class_hierarchy (class_id, ancestor_id) VALUES (?, ?)',
    [SYSTEM_CLASS_UUIDS.task, SYSTEM_CLASS_UUIDS.task]
  );

  const todayUuid = getTodayDayUuid();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayUuid = dateToDayUuid(yesterday);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowUuid = dateToDayUuid(tomorrow);

  function createTask(nodeId: string, status: string, extras: { scheduled?: string; deadline?: string; closed?: string; writeDate?: string } = {}) {
    store.createNode({ nodeId, kind: 'block', parentId: null, classIds: [SYSTEM_CLASS_UUIDS.task] });
    store.setProperty({
      propertyValueId: uuidv7(),
      nodeId,
      schemaId: SYSTEM_PROPERTY_UUIDS.task_status,
      value: status,
    });
    if (extras.scheduled) {
      store.setProperty({
        propertyValueId: uuidv7(),
        nodeId,
        schemaId: SYSTEM_PROPERTY_UUIDS.task_scheduled,
        value: extras.scheduled,
      });
    }
    if (extras.deadline) {
      store.setProperty({
        propertyValueId: uuidv7(),
        nodeId,
        schemaId: SYSTEM_PROPERTY_UUIDS.task_deadline,
        value: extras.deadline,
      });
    }
    if (extras.closed) {
      store.setProperty({
        propertyValueId: uuidv7(),
        nodeId,
        schemaId: SYSTEM_PROPERTY_UUIDS.task_closed_date,
        value: extras.closed,
      });
    }
    if (extras.writeDate) {
      store.getDb().run('UPDATE node SET updated_at = ? WHERE id = ?', [extras.writeDate, nodeId]);
    }
  }

  // Pending tasks for popup sections.
  createTask('overdue-1', 'Pending', { scheduled: yesterdayUuid });
  createTask('overdue-2', 'Doing', { deadline: yesterdayUuid });
  createTask('today-1', 'Pending', { scheduled: todayUuid });
  createTask('today-2', 'Doing', { deadline: todayUuid });
  createTask('upcoming-1', 'Pending', { scheduled: tomorrowUuid });
  createTask('unscheduled-1', 'Pending', { writeDate: '2026-07-14T12:00:00Z' });
  createTask('unscheduled-2', 'Pending', { writeDate: '2026-07-10T08:00:00Z' });

  // Completed today.
  createTask('completed-1', 'Done', { closed: todayUuid });
  createTask('completed-2', 'Done', { closed: todayUuid });

  // Hidden statuses (Backlog/Reviewing) should not appear in popup counts.
  createTask('hidden-backlog', 'Backlog', { scheduled: todayUuid });
  createTask('hidden-reviewing', 'Reviewing', { deadline: todayUuid });

  return { todayUuid, yesterdayUuid, tomorrowUuid };
}

describe('getPopupQueryForSection', () => {
  it.each(['overdue', 'today', 'upcoming', 'unscheduled', 'completed'] as const)(
    'requests properties for the %s section',
    (section) => {
      expect(getPopupQueryForSection(section).include_properties).toBe(true);
    },
  );

  it('caps upcoming at 20 and unscheduled/completed at 10 rows', () => {
    expect(getPopupQueryForSection('upcoming').limit).toBe(20);
    expect(getPopupQueryForSection('unscheduled').limit).toBe(10);
    expect(getPopupQueryForSection('completed').limit).toBe(10);
    expect(getPopupQueryForSection('overdue').limit).toBeUndefined();
    expect(getPopupQueryForSection('today').limit).toBeUndefined();
  });
});

describe('getTaskDateUuid', () => {
  it('prefers scheduled over deadline and ignores non-day-uuid values', () => {
    const node = {
      properties_uuid: {
        [SYSTEM_PROPERTY_UUIDS.task_scheduled]: '00000000-0000-0000-00dd-202607200000',
        [SYSTEM_PROPERTY_UUIDS.task_deadline]: '00000000-0000-0000-00dd-202607180000',
      },
    } as never;
    expect(getTaskDateUuid(node)).toBe('00000000-0000-0000-00dd-202607200000');
    expect(getTaskDateUuid({ properties_uuid: { [SYSTEM_PROPERTY_UUIDS.task_scheduled]: 42 } } as never)).toBeNull();
    expect(getTaskDateUuid({ properties_uuid: undefined } as never)).toBeNull();
  });
});

describe('useTasksPopupData', () => {
  async function getStore(Wrapper: ReturnType<typeof createWrapper>) {
    const { result } = renderHook(() => useWorkspaceStore('ws-test'), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.store).toBeDefined());
    return result.current.store!;
  }

  it('derives the due count from overdue + today totals', async () => {
    const Wrapper = createWrapper();
    const store = await getStore(Wrapper);
    seedTaskData(store);

    const { result } = renderHook(() => useTasksPopupData(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.dueCount).toBe(4));

    expect(result.current.sections.upcoming.totalCount).toBe(1);
    expect(result.current.sections.completed.totalCount).toBe(2);
    expect(result.current.sections.unscheduled.totalCount).toBe(2);
  });

  it('sorts unscheduled tasks by recently updated first', async () => {
    const Wrapper = createWrapper();
    const store = await getStore(Wrapper);
    seedTaskData(store);

    const { result } = renderHook(() => useTasksPopupData(), { wrapper: Wrapper });
    await waitFor(() =>
      expect(result.current.sections.unscheduled.nodes.map((n) => n.uuid)).toEqual([
        'unscheduled-1',
        'unscheduled-2',
      ])
    );
  });
});

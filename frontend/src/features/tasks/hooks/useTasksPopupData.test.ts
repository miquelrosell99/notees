import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { getPopupQueryForSection, getTaskDateUuid, useTasksPopupData } from './useTasksPopupData';
import { executeQuery } from '@/api/nodeViews';

vi.mock('@/api/nodeViews', () => ({ executeQuery: vi.fn() }));
const executeQueryMock = vi.mocked(executeQuery);

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client: qc }, children);
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
      if (ast.includes('task_closed_date')) return { nodes: [], total_count: 2 } as never;
      if (ast.includes('less_than') && !ast.includes('greater_than')) return { nodes: [{ uuid: 'o1' }], total_count: 5 } as never;
      if (ast.includes('greater_than')) return { nodes: [{ uuid: 'u1' }], total_count: 7 } as never;
      return { nodes: [{ uuid: 't1' }], total_count: 3 } as never; // today: equals only
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

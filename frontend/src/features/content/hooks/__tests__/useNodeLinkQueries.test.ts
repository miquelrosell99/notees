import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useLinkedReferences } from '../useNodeLinkQueries';
import { useLinkedReferencesCount } from '../useLinkedReferencesCount';
import type * as UseNodeLinkQueriesModule from '../useNodeLinkQueries';

const mockUseGraphQuery = vi.fn();

vi.mock('@/core/graphQueries/hooks/useGraphQuery', () => ({
  useGraphQuery: (...args: unknown[]) => mockUseGraphQuery(...args),
}));

vi.mock('@/core/graphQueries/queries', () => ({
  GetLinkedReferencesQuery: { name: 'GetLinkedReferencesQuery' },
  HydrateLinkedReferencesQuery: { name: 'HydrateLinkedReferencesQuery' },
  GetBacklinksQuery: { name: 'GetBacklinksQuery' },
}));

import { usePropertyBacklinks } from '../useNodeLinkQueries';

vi.mock('../useNodeLinkQueries', async (importOriginal) => {
  const mod = await importOriginal<typeof UseNodeLinkQueriesModule>();
  return {
    ...mod,
    usePropertyBacklinks: vi.fn(),
  };
});

describe('useLinkedReferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns undefined data while the ID query is loading', () => {
    mockUseGraphQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    const { result } = renderHook(() => useLinkedReferences('node-1'));

    expect(mockUseGraphQuery).toHaveBeenCalledWith(
      { name: 'GetLinkedReferencesQuery' },
      { nodeUuid: 'node-1', limit: undefined, offset: undefined },
      { enabled: true }
    );
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('hydrates visible IDs when the ID query returns results', () => {
    const idsQueryResult = {
      data: { ids: ['source-1', 'source-2'], totalCount: 2, hasMore: false },
      isLoading: false,
      error: null,
    };
    const hydratedResult = {
      data: [
        { source_node: { uuid: 'source-1' }, link_type: 'text' },
        { source_node: { uuid: 'source-2' }, link_type: 'property' },
      ],
      isLoading: false,
      error: null,
    };
    mockUseGraphQuery
      .mockReturnValueOnce(idsQueryResult)
      .mockReturnValueOnce(hydratedResult);

    const { result } = renderHook(() => useLinkedReferences('node-1', { limit: 10, offset: 0 }));

    expect(mockUseGraphQuery).toHaveBeenLastCalledWith(
      { name: 'HydrateLinkedReferencesQuery' },
      { nodeUuid: 'node-1', sourceIds: ['source-1', 'source-2'] },
      { enabled: true }
    );
    expect(result.current.data).toEqual({
      linked_references: hydratedResult.data,
      total_count: 2,
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isFetching).toBe(false);
  });

  it('disables the ID query when nodeUuid is null', () => {
    mockUseGraphQuery.mockReturnValue({ data: undefined, isLoading: false, error: null });
    renderHook(() => useLinkedReferences(null));

    expect(mockUseGraphQuery).toHaveBeenCalledWith(
      { name: 'GetLinkedReferencesQuery' },
      { nodeUuid: '', limit: undefined, offset: undefined },
      { enabled: false }
    );
  });

  it('disables the hydration query when explicitly disabled via options', () => {
    mockUseGraphQuery.mockReturnValue({
      data: { ids: ['source-1'], totalCount: 1, hasMore: false },
      isLoading: false,
      error: null,
    });
    renderHook(() => useLinkedReferences('node-1', undefined, { enabled: false }));

    expect(mockUseGraphQuery).toHaveBeenCalledWith(
      { name: 'GetLinkedReferencesQuery' },
      { nodeUuid: 'node-1', limit: undefined, offset: undefined },
      { enabled: false }
    );
    expect(mockUseGraphQuery).toHaveBeenLastCalledWith(
      { name: 'HydrateLinkedReferencesQuery' },
      { nodeUuid: 'node-1', sourceIds: ['source-1'] },
      { enabled: false }
    );
  });

  it('does not enable hydration when the ID query returns no IDs', () => {
    mockUseGraphQuery
      .mockReturnValueOnce({
        data: { ids: [], totalCount: 0, hasMore: false },
        isLoading: false,
        error: null,
      })
      .mockReturnValueOnce({ data: [], isLoading: false, error: null });

    renderHook(() => useLinkedReferences('node-1'));

    expect(mockUseGraphQuery).toHaveBeenLastCalledWith(
      { name: 'HydrateLinkedReferencesQuery' },
      { nodeUuid: 'node-1', sourceIds: [] },
      { enabled: false }
    );
  });

  it('forwards errors from either query', () => {
    const error = new Error('hydration failed');
    mockUseGraphQuery
      .mockReturnValueOnce({
        data: { ids: ['source-1'], totalCount: 1, hasMore: false },
        isLoading: false,
        error: null,
      })
      .mockReturnValueOnce({ data: undefined, isLoading: false, error });

    const { result } = renderHook(() => useLinkedReferences('node-1'));
    expect(result.current.error).toBe(error);
  });
});

describe('useLinkedReferencesCount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sums edge backlinks and property backlinks', () => {
    mockUseGraphQuery.mockReturnValue({
      data: { ids: ['a', 'b'], totalCount: 2, hasMore: false },
      isLoading: false,
      error: null,
    });
    vi.mocked(usePropertyBacklinks).mockReturnValue({
      data: [{ source_node_uuid: 'c' }],
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof usePropertyBacklinks>);

    const { result } = renderHook(() => useLinkedReferencesCount('node-1'));

    expect(mockUseGraphQuery).toHaveBeenCalledWith(
      { name: 'GetBacklinksQuery' },
      { nodeUuid: 'node-1' },
      { enabled: true }
    );
    expect(result.current.count).toBe(3);
    expect(result.current.isLoading).toBe(false);
  });

  it('returns zero when nodeUuid is null', () => {
    mockUseGraphQuery.mockReturnValue({ data: undefined, isLoading: false, error: null });
    vi.mocked(usePropertyBacklinks).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof usePropertyBacklinks>);

    const { result } = renderHook(() => useLinkedReferencesCount(null));

    expect(mockUseGraphQuery).toHaveBeenCalledWith(
      { name: 'GetBacklinksQuery' },
      { nodeUuid: '' },
      { enabled: false }
    );
    expect(result.current.count).toBe(0);
  });

  it('is loading while either query is loading', () => {
    mockUseGraphQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });
    vi.mocked(usePropertyBacklinks).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof usePropertyBacklinks>);

    const { result } = renderHook(() => useLinkedReferencesCount('node-1'));
    expect(result.current.isLoading).toBe(true);
  });
});

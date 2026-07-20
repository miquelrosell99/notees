import { describe, it, expect } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { WorkspaceStoreProvider } from '../WorkspaceStoreProvider';
import { useWorkspaceStore } from '../useWorkspaceStore';
import { useQueryAst } from '../useQueryAst';
import { MemoryRelay, MemoryTransport } from '../../transport';
import { uuidv7 } from '../../uuid';
import { createClassCondition, createEmptyQueryAST } from '@/types/queryAST';

function createProviderProps() {
  const actorId = uuidv7();
  const relay = new MemoryRelay();
  const transport = new MemoryTransport(relay, 'ws-test');
  return { actorId, transport };
}

function wrapper(props: { actorId: string; transport: MemoryTransport }) {
  return function Wrapper({ children }: { children: ReactNode }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/ws-test']}>
          <Routes>
            <Route
              path="/:workspaceId/*"
              element={
                <WorkspaceStoreProvider
                  actorId={props.actorId}
                  transport={props.transport}
                >
                  {children}
                </WorkspaceStoreProvider>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('useQueryAst', () => {
  it('returns projected nodes matching a class condition', async () => {
    const props = createProviderProps();
    const Wrapper = wrapper(props);
    const classId = uuidv7();
    const pageId = uuidv7();

    const { result: storeResult } = renderHook(() => useWorkspaceStore('ws-test'), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(storeResult.current.store).toBeDefined());
    const store = storeResult.current.store!;

    act(() => {
      store.createNode({ nodeId: classId, kind: 'class', parentId: null });
      store.getDb().run(
        'INSERT OR IGNORE INTO class_hierarchy (class_id, ancestor_id) VALUES (?, ?)',
        [classId, classId]
      );
      store.createNode({ nodeId: pageId, kind: 'page', parentId: null, classIds: [classId] });
    });

    const ast = {
      ...createEmptyQueryAST(),
      scope: { type: 'scope' as const, scope_type: 'pages' as const },
      root_group: {
        type: 'group' as const,
        logic: 'AND' as const,
        children: [createClassCondition(classId)],
      },
    };

    const { result } = renderHook(() => useQueryAst(ast), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0].uuid).toBe(pageId);
    expect(result.current.data![0].is_page).toBe(true);
  });

  it('returns an empty array when ast is null', async () => {
    const props = createProviderProps();
    const Wrapper = wrapper(props);

    const { result } = renderHook(() => useQueryAst(null), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual([]);
    expect(result.current.isSuccess).toBe(true);
  });
});

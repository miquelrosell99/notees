import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { WorkspaceStoreProvider } from '../../hooks/WorkspaceStoreProvider';
import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';
import { MemoryRelay, MemoryTransport } from '../../transport';
import { uuidv7 } from '../../uuid';

import {
  useNodeAdapter,
  useNodesAdapter,
  useNodeChildrenAdapter,
  useCreateNodeAdapter,
  useMoveNodeAdapter,
} from '@/core/adapters';

let mockEnableSqliteStore = false;

vi.mock('@/core/utils/featureFlags', () => ({
  get ENABLE_SQLITE_STORE() {
    return mockEnableSqliteStore;
  },
}));

function createProviderProps() {
  const actorId = uuidv7();
  const relay = new MemoryRelay();
  const transport = new MemoryTransport(relay, 'ws-test');
  return { actorId, transport };
}

function sqliteWrapper(props: { actorId: string; transport: MemoryTransport }) {
  return function Wrapper({ children }: { children: ReactNode }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/ws-test']}>
          <Routes>
            <Route
              path="/:workspaceId/*"
              element={
                <WorkspaceStoreProvider actorId={props.actorId} transport={props.transport}>
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

describe('nodeAdapter', () => {
  afterEach(() => {
    vi.clearAllMocks();
    mockEnableSqliteStore = false;
  });

  describe('when ENABLE_SQLITE_STORE is true', () => {
    beforeEach(() => {
      mockEnableSqliteStore = true;
    });

    it('useNodeAdapter returns projected node data', async () => {
      const props = createProviderProps();
      const Wrapper = sqliteWrapper(props);
      const nodeId = uuidv7();

      const { result: storeResult } = renderHook(() => useWorkspaceStore('ws-test'), {
        wrapper: Wrapper,
      });
      await waitFor(() => expect(storeResult.current.store).toBeDefined());

      act(() => {
        storeResult.current.store!.createNode({ nodeId, kind: 'page', parentId: null });
        storeResult.current.store!.updateText(nodeId, (text) => text.insert(0, 'SQLite page'));
      });

      const { result } = renderHook(() => useNodeAdapter(nodeId), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.data).toBeDefined();
      expect(result.current.data!.uuid).toBe(nodeId);
      expect(result.current.data!.name).toBe('SQLite page');
      expect(result.current.data!.is_page).toBe(true);
    });

    it('useNodesAdapter returns projected pages', async () => {
      const props = createProviderProps();
      const Wrapper = sqliteWrapper(props);

      const { result: storeResult } = renderHook(() => useWorkspaceStore('ws-test'), {
        wrapper: Wrapper,
      });
      await waitFor(() => expect(storeResult.current.store).toBeDefined());

      const pageId = uuidv7();
      act(() => {
        storeResult.current.store!.createNode({ nodeId: pageId, kind: 'page', parentId: null });
      });

      const { result } = renderHook(() => useNodesAdapter({ pages_only: true }), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.data).toBeDefined());
      await waitFor(() => expect(result.current.data!.length).toBeGreaterThan(0));
      expect(result.current.data!.some((n) => n.uuid === pageId)).toBe(true);
    });

    it('useCreateNodeAdapter creates a node that useNodeAdapter can read', async () => {
      const props = createProviderProps();
      const Wrapper = sqliteWrapper(props);

      const { result: createResult } = renderHook(() => useCreateNodeAdapter(), { wrapper: Wrapper });
      await waitFor(() => expect(createResult.current.isPending).toBe(false));

      let createdUuid = '';
      await act(async () => {
        const node = await createResult.current.mutateAsync({ name: 'Created page' });
        createdUuid = node.uuid;
      });

      expect(createdUuid).not.toBe('');

      const { result: readResult } = renderHook(() => useNodeAdapter(createdUuid), { wrapper: Wrapper });
      await waitFor(() => expect(readResult.current.data).toBeDefined());
      expect(readResult.current.data!.name).toBe('Created page');
    });

    it('useMoveNodeAdapter moves a child between parents', async () => {
      const props = createProviderProps();
      const Wrapper = sqliteWrapper(props);

      const { result: storeResult } = renderHook(() => useWorkspaceStore('ws-test'), {
        wrapper: Wrapper,
      });
      await waitFor(() => expect(storeResult.current.store).toBeDefined());
      const store = storeResult.current.store!;

      const parentA = uuidv7();
      const parentB = uuidv7();
      const childId = uuidv7();

      act(() => {
        store.createNode({ nodeId: parentA, kind: 'page', parentId: null });
        store.createNode({ nodeId: parentB, kind: 'page', parentId: null });
        store.createNode({ nodeId: childId, kind: 'block', parentId: null });
        store.moveNode(childId, parentA);
      });

      const { result: moveResult } = renderHook(() => useMoveNodeAdapter(), { wrapper: Wrapper });
      await waitFor(() => expect(moveResult.current.isPending).toBe(false));

      await act(async () => {
        await moveResult.current.mutateAsync({ nodeUuid: childId, parentId: parentB });
      });

      const { result: childrenA } = renderHook(() => useNodeChildrenAdapter(parentA), {
        wrapper: Wrapper,
      });
      const { result: childrenB } = renderHook(() => useNodeChildrenAdapter(parentB), {
        wrapper: Wrapper,
      });

      await waitFor(() => expect(childrenA.current.data?.some((n) => n.uuid === childId)).toBe(false));
      await waitFor(() => expect(childrenB.current.data?.some((n) => n.uuid === childId)).toBe(true));

      const { result: childResult } = renderHook(() => useNodeAdapter(childId), { wrapper: Wrapper });
      await waitFor(() => expect(childResult.current.data).toBeDefined());
      expect(childResult.current.data!.parent_uuid).toBe(parentB);
    });

    it('useNodeAdapter refreshes when the node changes', async () => {
      const props = createProviderProps();
      const Wrapper = sqliteWrapper(props);
      const nodeId = uuidv7();

      const { result: storeResult } = renderHook(() => useWorkspaceStore('ws-test'), {
        wrapper: Wrapper,
      });
      await waitFor(() => expect(storeResult.current.store).toBeDefined());
      const store = storeResult.current.store!;

      act(() => {
        store.createNode({ nodeId, kind: 'page', parentId: null });
        store.updateText(nodeId, (text) => text.insert(0, 'Initial'));
      });

      const { result } = renderHook(() => useNodeAdapter(nodeId), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.data?.name).toBe('Initial'));

      act(() => {
        store.setNodeText(nodeId, 'Updated');
      });

      await waitFor(() => expect(result.current.data?.name).toBe('Updated'));
    });

    it('useNodesAdapter refreshes when a new page is created', async () => {
      const props = createProviderProps();
      const Wrapper = sqliteWrapper(props);

      const { result: storeResult } = renderHook(() => useWorkspaceStore('ws-test'), {
        wrapper: Wrapper,
      });
      await waitFor(() => expect(storeResult.current.store).toBeDefined());
      const store = storeResult.current.store!;

      const firstPageId = uuidv7();
      act(() => {
        store.createNode({ nodeId: firstPageId, kind: 'page', parentId: null });
      });

      const { result } = renderHook(() => useNodesAdapter({ pages_only: true }), {
        wrapper: Wrapper,
      });
      await waitFor(() => expect(result.current.data?.some((n) => n.uuid === firstPageId)).toBe(true));

      const secondPageId = uuidv7();
      act(() => {
        store.createNode({ nodeId: secondPageId, kind: 'page', parentId: null });
      });

      await waitFor(() => expect(result.current.data?.some((n) => n.uuid === secondPageId)).toBe(true));
    });

    it('useNodeChildrenAdapter refreshes when children change', async () => {
      const props = createProviderProps();
      const Wrapper = sqliteWrapper(props);

      const { result: storeResult } = renderHook(() => useWorkspaceStore('ws-test'), {
        wrapper: Wrapper,
      });
      await waitFor(() => expect(storeResult.current.store).toBeDefined());
      const store = storeResult.current.store!;

      const parentId = uuidv7();
      const childA = uuidv7();
      act(() => {
        store.createNode({ nodeId: parentId, kind: 'page', parentId: null });
        store.createNode({ nodeId: childA, kind: 'block', parentId: null });
        store.moveNode(childA, parentId);
      });

      const { result } = renderHook(() => useNodeChildrenAdapter(parentId), {
        wrapper: Wrapper,
      });
      await waitFor(() => expect(result.current.data?.some((n) => n.uuid === childA)).toBe(true));

      const childB = uuidv7();
      act(() => {
        store.createNode({ nodeId: childB, kind: 'block', parentId: null });
        store.moveNode(childB, parentId);
      });

      await waitFor(() => expect(result.current.data?.some((n) => n.uuid === childB)).toBe(true));
      await waitFor(() => expect(result.current.data).toHaveLength(2));
    });
  });
});
